import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  atomicWriteFile,
  atomicWriteJSON,
  atomicReadFile,
  atomicReadTextFile,
  computeChecksum,
  createManifest,
  validateShelf,
  formatValidationResult,
  ShelfManifest,
  ValidationResult,
} from './integrity';
import {
  fileSafeName,
  shelfDirName,
  ensureDir,
  safeRemoveDir,
  safeReadFileBuffer,
  OperationLock,
} from './fileUtils';

const execAsync = promisify(exec);

const GIT_TIMEOUT_MS = 30_000;

export interface ShelfMeta {
  name: string;
  timestamp: number;
  files: string[];
  description?: string;
  type?: 'changes' | 'staged' | 'silent';
}

export interface UnshelveResult {
  success: boolean;
  restoredFiles: string[];
  failedFiles: Array<{ file: string; error: string }>;
  skippedFiles: string[];
  integrityWarning?: string;
}

export class ShelfManager {
  private shelfDir: string;
  private root: string;
  private lock = new OperationLock();

  constructor(context: vscode.ExtensionContext) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      throw new Error('No workspace folder found');
    }
    this.root = root;

    const storageUri = context.storageUri;
    if (!storageUri) {
      throw new Error('Workspace storage not available');
    }
    const storageDir = path.join(storageUri.fsPath, 'code-shelf');
    this.shelfDir = storageDir;
    ensureDir(this.shelfDir);
  }

  private async git(args: string): Promise<string> {
    const { stdout } = await execAsync(`git ${args}`, {
      cwd: this.root,
      maxBuffer: 50 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout;
  }

  private async isInIndex(file: string): Promise<boolean> {
    try {
      const result = await this.git(`ls-files --error-unmatch "${file}"`);
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async existsInHead(file: string): Promise<boolean> {
    try {
      await this.git(`cat-file -e HEAD:"${file}"`);
      return true;
    } catch {
      return false;
    }
  }

  async getModifiedFiles(): Promise<string[]> {
    const tracked = (await this.git('diff --name-only')).split('\n').filter(f => f.trim());
    const staged = (await this.git('diff --cached --name-only')).split('\n').filter(f => f.trim());
    const untracked = (await this.git('ls-files --others --exclude-standard')).split('\n').filter(f => f.trim());
    return [...new Set([...tracked, ...staged, ...untracked])];
  }

  async getStagedFiles(): Promise<string[]> {
    return (await this.git('diff --cached --name-only')).split('\n').filter(f => f.trim());
  }

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

  private resolveShelfPath(name: string): string {
    return path.join(this.shelfDir, shelfDirName(name));
  }

  private findShelfPathByName(name: string): string | undefined {
    const canonical = this.resolveShelfPath(name);
    if (fs.existsSync(canonical)) {
      return canonical;
    }

    if (!fs.existsSync(this.shelfDir)) {
      return undefined;
    }

    for (const dir of fs.readdirSync(this.shelfDir)) {
      const metaPath = path.join(this.shelfDir, dir, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta: ShelfMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (meta.name === name) {
            return path.join(this.shelfDir, dir);
          }
        } catch {
          // skip
        }
      }
    }
    return undefined;
  }

  async shelve(files: string[], name: string, description?: string, type: 'changes' | 'staged' | 'silent' = 'changes'): Promise<boolean> {
    const release = await this.lock.acquire();
    try {
      const finalDir = this.resolveShelfPath(name);
      if (fs.existsSync(finalDir)) {
        throw new Error(`A shelf named "${name}" already exists. Please use a different name.`);
      }

      const pendingDir = finalDir + '.pending.' + Date.now();
      ensureDir(pendingDir);

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

      const modifiedTracked: string[] = [];
      const deletedTracked: string[] = [];
      for (const file of committedModified) {
        if (fs.existsSync(path.join(this.root, file))) {
          modifiedTracked.push(file);
        } else {
          deletedTracked.push(file);
        }
      }

      const savedFiles: Record<string, Buffer | string> = {};

      for (const file of modifiedTracked) {
        const sn = fileSafeName(file);
        let diff: string;
        if (type === 'staged') {
          diff = (await this.git(`diff --cached -- "${file}"`)).trim();
        } else {
          diff = await this.getEffectiveDiff(file);
        }
        if (diff) {
          const patchFileName = `${sn}.patch`;
          atomicWriteFile(path.join(pendingDir, patchFileName), diff);
          savedFiles[patchFileName] = diff;
        }
      }

      for (const file of deletedTracked) {
        const sn = fileSafeName(file);
        const headContent = await this.git(`show HEAD:"${file}"`);
        const headFileName = `${sn}.head`;
        const markerFileName = `${sn}.deleted`;
        atomicWriteFile(path.join(pendingDir, headFileName), headContent);
        atomicWriteFile(path.join(pendingDir, markerFileName), file);
        savedFiles[headFileName] = headContent;
        savedFiles[markerFileName] = file;
      }

      for (const file of [...addedToIndex, ...untracked]) {
        const sn = fileSafeName(file);
        const fullPath = path.join(this.root, file);
        if (fs.existsSync(fullPath)) {
          const content = safeReadFileBuffer(fullPath);
          const fullFileName = `${sn}.full`;
          const markerFileName = `${sn}.new`;
          atomicWriteFile(path.join(pendingDir, fullFileName), content);
          atomicWriteFile(path.join(pendingDir, markerFileName), file);
          savedFiles[fullFileName] = content;
          savedFiles[markerFileName] = file;
        }
      }

      const manifest = createManifest(savedFiles);
      atomicWriteJSON(path.join(pendingDir, 'manifest.json'), manifest);

      const postManifest = JSON.parse(fs.readFileSync(path.join(pendingDir, 'manifest.json'), 'utf-8')) as ShelfManifest;
      const validation = validateShelf(pendingDir, postManifest);
      if (!validation.valid) {
        safeRemoveDir(pendingDir);
        throw new Error(`Integrity check failed after saving shelf. No data was lost.\n${formatValidationResult(validation)}`);
      }

      const meta: ShelfMeta = { name, timestamp: Date.now(), files, description, type };
      atomicWriteJSON(path.join(pendingDir, 'metadata.json'), meta);

      try {
        fs.renameSync(pendingDir, finalDir);
      } catch (renameErr) {
        if (!fs.existsSync(finalDir)) {
          try {
            fs.cpSync(pendingDir, finalDir, { recursive: true });
            safeRemoveDir(pendingDir);
          } catch (cpErr) {
            safeRemoveDir(pendingDir);
            throw new Error(`Failed to finalize shelf: ${(renameErr as Error).message}. Your working tree was not modified.`);
          }
        }
      }

      await this.revertWorkingTree(modifiedTracked, deletedTracked, addedToIndex, untracked);

      return true;
    } catch (error) {
      const msg = (error as Error).message;
      vscode.window.showErrorMessage(`Failed to shelve: ${msg}`);
      return false;
    } finally {
      release();
    }
  }

  private async revertWorkingTree(
    modifiedTracked: string[],
    deletedTracked: string[],
    addedToIndex: string[],
    untracked: string[],
  ): Promise<void> {
    const revertErrors: string[] = [];

    if (modifiedTracked.length > 0) {
      try {
        const fileArgs = modifiedTracked.map(f => `"${f}"`).join(' ');
        await this.git(`reset HEAD -- ${fileArgs}`);
        await this.git(`checkout HEAD -- ${fileArgs}`);
      } catch (err) {
        revertErrors.push(`Modified files revert failed: ${(err as Error).message}`);
      }
    }

    if (deletedTracked.length > 0) {
      try {
        const fileArgs = deletedTracked.map(f => `"${f}"`).join(' ');
        await this.git(`reset HEAD -- ${fileArgs}`);
        await this.git(`checkout HEAD -- ${fileArgs}`);
      } catch (err) {
        revertErrors.push(`Deleted files revert failed: ${(err as Error).message}`);
      }
    }

    if (addedToIndex.length > 0) {
      try {
        const fileArgs = addedToIndex.map(f => `"${f}"`).join(' ');
        await this.git(`reset HEAD -- ${fileArgs}`);
      } catch (err) {
        revertErrors.push(`Added-to-index reset failed: ${(err as Error).message}`);
      }
      for (const file of addedToIndex) {
        try {
          const fullPath = path.join(this.root, file);
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
          }
        } catch (err) {
          revertErrors.push(`Failed to delete added file ${file}: ${(err as Error).message}`);
        }
      }
    }

    for (const file of untracked) {
      try {
        const fullPath = path.join(this.root, file);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      } catch (err) {
        revertErrors.push(`Failed to delete untracked file ${file}: ${(err as Error).message}`);
      }
    }

    if (revertErrors.length > 0) {
      vscode.window.showWarningMessage(
        `Shelf saved successfully, but some files could not be reverted:\n${revertErrors.join('\n')}\n\nYour changes are safely stored in the shelf.`
      );
    }
  }

  private validateShelfIntegrity(shelfPath: string): { valid: boolean; warning?: string; manifest?: ShelfManifest } {
    const manifestPath = path.join(shelfPath, 'manifest.json');
    const metaPath = path.join(shelfPath, 'metadata.json');

    if (!fs.existsSync(metaPath)) {
      return { valid: false, warning: 'Shelf metadata is missing. The shelf may be corrupted.' };
    }

    try {
      JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      return { valid: false, warning: 'Shelf metadata is corrupted (invalid JSON).' };
    }

    if (!fs.existsSync(manifestPath)) {
      return {
        valid: true,
        warning: 'This shelf was created with an older version and has no integrity manifest. Files will be restored but cannot be verified.',
      };
    }

    try {
      const manifest: ShelfManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const result = validateShelf(shelfPath, manifest);
      if (!result.valid) {
        return {
          valid: false,
          warning: `Integrity check failed:\n${formatValidationResult(result)}`,
          manifest,
        };
      }
      return { valid: true, manifest };
    } catch {
      return { valid: false, warning: 'Shelf manifest is corrupted (invalid JSON).' };
    }
  }

  async isFileDirty(file: string): Promise<boolean> {
    try {
      const inIndex = await this.isInIndex(file);
      if (!inIndex) {
        return fs.existsSync(path.join(this.root, file));
      }
      const diff = await this.git(`diff HEAD -- "${file}"`);
      return diff.trim().length > 0;
    } catch {
      return fs.existsSync(path.join(this.root, file));
    }
  }

  async unshelve(name: string): Promise<boolean> {
    const release = await this.lock.acquire();
    try {
      const result = await this.unshelveInternal(name);
      if (!result.success) {
        const details: string[] = [];
        if (result.failedFiles.length > 0) {
          details.push(`Failed: ${result.failedFiles.map(f => `${f.file} (${f.error})`).join(', ')}`);
        }
        if (result.integrityWarning) {
          details.push(result.integrityWarning);
        }
        vscode.window.showErrorMessage(`Unshelve completed with issues:\n${details.join('\n')}`);
        return result.restoredFiles.length > 0;
      }
      return true;
    } finally {
      release();
    }
  }

  private async unshelveInternal(name: string): Promise<UnshelveResult> {
    const result: UnshelveResult = {
      success: true,
      restoredFiles: [],
      failedFiles: [],
      skippedFiles: [],
    };

    const shelfPath = this.findShelfPathByName(name);
    if (!shelfPath) {
      result.success = false;
      result.failedFiles.push({ file: '(shelf)', error: `Shelf "${name}" not found` });
      return result;
    }

    const integrity = this.validateShelfIntegrity(shelfPath);
    if (!integrity.valid) {
      result.success = false;
      result.integrityWarning = integrity.warning;
      return result;
    }
    if (integrity.warning) {
      result.integrityWarning = integrity.warning;
    }

    let meta: ShelfMeta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(shelfPath, 'metadata.json'), 'utf-8'));
    } catch {
      result.success = false;
      result.failedFiles.push({ file: '(metadata)', error: 'Corrupted metadata' });
      return result;
    }

    const dirtyFiles: string[] = [];
    for (const file of meta.files) {
      try {
        if (await this.isFileDirty(file)) {
          dirtyFiles.push(file);
        }
      } catch {
        // If we can't check, be cautious and include it
        dirtyFiles.push(file);
      }
    }

    if (dirtyFiles.length > 0) {
      const proceed = await vscode.window.showWarningMessage(
        `The following files have local changes that will be overwritten:\n\n${dirtyFiles.join('\n')}\n\nProceed with unshelve?`,
        { modal: true },
        'Overwrite',
        'Cancel'
      );
      if (proceed !== 'Overwrite') {
        result.skippedFiles = meta.files;
        result.success = false;
        return result;
      }
    }

    for (const file of meta.files) {
      try {
        const restored = await this.unshelveSingleFile(shelfPath, name, file);
        if (restored) {
          result.restoredFiles.push(file);
        } else {
          result.skippedFiles.push(file);
        }
      } catch (err) {
        result.failedFiles.push({ file, error: (err as Error).message });
        result.success = false;
      }
    }

    return result;
  }

  async unshelveFile(shelfName: string, file: string): Promise<boolean> {
    const release = await this.lock.acquire();
    try {
      const shelfPath = this.findShelfPathByName(shelfName);
      if (!shelfPath) {
        vscode.window.showErrorMessage(`Shelf "${shelfName}" not found`);
        return false;
      }

      const integrity = this.validateShelfIntegrity(shelfPath);
      if (!integrity.valid) {
        vscode.window.showErrorMessage(`Cannot unshelve — integrity check failed:\n${integrity.warning}`);
        return false;
      }

      try {
        if (await this.isFileDirty(file)) {
          const proceed = await vscode.window.showWarningMessage(
            `"${file}" has local changes that will be overwritten. Proceed?`,
            { modal: true },
            'Overwrite',
            'Cancel'
          );
          if (proceed !== 'Overwrite') {
            return false;
          }
        }
      } catch {
        // If we can't check, proceed anyway
      }

      return await this.unshelveSingleFile(shelfPath, shelfName, file);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to unshelve file: ${(error as Error).message}`);
      return false;
    } finally {
      release();
    }
  }

  private async unshelveSingleFile(shelfPath: string, shelfName: string, file: string): Promise<boolean> {
    const sn = fileSafeName(file);

    const newMarker = path.join(shelfPath, `${sn}.new`);
    if (fs.existsSync(newMarker)) {
      const fullFile = path.join(shelfPath, `${sn}.full`);
      if (fs.existsSync(fullFile)) {
        const content = safeReadFileBuffer(fullFile);
        const targetPath = path.join(this.root, file);
        ensureDir(path.dirname(targetPath));
        atomicWriteFile(targetPath, content);
      }
      return true;
    }

    const deletedMarker = path.join(shelfPath, `${sn}.deleted`);
    if (fs.existsSync(deletedMarker)) {
      const fullPath = path.join(this.root, file);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
      return true;
    }

    const patchFile = path.join(shelfPath, `${sn}.patch`);
    if (fs.existsSync(patchFile)) {
      const fullPath = path.join(this.root, file);
      if (!fs.existsSync(fullPath)) {
        try {
          await this.git(`checkout HEAD -- "${file}"`);
        } catch {
          ensureDir(path.dirname(fullPath));
          atomicWriteFile(fullPath, '');
        }
      }
      await this.git(`apply --3way "${patchFile}"`);
      return true;
    }

    return false;
  }

  async renameShelf(oldName: string, newName: string): Promise<boolean> {
    const release = await this.lock.acquire();
    try {
      const oldPath = this.findShelfPathByName(oldName);
      if (!oldPath) throw new Error(`Shelf "${oldName}" not found`);

      const newPath = this.resolveShelfPath(newName);
      if (fs.existsSync(newPath)) throw new Error(`Shelf "${newName}" already exists`);

      const metaPath = path.join(oldPath, 'metadata.json');
      const meta: ShelfMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      meta.name = newName;
      atomicWriteJSON(metaPath, meta);

      const manifestPath = path.join(oldPath, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath);
      }

      fs.renameSync(oldPath, newPath);
      return true;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to rename: ${(error as Error).message}`);
      return false;
    } finally {
      release();
    }
  }

  async getShelves(): Promise<ShelfMeta[]> {
    if (!fs.existsSync(this.shelfDir)) return [];

    const shelves: ShelfMeta[] = [];
    for (const name of fs.readdirSync(this.shelfDir)) {
      const dirPath = path.join(this.shelfDir, name);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      if (name.endsWith('.pending') || name.includes('.pending.')) continue;

      const metaPath = path.join(dirPath, 'metadata.json');
      if (fs.existsSync(metaPath)) {
        try {
          shelves.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
        } catch {
          // skip corrupted
        }
      }
    }
    return shelves.sort((a, b) => b.timestamp - a.timestamp);
  }

  async deleteShelf(name: string): Promise<boolean> {
    const release = await this.lock.acquire();
    try {
      const shelfPath = this.findShelfPathByName(name);
      if (shelfPath && fs.existsSync(shelfPath)) {
        safeRemoveDir(shelfPath);
        return true;
      }
      return false;
    } finally {
      release();
    }
  }

  getShelfDiff(shelfName: string, file?: string): string {
    const shelfPath = this.findShelfPathByName(shelfName);
    if (!shelfPath || !fs.existsSync(shelfPath)) return '';

    if (file) {
      const sn = fileSafeName(file);
      const patchFile = path.join(shelfPath, `${sn}.patch`);
      if (fs.existsSync(patchFile)) {
        try { return fs.readFileSync(patchFile, 'utf-8'); } catch { return ''; }
      }
      const fullFile = path.join(shelfPath, `${sn}.full`);
      if (fs.existsSync(fullFile)) {
        try {
          return `--- /dev/null\n+++ b/${file}\n${fs.readFileSync(fullFile, 'utf-8')}`;
        } catch { return ''; }
      }
      const headFile = path.join(shelfPath, `${sn}.head`);
      if (fs.existsSync(headFile)) {
        try {
          return `--- a/${file}\n+++ /dev/null\n${fs.readFileSync(headFile, 'utf-8').split('\n').map(l => '-' + l).join('\n')}`;
        } catch { return ''; }
      }
      return '';
    }

    let combined = '';
    try {
      for (const f of fs.readdirSync(shelfPath)) {
        if (f.endsWith('.patch')) {
          try {
            combined += fs.readFileSync(path.join(shelfPath, f), 'utf-8') + '\n';
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* shelf dir read error */ }
    return combined;
  }

  getPatchPath(shelfName: string, file: string): string | undefined {
    const shelfPath = this.findShelfPathByName(shelfName);
    if (!shelfPath) return undefined;
    const sn = fileSafeName(file);
    const p = path.join(shelfPath, `${sn}.patch`);
    return fs.existsSync(p) ? p : undefined;
  }

  async getDiffContents(shelfName: string, file: string): Promise<{ original: string; modified: string } | undefined> {
    const shelfPath = this.findShelfPathByName(shelfName);
    if (!shelfPath || !fs.existsSync(shelfPath)) return undefined;
    const sn = fileSafeName(file);

    const fullFile = path.join(shelfPath, `${sn}.full`);
    const newMarker = path.join(shelfPath, `${sn}.new`);
    if (fs.existsSync(fullFile) && fs.existsSync(newMarker)) {
      try {
        return { original: '', modified: fs.readFileSync(fullFile, 'utf-8') };
      } catch { return undefined; }
    }

    const headFile = path.join(shelfPath, `${sn}.head`);
    const deletedMarker = path.join(shelfPath, `${sn}.deleted`);
    if (fs.existsSync(headFile) && fs.existsSync(deletedMarker)) {
      try {
        return { original: fs.readFileSync(headFile, 'utf-8'), modified: '' };
      } catch { return undefined; }
    }

    const patchFile = path.join(shelfPath, `${sn}.patch`);
    if (fs.existsSync(patchFile)) {
      try {
        const original = await this.git(`show HEAD:"${file}"`);
        const patch = fs.readFileSync(patchFile, 'utf-8');
        const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const tempDir = path.join(this.shelfDir, `__diff_${uniqueId}__`);
        ensureDir(tempDir);

        try {
          const tempFile = path.join(tempDir, path.basename(file));
          fs.writeFileSync(tempFile, original);
          await execAsync(`git apply "${patchFile}"`, { cwd: tempDir, timeout: GIT_TIMEOUT_MS });
          const modified = fs.readFileSync(tempFile, 'utf-8');
          return { original, modified };
        } catch {
          return { original, modified: patch };
        } finally {
          safeRemoveDir(tempDir);
        }
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  getShelfFilePath(shelfName: string, file: string): string | undefined {
    const shelfPath = this.findShelfPathByName(shelfName);
    if (!shelfPath) return undefined;
    const sn = fileSafeName(file);
    const full = path.join(shelfPath, `${sn}.full`);
    return fs.existsSync(full) ? full : undefined;
  }

  async validateShelfByName(name: string): Promise<ValidationResult | null> {
    const shelfPath = this.findShelfPathByName(name);
    if (!shelfPath) return null;

    const manifestPath = path.join(shelfPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return {
        valid: false,
        missingFiles: [],
        corruptedFiles: [],
        extraFiles: [],
      };
    }

    try {
      const manifest: ShelfManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      return validateShelf(shelfPath, manifest);
    } catch {
      return {
        valid: false,
        missingFiles: [],
        corruptedFiles: [],
        extraFiles: [],
      };
    }
  }

  async repairPendingShelves(): Promise<string[]> {
    const repaired: string[] = [];
    if (!fs.existsSync(this.shelfDir)) return repaired;

    for (const name of fs.readdirSync(this.shelfDir)) {
      const dirPath = path.join(this.shelfDir, name);
      if (!fs.statSync(dirPath).isDirectory()) continue;

      if (name.includes('.pending.')) {
        safeRemoveDir(dirPath);
        repaired.push(`Cleaned up pending directory: ${name}`);
      }
    }

    return repaired;
  }

  async getShelfStoragePath(): Promise<string> {
    return this.shelfDir;
  }
}
