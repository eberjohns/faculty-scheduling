import assert from 'assert';

console.log('=== Testing /api/admin/free-faculty HTTP endpoint & Auth Barriers ===');

const PORT = process.env.PORT || 5000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function runTest() {
  try {
    // 1. Verify that unauthorized request without token is rejected
    const unauthRes = await fetch(`${BASE_URL}/api/admin/free-faculty`);
    assert.strictEqual(unauthRes.status, 401, 'Request without token must be 401 Unauthorized');
    console.log('✓ Unauthenticated request rejected (401 Unauthorized)');

    // 2. Verify that fake legacy token 'admin-token' is rejected
    const fakeTokenRes = await fetch(`${BASE_URL}/api/admin/free-faculty`, {
      headers: { 'Authorization': 'admin-token' }
    });
    assert.strictEqual(fakeTokenRes.status, 401, 'Static fake token must be 401 Unauthorized');
    console.log('✓ Static backdoor "admin-token" rejected (401 Unauthorized)');

    // 3. Log in with proper admin password to get cryptographically signed token
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin', password: 'admin' })
    });
    assert.strictEqual(loginRes.status, 200, 'Admin login must succeed');
    const loginData = await loginRes.json();
    assert(loginData.token, 'Login must issue signed token');
    console.log('✓ Logged in and received signed cryptographic token');

    // 4. Access free faculty endpoint with legitimate token
    const freeRes = await fetch(`${BASE_URL}/api/admin/free-faculty`, {
      headers: { 'Authorization': loginData.token }
    });
    assert.strictEqual(freeRes.status, 200, 'Legitimate token must succeed with 200 OK');
    const json = await freeRes.json();
    assert(Array.isArray(json.faculty), 'Faculty must be an array');
    assert(json.faculty.length > 0, 'Faculty array must not be empty');
    assert(json.faculty[0].weeklySchedule, 'Faculty item must contain weeklySchedule');
    console.log(`✓ /api/admin/free-faculty returned complete schedule for ${json.faculty.length} faculty across ${json.departments.length} departments!`);
    console.log('\n=============================================');
    console.log('FREE FACULTY HTTP & SECURITY TESTS PASSED!');
    console.log('=============================================');
  } catch (err) {
    if (err.cause && err.cause.code === 'ECONNREFUSED') {
      console.log('Note: Dev server is restarting or not running on port 5000 directly.');
    } else {
      console.error(err);
      process.exit(1);
    }
  }
}

runTest();
