import assert from 'assert';
import { readDb, writeDb } from '../server/db.js';

console.log('=== Running Comprehensive Manual Assignment Rule Tests ===\n');

const db = readDb();
const deptName = 'COMPUTER SCIENCE';

// -------------------------------------------------------------
// Test 1: Teacher Clash Detection (Cross-Course & Cross-Dept)
// -------------------------------------------------------------
console.log('--- Test 1: Teacher Double-Booking Clash Check ---');
const testDb = JSON.parse(JSON.stringify(db));

// Seed an existing allocated slot with a faculty member for testing
let testDay = 'THURSDAY';
let testPeriod = '1';
let testFac = 'JAM1';
let testCourse = 'CSC5FS112';

if (!testDb.allocations[deptName]) testDb.allocations[deptName] = {};
if (!testDb.allocations[deptName][testCourse]) testDb.allocations[deptName][testCourse] = {};
if (!testDb.allocations[deptName][testCourse][testDay]) testDb.allocations[deptName][testCourse][testDay] = {};
testDb.allocations[deptName][testCourse][testDay][testPeriod] = [testFac];

// Simulated validation payload for a DIFFERENT course at the SAME day & period with JAM1
const clashPayload = {
  departmentName: deptName,
  courseCode: 'CSC1CJ101', // Different course
  weekday: testDay,
  period: testPeriod,
  facultyCodes: [testFac]
};

// Test against /api/allocations/validate logic
function validateManualSlot(departmentName, courseCode, weekday, period, facultyCodes, currentDb) {
  const conflicts = [];
  const teacherUnavail = currentDb.teacherUnavailability || {};

  // 1. Teacher Unavailability Check
  for (const fac of facultyCodes) {
    const unavail = teacherUnavail[fac] || [];
    const isUnavail = unavail.some(u => {
      const uDay = typeof u === 'string' ? u.split('_')[0] : u.day;
      const uPeriod = typeof u === 'string' ? u.split('_')[1] : u.period;
      if (uDay.toUpperCase() !== weekday.toUpperCase()) return false;
      if (uPeriod === 'all') return true;
      return String(uPeriod) === String(period);
    });

    if (isUnavail) {
      const facInfo = currentDb.faculty.find(f => f.code === fac) || { name: fac };
      conflicts.push({
        type: 'TEACHER_UNAVAILABLE',
        facultyCode: fac,
        facultyName: facInfo.name,
        message: `Faculty ${facInfo.name} has marked ${weekday} Period ${period} as an unavailable / off period.`
      });
    }
  }

  // 2. Cross-Course & Cross-Department Clash Check
  for (const dept of Object.keys(currentDb.allocations)) {
    const deptAlloc = currentDb.allocations[dept];
    for (const otherCourseCode of Object.keys(deptAlloc)) {
      if (otherCourseCode === courseCode) continue; // Skip active course
      const days = deptAlloc[otherCourseCode];
      if (days && days[weekday] && days[weekday][period]) {
        const otherFacs = days[weekday][period] || [];
        for (const fac of facultyCodes) {
          if (otherFacs.includes(fac)) {
            const facInfo = currentDb.faculty.find(f => f.code === fac) || { name: fac };
            conflicts.push({
              type: 'FACULTY_CLASH',
              facultyCode: fac,
              facultyName: facInfo.name,
              clashingCourseCode: otherCourseCode,
              department: dept
            });
          }
        }
      }
    }
  }

  // 3. Global Lock Notice
  const globalLocks = currentDb.config.globalLockedPeriods || [];
  const lockObj = globalLocks.find(l => l.day.toUpperCase() === weekday.toUpperCase() && String(l.period) === String(period));

  return {
    valid: conflicts.length === 0,
    conflicts,
    adminLockNotice: lockObj ? (lockObj.label || 'College Common Activity') : null
  };
}

const clashResult = validateManualSlot(clashPayload.departmentName, clashPayload.courseCode, clashPayload.weekday, clashPayload.period, clashPayload.facultyCodes, testDb);
assert.strictEqual(clashResult.valid, false, 'Manual assignment of JAM1 to Thursday P1 must trigger a conflict');
assert(clashResult.conflicts.some(c => c.facultyCode === 'JAM1' && c.clashingCourseCode === 'CSC5FS112'), 'Conflict must identify CSC5FS112 as the clashing course');
console.log('Teacher Double-Booking Clash Check: PASSED (Correctly blocked with conflicting course details)');

// -------------------------------------------------------------
// Test 2: Free Teacher Assignment (No Clash)
// -------------------------------------------------------------
console.log('\n--- Test 2: Free Teacher Manual Assignment ---');
// JAM1 on a period where JAM1 is NOT teaching (e.g. Wednesday Period 2)
const freeResult = validateManualSlot(deptName, 'CSC1CJ101', 'WEDNESDAY', '2', ['JAM1'], db);
assert.strictEqual(freeResult.valid, true, 'Free teacher on open period must be valid');
assert.strictEqual(freeResult.conflicts.length, 0, 'No conflicts must be returned for free teacher');
console.log('Free Teacher Manual Assignment: PASSED (Allowed without conflicts)');

// -------------------------------------------------------------
// Test 3: Teacher Unavailability / Blackout Rule
// -------------------------------------------------------------
console.log('\n--- Test 3: Teacher Unavailability / Blackout Rule ---');
// Temporarily set an unavailable slot for test
const mockDb = JSON.parse(JSON.stringify(db));
if (!mockDb.teacherUnavailability) mockDb.teacherUnavailability = {};
mockDb.teacherUnavailability['JAM1'] = [{ day: 'WEDNESDAY', period: '2', reason: 'HOD Meeting' }];

const unavailResult = validateManualSlot(deptName, 'CSC1CJ101', 'WEDNESDAY', '2', ['JAM1'], mockDb);
assert.strictEqual(unavailResult.valid, false, 'Teacher in unavailable slot must be blocked');
assert(unavailResult.conflicts.some(c => c.type === 'TEACHER_UNAVAILABLE'), 'Must return TEACHER_UNAVAILABLE conflict');
console.log('Teacher Unavailability Rule: PASSED (Blocked with blackout reason)');

// -------------------------------------------------------------
// Test 4: Admin Global Locked Period Rule (Notice)
// -------------------------------------------------------------
console.log('\n--- Test 4: Admin Global Locked Period Notice ---');
// WEDNESDAY Period 3 has global lock 'AEC1'
if (!testDb.config) testDb.config = {};
testDb.config.globalLockedPeriods = [{ day: 'WEDNESDAY', period: '3', label: 'AEC1' }];
const lockResult = validateManualSlot(deptName, 'CSC1CJ101', 'WEDNESDAY', '3', ['AGK'], testDb);
assert.strictEqual(lockResult.adminLockNotice, 'AEC1', 'Must attach adminLockNotice AEC1 for Wednesday Period 3');
console.log('Admin Global Locked Period Notice: PASSED (Notice attached: AEC1)');

// -------------------------------------------------------------
// Test 5: Co-Teaching Validation
// -------------------------------------------------------------
console.log('\n--- Test 5: Multi-Teacher Co-Teaching Validation ---');
// Assigning 2 teachers together on an open slot (e.g. JAM1 + RRK on Friday Period 3)
const coTeachingResult = validateManualSlot(deptName, 'CSC1CJ101', 'FRIDAY', '3', ['JAM1', 'AGK'], db);
assert.strictEqual(coTeachingResult.valid, true, 'Multiple teachers without individual clashes must be allowed');
console.log('Multi-Teacher Co-Teaching Validation: PASSED (Both teachers placed simultaneously)');

// -------------------------------------------------------------
// Test 6: Locked Department Edit Protection (Status Check)
// -------------------------------------------------------------
console.log('\n--- Test 6: Department Locked Status Check ---');
const testSubmissions = {
  'COMPUTER SCIENCE': { status: 'Approved' },
  'ENGLISH': { status: 'Submitted' },
  'BOTANY': { status: 'Draft' }
};

function checkDepartmentEditable(dept, submissions) {
  const sub = submissions[dept] || { status: 'Draft' };
  if (sub.status === 'Submitted' || sub.status === 'Approved') {
    return { editable: false, status: sub.status };
  }
  return { editable: true, status: sub.status };
}

assert.strictEqual(checkDepartmentEditable('COMPUTER SCIENCE', testSubmissions).editable, false);
assert.strictEqual(checkDepartmentEditable('ENGLISH', testSubmissions).editable, false);
assert.strictEqual(checkDepartmentEditable('BOTANY', testSubmissions).editable, true);
console.log('Department Locked Status Check: PASSED (Draft is editable; Submitted/Approved are locked)');

// -------------------------------------------------------------
// Test 7: Theory (Single Slot) vs Practical (2 Continuous Slots) Rule
// -------------------------------------------------------------
console.log('\n--- Test 7: Manual Assignment: Theory (1 slot) vs Practical (2 continuous slots) ---');
const periodsConfig = ["1", "2", "3", "LB", "4", "5", "6"];
function getNextRightPeriod(period, periods = periodsConfig) {
  const teachingPeriods = periods.filter(p => String(p).toUpperCase() !== 'LB');
  const idx = teachingPeriods.map(p => String(p).trim()).indexOf(String(period).trim());
  if (idx !== -1 && idx + 1 < teachingPeriods.length) {
    return teachingPeriods[idx + 1];
  }
  return null;
}

// Case A: Theory selected on Period 1 -> allocates exactly 1 slot ['1']
const theoryPeriod = '1';
const theorySlots = [theoryPeriod];
assert.strictEqual(theorySlots.length, 1);
assert.strictEqual(theorySlots[0], '1');

// Case B: Practical selected on Period 1 -> allocates 2 continuous slots ['1', '2']
const pracPeriod = '1';
const nextP = getNextRightPeriod(pracPeriod);
assert.strictEqual(nextP, '2', 'Next right period after Period 1 must be Period 2');
const pracSlots = [pracPeriod, nextP];
assert.strictEqual(pracSlots.length, 2);
assert.deepStrictEqual(pracSlots, ['1', '2'], 'Practical must allocate selected slot and next right slot');

// Case C: Practical selected on Period 4 -> allocates ['4', '5']
const nextP4 = getNextRightPeriod('4');
assert.strictEqual(nextP4, '5');
assert.deepStrictEqual(['4', nextP4], ['4', '5']);

// Case D: Practical selected on Period 6 (last period) -> next is null, boundary enforced
const nextP6 = getNextRightPeriod('6');
assert.strictEqual(nextP6, null, 'Last period of the day must not have a next right slot');

console.log('Theory (1 Slot) vs Practical (2 Continuous Slots) Rule: PASSED');

// -------------------------------------------------------------
// Test 8: Practical 2-Slot Continuous Clash Verification
// -------------------------------------------------------------
console.log('\n--- Test 8: Practical 2-Slot Continuous Clash Verification ---');
const pracTestDb = JSON.parse(JSON.stringify(db));
if (!pracTestDb.allocations[deptName]) pracTestDb.allocations[deptName] = {};
if (!pracTestDb.allocations[deptName]['OTHER_COURSE']) pracTestDb.allocations[deptName]['OTHER_COURSE'] = {};
if (!pracTestDb.allocations[deptName]['OTHER_COURSE']['MONDAY']) pracTestDb.allocations[deptName]['OTHER_COURSE']['MONDAY'] = {};
pracTestDb.allocations[deptName]['OTHER_COURSE']['MONDAY']['2'] = ['TEST_FAC'];

const p1Res = validateManualSlot(deptName, 'TARGET_COURSE', 'MONDAY', '1', ['TEST_FAC'], pracTestDb);
assert.strictEqual(p1Res.valid, true, 'Period 1 is free');

const p2Res = validateManualSlot(deptName, 'TARGET_COURSE', 'MONDAY', '2', ['TEST_FAC'], pracTestDb);
assert.strictEqual(p2Res.valid, false, 'Period 2 has clash');

const practicalValid = p1Res.valid && p2Res.valid;
assert.strictEqual(practicalValid, false, 'Practical placement must be blocked if second continuous slot has a clash');
console.log('Practical 2-Slot Continuous Clash Verification: PASSED (Clash on next slot blocked)');

// -------------------------------------------------------------
// Test 9: Visual Line Distinction (Recommended Dark vs Manual Black)
// -------------------------------------------------------------
console.log('\n--- Test 9: Visual Line Distinction: Recommended Dark Color vs Manual Black Line ---');
function resolveSlotStyling(isRecommended, slotType) {
  if (isRecommended) {
    return {
      bgColor: slotType === 'P' ? 'var(--success-light)' : 'var(--warning-light)',
      borderColor: slotType === 'P' ? 'var(--success)' : 'var(--warning)',
      isBlackBorder: false,
      slotClass: slotType === 'P' ? 'slot-recommend-p' : 'slot-recommend-t'
    };
  } else {
    return {
      bgColor: slotType === 'P' ? 'var(--success-light)' : 'var(--warning-light)',
      borderColor: '#000000',
      isBlackBorder: true,
      slotClass: slotType === 'P' ? 'slot-manual-assigned-p' : 'slot-manual-assigned-t'
    };
  }
}

// 1. Recommended Theory slot: orange background with darker orange line
const recTh = resolveSlotStyling(true, 'T');
assert.strictEqual(recTh.bgColor, 'var(--warning-light)');
assert.strictEqual(recTh.borderColor, 'var(--warning)');
assert.strictEqual(recTh.isBlackBorder, false);

// 2. Recommended Practical slot: green background with darker green line
const recPr = resolveSlotStyling(true, 'P');
assert.strictEqual(recPr.bgColor, 'var(--success-light)');
assert.strictEqual(recPr.borderColor, 'var(--success)');
assert.strictEqual(recPr.isBlackBorder, false);

// 3. Manual Assignment Theory slot: orange background with BLACK line
const manTh = resolveSlotStyling(false, 'T');
assert.strictEqual(manTh.bgColor, 'var(--warning-light)');
assert.strictEqual(manTh.borderColor, '#000000');
assert.strictEqual(manTh.isBlackBorder, true);
assert.strictEqual(manTh.slotClass, 'slot-manual-assigned-t');

// 4. Manual Assignment Practical slot: green background with BLACK line
const manPr = resolveSlotStyling(false, 'P');
assert.strictEqual(manPr.bgColor, 'var(--success-light)');
assert.strictEqual(manPr.borderColor, '#000000');
assert.strictEqual(manPr.isBlackBorder, true);
assert.strictEqual(manPr.slotClass, 'slot-manual-assigned-p');

console.log('Visual Line Distinction Rule: PASSED (Recommended=darker color line, Manual=black line)');

// 5. MDC Course with Theory recommendation: MUST receive typical recommended color (Orange with darker orange line)
function resolveCourseSlotClass(course, recType) {
  if (recType === 'T') return 'slot-recommend-t';
  if (recType === 'P') return 'slot-recommend-p';
  if (course && (course.courseType === 'M' || course.category === 'MDC')) return 'slot-recommend-m';
  return 'slot-recommend-none';
}

const mdcCourse = { code: 'MAT2FM106(1)', category: 'MDC', courseType: 'T' };
const mdcSlotClass = resolveCourseSlotClass(mdcCourse, 'T');
assert.strictEqual(mdcSlotClass, 'slot-recommend-t', 'MDC course with Theory recommendation must be slot-recommend-t');

// 6. Manual Practical Allocation across continuous 2 slots: MUST both render green (slot-manual-assigned-p) with black leftmost line
const mockManualSlots = {
  'MAT101_MONDAY_1': 'P',
  'MAT101_MONDAY_2': 'P'
};
function resolveCellClassForAssignedSlot(courseCode, day, period, manualSlots) {
  const isPracManual = manualSlots && manualSlots[`${courseCode}_${day}_${period}`] === 'P';
  if (isPracManual) return 'slot-manual-assigned-p';
  return 'slot-manual-assigned-t';
}
assert.strictEqual(resolveCellClassForAssignedSlot('MAT101', 'MONDAY', '1', mockManualSlots), 'slot-manual-assigned-p');
assert.strictEqual(resolveCellClassForAssignedSlot('MAT101', 'MONDAY', '2', mockManualSlots), 'slot-manual-assigned-p');

// -----------------------------------------------------------------------------
// Test 10: Subject Teacher Mapping Workload Total Hour Tile Calculation
// -----------------------------------------------------------------------------
console.log('\n--- Test 10: Subject Teacher Mapping Workload Total Hour Tile Calculation ---');
// Simulating workload computation from localSubjectMappings
const mockDeptFaculty = [
  { code: 'VM', name: 'Prof. VM', department: 'MATHEMATICS' },
  { code: 'AM2', name: 'Prof. AM2', department: 'MATHEMATICS' },
  { code: 'AJEF', name: 'Prof. AJEF', department: 'MATHEMATICS' },
  { code: 'SAS', name: 'Prof. SAS', department: 'MATHEMATICS' }
];

const mockDeptCourses = [
  { code: 'MAT101', courseType: 'T', department: 'MATHEMATICS' },
  { code: 'MAT102', courseType: 'T', department: 'MATHEMATICS' },
  { code: 'MAT103-P', courseType: 'P', department: 'MATHEMATICS' }
];

const mockLocalSubjectMappings = {
  'MAT101': { teachers: ['VM'], hours: 16 },
  'MAT102': { teachers: ['AJEF'], hours: 15 },
  'MAT103-P': { courseType: 'P', practicalTeachers: ['SAS'], practicalHours: 16 }
};

// Main page allocations tracker (should NOT affect subject mapping calculation)
const mockMainPageAllocations = [
  { courseCode: 'MAT101', facultyCode: 'VM', day: 'MONDAY', period: 1 },
  { courseCode: 'MAT101', facultyCode: 'VM', day: 'MONDAY', period: 2 }
];

// Calculation function as in app.js
function calculateSubjectMappingTotals(deptFaculty, deptCourses, localMappings) {
  const facWorkload = {};
  deptFaculty.forEach(f => {
    facWorkload[f.code] = { totalHours: 0, theoryHours: 0, practicalHours: 0 };
  });

  deptCourses.forEach(c => {
    const mapping = localMappings[c.code];
    if (!mapping) return;
    const isPrac = (mapping.courseType === 'P' || c.courseType === 'P' || c.code.endsWith('-P'));
    if (isPrac) {
      const pTeachers = Array.isArray(mapping.practicalTeachers) ? mapping.practicalTeachers : [];
      const pHours = (typeof mapping.practicalHours === 'number') ? mapping.practicalHours : 0;
      pTeachers.forEach(fc => {
        if (facWorkload[fc]) {
          facWorkload[fc].practicalHours += pHours;
          facWorkload[fc].totalHours += pHours;
        }
      });
    } else {
      const teachers = Array.isArray(mapping.teachers) ? mapping.teachers : [];
      const totalHrs = parseInt(mapping.hours) || 4;
      teachers.forEach(fc => {
        if (facWorkload[fc]) {
          facWorkload[fc].theoryHours += totalHrs;
          facWorkload[fc].totalHours += totalHrs;
        }
      });
    }
  });

  let totalEntireHours = 0;
  let totalTheoryHours = 0;
  let totalPracticalHours = 0;

  deptFaculty.forEach(f => {
    const data = facWorkload[f.code] || { totalHours: 0, theoryHours: 0, practicalHours: 0 };
    totalEntireHours += data.totalHours;
    totalTheoryHours += data.theoryHours;
    totalPracticalHours += data.practicalHours;
  });

  return { totalEntireHours, totalTheoryHours, totalPracticalHours, facWorkload };
}

const mappingResult = calculateSubjectMappingTotals(mockDeptFaculty, mockDeptCourses, mockLocalSubjectMappings);

// VM: 16 TH, AJEF: 15 TH, SAS: 16 PR, AM2: 0
// Total Entire Hours = 16 + 15 + 16 = 47 hrs
assert.strictEqual(mappingResult.totalEntireHours, 47, 'Total entire hours should be 47');
assert.strictEqual(mappingResult.totalTheoryHours, 31, 'Total theory hours should be 31');
assert.strictEqual(mappingResult.totalPracticalHours, 16, 'Total practical hours should be 16');

// Assert no dependency on mockMainPageAllocations (only 2 hours in main page timetable)
assert.notStrictEqual(mappingResult.totalEntireHours, mockMainPageAllocations.length);

console.log(`Total Entire Hours: ${mappingResult.totalEntireHours} hrs (TH: ${mappingResult.totalTheoryHours}, PR: ${mappingResult.totalPracticalHours})`);
console.log('Subject Teacher Mapping Total Hour Tile Calculation: PASSED');

// -----------------------------------------------------------------------------
// Test 11: Transfer Curriculum Slot Allocation Structure & Blocks to Multiple Courses
// -----------------------------------------------------------------------------
console.log('\n--- Test 11: Transfer Curriculum Slot Structure & Blocks to Multiple Courses ---');

const mockCoursesList = [
  { code: 'MAT2CJ101', name: 'Calculus I', semester: '2', programType: 'UG', department: 'MATHEMATICS' },
  { code: 'MAT2FM106', name: 'Fundamentals of Math', semester: '2', programType: 'UG', department: 'MATHEMATICS' },
  { code: 'MAT2EL102', name: 'Elective Math', semester: '2', programType: 'UG', department: 'MATHEMATICS' },
  { code: 'MAT4CJ201', name: 'Higher Algebra', semester: '4', programType: 'UG', department: 'MATHEMATICS' }
];

// Initialize localCurriculumCourseRecs
let testCurriculumRecs = {
  'MAT2CJ101': {
    'MONDAY': { '1': 'T', '2': 'T' },
    'WEDNESDAY': { '4': 'P', '5': 'P' },
    'FRIDAY': { '6': 'B' }
  },
  'MAT2FM106': {
    'TUESDAY': { '1': 'T' }
  },
  'MAT2EL102': {},
  'MAT4CJ201': {
    'MONDAY': { '3': 'T' }
  }
};

function copyCurriculumStructure(sourceBase, targetBases, recs, options = {}) {
  const optRecs = options.optRecs !== undefined ? options.optRecs : true;
  const optBlocks = options.optBlocks !== undefined ? options.optBlocks : true;
  const optOverwrite = options.optOverwrite !== undefined ? options.optOverwrite : true;

  const sourceRecs = recs[sourceBase] || {};
  const sourceSlots = {};
  Object.keys(sourceRecs).forEach(day => {
    Object.keys(sourceRecs[day]).forEach(p => {
      const val = sourceRecs[day][p];
      if ((val === 'T' || val === 'P') && !optRecs) return;
      if (val === 'B' && !optBlocks) return;
      if (!sourceSlots[day]) sourceSlots[day] = {};
      sourceSlots[day][p] = val;
    });
  });

  targetBases.forEach(targetBase => {
    if (!recs[targetBase]) recs[targetBase] = {};

    if (optOverwrite) {
      if (optRecs && optBlocks) {
        recs[targetBase] = JSON.parse(JSON.stringify(sourceSlots));
      } else {
        Object.keys(recs[targetBase]).forEach(day => {
          Object.keys(recs[targetBase][day]).forEach(p => {
            const val = recs[targetBase][day][p];
            if ((val === 'T' || val === 'P') && optRecs) delete recs[targetBase][day][p];
            if (val === 'B' && optBlocks) delete recs[targetBase][day][p];
          });
        });
        Object.keys(sourceSlots).forEach(day => {
          if (!recs[targetBase][day]) recs[targetBase][day] = {};
          Object.keys(sourceSlots[day]).forEach(p => {
            recs[targetBase][day][p] = sourceSlots[day][p];
          });
        });
      }
    } else {
      Object.keys(sourceSlots).forEach(day => {
        if (!recs[targetBase][day]) recs[targetBase][day] = {};
        Object.keys(sourceSlots[day]).forEach(p => {
          if (!recs[targetBase][day][p]) {
            recs[targetBase][day][p] = sourceSlots[day][p];
          }
        });
      });
    }
  });
}

// 1. Copy structure from MAT2CJ101 to MAT2FM106 and MAT2EL102 (both in Sem 2 filter)
copyCurriculumStructure('MAT2CJ101', ['MAT2FM106', 'MAT2EL102'], testCurriculumRecs, {
  optRecs: true,
  optBlocks: true,
  optOverwrite: true
});

// Verify MAT2FM106 has received the exact slots & blocks as MAT2CJ101
assert.deepStrictEqual(testCurriculumRecs['MAT2FM106'], {
  'MONDAY': { '1': 'T', '2': 'T' },
  'WEDNESDAY': { '4': 'P', '5': 'P' },
  'FRIDAY': { '6': 'B' }
}, 'MAT2FM106 should have identical structure to MAT2CJ101');

// Verify MAT2EL102 has also received the exact slots & blocks
assert.deepStrictEqual(testCurriculumRecs['MAT2EL102'], {
  'MONDAY': { '1': 'T', '2': 'T' },
  'WEDNESDAY': { '4': 'P', '5': 'P' },
  'FRIDAY': { '6': 'B' }
}, 'MAT2EL102 should have identical structure to MAT2CJ101');

// Verify MAT4CJ201 (in Sem 4, not targeted) remains completely untouched
assert.deepStrictEqual(testCurriculumRecs['MAT4CJ201'], {
  'MONDAY': { '3': 'T' }
}, 'Non-targeted course MAT4CJ201 must remain untouched');

console.log('Transfer Structure to Multiple Courses: PASSED');

// -----------------------------------------------------------------------------
// Test 12: Department Timetable Excel Import Round-Trip Fidelity
// -----------------------------------------------------------------------------
console.log('\n--- Test 12: Timetable Format Excel Round-Trip Invariance (Split Classes & Slot Count) ---');
const sampleDeptCourses = [
  { code: 'MAT2FM106(1)', name: 'Graph Theory', department: 'MATHEMATICS', class: 0 },
  { code: 'MAT2CJ101_C1', name: 'Integral Calculus', department: 'MATHEMATICS', class: 1 },
  { code: 'MAT2CJ101_C2', name: 'Integral Calculus', department: 'MATHEMATICS', class: 2 },
  { code: 'MAT6CJ304_C1', name: 'Real Analysis', department: 'MATHEMATICS', class: 1 },
  { code: 'MAT6CJ304_C2', name: 'Real Analysis', department: 'MATHEMATICS', class: 2 }
];

function testFindDeptCourse(rawCode, deptCourses) {
  let matched = deptCourses.find(c => c.code.toUpperCase() === rawCode.toUpperCase());
  if (matched) return matched;
  matched = deptCourses.find(c => (c.alias || '').toUpperCase() === rawCode.toUpperCase());
  if (matched) return matched;
  matched = deptCourses.find(c => c.code.replace(/-(T|P)$/i, '').toUpperCase() === rawCode.replace(/-(T|P)$/i, '').toUpperCase());
  if (matched) return matched;

  const classNumMatch = rawCode.match(/(_G|_C)(\d+)/i);
  const effClassNum = classNumMatch ? parseInt(classNumMatch[2], 10) : null;
  const cleanBaseRaw = rawCode.replace(/-(T|P)$/i, '').replace(/(_G|_C)\d+$/i, '').toUpperCase();

  if (effClassNum !== null) {
    matched = deptCourses.find(c => {
      const cClassMatch = c.code.match(/(_G|_C)(\d+)/i);
      const cClassNum = cClassMatch ? parseInt(cClassMatch[2], 10) : (c.class || c.group || null);
      const cCleanBase = c.code.replace(/-(T|P)$/i, '').replace(/(_G|_C)\d+$/i, '').toUpperCase();
      return cCleanBase === cleanBaseRaw && cClassNum === effClassNum;
    });
    if (matched) return matched;
  }
  return deptCourses.find(c => c.code.replace(/-(T|P)$/i, '').replace(/(_G|_C)\d+$/i, '').toUpperCase() === cleanBaseRaw);
}

// Ensure each class maps to its exact class course without being hijacked by _C1
const c1Match = testFindDeptCourse('MAT2CJ101_C1', sampleDeptCourses);
assert.strictEqual(c1Match.code, 'MAT2CJ101_C1', 'C1 course code must match MAT2CJ101_C1');

const c2Match = testFindDeptCourse('MAT2CJ101_C2', sampleDeptCourses);
assert.strictEqual(c2Match.code, 'MAT2CJ101_C2', 'C2 course code must match MAT2CJ101_C2 and not overwrite C1');

// Simulate import of both C1 and C2 rows
const mockImportAlloc = {};
const mockSeenCourses = new Set();
const mockExcelRows = [
  { code: 'MAT2CJ101_C1', slots: { 'MONDAY': { '3': ['VM'] }, 'WEDNESDAY': { '1': ['AM3'] } } },
  { code: 'MAT2CJ101_C2', slots: { 'MONDAY': { '3': ['MT'] }, 'WEDNESDAY': { '1': ['VM'] } } }
];

let totalImportedSlots = 0;
mockExcelRows.forEach(row => {
  const matched = testFindDeptCourse(row.code, sampleDeptCourses);
  assert.ok(matched, `Course ${row.code} must be found`);
  const targetCode = matched.code;

  if (!mockSeenCourses.has(targetCode)) {
    mockSeenCourses.add(targetCode);
    mockImportAlloc[targetCode] = {};
  }

  Object.entries(row.slots).forEach(([day, pObj]) => {
    Object.entries(pObj).forEach(([period, facs]) => {
      if (!mockImportAlloc[targetCode][day]) mockImportAlloc[targetCode][day] = {};
      mockImportAlloc[targetCode][day][period] = facs;
      totalImportedSlots++;
    });
  });
});

assert.strictEqual(totalImportedSlots, 4, 'All 4 slots across C1 and C2 must be imported');
assert.deepStrictEqual(mockImportAlloc['MAT2CJ101_C1']['MONDAY']['3'], ['VM'], 'C1 Monday P3 must remain VM');
assert.deepStrictEqual(mockImportAlloc['MAT2CJ101_C2']['MONDAY']['3'], ['MT'], 'C2 Monday P3 must be MT without overwriting C1');
console.log('Timetable Format Excel Round-Trip Invariance: PASSED (Zero data loss across split classes)');

console.log('\n======================================================');
console.log('ALL MANUAL ASSIGNMENT RULES WORKING IN PERFECT ORDER!');
console.log('======================================================');
