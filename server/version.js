import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const VERSION_FILE_PATH = path.join(ROOT_DIR, 'version.json');
const PACKAGE_FILE_PATH = path.join(ROOT_DIR, 'package.json');

let cachedVersionInfo = null;

function readPackageVersion() {
  try {
    if (fs.existsSync(PACKAGE_FILE_PATH)) {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_FILE_PATH, 'utf8'));
      return pkg.version || '1.0.0';
    }
  } catch (err) {
    // fallback
  }
  return '1.0.0';
}

function getGitInfo() {
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

function readVersionJson() {
  try {
    if (fs.existsSync(VERSION_FILE_PATH)) {
      return JSON.parse(fs.readFileSync(VERSION_FILE_PATH, 'utf8'));
    }
  } catch (err) {
    // ignore
  }
  return null;
}

export function saveVersionJson(data) {
  try {
    fs.writeFileSync(VERSION_FILE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn('[Version] Could not write version.json:', err.message);
  }
}

export function getVersionInfo(forceRefresh = false) {
  if (cachedVersionInfo && !forceRefresh) {
    return {
      ...cachedVersionInfo,
      serverUptimeSeconds: Math.floor(process.uptime())
    };
  }

  const pkgVersion = readPackageVersion();
  const gitInfo = getGitInfo();
  const fileInfo = readVersionJson();

  const commit = gitInfo?.commit || fileInfo?.commit || 'unknown';
  const commitFull = gitInfo?.commitFull || fileInfo?.commitFull || 'unknown';
  const branch = gitInfo?.branch || fileInfo?.branch || 'main';
  const commitDate = gitInfo?.commitDate || fileInfo?.commitDate || null;
  const commitMessage = gitInfo?.commitMessage || fileInfo?.commitMessage || null;

  const versionData = {
    version: pkgVersion,
    commit,
    commitFull,
    branch,
    commitDate,
    commitMessage,
    builtAt: fileInfo?.builtAt || new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
    environment: process.env.NODE_ENV || 'production'
  };

  // If git is accessible and returned real info, persist to version.json
  if (gitInfo) {
    versionData.builtAt = new Date().toISOString();
    saveVersionJson(versionData);
  }

  cachedVersionInfo = versionData;
  return {
    ...versionData,
    serverUptimeSeconds: Math.floor(process.uptime())
  };
}
