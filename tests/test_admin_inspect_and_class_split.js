import http from 'http';

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, data: body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- Starting Admin Inspect Records & Class Split Tests ---');
  let failures = 0;

  // Login as Admin
  let adminToken = '';
  try {
    const loginRes = await request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      role: 'admin',
      password: 'admin'
    });

    if (loginRes.status === 200 && loginRes.data.token) {
      adminToken = loginRes.data.token;
      console.log('✓ PASS: Successfully logged in as Admin');
    } else {
      console.error('✗ FAIL: Admin login failed:', loginRes.data);
      process.exit(1);
    }
  } catch (e) {
    console.error('✗ ERROR during admin login:', e);
    process.exit(1);
  }

  // Helper to fetch live courses from server
  async function fetchLiveCourses(dept) {
    const path = dept ? `/api/courses?department=${encodeURIComponent(dept)}` : '/api/courses';
    const res = await request({
      hostname: 'localhost',
      port: 5000,
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    return res.data || [];
  }

  // 1. Test Department Class Config is rejected with 403
  try {
    const res = await request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/courses/class-config',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, {
      courseCode: 'ENG2FA103(2)',
      classes: 3,
      batches: ['U1ENG1'],
      departmentName: 'ENGLISH'
    });

    if (res.status === 403) {
      console.log('✓ PASS: POST /api/courses/class-config returns 403 Forbidden for department split');
    } else {
      console.error(`✗ FAIL: Expected 403 Forbidden, got ${res.status}:`, res.data);
      failures++;
    }
  } catch (e) {
    console.error('✗ ERROR testing department class config:', e);
    failures++;
  }

  // 2. Test Admin Course Update with Class Split (change ENG2FA103(2) in ENGLISH from 5 to 3)
  try {
    const coursesBefore = await fetchLiveCourses('ENGLISH');
    const engClassesBefore = coursesBefore.filter(c => 
      c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'ENG2FA103(2)'
    );
    const sfCoursesBefore = await fetchLiveCourses('ENGLISH_SF');
    const sfClassesBefore = sfCoursesBefore.filter(c => 
      c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'ENG2FA103(2)'
    );

    console.log(`Initial live state for ENG2FA103(2): ${engClassesBefore.length} in ENGLISH, ${sfClassesBefore.length} in ENGLISH_SF`);

    // Contract classes to 3
    const updateRes = await request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/admin/courses/ENG2FA103(2)',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      }
    }, {
      name: 'ADVANCED ENGLISH LANGUAGE SKILLS FOR SCIENCES',
      alias: 'AELSFS',
      classes: 3,
      department: 'ENGLISH'
    });

    if (updateRes.status === 200 && updateRes.data.success) {
      console.log('✓ PASS: Admin PUT /api/admin/courses/:code succeeded');
    } else {
      console.error(`✗ FAIL: Admin PUT returned ${updateRes.status}:`, updateRes.data);
      failures++;
    }

    const coursesAfter3 = await fetchLiveCourses('ENGLISH');
    const engClassesAfter3 = coursesAfter3.filter(c => 
      c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'ENG2FA103(2)'
    );
    const sfCoursesAfter3 = await fetchLiveCourses('ENGLISH_SF');
    const sfClassesAfter3 = sfCoursesAfter3.filter(c => 
      c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'ENG2FA103(2)'
    );

    if (engClassesAfter3.length === 3) {
      console.log(`✓ PASS: ENGLISH department classes updated to 3: ${engClassesAfter3.map(c => c.code).join(', ')}`);
    } else {
      console.error(`✗ FAIL: Expected 3 ENGLISH classes, found ${engClassesAfter3.length}:`, engClassesAfter3.map(c => c.code));
      failures++;
    }

    if (sfClassesAfter3.length === sfClassesBefore.length) {
      console.log(`✓ PASS: ENGLISH_SF department classes untouched (${sfClassesAfter3.length} row)`);
    } else {
      console.error(`✗ FAIL: ENGLISH_SF classes changed unexpectedly from ${sfClassesBefore.length} to ${sfClassesAfter3.length}`);
      failures++;
    }

    // Now restore back to 5 classes for ENGLISH
    const restoreRes = await request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/admin/courses/ENG2FA103(2)',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      }
    }, {
      name: 'ADVANCED ENGLISH LANGUAGE SKILLS FOR SCIENCES',
      alias: 'AELSFS',
      classes: 5,
      department: 'ENGLISH'
    });

    const coursesRestored = await fetchLiveCourses('ENGLISH');
    const engClassesRestored = coursesRestored.filter(c => 
      c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'ENG2FA103(2)'
    );
    if (engClassesRestored.length === 5) {
      console.log(`✓ PASS: Successfully restored ENGLISH classes to 5: ${engClassesRestored.map(c => c.code).join(', ')}`);
    } else {
      console.error(`✗ FAIL: Expected 5 ENGLISH classes after restore, found ${engClassesRestored.length}`);
      failures++;
    }
  } catch (e) {
    console.error('✗ ERROR in admin course update test:', e);
    failures++;
  }

  // 3. Test Bulk Delete Courses by Primary Key (code + class + department)
  try {
    // Contract ENG2FA103(2) in ENGLISH temporarily to 2 classes to test bulk delete on C2
    await request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/admin/courses/ENG2FA103(2)',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      }
    }, {
      name: 'ADVANCED ENGLISH LANGUAGE SKILLS FOR SCIENCES',
      alias: 'AELSFS',
      classes: 2,
      department: 'ENGLISH'
    });

    // Verify C1 and C2 exist
    let liveEng = await fetchLiveCourses('ENGLISH');
    let c1 = liveEng.find(c => c.code === 'ENG2FA103(2)_C1' && c.department === 'ENGLISH');
    let c2 = liveEng.find(c => c.code === 'ENG2FA103(2)_C2' && c.department === 'ENGLISH');

    if (!c1 || !c2) {
      console.error('✗ Setup error for bulk delete: C1 or C2 not found');
      failures++;
    } else {
      // Bulk delete only C2 using primary key (code + class + department)
      const bulkRes = await request({
        hostname: 'localhost',
        port: 5000,
        path: '/api/admin/courses/bulk-delete',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        }
      }, {
        records: [
          { code: 'ENG2FA103(2)_C2', class: 2, department: 'ENGLISH' }
        ]
      });

      if (bulkRes.status === 200 && bulkRes.data.deletedCount === 1) {
        console.log('✓ PASS: Bulk delete deleted exactly 1 targeted record by primary key (ENG2FA103(2)_C2, class 2, ENGLISH)');
      } else {
        console.error(`✗ FAIL: Bulk delete unexpected result:`, bulkRes.data);
        failures++;
      }

      // Verify C1 still exists in ENGLISH and ENGLISH_SF still exists
      liveEng = await fetchLiveCourses('ENGLISH');
      const c1StillExists = liveEng.some(c => c.code === 'ENG2FA103(2)_C1');
      const c2StillExists = liveEng.some(c => c.code === 'ENG2FA103(2)_C2');
      const sfLive = await fetchLiveCourses('ENGLISH_SF');
      const sfExists = sfLive.some(c => c.code.includes('ENG2FA103(2)'));

      if (c1StillExists && !c2StillExists && sfExists) {
        console.log('✓ PASS: Primary key targeting confirmed: C2 was deleted, C1 and ENGLISH_SF were preserved');
      } else {
        console.error(`✗ FAIL: c1StillExists=${c1StillExists}, c2StillExists=${c2StillExists}, sfExists=${sfExists}`);
        failures++;
      }
    }

    // Restore ENG2FA103(2) in ENGLISH back to 5 classes
    await request({
      hostname: 'localhost',
      port: 5000,
      path: '/api/admin/courses/ENG2FA103(2)',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      }
    }, {
      name: 'ADVANCED ENGLISH LANGUAGE SKILLS FOR SCIENCES',
      alias: 'AELSFS',
      classes: 5,
      department: 'ENGLISH'
    });

    const restoredFinal = await fetchLiveCourses('ENGLISH');
    const finalCount = restoredFinal.filter(c => c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'ENG2FA103(2)').length;
    console.log(`✓ Restored ENG2FA103(2) in ENGLISH to ${finalCount} classes.`);
  } catch (e) {
    console.error('✗ ERROR testing bulk delete:', e);
    failures++;
  }

  console.log(`\n--- Finished: ${failures === 0 ? 'ALL TESTS PASSED!' : `${failures} FAILURES`} ---`);
  process.exit(failures > 0 ? 1 : 0);
}

runTests();

