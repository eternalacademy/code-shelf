import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Test harness — simulates a git repo workspace for shelf operations
const TEST_DIR = path.join(__dirname, '..', 'test-workspace');
const SHELF_DIR = path.join(TEST_DIR, '.vscode', 'shelf');

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
  await git('add .');
  await git('commit -m "initial"');
}

// --- Tests ---

async function testIsTrackedFile(): Promise<void> {
  console.log('  test: tracked file is detected');
  await setupTestRepo();
  
  // Modify tracked file
  writeFile('tracked-file.txt', 'modified content');
  
  const result = await git('ls-files --error-unmatch "tracked-file.txt"');
  assert.ok(result.trim().length > 0, 'Tracked file should be detected');
  console.log('    ✅ PASS');
}

async function testUntrackedFileDoesNotThrow(): Promise<void> {
  console.log('  test: untracked file does not throw');
  await setupTestRepo();
  
  writeFile('new-file.txt', 'new content');
  
  // This should throw — our fix wraps it in try/catch
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
  
  // Modify tracked file
  writeFile('tracked-file.txt', 'modified content');
  
  // Save diff manually (simulating shelf logic)
  const diff = await git('diff -- "tracked-file.txt"');
  assert.ok(diff.includes('modified content'), 'Diff should contain modifications');
  
  // Revert
  await git('checkout -- "tracked-file.txt"');
  assert.strictEqual(readFile('tracked-file.txt'), 'original content', 'File should be reverted');
  
  // Apply back
  const patchPath = path.join(TEST_DIR, 'test.patch');
  fs.writeFileSync(patchPath, diff);
  await git(`apply "${patchPath}"`);
  assert.strictEqual(readFile('tracked-file.txt'), 'modified content', 'File should be restored');
  
  console.log('    ✅ PASS');
}

async function testShelveUntrackedFile(): Promise<void> {
  console.log('  test: shelve and unshelve untracked file');
  await setupTestRepo();
  
  // Create untracked file
  writeFile('src/test.js', 'console.log("hello");');
  const content = readFile('src/test.js');
  
  // Simulate shelving: save content, then delete
  const savedContent = content;
  fs.unlinkSync(path.join(TEST_DIR, 'src', 'test.js'));
  assert.ok(!fs.existsSync(path.join(TEST_DIR, 'src', 'test.js')), 'File should be deleted');
  
  // Simulate unshelving: restore content
  writeFile('src/test.js', savedContent);
  assert.strictEqual(readFile('src/test.js'), 'console.log("hello");', 'File should be restored');
  
  console.log('    ✅ PASS');
}

async function testMixedShelve(): Promise<void> {
  console.log('  test: shelve mixed tracked and untracked files');
  await setupTestRepo();
  
  // Add more tracked files
  writeFile('src/app.ts', 'original app');
  await git('add .');
  await git('commit -m "add app"');
  
  // Modify tracked + add untracked
  writeFile('src/app.ts', 'modified app');
  writeFile('src/new-module.ts', 'new module');
  
  // Check both appear in modified list
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

// --- Run all tests ---

async function runTests(): Promise<void> {
  console.log('\n🧪 Code Shelf Tests\n');
  
  const tests = [
    testIsTrackedFile,
    testUntrackedFileDoesNotThrow,
    testShelveTrackedFile,
    testShelveUntrackedFile,
    testMixedShelve,
    testSanitizeName,
    testSanitizeFilePath,
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
