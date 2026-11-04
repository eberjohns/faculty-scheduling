import assert from 'assert';
import { generateDepartmentSchedule } from '../server/scheduler.js';

console.log('--- TEST: Multi-Teacher Quotas and Clash Prevention ---');

// Build mock DB
const mockDb = {
  config: {
    periods: ['1', '2', '3', 'LB', '4', '5', '6'],
    globalLockedPeriods: []
  },
  departments: {
    'MATHEMATICS': { name: 'Mathematics', code: 'MAT' }
  },
  courses: [
    {
      code: 'MAT2CJ101_C1',
      name: 'Integral Calculus',
      department: 'MATHEMATICS',
      semester: '2',
      courseType: 'T',
      hours: 4,
      teachers: ['VM', 'AM3'],
      teacherHours: { VM: 2, AM3: 2 },
      recommendations: {
        MONDAY: { '3': 'T' },
        TUESDAY: {},
        WEDNESDAY: { '1': 'T' },
        THURSDAY: { '4': 'T' },
        FRIDAY: { '2': 'T' }
      }
    },
    {
      code: 'MAT2CJ101_C2',
      name: 'Integral Calculus',
      department: 'MATHEMATICS',
      semester: '2',
      courseType: 'T',
      hours: 4,
      teachers: ['VM', 'MT'],
      teacherHours: { VM: 2, MT: 2 },
      recommendations: {
        MONDAY: { '3': 'T' },
        TUESDAY: {},
        WEDNESDAY: { '1': 'T' },
        THURSDAY: { '4': 'T' },
        FRIDAY: { '2': 'T' }
      }
    }
  ],
  faculty: [
    { code: 'VM', name: 'Dr. V M', department: 'MATHEMATICS' },
    { code: 'AM3', name: 'Dr. A M', department: 'MATHEMATICS' },
    { code: 'MT', name: 'Mr. M T', department: 'MATHEMATICS' }
  ],
  allocations: {
    'MATHEMATICS': {}
  },
  submissions: {},
  teacherUnavailability: {},
  subjectTeacherMapping: {
    'MATHEMATICS': {
      'MAT2CJ101_C1': {
        hours: 4,
        courseType: 'T',
        teachers: ['VM', 'AM3'],
        teacherHours: { VM: 2, AM3: 2 },
        theoryTeachers: ['VM', 'AM3'],
        theoryTeacherHours: { VM: 2, AM3: 2 }
      },
      'MAT2CJ101_C2': {
        hours: 4,
        courseType: 'T',
        teachers: ['VM', 'MT'],
        teacherHours: { VM: 2, MT: 2 },
        theoryTeachers: ['VM', 'MT'],
        theoryTeacherHours: { VM: 2, MT: 2 }
      }
    }
  },
  crossDepartmentRequests: []
};

// Run scheduler
const result = generateDepartmentSchedule({
  db: mockDb,
  departmentName: 'MATHEMATICS',
  selectedCourseCodes: ['MAT2CJ101_C1', 'MAT2CJ101_C2'],
  allowRelaxedFallback: true
});

assert.strictEqual(result.success, true, 'Schedule generation should succeed');

const c1Alloc = result.allocations['MAT2CJ101_C1'];
const c2Alloc = result.allocations['MAT2CJ101_C2'];
assert.ok(c1Alloc, 'C1 allocations must exist');
assert.ok(c2Alloc, 'C2 allocations must exist');

// 1. Count teacher hours for C1 and C2
const countHours = (alloc) => {
  const counts = {};
  for (const day of Object.keys(alloc)) {
    for (const period of Object.keys(alloc[day])) {
      const teachers = alloc[day][period] || [];
      teachers.forEach(t => {
        counts[t] = (counts[t] || 0) + 1;
      });
    }
  }
  return counts;
};

const c1Counts = countHours(c1Alloc);
const c2Counts = countHours(c2Alloc);

console.log('C1 allocated hours:', c1Counts);
console.log('C2 allocated hours:', c2Counts);

// VM must get EXACTLY 2 hours in C1, NEVER 4 hours
assert.strictEqual(c1Counts['VM'], 2, 'VM must get exactly 2 hours in C1');
assert.strictEqual(c1Counts['AM3'], 2, 'AM3 must get exactly 2 hours in C1');

// VM must get EXACTLY 2 hours in C2, NEVER 4 hours
assert.strictEqual(c2Counts['VM'], 2, 'VM must get exactly 2 hours in C2');
assert.strictEqual(c2Counts['MT'], 2, 'MT must get exactly 2 hours in C2');

// 2. Assert ZERO teacher clashes between C1 and C2 on any day and period
const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const periods = ['1', '2', '3', '4', '5', '6'];

let clashCount = 0;
weekdays.forEach(d => {
  periods.forEach(p => {
    const t1 = (c1Alloc[d] && c1Alloc[d][p]) || [];
    const t2 = (c2Alloc[d] && c2Alloc[d][p]) || [];
    const overlap = t1.filter(t => t2.includes(t));
    if (overlap.length > 0) {
      console.error(`CLASH on ${d} Period ${p}: ${overlap.join(', ')}`);
      clashCount++;
    }
  });
});

assert.strictEqual(clashCount, 0, 'Zero clashes allowed for shared teachers across classes!');
console.log('Zero teacher clashes verified across classes: PASSED');

// 3. Assert all 4 recommended slots are filled
const recSlots = [
  { day: 'MONDAY', period: '3' },
  { day: 'WEDNESDAY', period: '1' },
  { day: 'THURSDAY', period: '4' },
  { day: 'FRIDAY', period: '2' }
];

recSlots.forEach(({ day, period }) => {
  assert.ok(c1Alloc[day] && c1Alloc[day][period] && c1Alloc[day][period].length > 0, `C1 must have slot ${day} P${period} filled`);
  assert.ok(c2Alloc[day] && c2Alloc[day][period] && c2Alloc[day][period].length > 0, `C2 must have slot ${day} P${period} filled`);
});
console.log('All 4 recommended slots filled for both classes: PASSED');

// 4. Test Composite Practical Course with split Theory teachers (MAT4CJ205)
console.log('--- TEST: Composite Course Practical Co-Teaching and Theory Split ---');
const compositeDb = {
  config: {
    periods: ['1', '2', '3', 'LB', '4', '5', '6'],
    globalLockedPeriods: []
  },
  departments: {
    'MATHEMATICS': { name: 'Mathematics', code: 'MAT' }
  },
  courses: [
    {
      code: 'MAT4CJ205_C1',
      name: 'Python Lab and Theory',
      department: 'MATHEMATICS',
      semester: '4',
      courseType: 'P',
      hours: 5,
      practicalHours: 2,
      theoryHours: 3,
      practicalTeachers: ['SAS'],
      theoryTeachers: ['SAS', 'JA'],
      theoryTeacherHours: { SAS: 1, JA: 2 },
      recommendations: {
        WEDNESDAY: { '1': 'P', '2': 'P' }
      }
    },
    {
      code: 'MAT4CJ205_C2',
      name: 'Python Lab and Theory',
      department: 'MATHEMATICS',
      semester: '4',
      courseType: 'P',
      hours: 5,
      practicalHours: 2,
      theoryHours: 3,
      practicalTeachers: ['MT'],
      theoryTeachers: ['JA', 'MT'],
      theoryTeacherHours: { JA: 2, MT: 1 },
      recommendations: {
        WEDNESDAY: { '1': 'P', '2': 'P' }
      }
    }
  ],
  faculty: [
    { code: 'SAS', name: 'Dr. Sabu', department: 'MATHEMATICS' },
    { code: 'JA', name: 'Dr. Julie', department: 'MATHEMATICS' },
    { code: 'MT', name: 'Mr. Mathew', department: 'MATHEMATICS' }
  ],
  allocations: {
    'MATHEMATICS': {}
  },
  submissions: {},
  teacherUnavailability: {},
  subjectTeacherMapping: {
    'MATHEMATICS': {
      'MAT4CJ205_C1': {
        hours: 5,
        courseType: 'P',
        practicalHours: 2,
        theoryHours: 3,
        practicalTeachers: ['SAS'],
        theoryTeachers: ['SAS', 'JA'],
        theoryTeacherHours: { SAS: 1, JA: 2 }
      },
      'MAT4CJ205_C2': {
        hours: 5,
        courseType: 'P',
        practicalHours: 2,
        theoryHours: 3,
        practicalTeachers: ['MT'],
        theoryTeachers: ['JA', 'MT'],
        theoryTeacherHours: { JA: 2, MT: 1 }
      }
    }
  },
  crossDepartmentRequests: []
};

const compResult = generateDepartmentSchedule({
  db: compositeDb,
  departmentName: 'MATHEMATICS',
  selectedCourseCodes: ['MAT4CJ205_C1', 'MAT4CJ205_C2'],
  allowRelaxedFallback: true
});

assert.strictEqual(compResult.success, true, 'Composite schedule generation should succeed');
const p1Alloc = compResult.allocations['MAT4CJ205_C1'];
const p2Alloc = compResult.allocations['MAT4CJ205_C2'];

// Practical slots (Wed 1 & 2) must be filled
assert.deepStrictEqual(p1Alloc['WEDNESDAY']['1'], ['SAS'], 'C1 Wed 1 practical teacher must be SAS');
assert.deepStrictEqual(p1Alloc['WEDNESDAY']['2'], ['SAS'], 'C1 Wed 2 practical teacher must be SAS');
assert.deepStrictEqual(p2Alloc['WEDNESDAY']['1'], ['MT'], 'C2 Wed 1 practical teacher must be MT');
assert.deepStrictEqual(p2Alloc['WEDNESDAY']['2'], ['MT'], 'C2 Wed 2 practical teacher must be MT');

const p1Counts = countHours(p1Alloc);
const p2Counts = countHours(p2Alloc);

console.log('Composite C1 hours:', p1Counts);
console.log('Composite C2 hours:', p2Counts);

// Check that SAS gets 2 prac + 1 theory = 3 hours total in C1
assert.strictEqual(p1Counts['SAS'], 3, 'SAS must get 3 hours (2 prac + 1 theory) in C1');
assert.strictEqual(p1Counts['JA'], 2, 'JA must get 2 hours theory in C1');

// Check that MT gets 2 prac + 1 theory = 3 hours total in C2
assert.strictEqual(p2Counts['MT'], 3, 'MT must get 3 hours (2 prac + 1 theory) in C2');
assert.strictEqual(p2Counts['JA'], 2, 'JA must get 2 hours theory in C2');

// Check that JA has zero clashes between C1 and C2
let jaClash = 0;
weekdays.forEach(d => {
  periods.forEach(p => {
    const t1 = (p1Alloc[d] && p1Alloc[d][p]) || [];
    const t2 = (p2Alloc[d] && p2Alloc[d][p]) || [];
    if (t1.includes('JA') && t2.includes('JA')) {
      jaClash++;
    }
  });
});
assert.strictEqual(jaClash, 0, 'JA must have 0 clashes between C1 and C2');
console.log('Composite practical & theory quotas verified: PASSED');

console.log('--- TEST PASSED SUCCESSFULLY ---');
