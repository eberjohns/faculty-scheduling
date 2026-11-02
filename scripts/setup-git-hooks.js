#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(ROOT_DIR, '.git', 'hooks');
const PRE_COMMIT_HOOK = path.join(HOOKS_DIR, 'pre-commit');

function setupHooks() {
  if (!fs.existsSync(HOOKS_DIR)) {
    console.log('[Git Hooks] .git/hooks directory not found. Skipping hook setup.');
    return;
  }

  const hookContent = `#!/bin/sh
# Auto-bump patch version on each commit unless package.json is already staged
node scripts/bump-version.js patch --hook
`;

  try {
    fs.writeFileSync(PRE_COMMIT_HOOK, hookContent, { encoding: 'utf8', mode: 0o755 });
    console.log('✅ Git pre-commit hook installed successfully at .git/hooks/pre-commit');
  } catch (err) {
    console.warn('⚠️ Could not write Git pre-commit hook:', err.message);
  }
}

setupHooks();

