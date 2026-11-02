import assert from 'assert';
import { generateDepartmentSchedule } from '../server/scheduler.js';

console.log('=== Testing Recommended Slot Teacher Clash Prevention & Quota Guards ===');

// Setup mock database with two courses in Mathematics department
const mockDb = {
  faculty: [
    { code: 'VM', name: 'Prof. VM', department: 'Mathematics' },
    { code: 'AM3', name: 'Prof. AM3', department: 'Mathematics' }
  ],
  courses: [
    {
      code: 'MTH101',
      name: 'Course 1',
      department: 'Mathematics',
      semester: '1',
      programType: 'UG',
      category: 'MAJOR',
      hours: 2,
      recommendations: {
        MONDAY: { '1': 'T', '2': 'T' }
      }
    },
    {
      code: 'MTH201',
      name: 'Course 2',
      department: 'Mathematics',
      semester: '2',
      programType: 'UG',
      category: 'MAJOR',
      hours: 2,
      recommendations: {
        MONDAY: { '1': 'T', '2': 'T' } // Same recommended slots!
      }
    }
  ],
  config: {
    periods: ['1', '2', '3', 'LB', '4', '5', '6'],
    globalLockedPeriods: []
  },
  allocations: {
    MATHEMATICS: {}
  }
};

// Course 1 has VM mapped for 2 hours
// Course 2 has [VM, AM3] as pool with 1 hour each, but VM cannot take Mon P1/P2 if already assigned to MTH101!
const result = generateDepartmentSchedule({
  db: mockDb,
  departmentName: 'MATHEMATICS',
  selectedCourseCodes: ['MTH101', 'MTH201'],
  courseFacultyMap: {
    MTH101: ['VM'],
    MTH201: ['VM', 'AM3']
  },
  courseFacultyConfig: {
    MTH101: { teachers: ['VM'], teacherHours: { VM: 2 }, distribute: false },
    MTH201: { teachers: ['VM', 'AM3'], teacherHours: { VM: 1, AM3: 1 }, distribute: true }
  }
});

assert.strictEqual(result.success, true, 'Generation must succeed');

// Check allocations for Monday Period 1 and Period 2
const mth101Alloc = result.allocations['MTH101'];
const mth201Alloc = result.allocations['MTH201'];

const mon1Mth101 = mth101Alloc.MONDAY && mth101Alloc.MONDAY['1'];
const mon1Mth201 = mth201Alloc.MONDAY && mth201Alloc.MONDAY['1'];

if (mon1Mth101 && mon1Mth201) {
  const clash = mon1Mth101.some(t => mon1Mth201.includes(t));
  assert.strictEqual(clash, false, 'Teacher VM must NEVER be scheduled in both courses at Monday Period 1 simultaneously!');
}

const mon2Mth101 = mth101Alloc.MONDAY && mth101Alloc.MONDAY['2'];
const mon2Mth201 = mth201Alloc.MONDAY && mth201Alloc.MONDAY['2'];

if (mon2Mth101 && mon2Mth201) {
  const clash = mon2Mth101.some(t => mon2Mth201.includes(t));
  assert.strictEqual(clash, false, 'Teacher VM must NEVER be scheduled in both courses at Monday Period 2 simultaneously!');
}

// Check total hours assigned to VM on MTH201 (must not exceed quota of 1 hour)
let vmHoursMth201 = 0;
['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].forEach(d => {
  Object.keys(mth201Alloc[d] || {}).forEach(p => {
    if (mth201Alloc[d][p].includes('VM')) vmHoursMth201++;
  });
});

assert.strictEqual(vmHoursMth201 <= 1, true, `VM was assigned ${vmHoursMth201} hours on MTH201 (must not exceed mapped quota of 1)`);

console.log('--- Teacher Clash in Recommended Slots Check: PASSED (Zero parallel collisions) ---');
console.log('--- Teacher Specific Quota Check: PASSED (Quota strictly respected) ---');
console.log('ALL RECOMMENDED SLOT CLASH TESTS PASSED!');
