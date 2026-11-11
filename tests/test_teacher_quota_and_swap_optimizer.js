import assert from 'assert';
import {
  getExpectedTeacherHours,
  auditTeacherHourQuotas,
  runTeacherSwapOptimizer
} from '../server/scheduler.js';

console.log('=== Running Teacher Quota Scrutiny & Intra-Course Teacher Swap Optimizer Tests ===\n');

// ---------------------------------------------------------------------------
// TEST 1: Teacher Quota Scrutiny & Invariance Audit
// ---------------------------------------------------------------------------
console.log('--- Test 1: Teacher Quota Scrutiny & Neutral Slot Overflow Trimming ---');

const testDb = {
  faculty: [
    { code: 'T_ALICE', name: 'Prof. Alice' },
    { code: 'T_BOB', name: 'Prof. Bob' }
  ],
  subjectTeacherMapping: {
    MATHEMATICS: {
      'MAT101': {
        courseType: 'T',
        teachers: ['T_ALICE', 'T_BOB'],
        theoryTeachers: ['T_ALICE', 'T_BOB'],
        hours: 4,
        theoryTeacherHours: {
          'T_ALICE': 2,
          'T_BOB': 2
        }
      }
    }
  }
};

const courseMat101 = {
  code: 'MAT101',
  name: 'Calculus I',
  department: 'MATHEMATICS',
  courseType: 'T',
  hours: 4,
  recommendations: {
    MONDAY: { '1': 'T' },
    WEDNESDAY: { '1': 'T' }
  }
};

// Verify getExpectedTeacherHours
const expected = getExpectedTeacherHours(courseMat101, {}, testDb, 'MATHEMATICS');
assert.strictEqual(expected['T_ALICE'], 2, 'Alice expected hours should be 2');
assert.strictEqual(expected['T_BOB'], 2, 'Bob expected hours should be 2');
console.log('✓ getExpectedTeacherHours correctly extracted mapped quotas:', expected);

// Create an allocation where Alice was given 3 hours (1 excess hour in neutral Friday P3)
const allocationsWithExcess = {
  'MAT101': {
    MONDAY: { '1': ['T_ALICE'] },      // Recommended slot
    WEDNESDAY: { '1': ['T_BOB'] },     // Recommended slot
    THURSDAY: { '2': ['T_BOB'] },      // Neutral slot
    FRIDAY: { '2': ['T_ALICE'], '3': ['T_ALICE'] } // Friday P2 & P3 are neutral slots (excess!)
  }
};

// Snapshot testDb.subjectTeacherMapping to verify strict read-only access
const originalMappingSnapshot = JSON.stringify(testDb.subjectTeacherMapping);

const auditResult = auditTeacherHourQuotas({
  allocations: allocationsWithExcess,
  targetCourses: [courseMat101],
  courseFacultyConfig: {},
  db: testDb,
  deptUpper: 'MATHEMATICS',
  pinnedSlots: {}
});

assert.strictEqual(auditResult.compliant, false, 'Audit must detect excess quota');
assert.strictEqual(auditResult.discrepancies.length, 1, 'Exactly 1 discrepancy detected');
const disc = auditResult.discrepancies[0];
assert.strictEqual(disc.facultyCode, 'T_ALICE', 'Discrepancy must pinpoint T_ALICE');
assert.strictEqual(disc.courseCode, 'MAT101', 'Discrepancy must pinpoint MAT101');
assert.strictEqual(disc.mappedHours, 2, 'Mapped hours must be 2');
assert.strictEqual(disc.excessHours, 1, 'Excess hours must be 1');
assert.strictEqual(auditResult.trimActions.length, 1, 'Exactly 1 neutral slot trimmed');
assert.strictEqual(auditResult.trimActions[0].day, 'FRIDAY');
assert.strictEqual(auditResult.trimActions[0].period, '3', 'Trimmed the neutral Friday P3 slot');

// Verify recommended slots were NOT touched
assert.deepStrictEqual(allocationsWithExcess['MAT101']['MONDAY']['1'], ['T_ALICE'], 'Recommended Monday P1 preserved');
assert.deepStrictEqual(allocationsWithExcess['MAT101']['WEDNESDAY']['1'], ['T_BOB'], 'Recommended Wednesday P1 preserved');
// Verify Friday P3 was trimmed
assert.strictEqual(allocationsWithExcess['MAT101']['FRIDAY']['3'], undefined, 'Friday P3 neutral excess was removed');

// Verify db.subjectTeacherMapping is completely unmodified
assert.strictEqual(JSON.stringify(testDb.subjectTeacherMapping), originalMappingSnapshot, 'db.subjectTeacherMapping must remain 100% read-only');
console.log('✓ Teacher Quota Scrutiny & Invariance Audit: PASSED (Pinpointed excess, trimmed neutral slot, read-only STM preserved)\n');


// ---------------------------------------------------------------------------
// TEST 2: Intra-Course Teacher Swap Optimizer (User Sem 1 vs Sem 5 Scenario)
// ---------------------------------------------------------------------------
console.log('--- Test 2: Intra-Course Teacher Swap Optimizer (Sem 1 vs Sem 5 Bottleneck Resolution) ---');

/**
 * Scenario:
 * Sem 1 course 'MAT1CJ101' is taught by Prof. A and Prof. B (2 hours each).
 * It is currently scheduled at:
 *   - MONDAY P2: Prof. A (Recommended 'T')
 *   - WEDNESDAY P2: Prof. B (Recommended 'T')
 *   - THURSDAY P1: Prof. A
 *   - FRIDAY P3: Prof. B
 * 
 * Sem 5 course 'MAT5CJ301' needs 1 hour with Prof. A.
 * The ONLY available slot for Sem 5 is MONDAY P2 (all other slots are blocked or cohort clashes).
 * Direct placement fails because Prof. A is teaching MAT1CJ101 on Monday P2.
 * 
 * Solution:
 * Swapping Prof. A and Prof. B on MAT1CJ101 between Monday P2 and Wednesday P2:
 *   - Monday P2 is now Prof. B
 *   - Wednesday P2 is now Prof. A
 *   - Both Monday P2 and Wednesday P2 stay exactly in their slots (100% frozen)
 *   - Monday P2 is now free for Prof. A to teach MAT5CJ301!
 */
const multiCohortDb = {
  periods: ['1', '2', '3', 'LB', '4', '5', '6'],
  faculty: [
    { code: 'PROF_A', name: 'Prof. Alice' },
    { code: 'PROF_B', name: 'Prof. Bob' }
  ],
  globalLockedPeriods: [
    // Period 1, 3, 4, 5, 6 locked for Semester 5 (only Period 2 open on Monday & Wednesday)
    { day: 'MONDAY', period: '1', semester: '5' },
    { day: 'MONDAY', period: '3', semester: '5' },
    { day: 'MONDAY', period: '4', semester: '5' },
    { day: 'MONDAY', period: '5', semester: '5' },
    { day: 'MONDAY', period: '6', semester: '5' },
    { day: 'TUESDAY', period: 'all', semester: '5' },
    { day: 'WEDNESDAY', period: '1', semester: '5' },
    { day: 'WEDNESDAY', period: '2', semester: '5' }, // Wed P2 locked for Sem 5!
    { day: 'WEDNESDAY', period: '3', semester: '5' },
    { day: 'WEDNESDAY', period: '4', semester: '5' },
    { day: 'WEDNESDAY', period: '5', semester: '5' },
    { day: 'WEDNESDAY', period: '6', semester: '5' },
    { day: 'THURSDAY', period: 'all', semester: '5' },
    { day: 'FRIDAY', period: 'all', semester: '5' }
  ],
  subjectTeacherMapping: {
    MATHEMATICS: {
      'MAT1CJ101': {
        courseType: 'T',
        teachers: ['PROF_A', 'PROF_B'],
        hours: 4,
        theoryTeacherHours: { 'PROF_A': 2, 'PROF_B': 2 }
      },
      'MAT5CJ301': {
        courseType: 'T',
        teachers: ['PROF_A'],
        hours: 1,
        theoryTeacherHours: { 'PROF_A': 1 }
      }
    }
  }
};

const courses = [
  {
    code: 'MAT1CJ101',
    name: 'Introductory Analysis',
    semester: '1',
    programType: 'UG',
    department: 'MATHEMATICS',
    courseType: 'T',
    hours: 4,
    recommendations: {
      MONDAY: { '2': 'T' },
      WEDNESDAY: { '2': 'T' }
    }
  },
  {
    code: 'MAT5CJ301',
    name: 'Advanced Topology',
    semester: '5',
    programType: 'UG',
    department: 'MATHEMATICS',
    courseType: 'T',
    hours: 1,
    recommendations: {
      MONDAY: { '2': 'T' }
    }
  }
];

const initialAllocations = {
  'MAT1CJ101': {
    MONDAY: { '2': ['PROF_A'] },
    WEDNESDAY: { '2': ['PROF_B'] },
    THURSDAY: { '1': ['PROF_A'] },
    FRIDAY: { '3': ['PROF_B'] }
  },
  'MAT5CJ301': {}
};

const unassigned = [
  {
    courseCode: 'MAT5CJ301',
    facultyCode: 'PROF_A',
    unassignedHours: 1,
    type: 'Theory'
  }
];

const swapResult = runTeacherSwapOptimizer({
  allocations: initialAllocations,
  targetCourses: courses,
  courseFacultyConfig: {},
  db: multiCohortDb,
  deptUpper: 'MATHEMATICS',
  pinnedSlots: {},
  unassignedItems: unassigned,
  maxConsecutiveHours: 2
});

assert.strictEqual(swapResult.resolvedCount, 1, 'Should resolve 1 unassigned hour');
assert.strictEqual(swapResult.fullyResolvedCourses.has('MAT5CJ301'), true, 'MAT5CJ301 must be fully resolved');

// Invariants Verification:
// 1. Slot Immutability: MAT1CJ101 still scheduled at MONDAY P2 and WEDNESDAY P2
assert(initialAllocations['MAT1CJ101']['MONDAY']['2'], 'Monday P2 slot on MAT1CJ101 must remain scheduled');
assert(initialAllocations['MAT1CJ101']['WEDNESDAY']['2'], 'Wednesday P2 slot on MAT1CJ101 must remain scheduled');

// 2. Swapped Teachers on MAT1CJ101: Monday P2 now has PROF_B, Wednesday P2 now has PROF_A
assert.deepStrictEqual(initialAllocations['MAT1CJ101']['MONDAY']['2'], ['PROF_B'], 'Monday P2 on MAT1CJ101 must now be taught by PROF_B');
assert.deepStrictEqual(initialAllocations['MAT1CJ101']['WEDNESDAY']['2'], ['PROF_A'], 'Wednesday P2 on MAT1CJ101 must now be taught by PROF_A');

// 3. MAT5CJ301 is now placed on MONDAY P2 with PROF_A
assert.deepStrictEqual(initialAllocations['MAT5CJ301']['MONDAY']['2'], ['PROF_A'], 'MAT5CJ301 must be placed on Monday P2 with PROF_A');

// 4. Quota Conservation:
// MAT1CJ101: PROF_A has 2 hours (Wed P2, Thu P1), PROF_B has 2 hours (Mon P2, Fri P3)
let profAHours = 0;
let profBHours = 0;
['MONDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].forEach(d => {
  Object.keys(initialAllocations['MAT1CJ101'][d] || {}).forEach(p => {
    if (initialAllocations['MAT1CJ101'][d][p].includes('PROF_A')) profAHours++;
    if (initialAllocations['MAT1CJ101'][d][p].includes('PROF_B')) profBHours++;
  });
});
assert.strictEqual(profAHours, 2, 'PROF_A must still have exactly 2 hours on MAT1CJ101');
assert.strictEqual(profBHours, 2, 'PROF_B must still have exactly 2 hours on MAT1CJ101');

console.log('✓ Swap optimizer successfully swapped teachers, preserved slot timings, and placed MAT5CJ301: PASSED');
console.log('  Swap Log:', swapResult.swapLog[0], '\n');


// ---------------------------------------------------------------------------
// TEST 3: Invariance Gate Rejections (Safety Barriers)
// ---------------------------------------------------------------------------
console.log('--- Test 3: Invariance Gate Safety Barriers ---');

// Case 3a: Swap partner has blackout / unavailable slot
const dbWithBlackout = JSON.parse(JSON.stringify(multiCohortDb));
dbWithBlackout.teacherAvailability = {
  'PROF_B': [{ day: 'MONDAY', period: '2' }] // Bob unavailable on Monday P2!
};

const allocBlockedByBlackout = {
  'MAT1CJ101': {
    MONDAY: { '2': ['PROF_A'] },
    WEDNESDAY: { '2': ['PROF_B'] },
    THURSDAY: { '1': ['PROF_A'] },
    FRIDAY: { '3': ['PROF_B'] }
  },
  'MAT5CJ301': {}
};

const resBlackout = runTeacherSwapOptimizer({
  allocations: allocBlockedByBlackout,
  targetCourses: courses,
  courseFacultyConfig: {},
  db: dbWithBlackout,
  deptUpper: 'MATHEMATICS',
  pinnedSlots: {},
  unassignedItems: [{ courseCode: 'MAT5CJ301', facultyCode: 'PROF_A', unassignedHours: 1, type: 'Theory' }],
  maxConsecutiveHours: 2
});

console.log('resBlackout.swapLog:', resBlackout.swapLog);
assert.strictEqual(resBlackout.resolvedCount, 0, 'Swap must be rejected when partner has blackout on slot');
assert.deepStrictEqual(allocBlockedByBlackout['MAT1CJ101']['MONDAY']['2'], ['PROF_A'], 'No swap executed if blackout gate fails');
console.log('✓ Gate 4 (Blackout Rejection): PASSED');

// Case 3b: Single teacher course cannot swap
const singleTeacherCourses = [
  {
    code: 'SINGLE101',
    name: 'Single Course',
    semester: '1',
    programType: 'UG',
    department: 'MATHEMATICS',
    courseType: 'T',
    hours: 2,
    teachers: ['PROF_A']
  },
  {
    code: 'MAT5CJ301',
    name: 'Advanced Topology',
    semester: '5',
    programType: 'UG',
    department: 'MATHEMATICS',
    courseType: 'T',
    hours: 1
  }
];

const singleTeacherAlloc = {
  'SINGLE101': {
    MONDAY: { '2': ['PROF_A'] }
  },
  'MAT5CJ301': {}
};

const resSingle = runTeacherSwapOptimizer({
  allocations: singleTeacherAlloc,
  targetCourses: singleTeacherCourses,
  courseFacultyConfig: {},
  db: multiCohortDb,
  deptUpper: 'MATHEMATICS',
  pinnedSlots: {},
  unassignedItems: [{ courseCode: 'MAT5CJ301', facultyCode: 'PROF_A', unassignedHours: 1, type: 'Theory' }],
  maxConsecutiveHours: 2
});

assert.strictEqual(resSingle.resolvedCount, 0, 'Cannot swap when obstacle course is single-teacher');
console.log('✓ Gate 2 (Single-Teacher Pool Gate Rejection): PASSED');

// Case 3c: Cross-department external clash prevents swap
const dbWithCrossDeptClash = JSON.parse(JSON.stringify(multiCohortDb));
dbWithCrossDeptClash.allocations = {
  PHYSICS: {
    'PHY101': {
      MONDAY: { '2': ['PROF_B'] } // Bob is teaching Physics on Monday P2!
    }
  }
};

const allocCrossClash = {
  'MAT1CJ101': {
    MONDAY: { '2': ['PROF_A'] },
    WEDNESDAY: { '2': ['PROF_B'] }
  },
  'MAT5CJ301': {}
};

const resCross = runTeacherSwapOptimizer({
  allocations: allocCrossClash,
  targetCourses: courses,
  courseFacultyConfig: {},
  db: dbWithCrossDeptClash,
  deptUpper: 'MATHEMATICS',
  pinnedSlots: {},
  unassignedItems: [{ courseCode: 'MAT5CJ301', facultyCode: 'PROF_A', unassignedHours: 1, type: 'Theory' }],
  maxConsecutiveHours: 2
});

assert.strictEqual(resCross.resolvedCount, 0, 'Swap must be rejected when partner has clash in another department');
assert.deepStrictEqual(allocCrossClash['MAT1CJ101']['MONDAY']['2'], ['PROF_A'], 'No swap executed if cross-department clash exists');
console.log('✓ Gate 4 (Cross-Department Clash Rejection): PASSED');

console.log('\n--- Test 4: End-to-End generateDepartmentSchedule with Quota Audit Integration ---');
import { generateDepartmentSchedule } from '../server/scheduler.js';

const e2eDb = {
  periods: ['1', '2', '3', 'LB', '4', '5', '6'],
  faculty: [
    { code: 'T_ALICE', name: 'Prof. Alice' },
    { code: 'T_BOB', name: 'Prof. Bob' }
  ],
  courses: [courseMat101],
  globalLockedPeriods: [],
  subjectTeacherMapping: {
    MATHEMATICS: {
      'MAT101': {
        courseType: 'T',
        teachers: ['T_ALICE', 'T_BOB'],
        theoryTeachers: ['T_ALICE', 'T_BOB'],
        hours: 4,
        theoryTeacherHours: { 'T_ALICE': 2, 'T_BOB': 2 }
      }
    }
  }
};

const genResult = generateDepartmentSchedule({
  db: e2eDb,
  departmentName: 'MATHEMATICS',
  semester: '1',
  selectedCourseCodes: ['MAT101']
});

assert.strictEqual(genResult.success, true, 'Generation should succeed');
assert(genResult.quotaAudit, 'Result must include quotaAudit report');
assert.strictEqual(genResult.quotaAudit.compliant, true, 'Clean generation must be 100% quota compliant');
assert.strictEqual(genResult.quotaAudit.discrepancies.length, 0, 'No discrepancies in clean run');

// Check exact allocated hours
let aliceCount = 0;
let bobCount = 0;
['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].forEach(d => {
  Object.keys((genResult.allocations['MAT101'] && genResult.allocations['MAT101'][d]) || {}).forEach(p => {
    if (genResult.allocations['MAT101'][d][p].includes('T_ALICE')) aliceCount++;
    if (genResult.allocations['MAT101'][d][p].includes('T_BOB')) bobCount++;
  });
});

assert.strictEqual(aliceCount, 2, 'Alice must be allocated exactly mapped 2 hours');
assert.strictEqual(bobCount, 2, 'Bob must be allocated exactly mapped 2 hours');
console.log('✓ E2E Timetable Generation Quota Invariance Audit: PASSED (Alice: 2, Bob: 2, 0 excess)');

console.log('\n=============================================================');
console.log('ALL TEACHER QUOTA SCRUTINY & SWAP OPTIMIZER TESTS PASSED!');
console.log('=============================================================');
