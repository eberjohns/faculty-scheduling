import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseSemver, computeNextVersion, bumpVersion } from '../scripts/bump-version.js';
import { getVersionInfo } from '../server/version.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PACKAGE_PATH = path.join(ROOT_DIR, 'package.json');
const VERSION_PATH = path.join(ROOT_DIR, 'version.json');

console.log('=== Running Semantic Version & Auto-Bump Tests ===\n');

// 1. Test parseSemver
console.log('--- Test 1: Semver Parsing ---');
const p1 = parseSemver('1.0.0');
assert.strictEqual(p1.major, 1);
assert.strictEqual(p1.minor, 0);
assert.strictEqual(p1.patch, 0);

const p2 = parseSemver('2.15.8');
assert.strictEqual(p2.major, 2);
assert.strictEqual(p2.minor, 15);
assert.strictEqual(p2.patch, 8);
console.log('parseSemver: PASSED\n');

// 2. Test computeNextVersion
console.log('--- Test 2: computeNextVersion Logic ---');
assert.strictEqual(computeNextVersion('2.0.0', 'patch'), '2.0.1');
assert.strictEqual(computeNextVersion('2.0.1', 'patch'), '2.0.2');
assert.strictEqual(computeNextVersion('2.0.5', 'minor'), '2.1.0');
assert.strictEqual(computeNextVersion('2.3.9', 'major'), '3.0.0');
assert.strictEqual(computeNextVersion('2.0.0', 'custom', '2.5.0'), '2.5.0');
assert.strictEqual(computeNextVersion('1.0.0', 'custom', '2.0.0'), '2.0.0');
console.log('computeNextVersion: PASSED\n');

// 3. Test bumpVersion function in isolation
console.log('--- Test 3: bumpVersion File Synchronization ---');
const backupPkg = fs.readFileSync(PACKAGE_PATH, 'utf8');
const backupVer = fs.readFileSync(VERSION_PATH, 'utf8');

try {
  // Set to 2.0.0
  bumpVersion('custom', '2.0.0', { silent: true });
  let info = getVersionInfo(true);
  assert.strictEqual(info.version, '2.0.0');

  // Bump patch: 2.0.0 -> 2.0.1
  bumpVersion('patch', null, { silent: true });
  info = getVersionInfo(true);
  assert.strictEqual(info.version, '2.0.1');

  // Bump minor: 2.0.1 -> 2.1.0
  bumpVersion('minor', null, { silent: true });
  info = getVersionInfo(true);
  assert.strictEqual(info.version, '2.1.0');

  // Bump major: 2.1.0 -> 3.0.0
  bumpVersion('major', null, { silent: true });
  info = getVersionInfo(true);
  assert.strictEqual(info.version, '3.0.0');

  console.log('bumpVersion file sync: PASSED\n');
} finally {
  // Restore 2.0.0 clean state
  bumpVersion('custom', '2.0.0', { silent: true });
}

// 4. Verify Final State
const finalInfo = getVersionInfo(true);
assert.strictEqual(finalInfo.version, '2.0.0', 'Final version must be 2.0.0');
console.log('Final version verified: v' + finalInfo.version);

console.log('\n========================================');
console.log('ALL VERSION & BUMP TESTS PASSED!');
console.log('========================================');

