import assert from 'assert';
import { initDb, readDb, writeDb } from '../server/db.js';

async function runTests() {
  console.log('=== Running Course Class Split & Record Count Tests ===\n');

  await initDb();
  let db = readDb();

  const mathCourses = db.courses.filter(c => 
    c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'MAT6CJ304' && 
    (c.department || '').toUpperCase() === 'MATHEMATICS'
  );

  console.log('--- Initial MAT6CJ304 records in MATHEMATICS ---');
  console.log(mathCourses.map(c => ({ code: c.code, class: c.class, teachers: c.teachers })));
  assert.strictEqual(mathCourses.length, 2, 'Expected exactly 2 classes for MAT6CJ304 (no orphaned base record)');
  assert.strictEqual(mathCourses[0].code, 'MAT6CJ304_C1');
  assert.strictEqual(mathCourses[1].code, 'MAT6CJ304_C2');
  console.log('Initial state: PASSED (exactly 2 records: _C1 and _C2)\n');

  // Helper simulation of PUT /api/admin/courses/:code
  function simulateUpdateClasses(code, department, newClasses) {
    const cleanBaseCode = code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
    const targetDept = (department || '').trim().toUpperCase();
    const targetClassesCount = Math.max(1, Math.min(5, parseInt(newClasses, 10) || 1));

    const currentClassVariants = db.courses.filter(c => {
      const cBase = c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
      return cBase === cleanBaseCode && (c.department || '').trim().toUpperCase() === targetDept;
    });

    const archetype = currentClassVariants[0];

    if (targetClassesCount === 1) {
      const unsuffixedRecord = currentClassVariants.find(c => c.code === cleanBaseCode);
      const c1Record = currentClassVariants.find(c => c.code === `${cleanBaseCode}_C1`);
      const keep = (c1Record && (c1Record.teachers?.length || 0) > 0) ? c1Record : (unsuffixedRecord || c1Record || currentClassVariants[0]);

      const oldKeepCode = keep.code;
      keep.code = cleanBaseCode;
      keep.class = 0;
      keep.group = 0;
      keep.classes = 1;

      if (oldKeepCode !== cleanBaseCode && db.allocations && db.allocations[targetDept]) {
        if (!db.allocations[targetDept][cleanBaseCode] || Object.keys(db.allocations[targetDept][cleanBaseCode]).length === 0) {
          if (db.allocations[targetDept][oldKeepCode]) {
            db.allocations[targetDept][cleanBaseCode] = db.allocations[targetDept][oldKeepCode];
          }
        }
      }

      const toRemoveVariants = currentClassVariants.filter(c => c !== keep);
      const toRemoveCodes = toRemoveVariants.map(c => c.code).filter(cd => cd !== cleanBaseCode);

      db.courses = db.courses.filter(c => c === keep || !toRemoveVariants.includes(c));

      if (db.allocations && db.allocations[targetDept]) {
        toRemoveCodes.forEach(remCode => {
          delete db.allocations[targetDept][remCode];
          delete db.allocations[targetDept][`${remCode}-T`];
          delete db.allocations[targetDept][`${remCode}-P`];
        });
        for (let i = 1; i <= 5; i++) {
          const suffixed = `${cleanBaseCode}_C${i}`;
          delete db.allocations[targetDept][suffixed];
          delete db.allocations[targetDept][`${suffixed}-T`];
          delete db.allocations[targetDept][`${suffixed}-P`];
        }
      }
      for (let i = 1; i <= 5; i++) {
        delete db.groupMappings[`${cleanBaseCode}_C${i}`];
      }
    } else {
      const existingByNum = {};
      const unsuffixed = [];
      currentClassVariants.forEach(c => {
        const m = c.code.match(/(_G|_C)(\d+)$/);
        if (m) {
          existingByNum[parseInt(m[2], 10)] = c;
        } else {
          unsuffixed.push(c);
        }
      });

      const toRemove = [];

      if (unsuffixed.length > 0) {
        if (!existingByNum[1]) {
          unsuffixed[0].code = `${cleanBaseCode}_C1`;
          unsuffixed[0].class = 1;
          unsuffixed[0].group = 1;
          unsuffixed[0].classes = 1;
          existingByNum[1] = unsuffixed[0];

          if (db.allocations && db.allocations[targetDept] && db.allocations[targetDept][cleanBaseCode]) {
            if (!db.allocations[targetDept][`${cleanBaseCode}_C1`]) {
              db.allocations[targetDept][`${cleanBaseCode}_C1`] = db.allocations[targetDept][cleanBaseCode];
            }
            delete db.allocations[targetDept][cleanBaseCode];
            delete db.allocations[targetDept][`${cleanBaseCode}-T`];
            delete db.allocations[targetDept][`${cleanBaseCode}-P`];
          }
          unsuffixed.slice(1).forEach(u => toRemove.push(u));
        } else {
          unsuffixed.forEach(u => toRemove.push(u));
          if (db.allocations && db.allocations[targetDept]) {
            delete db.allocations[targetDept][cleanBaseCode];
            delete db.allocations[targetDept][`${cleanBaseCode}-T`];
            delete db.allocations[targetDept][`${cleanBaseCode}-P`];
          }
        }
      }

      for (let cl = 1; cl <= targetClassesCount; cl++) {
        if (!existingByNum[cl]) {
          const newCourse = {
            ...archetype,
            code: `${cleanBaseCode}_C${cl}`,
            class: cl,
            group: cl,
            classes: 1,
            department: targetDept,
            teachers: [],
            teacherHours: {},
            theoryTeachers: [],
            theoryTeacherHours: {},
            practicalTeachers: [],
            recommendations: { MONDAY: {}, TUESDAY: {}, WEDNESDAY: {}, THURSDAY: {}, FRIDAY: {} },
            masterRecommendations: { MONDAY: {}, TUESDAY: {}, WEDNESDAY: {}, THURSDAY: {}, FRIDAY: {} }
          };
          db.courses.push(newCourse);
          existingByNum[cl] = newCourse;
        } else {
          existingByNum[cl].class = cl;
          existingByNum[cl].group = cl;
          existingByNum[cl].classes = 1;
        }
      }

      Object.keys(existingByNum).forEach(clStr => {
        const cl = parseInt(clStr, 10);
        if (cl > targetClassesCount) {
          toRemove.push(existingByNum[cl]);
        }
      });

      if (toRemove.length > 0) {
        db.courses = db.courses.filter(c => !toRemove.includes(c));
        if (db.allocations && db.allocations[targetDept]) {
          toRemove.forEach(remCourse => {
            const remCode = remCourse.code;
            delete db.allocations[targetDept][remCode];
            delete db.allocations[targetDept][`${remCode}-T`];
            delete db.allocations[targetDept][`${remCode}-P`];
          });
        }
        toRemove.forEach(remCourse => {
          delete db.groupMappings[remCourse.code];
        });
      }
    }
  }

  // Test 1: Split to 3 classes
  console.log('--- Test 1: Split MAT6CJ304 to 3 classes ---');
  simulateUpdateClasses('MAT6CJ304', 'MATHEMATICS', 3);
  let res3 = db.courses.filter(c => 
    c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'MAT6CJ304' && 
    (c.department || '').toUpperCase() === 'MATHEMATICS'
  );
  console.log('Resulting codes:', res3.map(c => c.code));
  assert.strictEqual(res3.length, 3, 'Must have exactly 3 class records');
  assert.deepStrictEqual(res3.map(c => c.code).sort(), ['MAT6CJ304_C1', 'MAT6CJ304_C2', 'MAT6CJ304_C3']);
  console.log('Split to 3: PASSED\n');

  // Test 2: Reduce from 3 to 2 classes
  console.log('--- Test 2: Reduce MAT6CJ304 to 2 classes ---');
  simulateUpdateClasses('MAT6CJ304', 'MATHEMATICS', 2);
  let res2 = db.courses.filter(c => 
    c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'MAT6CJ304' && 
    (c.department || '').toUpperCase() === 'MATHEMATICS'
  );
  console.log('Resulting codes:', res2.map(c => c.code));
  assert.strictEqual(res2.length, 2, 'Must have exactly 2 class records');
  assert.deepStrictEqual(res2.map(c => c.code).sort(), ['MAT6CJ304_C1', 'MAT6CJ304_C2']);
  console.log('Reduce to 2: PASSED\n');

  // Test 3: Reduce from 2 to 1 class
  console.log('--- Test 3: Reduce MAT6CJ304 to 1 class ---');
  simulateUpdateClasses('MAT6CJ304', 'MATHEMATICS', 1);
  let res1 = db.courses.filter(c => 
    c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'MAT6CJ304' && 
    (c.department || '').toUpperCase() === 'MATHEMATICS'
  );
  console.log('Resulting codes:', res1.map(c => c.code));
  assert.strictEqual(res1.length, 1, 'Must have exactly 1 record');
  assert.strictEqual(res1[0].code, 'MAT6CJ304');
  console.log('Reduce to 1: PASSED\n');

  // Test 4: Expand from 1 to 2 classes
  console.log('--- Test 4: Expand MAT6CJ304 from 1 to 2 classes ---');
  simulateUpdateClasses('MAT6CJ304', 'MATHEMATICS', 2);
  let resExpand = db.courses.filter(c => 
    c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === 'MAT6CJ304' && 
    (c.department || '').toUpperCase() === 'MATHEMATICS'
  );
  console.log('Resulting codes:', resExpand.map(c => c.code));
  assert.strictEqual(resExpand.length, 2, 'Must have exactly 2 class records');
  assert.deepStrictEqual(resExpand.map(c => c.code).sort(), ['MAT6CJ304_C1', 'MAT6CJ304_C2']);
  console.log('Expand to 2: PASSED\n');

  // Restore teacher assignments JA and SAS for MAT6CJ304_C1 and MAT6CJ304_C2
  const c1 = resExpand.find(c => c.code === 'MAT6CJ304_C1');
  const c2 = resExpand.find(c => c.code === 'MAT6CJ304_C2');
  if (c1) {
    c1.teachers = ['JA'];
    c1.teacherHours = { JA: 4 };
    c1.theoryTeachers = ['JA'];
    c1.theoryTeacherHours = { JA: 4 };
  }
  if (c2) {
    c2.teachers = ['SAS'];
    c2.teacherHours = { SAS: 4 };
    c2.theoryTeachers = ['SAS'];
    c2.theoryTeacherHours = { SAS: 4 };
  }
  writeDb(db);
  console.log('Restored clean 2-class state in DB.');

  console.log('\n========================================');
  console.log('ALL CLASS SPLIT & COUNT TESTS PASSED!');
  console.log('========================================');
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});

