#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PACKAGE_PATH = path.join(ROOT_DIR, 'package.json');
const VERSION_PATH = path.join(ROOT_DIR, 'version.json');

/**
 * Parses semantic version string X.Y.Z into numbers
 */
export function parseSemver(versionStr) {
  const match = String(versionStr || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) {
    return { major: 2, minor: 0, patch: 0, prerelease: '' };
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || ''
  };
}

/**
 * Computes the next version string based on bump type
 */
export function computeNextVersion(currentVersion, bumpType, customVersion) {
  if (customVersion && /^\d+\.\d+\.\d+.*$/.test(customVersion.trim())) {
    return customVersion.trim();
  }

  const { major, minor, patch } = parseSemver(currentVersion);

  switch (bumpType) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

/**
 * Reads Git metadata safely
 */
export function getGitInfo() {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    const commitFull = execSync('git rev-parse HEAD', { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    const commitDate = execSync('git log -1 --format=%cd --date=iso', { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    const commitMessage = execSync('git log -1 --format=%s', { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    return { commit, commitFull, branch, commitDate, commitMessage };
  } catch (err) {
    return null;
  }
}

/**
 * Core function to bump version across package.json and version.json
 */
export function bumpVersion(bumpType = 'patch', customVersion = null, options = {}) {
  const { gitAdd = false, isHook = false, silent = false } = options;

  // If invoked as git pre-commit hook, check if a merge or rebase is in progress
  if (isHook) {
    const isMerge = fs.existsSync(path.join(ROOT_DIR, '.git', 'MERGE_HEAD'));
    const isRebase = fs.existsSync(path.join(ROOT_DIR, '.git', 'rebase-merge')) || fs.existsSync(path.join(ROOT_DIR, '.git', 'rebase-apply'));
    if (isMerge || isRebase) {
      if (!silent) console.log('[Version Hook] Git merge/rebase in progress, skipping auto-version bump.');
      return null;
    }

    // Check if package.json was explicitly staged with changes by the user
    try {
      const stagedFiles = execSync('git diff --cached --name-only', { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim().split(/\r?\n/);
      if (stagedFiles.includes('package.json')) {
        if (!silent) console.log('[Version Hook] package.json already staged by user, preserving custom version bump.');
        return null;
      }
    } catch (err) {
      // ignore
    }
  }

  // 1. Read current version from package.json or version.json
  let currentVersion = '2.0.0';
  let pkgData = {};

  if (fs.existsSync(PACKAGE_PATH)) {
    try {
      pkgData = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
      if (pkgData.version) currentVersion = pkgData.version;
    } catch (e) {}
  } else if (fs.existsSync(VERSION_PATH)) {
    try {
      const vData = JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8'));
      if (vData.version) currentVersion = vData.version;
    } catch (e) {}
  }

  // 2. Compute new version
  const newVersion = computeNextVersion(currentVersion, bumpType, customVersion);

  // 3. Update package.json
  pkgData.version = newVersion;
  fs.writeFileSync(PACKAGE_PATH, JSON.stringify(pkgData, null, 2) + '\n', 'utf8');

  // 4. Update version.json
  const gitInfo = getGitInfo();
  let existingVersionJson = {};
  if (fs.existsSync(VERSION_PATH)) {
    try {
      existingVersionJson = JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8'));
    } catch (e) {}
  }

  const updatedVersionJson = {
    version: newVersion,
    commit: gitInfo?.commit || existingVersionJson.commit || 'unknown',
    commitFull: gitInfo?.commitFull || existingVersionJson.commitFull || 'unknown',
    branch: gitInfo?.branch || existingVersionJson.branch || 'main',
    commitDate: gitInfo?.commitDate || existingVersionJson.commitDate || new Date().toISOString(),
    commitMessage: gitInfo?.commitMessage || existingVersionJson.commitMessage || '',
    builtAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    environment: process.env.NODE_ENV || 'production'
  };

  fs.writeFileSync(VERSION_PATH, JSON.stringify(updatedVersionJson, null, 2) + '\n', 'utf8');

  // 5. Stage files in Git if requested or running in hook
  if (gitAdd || isHook) {
    try {
      execSync('git add package.json version.json', { cwd: ROOT_DIR, stdio: 'ignore', timeout: 2000 });
    } catch (e) {
      if (!silent) console.warn('[Version] Could not git add version files:', e.message);
    }
  }

  if (!silent) {
    console.log(`✅ Version updated: v${currentVersion} -> v${newVersion} (${bumpType || 'custom'})`);
  }

  return {
    oldVersion: currentVersion,
    version: newVersion,
    bumpType: bumpType || 'custom',
    builtAt: updatedVersionJson.builtAt
  };
}

// CLI Execution Support
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  const args = process.argv.slice(2);
  const isHook = args.includes('--hook');
  const gitAdd = args.includes('--git-add');
  const silent = args.includes('--silent');

  const cleanArgs = args.filter(a => !a.startsWith('--'));
  const firstArg = cleanArgs[0] || 'patch';

  let bumpType = 'patch';
  let customVersion = null;

  if (['patch', 'minor', 'major'].includes(firstArg.toLowerCase())) {
    bumpType = firstArg.toLowerCase();
  } else if (/^\d+\.\d+\.\d+.*$/.test(firstArg)) {
    bumpType = 'custom';
    customVersion = firstArg;
  }

  try {
    bumpVersion(bumpType, customVersion, { gitAdd, isHook, silent });
  } catch (err) {
    console.error('❌ Version bump error:', err.message);
    process.exit(1);
  }
}

