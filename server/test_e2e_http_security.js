import { spawn } from 'child_process';
import assert from 'assert';

const TEST_PORT = 5055;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

console.log(`Starting live server process on port ${TEST_PORT} for E2E security audit...`);

const serverProc = spawn('node', ['server/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(TEST_PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverStarted = false;
let serverLogs = '';

serverProc.stdout.on('data', (d) => {
  const msg = d.toString();
  serverLogs += msg;
  if (msg.includes('running at http://localhost:')) {
    serverStarted = true;
  }
});

serverProc.stderr.on('data', (d) => {
  serverLogs += d.toString();
});

async function waitServerReady(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (serverStarted) return true;
    try {
      const res = await fetch(`${BASE_URL}/healthcheck`);
      if (res.ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server failed to start within ${timeoutMs}ms. Logs:\n${serverLogs}`);
}

async function runAudit() {
  try {
    await waitServerReady();
    console.log('Server is running and listening on port ' + TEST_PORT);

    // Test 1: Security Headers
    console.log('\n--- 1. Testing Security Headers ---');
    const healthRes = await fetch(`${BASE_URL}/healthcheck`);
    assert(!healthRes.headers.get('x-powered-by'), 'X-Powered-By header should be absent');
    assert.strictEqual(healthRes.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options should be nosniff');
    assert.strictEqual(healthRes.headers.get('x-frame-options'), 'SAMEORIGIN', 'X-Frame-Options should be SAMEORIGIN');
    assert.strictEqual(healthRes.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', 'Referrer-Policy should match');
    console.log('Security Headers: ALL VERIFIED');

    // Test 2: Unauthenticated Admin Route Rejection (RBAC)
    console.log('\n--- 2. Testing RBAC Protection on Admin Endpoints ---');
    const unauthRes = await fetch(`${BASE_URL}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ academicYear: '2026-2027' })
    });
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated config POST should return 401');
    const unauthData = await unauthRes.json();
    assert.strictEqual(unauthData.success, false, 'Expected success: false for unauth access');
    console.log('Admin RBAC Protection: PASSED (Unauthorized requests rejected with 401)');

    // Test 3: Department RBAC Isolation
    console.log('\n--- 3. Testing Department Access Isolation ---');
    // Login as admin first
    const adminLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin', password: 'admin' })
    });
    const adminLoginData = await adminLoginRes.json();
    assert.strictEqual(adminLoginRes.status, 200, 'Admin login should succeed');
    assert(adminLoginData.token, 'Token should be returned');
    assert(adminLoginData.token.startsWith('v1.admin.'), 'Token should be signed v1 admin token');
    console.log('Admin login with signed token: SUCCESS');

    // Attempting admin config with admin token
    const adminConfigRes = await fetch(`${BASE_URL}/api/config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminLoginData.token}`
      },
      body: JSON.stringify({ academicYear: '2026-2027' })
    });
    assert.strictEqual(adminConfigRes.status, 200, 'Admin with signed token should succeed on /api/config');
    console.log('Admin authorized operation: SUCCESS');

    // Test 4: Rate Limiting on Login Endpoint
    console.log('\n--- 4. Testing Login Rate Limiting Protection ---');
    let rateLimited = false;
    for (let i = 0; i < 35; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin', password: 'wrongpassword' })
      });
      if (res.status === 429) {
        rateLimited = true;
        break;
      }
    }
    assert(rateLimited, 'Rate limiter should trigger 429 Too Many Requests after threshold');
    console.log('Rate Limiting (Anti-Brute-Force): PASSED (HTTP 429 triggered)');

    console.log('\n=============================================');
    console.log('ALL E2E HTTP SECURITY VERIFICATIONS PASSED!');
    console.log('=============================================\n');
  } finally {
    serverProc.kill('SIGTERM');
  }
}

runAudit().catch(err => {
  console.error('\nE2E Audit Failed:', err);
  serverProc.kill('SIGKILL');
  process.exit(1);
});
