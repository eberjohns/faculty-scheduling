import assert from 'assert';
import { readDb } from '../server/db.js';
import { generateDepartmentSchedule } from '../server/scheduler.js';

console.log('=== Running Auto-Generation Clash Prevention & Teacher Quota Invariance Tests ===');

const db = readDb();
const deptName = 'MATHEMATICS';
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

console.log('\n--- 1. Testing Clean Auto-Generation for All Department Courses ---');

const result1 = generateDepartmentSchedule({
  db,
  departmentName: deptName,
  semester: '',
  selectedCourseCodes: courses.map(c => c.code),
  courseFacultyMap,
  courseFacultyConfig,
  pinnedSlots: {},
  allowRelaxedFallback: true,
  forceRelaxed: false
});

assert.strictEqual(result1.success, true, 'Scheduler generation should succeed');

// Verify zero teacher clashes
const slotFaculty1 = {};
const clashes1 = [];

Object.entries(result1.allocations).forEach(([cCode, days]) => {
  Object.entries(days).forEach(([d, pMap]) => {
    Object.entries(pMap).forEach(([p, facs]) => {
      facs.forEach(f => {
        const key = `${d}_${p}_${f}`;
        if (slotFaculty1[key]) {
          clashes1.push({ fac: f, day: d, period: p, c1: slotFaculty1[key], c2: cCode });
        } else {
          slotFaculty1[key] = cCode;
        }
      });
    });
  });
});

assert.strictEqual(clashes1.length, 0, `Generated schedule must have 0 clashes, found: ${JSON.stringify(clashes1)}`);
console.log('✓ Zero clashes verified in generated schedule.');

console.log('\n--- 2. Testing Multiple Re-generations (Target Course Pinned Exemption) ---');

// Even if pinnedSlots contains current allocations from a previous run, target courses being regenerated
// must NOT be double-counted or pre-pinned as obstacles
const pinnedSlotsFromRun1 = JSON.parse(JSON.stringify(result1.allocations));

const result2 = generateDepartmentSchedule({
  db,
  departmentName: deptName,
  semester: '',
  selectedCourseCodes: courses.map(c => c.code),
  courseFacultyMap,
  courseFacultyConfig,
  pinnedSlots: pinnedSlotsFromRun1,
  allowRelaxedFallback: true,
  forceRelaxed: false
});

assert.strictEqual(result2.success, true, 'Re-generation should succeed');

// Verify total slots does not explode/accumulate
const totalSlots1 = Object.values(result1.allocations).reduce((sum, d) => sum + Object.values(d).reduce((s, p) => s + Object.keys(p).length, 0), 0);
const totalSlots2 = Object.values(result2.allocations).reduce((sum, d) => sum + Object.values(d).reduce((s, p) => s + Object.keys(p).length, 0), 0);

assert.strictEqual(totalSlots2 <= totalSlots1 + 5, true, `Slots count should not accumulate on multiple runs (Run1: ${totalSlots1}, Run2: ${totalSlots2})`);

const slotFaculty2 = {};
const clashes2 = [];
Object.entries(result2.allocations).forEach(([cCode, days]) => {
  Object.entries(days).forEach(([d, pMap]) => {
    Object.entries(pMap).forEach(([p, facs]) => {
      facs.forEach(f => {
        const key = `${d}_${p}_${f}`;
        if (slotFaculty2[key]) {
          clashes2.push({ fac: f, day: d, period: p, c1: slotFaculty2[key], c2: cCode });
        } else {
          slotFaculty2[key] = cCode;
        }
      });
    });
  });
});

assert.strictEqual(clashes2.length, 0, `Re-generated schedule must have 0 clashes, found: ${JSON.stringify(clashes2)}`);
console.log('✓ Zero clashes verified on repeated generation with pinnedSlots payload.');

console.log('\n--- 3. Testing Strict Teacher Hour Quotas Invariance ---');
// Verify for each course that no teacher received more than their mapped quota
courses.forEach(c => {
  const m = mapping[c.code] || {};
  const cAlloc = result2.allocations[c.code] || {};
  const teacherHoursPlaced = {};
  Object.values(cAlloc).forEach(pMap => {
    Object.values(pMap || {}).forEach(facs => {
      facs.forEach(f => {
        teacherHoursPlaced[f] = (teacherHoursPlaced[f] || 0) + 1;
      });
    });
  });

  if (m.courseType === 'P') {
    Object.entries(m.theoryTeacherHours || {}).forEach(([f, quota]) => {
      const q = parseInt(quota) || 0;
      // In practical courses, theory hours allocated to teacher f must not exceed quota
      const placed = teacherHoursPlaced[f] || 0;
      // Practical hours are co-taught so teacher f may also have practical hours
      const maxPossible = q + (m.practicalHours || 0);
      assert.strictEqual(placed <= maxPossible, true, `Teacher ${f} exceeded quota in ${c.code}: placed ${placed} > maxPossible ${maxPossible}`);
    });
  } else if (m.teacherHours) {
    Object.entries(m.teacherHours).forEach(([f, quota]) => {
      const q = parseInt(quota) || 0;
      const placed = teacherHoursPlaced[f] || 0;
      assert.strictEqual(placed <= q, true, `Teacher ${f} exceeded quota in ${c.code}: placed ${placed} > quota ${q}`);
    });
  }
});

console.log('✓ Teacher hour quotas strictly respected across all courses.');

console.log('\n=============================================================');
console.log('ALL AUTO-GENERATION CLASH & QUOTA INVARIANCE TESTS PASSED!');
console.log('=============================================================');

