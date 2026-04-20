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

  constructor(context: vscode.ExtensionContext) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error('No workspace folder found');
    }
    this.root = root;

    // Use VS Code's workspace storage — completely hidden from file explorer and search
    const storageUri = context.storageUri;
    if (!storageUri) {
      throw new Error('Workspace storage not available');
    }
    const storageDir = path.join(storageUri.fsPath, 'code-shelf');
    this.shelfDir = storageDir;
    this.ensureDir(this.shelfDir);
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async git(args: string): Promise<string> {
    const { stdout } = await execAsync(`git ${args}`, { cwd: this.root, maxBuffer: 50 * 1024 * 1024 });
    return stdout;
  }

  /**
   * Check if a file is in the git index (staged or tracked).
   */
  private async isInIndex(file: string): Promise<boolean> {
    try {
      const result = await this.git(`ls-files --error-unmatch "${file}"`);
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Check if a file exists in HEAD (was committed).
   * A file can be in the index but not in HEAD (newly added).
   */
  private async existsInHead(file: string): Promise<boolean> {
    try {
      await this.git(`cat-file -e HEAD:"${file}"`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all modified files — includes unstaged, staged, and untracked.
   */
  async getModifiedFiles(): Promise<string[]> {
    const tracked = (await this.git('diff --name-only')).split('\n').filter(f => f.trim());
    const staged = (await this.git('diff --cached --name-only')).split('\n').filter(f => f.trim());
    const untracked = (await this.git('ls-files --others --exclude-standard')).split('\n').filter(f => f.trim());
    return [...new Set([...tracked, ...staged, ...untracked])];
  }

  async getStagedFiles(): Promise<string[]> {
    return (await this.git('diff --cached --name-only')).split('\n').filter(f => f.trim());
  }

  /**
   * Get the effective diff for a file from HEAD (includes both staged and unstaged changes).
   */
  private async getEffectiveDiff(file: string): Promise<string> {
    let stagedDiff = '';
    try { stagedDiff = (await this.git(`diff --cached -- "${file}"`)).trim(); } catch { /* no staged changes */ }

    let unstagedDiff = '';
    try { unstagedDiff = (await this.git(`diff -- "${file}"`)).trim(); } catch { /* no unstaged changes */ }

    if (stagedDiff && unstagedDiff) {
      return (await this.git(`diff HEAD -- "${file}"`)).trim();
    }
    return stagedDiff || unstagedDiff;
  }

  async shelve(files: string[], name: string, description?: string, type: 'changes' | 'staged' | 'silent' = 'changes'): Promise<boolean> {
    try {
      const shelfPath = path.join(this.shelfDir, this.sanitizeName(name));
      this.ensureDir(shelfPath);

      const meta: ShelfMeta = { name, timestamp: Date.now(), files, description, type };
      fs.writeFileSync(path.join(shelfPath, 'metadata.json'), JSON.stringify(meta, null, 2));

      // Categorize files:
      // - committedModified: exists in HEAD, has changes → save diff, checkout HEAD
      // - addedToIndex: in index but not in HEAD (new file staged) → save full content, unstage + delete
      // - untracked: not in index at all → save full content, delete
      const committedModified: string[] = [];
      const addedToIndex: string[] = [];
      const untracked: string[] = [];

      for (const file of files) {
        const inIndex = await this.isInIndex(file);
        if (inIndex) {
          const inHead = await this.existsInHead(file);
          if (inHead) {
            committedModified.push(file);
          } else {
            addedToIndex.push(file);
          }
        } else {
          untracked.push(file);
        }
      }

      // Save patches for committed-modified files
      // Split into: modified (file exists) vs deleted (file gone but in HEAD)
      const modifiedTracked: string[] = [];
      const deletedTracked: string[] = [];
      for (const file of committedModified) {
        if (fs.existsSync(path.join(this.root, file))) {
          modifiedTracked.push(file);
        } else {
          deletedTracked.push(file);
        }
      }

      // Save diffs for modified files (file still exists)
      for (const file of modifiedTracked) {
        const safeName = file.replace(/[\\/]/g, '__');
        let diff: string;
        if (type === 'staged') {
          diff = (await this.git(`diff --cached -- "${file}"`)).trim();
        } else {
          diff = await this.getEffectiveDiff(file);
        }
        if (diff) {
          fs.writeFileSync(path.join(shelfPath, `${safeName}.patch`), diff);
        }
      }

      // Save HEAD content for deleted files (can't use git apply for deletions reliably)
      for (const file of deletedTracked) {
        const safeName = file.replace(/[\\/]/g, '__');
        const headContent = await this.git(`show HEAD:"${file}"`);
        fs.writeFileSync(path.join(shelfPath, `${safeName}.head`), headContent);
        fs.writeFileSync(path.join(shelfPath, `${safeName}.deleted`), file);
      }

      // Save full content for added-to-index files
      for (const file of addedToIndex) {
        const safeName = file.replace(/[\\/]/g, '__');
        const fullPath = path.join(this.root, file);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath);
          fs.writeFileSync(path.join(shelfPath, `${safeName}.full`), content);
          fs.writeFileSync(path.join(shelfPath, `${safeName}.new`), file);
        }
      }

      // Save full content for untracked files
      for (const file of untracked) {
        const safeName = file.replace(/[\\/]/g, '__');
        const fullPath = path.join(this.root, file);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath);
          fs.writeFileSync(path.join(shelfPath, `${safeName}.full`), content);
          fs.writeFileSync(path.join(shelfPath, `${safeName}.new`), file);
        }
      }

      // Revert: modified tracked → reset + checkout HEAD
      if (modifiedTracked.length > 0) {
        const fileArgs = modifiedTracked.map(f => `"${f}"`).join(' ');
        await this.git(`reset HEAD -- ${fileArgs}`);
        await this.git(`checkout HEAD -- ${fileArgs}`);
      }

      // Revert: deleted tracked → restore from HEAD (already reverted, but reset staging if needed)
      if (deletedTracked.length > 0) {
        const fileArgs = deletedTracked.map(f => `"${f}"`).join(' ');
        await this.git(`reset HEAD -- ${fileArgs}`);
        await this.git(`checkout HEAD -- ${fileArgs}`);
      }

      // Revert: added-to-index → reset (unstage) + delete file
      if (addedToIndex.length > 0) {
        const fileArgs = addedToIndex.map(f => `"${f}"`).join(' ');
        await this.git(`reset HEAD -- ${fileArgs}`);
        for (const file of addedToIndex) {
          const fullPath = path.join(this.root, file);
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        }
      }

      // Revert: untracked → delete file
      for (const file of untracked) {
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

      // Restore new files (added-to-index or untracked)
      const newMarker = path.join(shelfPath, `${safeName}.new`);
      if (fs.existsSync(newMarker)) {
        const fullFile = path.join(shelfPath, `${safeName}.full`);
        if (fs.existsSync(fullFile)) {
          const targetPath = path.join(this.root, file);
          this.ensureDir(path.dirname(targetPath));
          fs.copyFileSync(fullFile, targetPath);
        }
        return true;
      }

      // Restore deleted files — just delete the file from disk
      const deletedMarker = path.join(shelfPath, `${safeName}.deleted`);
      if (fs.existsSync(deletedMarker)) {
        const fullPath = path.join(this.root, file);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
        return true;
      }

      // Apply patch for tracked modified files
      const patchFile = path.join(shelfPath, `${safeName}.patch`);
      if (fs.existsSync(patchFile)) {
        const fullPath = path.join(this.root, file);
        if (!fs.existsSync(fullPath)) {
          try {
            await this.git(`checkout HEAD -- "${file}"`);
          } catch {
            this.ensureDir(path.dirname(fullPath));
            fs.writeFileSync(fullPath, '');
          }
        }
        await this.git(`apply "${patchFile}"`);
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
      const deletedFile = path.join(shelfPath, `${safeName}.head`);
      if (fs.existsSync(deletedFile)) return `--- a/${file}\n+++ /dev/null\n${fs.readFileSync(deletedFile, 'utf-8').split('\n').map(l => '-' + l).join('\n')}`;
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

  /**
   * Get original (HEAD) and modified content for a shelved file, for use in vscode.diff.
   * Returns { original, modified } or undefined.
   */
  async getDiffContents(shelfName: string, file: string): Promise<{ original: string; modified: string } | undefined> {
    const shelfPath = path.join(this.shelfDir, this.sanitizeName(shelfName));
    if (!fs.existsSync(shelfPath)) return undefined;
    const safeName = file.replace(/[\\/]/g, '__');

    // New file (added-to-index or untracked)
    const fullFile = path.join(shelfPath, `${safeName}.full`);
    const newMarker = path.join(shelfPath, `${safeName}.new`);
    if (fs.existsSync(fullFile) && fs.existsSync(newMarker)) {
      return { original: '', modified: fs.readFileSync(fullFile, 'utf-8') };
    }

    // Deleted file
    const headFile = path.join(shelfPath, `${safeName}.head`);
    const deletedMarker = path.join(shelfPath, `${safeName}.deleted`);
    if (fs.existsSync(headFile) && fs.existsSync(deletedMarker)) {
      return { original: fs.readFileSync(headFile, 'utf-8'), modified: '' };
    }

    // Modified tracked file — apply patch to HEAD content
    const patchFile = path.join(shelfPath, `${safeName}.patch`);
    if (fs.existsSync(patchFile)) {
      try {
        const original = await this.git(`show HEAD:"${file}"`);
        const patch = fs.readFileSync(patchFile, 'utf-8');
        // Write original to temp, apply patch, read result
        const tempDir = path.join(this.shelfDir, '__temp_diff__');
        this.ensureDir(tempDir);
        const tempOriginal = path.join(tempDir, safeName);
        fs.writeFileSync(tempOriginal, original);
        try {
          await execAsync(`git apply --reverse "${patchFile}"`, { cwd: tempDir });
          // Actually, let's do it differently: write original, apply patch forward
        } catch { /* ignore */ }

        // Simpler approach: write HEAD content to temp file, apply patch
        const tempFile = path.join(tempDir, path.basename(file));
        this.ensureDir(path.dirname(tempFile));
        fs.writeFileSync(tempFile, original);
        try {
          await execAsync(`git apply "${patchFile}"`, { cwd: tempDir });
          const modified = fs.readFileSync(tempFile, 'utf-8');
          // Cleanup
          fs.rmSync(tempDir, { recursive: true, force: true });
          return { original, modified };
        } catch {
          // Patch apply failed in temp dir — fallback to showing raw patch
          fs.rmSync(tempDir, { recursive: true, force: true });
          return { original, modified: patch };
        }
      } catch {
        // Can't get HEAD content (shouldn't happen for tracked)
        return undefined;
      }
    }

    return undefined;
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
