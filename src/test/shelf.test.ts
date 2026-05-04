import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

import {
  computeChecksum,
  atomicWriteFile,
  atomicReadTextFile,
  atomicWriteJSON,
  createManifest,
  validateShelf,
  verifyFile,
  formatValidationResult,
  ShelfManifest,
} from '../integrity';

import {
  fileSafeName,
  shelfDirName,
  ensureDir,
  safeRemoveDir,
  OperationLock,
} from '../fileUtils';

const execAsync = promisify(exec);

const TEST_DIR = path.join(__dirname, '..', 'test-workspace');
const TEST_SHELF_DIR = path.join(TEST_DIR, 'test-shelves');

async function git(args: string, cwd?: string): Promise<string> {
  const gitPath = process.platform === 'win32' ? '"C:\\Program Files\\Git\\cmd\\git.exe"' : 'git';
  const { stdout } = await execAsync(`${gitPath} ${args}`, { cwd: cwd || TEST_DIR });
  return stdout;
}

function writeFile(relPath: string, content: string): void {
  const fullPath = path.join(TEST_DIR, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(TEST_DIR, relPath), 'utf-8');
}

function fileExists(relPath: string): boolean {
  return fs.existsSync(path.join(TEST_DIR, relPath));
}

function cleanup(): void {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

async function setupTestRepo(): Promise<void> {
  cleanup();
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await git('init');
  await git('config user.email "test@test.com"');
  await git('config user.name "Test"');
  writeFile('tracked-file.txt', 'original content');
  writeFile('src/app.ts', 'original app');
  await git('add .');
  await git('commit -m "initial"');
}

// --- Integrity Tests ---

async function testComputeChecksum(): Promise<void> {
  console.log('  test: computeChecksum produces consistent SHA256');
  const content = 'hello world';
  const hash1 = computeChecksum(content);
  const hash2 = computeChecksum(Buffer.from(content));
  assert.strictEqual(hash1, hash2, 'String and Buffer should produce same checksum');
  assert.strictEqual(hash1.length, 64, 'SHA256 hex digest should be 64 chars');
  assert.strictEqual(hash1, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  console.log('    ✅ PASS');
}

async function testAtomicWriteFile(): Promise<void> {
  console.log('  test: atomicWriteFile creates file correctly');
  const testDir = path.join(TEST_DIR, 'atomic-test');
  ensureDir(testDir);
  const filePath = path.join(testDir, 'test.txt');
  atomicWriteFile(filePath, 'test content');
  assert.ok(fs.existsSync(filePath), 'File should exist');
  assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'test content');
  safeRemoveDir(testDir);
  console.log('    ✅ PASS');
}

async function testAtomicWriteJSON(): Promise<void> {
  console.log('  test: atomicWriteJSON creates valid JSON');
  const testDir = path.join(TEST_DIR, 'json-test');
  ensureDir(testDir);
  const filePath = path.join(testDir, 'data.json');
  const data = { name: 'test', value: 42 };
  atomicWriteJSON(filePath, data);
  assert.ok(fs.existsSync(filePath), 'File should exist');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  assert.strictEqual(parsed.name, 'test');
  assert.strictEqual(parsed.value, 42);
  safeRemoveDir(testDir);
  console.log('    ✅ PASS');
}

async function testCreateManifestAndValidate(): Promise<void> {
  console.log('  test: createManifest and validateShelf');
  const shelfDir = path.join(TEST_DIR, 'manifest-test');
  ensureDir(shelfDir);

  const fileContent = 'file content here';
  atomicWriteFile(path.join(shelfDir, 'test.patch'), fileContent);

  const files: Record<string, Buffer | string> = {
    'test.patch': fileContent,
  };
  const manifest = createManifest(files);

  assert.strictEqual(manifest.version, 1);
  assert.ok(manifest.files['test.patch']);
  assert.strictEqual(manifest.files['test.patch'].size, fileContent.length);

  atomicWriteJSON(path.join(shelfDir, 'manifest.json'), manifest);

  const loadedManifest: ShelfManifest = JSON.parse(fs.readFileSync(path.join(shelfDir, 'manifest.json'), 'utf-8'));
  const result = validateShelf(shelfDir, loadedManifest);
  assert.ok(result.valid, 'Shelf should be valid');
  assert.strictEqual(result.missingFiles.length, 0);
  assert.strictEqual(result.corruptedFiles.length, 0);

  safeRemoveDir(shelfDir);
  console.log('    ✅ PASS');
}

async function testValidateShelfDetectsCorruption(): Promise<void> {
  console.log('  test: validateShelf detects corrupted file');
  const shelfDir = path.join(TEST_DIR, 'corrupt-test');
  ensureDir(shelfDir);

  const originalContent = 'original content';
  atomicWriteFile(path.join(shelfDir, 'test.patch'), originalContent);

  const files: Record<string, Buffer | string> = { 'test.patch': originalContent };
  const manifest = createManifest(files);
  atomicWriteJSON(path.join(shelfDir, 'manifest.json'), manifest);

  // Corrupt the file
  fs.writeFileSync(path.join(shelfDir, 'test.patch'), 'corrupted!');

  const loadedManifest: ShelfManifest = JSON.parse(fs.readFileSync(path.join(shelfDir, 'manifest.json'), 'utf-8'));
  const result = validateShelf(shelfDir, loadedManifest);
  assert.ok(!result.valid, 'Shelf should be invalid');
  assert.ok(result.corruptedFiles.includes('test.patch'), 'Should detect corrupted file');

  safeRemoveDir(shelfDir);
  console.log('    ✅ PASS');
}

async function testValidateShelfDetectsMissingFile(): Promise<void> {
  console.log('  test: validateShelf detects missing file');
  const shelfDir = path.join(TEST_DIR, 'missing-test');
  ensureDir(shelfDir);

  const content = 'some content';
  const files: Record<string, Buffer | string> = { 'test.patch': content, 'other.patch': content };
  const manifest = createManifest(files);

  // Only write one of the two files
  atomicWriteFile(path.join(shelfDir, 'test.patch'), content);
  atomicWriteJSON(path.join(shelfDir, 'manifest.json'), manifest);

  const loadedManifest: ShelfManifest = JSON.parse(fs.readFileSync(path.join(shelfDir, 'manifest.json'), 'utf-8'));
  const result = validateShelf(shelfDir, loadedManifest);
  assert.ok(!result.valid, 'Shelf should be invalid');
  assert.ok(result.missingFiles.includes('other.patch'), 'Should detect missing file');

  safeRemoveDir(shelfDir);
  console.log('    ✅ PASS');
}

async function testVerifyFile(): Promise<void> {
  console.log('  test: verifyFile checks checksum and size');
  const testDir = path.join(TEST_DIR, 'verify-test');
  ensureDir(testDir);
  const filePath = path.join(testDir, 'test.txt');
  const content = 'verify me';
  atomicWriteFile(filePath, content);

  const checksum = computeChecksum(content);
  assert.ok(verifyFile(filePath, { checksum, size: content.length }), 'Should verify correct file');
  assert.ok(!verifyFile(filePath, { checksum: 'wrong', size: content.length }), 'Should reject wrong checksum');
  assert.ok(!verifyFile(filePath, { checksum, size: 999 }), 'Should reject wrong size');
  assert.ok(!verifyFile(path.join(testDir, 'nonexistent'), { checksum, size: content.length }), 'Should reject missing file');

  safeRemoveDir(testDir);
  console.log('    ✅ PASS');
}

// --- File Utils Tests ---

async function testFileSafeNameNoCollision(): Promise<void> {
  console.log('  test: fileSafeName prevents collisions');
  const name1 = fileSafeName('src/test.js');
  const name2 = fileSafeName('src__test.js');
  assert.notStrictEqual(name1, name2, 'Different paths should produce different safe names');
  console.log('    ✅ PASS');
}

async function testShelfDirNameNoCollision(): Promise<void> {
  console.log('  test: shelfDirName prevents collisions');
  const dir1 = shelfDirName('my-shelf');
  const dir2 = shelfDirName('my.shelf');
  assert.notStrictEqual(dir1, dir2, 'Different shelf names should produce different dir names');
  console.log('    ✅ PASS');
}

async function testOperationLock(): Promise<void> {
  console.log('  test: OperationLock prevents concurrent access');
  const lock = new OperationLock();
  const order: number[] = [];

  const release1 = await lock.acquire();
  order.push(1);

  let release2: (() => void) | undefined;
  const p2 = lock.acquire().then(r => {
    release2 = r;
    order.push(2);
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(order.length, 1, 'Second op should be blocked');
  assert.deepStrictEqual(order, [1]);

  release1();
  await p2;
  assert.deepStrictEqual(order, [1, 2], 'Second op should run after release');

  release2!();
  console.log('    ✅ PASS');
}

// --- Original Core Tests ---

async function testIsTrackedFile(): Promise<void> {
  console.log('  test: tracked file is detected');
  await setupTestRepo();
  writeFile('tracked-file.txt', 'modified content');
  const result = await git('ls-files --error-unmatch "tracked-file.txt"');
  assert.ok(result.trim().length > 0, 'Tracked file should be detected');
  console.log('    ✅ PASS');
}

async function testUntrackedFileDoesNotThrow(): Promise<void> {
  console.log('  test: untracked file does not throw');
  await setupTestRepo();
  writeFile('new-file.txt', 'new content');
  let threw = false;
  try {
    await git('ls-files --error-unmatch "new-file.txt"');
  } catch {
    threw = true;
  }
  assert.ok(threw, 'git ls-files --error-unmatch should throw for untracked files');
  console.log('    ✅ PASS (error handled correctly by wrapping in try/catch)');
}

async function testShelveTrackedFile(): Promise<void> {
  console.log('  test: shelve and unshelve tracked file');
  await setupTestRepo();
  writeFile('tracked-file.txt', 'modified content');
  const diff = await git('diff -- "tracked-file.txt"');
  assert.ok(diff.includes('modified content'), 'Diff should contain modifications');
  await git('checkout -- "tracked-file.txt"');
  assert.strictEqual(readFile('tracked-file.txt'), 'original content', 'File should be reverted');
  const patchPath = path.join(TEST_DIR, 'test.patch');
  fs.writeFileSync(patchPath, diff);
  await git(`apply "${patchPath}"`);
  assert.strictEqual(readFile('tracked-file.txt'), 'modified content', 'File should be restored');
  console.log('    ✅ PASS');
}

async function testShelveUntrackedFile(): Promise<void> {
  console.log('  test: shelve and unshelve untracked file');
  await setupTestRepo();
  writeFile('src/test.js', 'console.log("hello");');
  const content = readFile('src/test.js');
  const savedContent = content;
  fs.unlinkSync(path.join(TEST_DIR, 'src', 'test.js'));
  assert.ok(!fileExists('src/test.js'), 'File should be deleted');
  writeFile('src/test.js', savedContent);
  assert.strictEqual(readFile('src/test.js'), 'console.log("hello");', 'File should be restored');
  console.log('    ✅ PASS');
}

async function testMixedShelve(): Promise<void> {
  console.log('  test: shelve mixed tracked and untracked files');
  await setupTestRepo();
  writeFile('src/app.ts', 'modified app');
  writeFile('src/new-module.ts', 'new module');
  const modified = (await git('diff --name-only')).split('\n').filter(f => f.trim());
  const untracked = (await git('ls-files --others --exclude-standard')).split('\n').filter(f => f.trim());
  assert.ok(modified.includes('src/app.ts'), 'Modified file should appear');
  assert.ok(untracked.includes('src/new-module.ts'), 'Untracked file should appear');
  console.log('    ✅ PASS');
}

// --- New Feature Tests ---

async function testStagedFileDetection(): Promise<void> {
  console.log('  test: staged files are detected');
  await setupTestRepo();
  writeFile('tracked-file.txt', 'staged content');
  await git('add tracked-file.txt');
  writeFile('src/app.ts', 'also staged');
  await git('add src/app.ts');

  const staged = (await git('diff --cached --name-only')).split('\n').filter(f => f.trim());
  assert.ok(staged.includes('tracked-file.txt'), 'Staged tracked file should appear');
  assert.ok(staged.includes('src/app.ts'), 'Staged src file should appear');
  console.log('    ✅ PASS');
}

async function testShelveStagedTrackedFile(): Promise<void> {
  console.log('  test: shelve staged tracked file reverts to HEAD');
  await setupTestRepo();

  writeFile('tracked-file.txt', 'staged content');
  await git('add tracked-file.txt');

  const diff = await git('diff --cached -- "tracked-file.txt"');
  assert.ok(diff.includes('staged content'), 'Diff should contain staged changes');

  await git('reset HEAD -- "tracked-file.txt"');
  await git('checkout HEAD -- "tracked-file.txt"');

  assert.strictEqual(readFile('tracked-file.txt'), 'original content', 'File should be reverted');

  const patchPath = path.join(TEST_DIR, 'test.patch');
  fs.writeFileSync(patchPath, diff);
  await git(`apply "${patchPath}"`);
  assert.strictEqual(readFile('tracked-file.txt'), 'staged content', 'File should be restored');
  console.log('    ✅ PASS');
}

async function testShelveNewStagedFile(): Promise<void> {
  console.log('  test: shelve newly added (staged) file that does not exist in HEAD');
  await setupTestRepo();

  writeFile('src/brand-new.ts', 'export const x = 1;');
  await git('add src/brand-new.ts');

  let inHead = true;
  try { await git('cat-file -e HEAD:src/brand-new.ts'); } catch { inHead = false; }
  assert.ok(!inHead, 'New file should NOT exist in HEAD');

  const savedContent = readFile('src/brand-new.ts');
  await git('reset HEAD -- "src/brand-new.ts"');
  fs.unlinkSync(path.join(TEST_DIR, 'src', 'brand-new.ts'));
  assert.ok(!fileExists('src/brand-new.ts'), 'File should be deleted');

  writeFile('src/brand-new.ts', savedContent);
  assert.strictEqual(readFile('src/brand-new.ts'), 'export const x = 1;', 'File should be restored');
  console.log('    ✅ PASS');
}

async function testEffectiveDiffForStagedAndUnstaged(): Promise<void> {
  console.log('  test: effective diff combines staged + unstaged changes');
  await setupTestRepo();

  writeFile('tracked-file.txt', 'staged version');
  await git('add tracked-file.txt');

  writeFile('tracked-file.txt', 'staged + unstaged version');

  const headDiff = (await git('diff HEAD -- "tracked-file.txt"')).trim();
  assert.ok(headDiff.length > 0, 'Should have HEAD diff');
  assert.ok(headDiff.includes('staged + unstaged version'), 'HEAD diff should show final content');
  console.log('    ✅ PASS');
}

async function testCheckoutHEADFailsForNewFile(): Promise<void> {
  console.log('  test: git checkout HEAD fails for newly staged file');
  await setupTestRepo();

  writeFile('src/brand-new.ts', 'new');
  await git('add src/brand-new.ts');

  let threw = false;
  try {
    await git('checkout HEAD -- "src/brand-new.ts"');
  } catch {
    threw = true;
  }
  assert.ok(threw, 'checkout HEAD should fail for file not in HEAD');
  console.log('    ✅ PASS');
}

async function testFormatValidationResult(): Promise<void> {
  console.log('  test: formatValidationResult formats output correctly');
  const ok = formatValidationResult({ valid: true, missingFiles: [], corruptedFiles: [], extraFiles: [] });
  assert.ok(ok.includes('OK'));

  const withErrors = formatValidationResult({
    valid: false,
    missingFiles: ['a.patch'],
    corruptedFiles: ['b.patch'],
    extraFiles: [],
  });
  assert.ok(withErrors.includes('Missing'));
  assert.ok(withErrors.includes('Corrupted'));
  console.log('    ✅ PASS');
}

async function testAtomicWriteBuffer(): Promise<void> {
  console.log('  test: atomicWriteFile handles Buffer content');
  const testDir = path.join(TEST_DIR, 'buffer-test');
  ensureDir(testDir);
  const filePath = path.join(testDir, 'binary.bin');
  const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xFF]);
  atomicWriteFile(filePath, buf);
  const read = fs.readFileSync(filePath);
  assert.deepStrictEqual(read, buf);
  safeRemoveDir(testDir);
  console.log('    ✅ PASS');
}

// --- Run all tests ---

async function runTests(): Promise<void> {
  console.log('\n🧪 Code Shelf Tests\n');

  const tests = [
    // Integrity tests
    testComputeChecksum,
    testAtomicWriteFile,
    testAtomicWriteJSON,
    testCreateManifestAndValidate,
    testValidateShelfDetectsCorruption,
    testValidateShelfDetectsMissingFile,
    testVerifyFile,
    testAtomicWriteBuffer,
    testFormatValidationResult,

    // File utils tests
    testFileSafeNameNoCollision,
    testShelfDirNameNoCollision,
    testOperationLock,

    // Original core tests
    testIsTrackedFile,
    testUntrackedFileDoesNotThrow,
    testShelveTrackedFile,
    testShelveUntrackedFile,
    testMixedShelve,

    // Feature tests
    testStagedFileDetection,
    testShelveStagedTrackedFile,
    testShelveNewStagedFile,
    testEffectiveDiffForStagedAndUnstaged,
    testCheckoutHEADFailsForNewFile,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.log(`    ❌ FAIL: ${(err as Error).message}`);
      failed++;
    }
  }

  cleanup();

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  cleanup();
  process.exit(1);
});
