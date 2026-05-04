import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface FileEntry {
  checksum: string;
  size: number;
}

export interface ShelfManifest {
  version: number;
  files: Record<string, FileEntry>;
  createdAt: string;
}

export interface ValidationResult {
  valid: boolean;
  missingFiles: string[];
  corruptedFiles: string[];
  extraFiles: string[];
}

export function computeChecksum(content: Buffer | string): string {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function atomicWriteFile(filePath: string, content: Buffer | string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = filePath + '.tmp.' + process.pid + '.' + Date.now();

  try {
    if (typeof content === 'string') {
      fs.writeFileSync(tmpPath, content, 'utf-8');
    } else {
      fs.writeFileSync(tmpPath, content);
    }

    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

export function atomicReadFile(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

export function atomicReadTextFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function atomicWriteJSON(filePath: string, data: unknown): void {
  const content = JSON.stringify(data, null, 2);
  atomicWriteFile(filePath, content);
}

export function createManifest(files: Record<string, Buffer | string>): ShelfManifest {
  const entries: Record<string, FileEntry> = {};

  for (const [name, content] of Object.entries(files)) {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    entries[name] = {
      checksum: computeChecksum(buf),
      size: buf.length,
    };
  }

  return {
    version: 1,
    files: entries,
    createdAt: new Date().toISOString(),
  };
}

export function verifyFile(filePath: string, expected: FileEntry): boolean {
  try {
    if (!fs.existsSync(filePath)) {
      return false;
    }
    const stat = fs.statSync(filePath);
    if (stat.size !== expected.size) {
      return false;
    }
    const content = fs.readFileSync(filePath);
    const actual = computeChecksum(content);
    return actual === expected.checksum;
  } catch {
    return false;
  }
}

export function validateShelf(shelfPath: string, manifest: ShelfManifest): ValidationResult {
  const result: ValidationResult = {
    valid: true,
    missingFiles: [],
    corruptedFiles: [],
    extraFiles: [],
  };

  for (const [fileName, entry] of Object.entries(manifest.files)) {
    const fullPath = path.join(shelfPath, fileName);
    if (!fs.existsSync(fullPath)) {
      result.missingFiles.push(fileName);
      result.valid = false;
    } else if (!verifyFile(fullPath, entry)) {
      result.corruptedFiles.push(fileName);
      result.valid = false;
    }
  }

  const expectedFiles = new Set(Object.keys(manifest.files));
  expectedFiles.add('manifest.json');
  expectedFiles.add('metadata.json');

  try {
    for (const f of fs.readdirSync(shelfPath)) {
      if (!expectedFiles.has(f)) {
        result.extraFiles.push(f);
      }
    }
  } catch {
    result.valid = false;
  }

  return result;
}

export function formatValidationResult(result: ValidationResult): string {
  const parts: string[] = [];
  if (result.missingFiles.length > 0) {
    parts.push(`Missing files: ${result.missingFiles.join(', ')}`);
  }
  if (result.corruptedFiles.length > 0) {
    parts.push(`Corrupted files (checksum mismatch): ${result.corruptedFiles.join(', ')}`);
  }
  if (result.extraFiles.length > 0) {
    parts.push(`Unexpected files: ${result.extraFiles.join(', ')}`);
  }
  return parts.length > 0 ? parts.join('\n') : 'All files verified OK';
}
