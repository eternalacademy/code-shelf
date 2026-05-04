import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
  '.class', '.jar', '.war', '.pyc', '.o', '.obj',
  '.sqlite', '.db', '.iso', '.dmg',
]);

export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      const slice = buf.subarray(0, bytesRead);

      for (let i = 0; i < slice.length; i++) {
        const byte = slice[i];
        if (byte === 0) {
          return true;
        }
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function safeReadFileBuffer(filePath: string): Buffer {
  return fs.readFileSync(filePath);
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function safeRemoveDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function fileSafeName(filePath: string): string {
  const hash = crypto.createHash('sha1').update(filePath).digest('hex').substring(0, 12);
  const safe = filePath.replace(/[\\/]/g, '__').replace(/[^a-zA-Z0-9_.\-]/g, '_');
  return `${safe}__${hash}`;
}

export function shelfDirName(name: string): string {
  const hash = crypto.createHash('sha1').update(name).digest('hex').substring(0, 12);
  const safe = name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return `${safe}__${hash}`;
}

export class OperationLock {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve(() => this.release());
      } else {
        this.queue.push(() => {
          this.locked = true;
          resolve(() => this.release());
        });
      }
    });
  }

  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}
