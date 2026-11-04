import { spawn } from 'child_process';
import assert from 'assert';
import { generateToken } from '../server/security.js';

const TEST_PORT = 5057;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

console.log(`Starting server on port ${TEST_PORT} for Cross-Dept Edit feature verification...`);

const serverProc = spawn('node', ['server/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(TEST_PORT), DATABASE_URL: '' },
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

async function runTests() {
  try {
    await waitServerReady();
    console.log('Server is running and listening on port ' + TEST_PORT);

    const mathToken = generateToken({ role: 'department', departmentName: 'MATHEMATICS' });
    const otherToken = generateToken({ role: 'department', departmentName: 'CHEMISTRY' });

    // Step 1: Create a pending cross-department request via API
    console.log('\n--- 1. Creating a pending cross-department request via POST /api/cross-dept-requests ---');
    const initialPayload = {
      offeringDept: 'STATISTICS',
      courseCode: 'TEST_MAT999',
      courseName: 'Test Mathematics Course',
      semester: '2',
      courseType: 'T',
      hours: 2,
      theoryHours: 2,
      practicalHours: 0,
      pinnedSlots: [
        { day: 'MONDAY', period: '1', type: 'T' },
        { day: 'MONDAY', period: '2', type: 'T' }
      ]
    };

    const createRes = await fetch(`${BASE_URL}/api/cross-dept-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mathToken}`
      },
      body: JSON.stringify(initialPayload)
    });

    const createData = await createRes.json();
    assert.strictEqual(createRes.status, 200, `Should create request successfully: ${JSON.stringify(createData)}`);
    assert.strictEqual(createData.success, true);
    assert(createData.request && createData.request.id, 'Request ID must be present');
    assert.strictEqual(createData.request.status, 'PENDING');
    const reqId = createData.request.id;
    console.log(`✓ Created request ${reqId} with status PENDING.`);

    // Step 2: Edit the PENDING request as requesting department (MATHEMATICS)
    console.log('\n--- 2. Editing the PENDING request via PUT /api/cross-dept-requests/:id/edit ---');
    const editPayload = {
      offeringDept: 'PHYSICS',
      courseCode: 'TEST_MAT999',
      courseName: 'Test Mathematics Course (Updated)',
      semester: '3',
      courseType: 'BOTH',
      hours: 3,
      theoryHours: 1,
      practicalHours: 2,
      pinnedSlots: [
        { day: 'TUESDAY', period: '3', type: 'T' },
        { day: 'TUESDAY', period: '4', type: 'P' },
        { day: 'TUESDAY', period: '5', type: 'P' }
      ]
    };

    const editRes = await fetch(`${BASE_URL}/api/cross-dept-requests/${reqId}/edit`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mathToken}`
      },
      body: JSON.stringify(editPayload)
    });

    const editData = await editRes.json();
    assert.strictEqual(editRes.status, 200, 'Should allow editing pending request');
    assert.strictEqual(editData.success, true);
    assert.strictEqual(editData.request.offeringDept, 'PHYSICS');
    assert.strictEqual(editData.request.courseName, 'Test Mathematics Course (Updated)');
    assert.strictEqual(editData.request.hours, 3);
    assert.strictEqual(editData.request.theoryHours, 1);
    assert.strictEqual(editData.request.practicalHours, 2);
    assert.strictEqual(editData.request.pinnedSlots.length, 3);
    console.log('✓ Pending request edited successfully with updated hours and slots.');

    // Step 3: Non-owner department cannot edit
    console.log('\n--- 3. Testing Edit rejection for unauthorized department ---');
    const unauthRes = await fetch(`${BASE_URL}/api/cross-dept-requests/${reqId}/edit`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${otherToken}`
      },
      body: JSON.stringify(editPayload)
    });
    assert.strictEqual(unauthRes.status, 403, 'Unauthorized department must receive 403');
    console.log('✓ Unauthorized department blocked with 403.');

    // Step 4: Admin or offering department can reject or approve. Let's test with admin approval or simulated approved status.
    console.log('\n--- 4. Testing rejection of Edit when request is APPROVED ---');
    const adminToken = generateToken({ role: 'admin' });

    // Approve the request (or get faculty list for offering department to approve)
    const facRes = await fetch(`${BASE_URL}/api/faculty`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const facData = await facRes.json();
    const facultyList = Array.isArray(facData) ? facData : (facData.faculty || []);
    const physicsFac = facultyList.find(f => (f.department || '').toUpperCase() === 'PHYSICS') || facultyList[0];
    assert(physicsFac, 'Should find a faculty member');

    const approveRes = await fetch(`${BASE_URL}/api/cross-dept-requests/${reqId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${generateToken({ role: 'department', departmentName: 'PHYSICS' })}`
      },
      body: JSON.stringify({
        action: 'APPROVE',
        facultyCode: physicsFac.code
      })
    });
    const approveData = await approveRes.json();
    assert.strictEqual(approveRes.status, 200, `Approval should succeed: ${JSON.stringify(approveData)}`);
    console.log(`✓ Request ${reqId} approved and teacher ${physicsFac.code} assigned.`);

    // Step 5: Attempt to edit the APPROVED request
    console.log('\n--- 5. Attempting to edit an APPROVED request (must be rejected) ---');
    const editApprovedRes = await fetch(`${BASE_URL}/api/cross-dept-requests/${reqId}/edit`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${mathToken}`
      },
      body: JSON.stringify(editPayload)
    });
    const editApprovedData = await editApprovedRes.json();
    assert.strictEqual(editApprovedRes.status, 400, 'Approved request must not be editable (400)');
    assert.strictEqual(editApprovedData.success, false);
    assert.match(editApprovedData.message, /already APPROVED/i);
    console.log('✓ Approved request strictly rejected from editing with 400 Bad Request.');

    // Cleanup: Delete the test request
    console.log('\n--- 6. Cleanup test request ---');
    const delRes = await fetch(`${BASE_URL}/api/cross-dept-requests/${reqId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${mathToken}` }
    });
    assert.strictEqual(delRes.status, 200);
    console.log('✓ Test request cleaned up.');

    console.log('\n=============================================');
    console.log('ALL CROSS-DEPARTMENT EDIT TESTS PASSED!');
    console.log('=============================================\n');
  } finally {
    serverProc.kill('SIGTERM');
  }
}

runTests().catch(err => {
  console.error('\nTest Failed:', err);
  serverProc.kill('SIGKILL');
  process.exit(1);
});
