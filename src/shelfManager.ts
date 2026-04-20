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
}

export class ShelfManager {
  private shelfDir: string;

  constructor() {
    const config = vscode.workspace.getConfiguration('code-shelf');
    const relPath = config.get<string>('shelfDirectory', '.vscode/shelf');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error('No workspace folder found');
    }
    this.shelfDir = path.join(root, relPath);
    this.ensureDir(this.shelfDir);

    // Ensure shelf dir is gitignored
    const gitignore = path.join(root, relPath.split('/')[0] || '.vscode', '.gitignore');
    const shelfRelPath = relPath.split('/').pop() || 'shelf';
    const parentGitignore = path.join(root, relPath);
    this.ensureGitignore(root, relPath);
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private ensureGitignore(root: string, relPath: string): void {
    // Add shelf directory to .gitignore inside .vscode/
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
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const { stdout } = await execAsync(`git ${args}`, { cwd: root, maxBuffer: 50 * 1024 * 1024 });
    return stdout;
  }

  async getModifiedFiles(): Promise<string[]> {
    const tracked = (await this.git('diff --name-only')).split('\n').filter(f => f.trim());
    const untracked = (await this.git('ls-files --others --exclude-standard')).split('\n').filter(f => f.trim());
    return [...tracked, ...untracked];
  }

  async shelve(files: string[], name: string, description?: string): Promise<boolean> {
    try {
      const shelfPath = path.join(this.shelfDir, this.sanitizeName(name));
      this.ensureDir(shelfPath);

      // Save metadata
      const meta: ShelfMeta = { name, timestamp: Date.now(), files, description };
      fs.writeFileSync(path.join(shelfPath, 'metadata.json'), JSON.stringify(meta, null, 2));

      // Create patches for each tracked file
      for (const file of files) {
        const safeName = file.replace(/[\\/]/g, '__');
        const isTracked = (await this.git(`ls-files --error-unmatch "${file}" 2>&1`)).trim().length > 0;
        
        if (isTracked) {
          // Modified tracked file — save diff patch
          const diff = await this.git(`diff -- "${file}"`);
          if (diff.trim()) {
            fs.writeFileSync(path.join(shelfPath, `${safeName}.patch`), diff);
          }
        } else {
          // Untracked file — save full content
          const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
          const fullPath = path.join(root, file);
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath);
            fs.writeFileSync(path.join(shelfPath, `${safeName}.full`), content);
            // Mark as new file
            fs.writeFileSync(path.join(shelfPath, `${safeName}.new`), file);
          }
        }
      }

      // Revert / delete the files
      const trackedFiles = [];
      const untrackedFiles = [];
      for (const file of files) {
        const isTracked = (await this.git(`ls-files --error-unmatch "${file}" 2>&1`)).trim().length > 0;
        if (isTracked) {
          trackedFiles.push(file);
        } else {
          untrackedFiles.push(file);
        }
      }

      if (trackedFiles.length > 0) {
        await this.git(`checkout -- ${trackedFiles.map(f => `"${f}"`).join(' ')}`);
      }
      for (const file of untrackedFiles) {
        const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
        const fullPath = path.join(root, file);
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

  async getShelves(): Promise<ShelfMeta[]> {
    if (!fs.existsSync(this.shelfDir)) return [];

    const shelves: ShelfMeta[] = [];
    for (const name of fs.readdirSync(this.shelfDir)) {
      const metaPath = path.join(this.shelfDir, name, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        shelves.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
      }
    }
    return shelves.sort((a, b) => b.timestamp - a.timestamp);
  }

  async unshelve(name: string): Promise<boolean> {
    try {
      const shelfPath = path.join(this.shelfDir, this.sanitizeName(name));
      if (!fs.existsSync(shelfPath)) throw new Error(`Shelf "${name}" not found`);

      const meta: ShelfMeta = JSON.parse(fs.readFileSync(path.join(shelfPath, 'metadata.json'), 'utf-8'));
      const root = vscode.workspace.workspaceFolders![0].uri.fsPath;

      for (const file of meta.files) {
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
            const targetPath = path.join(root, file);
            this.ensureDir(path.dirname(targetPath));
            fs.copyFileSync(fullFile, targetPath);
          }
        }
      }

      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to unshelve: ${(error as Error).message}`);
      return false;
    }
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

    // Combine all diffs
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

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  }
}
