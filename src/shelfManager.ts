import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ShelfMeta {
  name: string;
  timestamp: number;
  files: string[];
  description?: string;
  type?: 'changes' | 'staged' | 'silent';
}

export class ShelfManager {
  private shelfDir: string;
  private root: string;

  constructor() {
    const config = vscode.workspace.getConfiguration('code-shelf');
    const relPath = config.get<string>('shelfDirectory', '.vscode/shelf');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error('No workspace folder found');
    }
    this.root = root;
    this.shelfDir = path.join(root, relPath);
    this.ensureDir(this.shelfDir);
    this.ensureGitignore(root, relPath);
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private ensureGitignore(root: string, relPath: string): void {
    const parts = relPath.replace(/\\/g, '/').split('/');
    if (parts[0] === '.vscode') {
      const gitignorePath = path.join(root, '.vscode', '.gitignore');
      let content = '';
      if (fs.existsSync(gitignorePath)) {
        content = fs.readFileSync(gitignorePath, 'utf-8');
      }
      const shelfFolder = parts.slice(1).join('/');
      if (!content.includes(shelfFolder)) {
        content = content.trimEnd() + '\n' + shelfFolder + '/\n';
        fs.writeFileSync(gitignorePath, content);
      }
    }
  }

  private async git(args: string): Promise<string> {
    const { stdout } = await execAsync(`git ${args}`, { cwd: this.root, maxBuffer: 50 * 1024 * 1024 });
    return stdout;
  }

  private async isTracked(file: string): Promise<boolean> {
    try {
      const result = await this.git(`ls-files --error-unmatch "${file}"`);
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  async getModifiedFiles(): Promise<string[]> {
    const tracked = (await this.git('diff --name-only')).split('\n').filter(f => f.trim());
    const untracked = (await this.git('ls-files --others --exclude-standard')).split('\n').filter(f => f.trim());
    return [...tracked, ...untracked];
  }

  async getStagedFiles(): Promise<string[]> {
    const staged = (await this.git('diff --cached --name-only')).split('\n').filter(f => f.trim());
    return staged;
  }

  async shelve(files: string[], name: string, description?: string, type: 'changes' | 'staged' | 'silent' = 'changes'): Promise<boolean> {
    try {
      const shelfPath = path.join(this.shelfDir, this.sanitizeName(name));
      this.ensureDir(shelfPath);

      const meta: ShelfMeta = { name, timestamp: Date.now(), files, description, type };
      fs.writeFileSync(path.join(shelfPath, 'metadata.json'), JSON.stringify(meta, null, 2));

      const trackedFiles: string[] = [];
      const untrackedFiles: string[] = [];

      for (const file of files) {
        if (await this.isTracked(file)) {
          trackedFiles.push(file);
        } else {
          untrackedFiles.push(file);
        }
      }

      // Save patches for tracked modified files
      const isStaged = type === 'staged';
      const diffFlag = isStaged ? 'diff --cached' : 'diff';

      for (const file of trackedFiles) {
        const safeName = file.replace(/[\\/]/g, '__');
        const diff = await this.git(`${diffFlag} -- "${file}"`);
        if (diff.trim()) {
          fs.writeFileSync(path.join(shelfPath, `${safeName}.patch`), diff);
        }
      }

      // Save full content for untracked files
      for (const file of untrackedFiles) {
        const safeName = file.replace(/[\\/]/g, '__');
        const fullPath = path.join(this.root, file);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath);
          fs.writeFileSync(path.join(shelfPath, `${safeName}.full`), content);
          fs.writeFileSync(path.join(shelfPath, `${safeName}.new`), file);
        }
      }

      // Revert changes
      if (isStaged) {
        // For staged: unstage (git reset), then checkout to revert content
        if (trackedFiles.length > 0) {
          await this.git(`reset HEAD -- ${trackedFiles.map(f => `"${f}"`).join(' ')}`);
          await this.git(`checkout -- ${trackedFiles.map(f => `"${f}"`).join(' ')}`);
        }
      } else {
        if (trackedFiles.length > 0) {
          await this.git(`checkout -- ${trackedFiles.map(f => `"${f}"`).join(' ')}`);
        }
      }

      // Delete untracked files
      for (const file of untrackedFiles) {
        const fullPath = path.join(this.root, file);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }

      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to shelve: ${(error as Error).message}`);
      return false;
    }
  }

  async unshelve(name: string): Promise<boolean> {
    try {
      const shelfPath = path.join(this.shelfDir, this.sanitizeName(name));
      if (!fs.existsSync(shelfPath)) throw new Error(`Shelf "${name}" not found`);

      const meta: ShelfMeta = JSON.parse(fs.readFileSync(path.join(shelfPath, 'metadata.json'), 'utf-8'));

      for (const file of meta.files) {
        await this.unshelveFile(name, file);
      }

      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to unshelve: ${(error as Error).message}`);
      return false;
    }
  }

  async unshelveFile(shelfName: string, file: string): Promise<boolean> {
    try {
      const shelfPath = path.join(this.shelfDir, this.sanitizeName(shelfName));
      if (!fs.existsSync(shelfPath)) throw new Error(`Shelf "${shelfName}" not found`);

      const safeName = file.replace(/[\\/]/g, '__');

      // Apply patch for tracked modified files
      const patchFile = path.join(shelfPath, `${safeName}.patch`);
      if (fs.existsSync(patchFile)) {
        await this.git(`apply "${patchFile}"`);
      }

      // Restore untracked new files
      const newMarker = path.join(shelfPath, `${safeName}.new`);
      if (fs.existsSync(newMarker)) {
        const fullFile = path.join(shelfPath, `${safeName}.full`);
        if (fs.existsSync(fullFile)) {
          const targetPath = path.join(this.root, file);
          this.ensureDir(path.dirname(targetPath));
          fs.copyFileSync(fullFile, targetPath);
        }
      }

      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to unshelve file: ${(error as Error).message}`);
      return false;
    }
  }

  async renameShelf(oldName: string, newName: string): Promise<boolean> {
    try {
      const oldPath = path.join(this.shelfDir, this.sanitizeName(oldName));
      const newPath = path.join(this.shelfDir, this.sanitizeName(newName));
      if (!fs.existsSync(oldPath)) throw new Error(`Shelf "${oldName}" not found`);
      if (fs.existsSync(newPath)) throw new Error(`Shelf "${newName}" already exists`);

      // Update metadata
      const metaPath = path.join(oldPath, 'metadata.json');
      const meta: ShelfMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      meta.name = newName;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

      fs.renameSync(oldPath, newPath);
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to rename: ${(error as Error).message}`);
      return false;
    }
  }

  async getShelves(): Promise<ShelfMeta[]> {
    if (!fs.existsSync(this.shelfDir)) return [];

    const shelves: ShelfMeta[] = [];
    for (const name of fs.readdirSync(this.shelfDir)) {
      const metaPath = path.join(this.shelfDir, name, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        try {
          shelves.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
        } catch {
          // Skip corrupted metadata
        }
      }
    }
    return shelves.sort((a, b) => b.timestamp - a.timestamp);
  }

  async deleteShelf(name: string): Promise<boolean> {
    const shelfPath = path.join(this.shelfDir, this.sanitizeName(name));
    if (fs.existsSync(shelfPath)) {
      fs.rmSync(shelfPath, { recursive: true, force: true });
      return true;
    }
    return false;
  }

  getShelfDiff(shelfName: string, file?: string): string {
    const shelfPath = path.join(this.shelfDir, this.sanitizeName(shelfName));
    if (!fs.existsSync(shelfPath)) return '';

    if (file) {
      const safeName = file.replace(/[\\/]/g, '__');
      const patchFile = path.join(shelfPath, `${safeName}.patch`);
      if (fs.existsSync(patchFile)) return fs.readFileSync(patchFile, 'utf-8');
      const fullFile = path.join(shelfPath, `${safeName}.full`);
      if (fs.existsSync(fullFile)) return `--- /dev/null\n+++ b/${file}\n${fs.readFileSync(fullFile, 'utf-8')}`;
      return '';
    }

    let combined = '';
    for (const f of fs.readdirSync(shelfPath)) {
      if (f.endsWith('.patch')) {
        combined += fs.readFileSync(path.join(shelfPath, f), 'utf-8') + '\n';
      }
    }
    return combined;
  }

  getPatchPath(shelfName: string, file: string): string | undefined {
    const shelfPath = path.join(this.shelfDir, this.sanitizeName(shelfName));
    const safeName = file.replace(/[\\/]/g, '__');
    const p = path.join(shelfPath, `${safeName}.patch`);
    return fs.existsSync(p) ? p : undefined;
  }

  getShelfFilePath(shelfName: string, file: string): string | undefined {
    const shelfPath = path.join(this.shelfDir, this.sanitizeName(shelfName));
    const safeName = file.replace(/[\\/]/g, '__');
    const full = path.join(shelfPath, `${safeName}.full`);
    return fs.existsSync(full) ? full : undefined;
  }

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  }
}
