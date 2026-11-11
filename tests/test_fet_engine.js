import assert from 'assert';
import { readDb } from '../server/db.js';
import { generateScheduleWithFet } from '../server/engine/fet_adapter.js';

console.log('=== Running Headless FET 7.12.0 Engine Verification Test ===\n');

const db = readDb();
const deptName = 'COMMERCE';
const courses = db.courses.filter(c => c.department === deptName);
const mapping = db.subjectTeacherMapping[deptName] || {};

const courseFacultyMap = {};
const courseFacultyConfig = {};

courses.forEach(c => {
  const m = mapping[c.code] || {};
  courseFacultyMap[c.code] = m.teachers || c.teachers || [];
  courseFacultyConfig[c.code] = {
    teachers: courseFacultyMap[c.code],
    teacherHours: m.teacherHours || c.teacherHours || null,
    distribute: m.courseType !== 'P' && courseFacultyMap[c.code].length > 1,
    courseType: m.courseType || c.courseType || 'T',
    practicalHours: m.practicalHours !== undefined ? m.practicalHours : c.practicalHours,
    theoryHours: m.theoryHours !== undefined ? m.theoryHours : c.theoryHours,
    practicalTeachers: m.practicalTeachers || c.practicalTeachers || [],
    theoryTeachers: m.theoryTeachers || c.theoryTeachers || [],
    theoryTeacherHours: m.theoryTeacherHours || c.theoryTeacherHours || null
  };
});

async function runTest() {
  const t0 = Date.now();
  const result = await generateScheduleWithFet({
    db,
    departmentName: deptName,
    semester: '',
    selectedCourseCodes: courses.map(c => c.code),
    courseFacultyMap,
    courseFacultyConfig,
    pinnedSlots: {},
    maxConsecutiveHours: 2,
    practicalBlockSize: 2
  });
  const elapsed = (Date.now() - t0) / 1000;

  console.log(`✓ FET Engine solved all ${courses.length} courses in ${elapsed}s`);
  assert.strictEqual(result.success, true, 'Result success should be true');
  assert.strictEqual(result.status, 'optimal', 'Status should be optimal');
  assert.strictEqual(result.engine, 'FET 7.12.0', 'Engine should be FET 7.12.0');
  assert(result.audit.totalAllocatedSlots > 150, 'Total slots allocated should be complete');

  // Verify Zero Teacher Clashes
  const teacherSlots = {};
  const clashes = [];
  const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

  Object.keys(result.allocations).forEach(cCode => {
    const cDays = result.allocations[cCode] || {};
    WEEKDAYS.forEach(d => {
      Object.keys(cDays[d] || {}).forEach(p => {
        const teachers = cDays[d][p] || [];
        teachers.forEach(t => {
          if (t === 'T_STAFF') return;
          const key = `${d}_${p}`;
          if (!teacherSlots[t]) teacherSlots[t] = {};
          if (teacherSlots[t][key]) {
            clashes.push({ teacher: t, slot: key, course1: teacherSlots[t][key], course2: cCode });
          } else {
            teacherSlots[t][key] = cCode;
          }
        });
      });
    });
  });

  assert.strictEqual(clashes.length, 0, `Should have 0 clashes, found: ${JSON.stringify(clashes)}`);
  console.log(`✓ Zero faculty clashes mathematically verified across all courses`);
  console.log(`✓ Total allocated slots: ${result.audit.totalAllocatedSlots}`);
  console.log('\n======================================================');
  console.log('FET HEADLESS ENGINE FULLY OPERATIONAL AND VERIFIED!');
  console.log('======================================================');
}

runTest().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});

