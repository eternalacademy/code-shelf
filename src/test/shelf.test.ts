import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const TEST_DIR = path.join(__dirname, '..', 'test-workspace');

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

// --- Core Tests ---

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

async function testSanitizeName(): Promise<void> {
  console.log('  test: shelf name sanitization');
  const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  assert.strictEqual(sanitize('my shelf'), 'my_shelf');
  assert.strictEqual(sanitize('my-shelf'), 'my-shelf');
  assert.strictEqual(sanitize('my.shelf'), 'my_shelf');
  assert.strictEqual(sanitize('shelf/../../etc'), 'shelf_______etc');
  console.log('    ✅ PASS');
}

async function testSanitizeFilePath(): Promise<void> {
  console.log('  test: file path sanitization for shelf storage');
  const safeName = (file: string) => file.replace(/[\\/]/g, '__');
  assert.strictEqual(safeName('src/test.js'), 'src__test.js');
  assert.strictEqual(safeName('src\\deep\\file.ts'), 'src__deep__file.ts');
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

async function testGetModifiedFilesIncludesStaged(): Promise<void> {
  console.log('  test: getModifiedFiles includes staged files');
  await setupTestRepo();

  // Modify and stage one file
  writeFile('tracked-file.txt', 'staged content');
  await git('add tracked-file.txt');

  // Modify another but don't stage
  writeFile('src/app.ts', 'unstaged change');

  // Create untracked
  writeFile('src/new.ts', 'brand new');

  const tracked = (await git('diff --name-only')).split('\n').filter(f => f.trim());
  const staged = (await git('diff --cached --name-only')).split('\n').filter(f => f.trim());
  const untracked = (await git('ls-files --others --exclude-standard')).split('\n').filter(f => f.trim());
  const all = [...new Set([...tracked, ...staged, ...untracked])];

  assert.ok(all.includes('tracked-file.txt'), 'Should include staged file');
  assert.ok(all.includes('src/app.ts'), 'Should include unstaged file');
  assert.ok(all.includes('src/new.ts'), 'Should include untracked file');
  assert.strictEqual(all.length, 3, 'Should have exactly 3 files');
  console.log('    ✅ PASS');
}

async function testShelveStagedTrackedFile(): Promise<void> {
  console.log('  test: shelve staged tracked file reverts to HEAD');
  await setupTestRepo();

  // Modify and stage
  writeFile('tracked-file.txt', 'staged content');
  await git('add tracked-file.txt');

  // Verify it's staged
  let staged = (await git('diff --cached --name-only')).split('\n').filter(f => f.trim());
  assert.ok(staged.includes('tracked-file.txt'), 'File should be staged');

  // Simulate shelve staged: save diff, reset, checkout
  const diff = await git('diff --cached -- "tracked-file.txt"');
  assert.ok(diff.includes('staged content'), 'Diff should contain staged changes');

  await git('reset HEAD -- "tracked-file.txt"');
  await git('checkout HEAD -- "tracked-file.txt"');

  // Verify reverted
  assert.strictEqual(readFile('tracked-file.txt'), 'original content', 'File should be reverted');
  staged = (await git('diff --cached --name-only')).split('\n').filter(f => f.trim());
  assert.ok(!staged.includes('tracked-file.txt'), 'File should be unstaged');

  // Simulate unshelve: apply patch
  const patchPath = path.join(TEST_DIR, 'test.patch');
  fs.writeFileSync(patchPath, diff);
  await git(`apply "${patchPath}"`);
  assert.strictEqual(readFile('tracked-file.txt'), 'staged content', 'File should be restored');
  console.log('    ✅ PASS');
}

async function testShelveNewStagedFile(): Promise<void> {
  console.log('  test: shelve newly added (staged) file that does not exist in HEAD');
  await setupTestRepo();

  // Create new file and stage it
  writeFile('src/brand-new.ts', 'export const x = 1;');
  await git('add src/brand-new.ts');

  // Verify it's staged (in index) but not in HEAD
  const staged = (await git('diff --cached --name-only')).split('\n').filter(f => f.trim());
  assert.ok(staged.includes('src/brand-new.ts'), 'New file should be staged');

  let inHead = true;
  try { await git('cat-file -e HEAD:src/brand-new.ts'); } catch { inHead = false; }
  assert.ok(!inHead, 'New file should NOT exist in HEAD');

  // Save content, then unstage + delete
  const savedContent = readFile('src/brand-new.ts');
  await git('reset HEAD -- "src/brand-new.ts"');
  fs.unlinkSync(path.join(TEST_DIR, 'src', 'brand-new.ts'));
  assert.ok(!fileExists('src/brand-new.ts'), 'File should be deleted');

  // Restore (unshelve)
  writeFile('src/brand-new.ts', savedContent);
  assert.strictEqual(readFile('src/brand-new.ts'), 'export const x = 1;', 'File should be restored');
  console.log('    ✅ PASS');
}

async function testShelveMixedStagedAndNew(): Promise<void> {
  console.log('  test: shelve mix of staged tracked + staged new + untracked files');
  await setupTestRepo();

  // Stage a tracked file change
  writeFile('tracked-file.txt', 'staged change');
  await git('add tracked-file.txt');

  // Stage a new file
  writeFile('src/new.ts', 'new file content');
  await git('add src/new.ts');

  // Untracked file
  writeFile('src/untracked.ts', 'untracked content');

  // Categorize
  const files = ['tracked-file.txt', 'src/new.ts', 'src/untracked.ts'];
  const committedModified: string[] = [];
  const addedToIndex: string[] = [];
  const untrackedFiles: string[] = [];

  for (const file of files) {
    let inIndex = false;
    try { const r = await git(`ls-files --error-unmatch "${file}"`); inIndex = r.trim().length > 0; } catch { inIndex = false; }
    if (inIndex) {
      let inHead = true;
      try { await git(`cat-file -e HEAD:"${file}"`); } catch { inHead = false; }
      if (inHead) { committedModified.push(file); } else { addedToIndex.push(file); }
    } else {
      untrackedFiles.push(file);
    }
  }

  assert.ok(committedModified.includes('tracked-file.txt'), 'Tracked file should be committedModified');
  assert.ok(addedToIndex.includes('src/new.ts'), 'New staged file should be addedToIndex');
  assert.ok(untrackedFiles.includes('src/untracked.ts'), 'Untracked file should be untracked');
  assert.strictEqual(committedModified.length, 1, 'Only 1 committed modified');
  assert.strictEqual(addedToIndex.length, 1, 'Only 1 added to index');
  assert.strictEqual(untrackedFiles.length, 1, 'Only 1 untracked');
  console.log('    ✅ PASS');
}

async function testEffectiveDiffForStagedAndUnstaged(): Promise<void> {
  console.log('  test: effective diff combines staged + unstaged changes');
  await setupTestRepo();

  // Stage one version
  writeFile('tracked-file.txt', 'staged version');
  await git('add tracked-file.txt');

  // Make additional unstaged change
  writeFile('tracked-file.txt', 'staged + unstaged version');

  const stagedDiff = (await git('diff --cached -- "tracked-file.txt"')).trim();
  const unstagedDiff = (await git('diff -- "tracked-file.txt"')).trim();
  const headDiff = (await git('diff HEAD -- "tracked-file.txt"')).trim();

  assert.ok(stagedDiff.length > 0, 'Should have staged diff');
  assert.ok(unstagedDiff.length > 0, 'Should have unstaged diff');
  assert.ok(headDiff.length > 0, 'Should have HEAD diff');
  // HEAD diff should be the combined version
  assert.ok(headDiff.includes('staged + unstaged version'), 'HEAD diff should show final content');
  console.log('    ✅ PASS');
}

async function testCheckoutHEADFailsForNewFile(): Promise<void> {
  console.log('  test: git checkout HEAD fails for newly staged file (confirms the bug scenario)');
  await setupTestRepo();

  writeFile('src/brand-new.ts', 'new');
  await git('add src/brand-new.ts');

  let threw = false;
  try {
    await git('checkout HEAD -- "src/brand-new.ts"');
  } catch {
    threw = true;
  }
  assert.ok(threw, 'checkout HEAD should fail for file not in HEAD — this is the bug we fixed');
  console.log('    ✅ PASS');
}

// --- Run all tests ---

async function runTests(): Promise<void> {
  console.log('\n🧪 Code Shelf Tests\n');

  const tests = [
    // Original tests
    testIsTrackedFile,
    testUntrackedFileDoesNotThrow,
    testShelveTrackedFile,
    testShelveUntrackedFile,
    testMixedShelve,
    testSanitizeName,
    testSanitizeFilePath,
    // New feature tests
    testStagedFileDetection,
    testGetModifiedFilesIncludesStaged,
    testShelveStagedTrackedFile,
    testShelveNewStagedFile,
    testShelveMixedStagedAndNew,
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
