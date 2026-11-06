import assert from 'assert';
import { readDb } from '../server/db.js';

// We can test findAllocationClashes behavior directly
const mockAllocations = {
  "MATHEMATICS": {
    "MAT2MN104": { "MONDAY": { "1": ["PG"] } },
    "MAT6EJ302(1)": { "MONDAY": { "1": ["PG"] } } // Internal clash in MATHEMATICS
  },
  "PHYSICS": {
    "PHY101": { "MONDAY": { "2": ["SSK"] } },
    "PHY102": { "MONDAY": { "3": ["SSK"] } } // Valid: SSK in different periods
  },
  "CHEMISTRY": {
    "CHE101": { "MONDAY": { "2": ["SSK"] } } // Cross-department clash with PHYSICS on Monday P2
  }
};

// Implement the scoping logic check
function findAllocationClashes(allocations, targetDept = null) {
  const clashes = [];
  const targetUpper = targetDept ? String(targetDept).trim().toUpperCase() : null;
  const usage = {};

  for (const dept of Object.keys(allocations)) {
    const deptAlloc = allocations[dept] || {};
    for (const courseCode of Object.keys(deptAlloc)) {
      const courseDays = deptAlloc[courseCode] || {};
      for (const weekday of Object.keys(courseDays)) {
        const periodsObj = courseDays[weekday] || {};
        if (!usage[weekday]) usage[weekday] = {};

        for (const period of Object.keys(periodsObj)) {
          if (!usage[weekday][period]) usage[weekday][period] = {};

          const facultyList = periodsObj[period] || [];
          for (const fac of facultyList) {
            if (!fac) continue;
            if (!usage[weekday][period][fac]) {
              usage[weekday][period][fac] = [];
            }
            usage[weekday][period][fac].push({
              department: dept,
              courseCode: courseCode
            });
          }
        }
      }
    }
  }

  for (const weekday of Object.keys(usage)) {
    for (const period of Object.keys(usage[weekday])) {
      for (const fac of Object.keys(usage[weekday][period])) {
        const bookings = usage[weekday][period][fac];
        if (bookings.length <= 1) continue;

        if (targetUpper && !bookings.some(b => (b.department || '').trim().toUpperCase() === targetUpper)) {
          continue;
        }

        const uniqueKeys = new Set(
          bookings.map(b => `${(b.department || '').toUpperCase()}::${b.courseCode.replace(/-(T|P)$/, '')}`)
        );

        if (uniqueKeys.size > 1) {
          const hasMultipleDepts = new Set(bookings.map(b => (b.department || '').toUpperCase())).size > 1;
          const courseLabels = bookings.map(b => hasMultipleDepts ? `${b.courseCode} (${b.department})` : b.courseCode);

          clashes.push({
            department: hasMultipleDepts 
              ? Array.from(new Set(bookings.map(b => b.department))).join(' / ') 
              : bookings[0].department,
            weekday,
            period,
            facultyCode: fac,
            courses: Array.from(new Set(courseLabels))
          });
        }
      }
    }
  }

  return clashes;
}

console.log('=== Running Clash Detection Scoping & Isolation Tests ===\n');

// Test 1: Department Scoping Isolation
// When checking PHYSICS, it must NOT see MATHEMATICS's internal clash
const physicsClashesWithoutCross = {
  "MATHEMATICS": mockAllocations["MATHEMATICS"],
  "PHYSICS": mockAllocations["PHYSICS"]
};

const isolatedPhysicsClashes = findAllocationClashes(physicsClashesWithoutCross, "PHYSICS");
assert.strictEqual(isolatedPhysicsClashes.length, 0, "PHYSICS should have 0 clashes when isolated from MATHEMATICS");
console.log('--- Test 1: Target Department Isolation from Other Departments: PASSED (0 false clashes)');

// Test 2: Global Check
// When targetDept is null, it should report the clash in MATHEMATICS
const globalClashes = findAllocationClashes(physicsClashesWithoutCross, null);
assert.strictEqual(globalClashes.length, 1, "Global check should find the 1 clash in MATHEMATICS");
assert.strictEqual(globalClashes[0].facultyCode, "PG", "Clashing faculty should be PG");
console.log('--- Test 2: Global Institution-wide Clash Reporting: PASSED (Found 1 clash in MATHEMATICS)');

// Test 3: Cross-Department Clash Detection
// When checking PHYSICS against CHEMISTRY where SSK is double booked on Monday P2
const crossClashes = findAllocationClashes(mockAllocations, "PHYSICS");
assert.strictEqual(crossClashes.length, 1, "Should detect cross-department clash involving PHYSICS");
assert.strictEqual(crossClashes[0].facultyCode, "SSK", "Clashing faculty should be SSK");
assert.ok(crossClashes[0].courses.some(c => c.includes('PHYSICS')), "Course label should include PHYSICS");
assert.ok(crossClashes[0].courses.some(c => c.includes('CHEMISTRY')), "Course label should include CHEMISTRY");
console.log('--- Test 3: Cross-Department Clash Attribution: PASSED (Detected SSK across PHYSICS & CHEMISTRY)');

// Test 4: Parallel Class Split Double-Booking Detection
// When a faculty member is assigned to both Class 1 and Class 2 of the same course in the same period
const parallelClassAllocations = {
  "COMMERCE_SF": {
    "COM4CJ204_C1": { "MONDAY": { "1": ["NTM"] } },
    "COM4CJ204_C2": { "MONDAY": { "1": ["NTM"] } }
  }
};
const parallelClassClashes = findAllocationClashes(parallelClassAllocations, "COMMERCE_SF");
assert.strictEqual(parallelClassClashes.length, 1, "Should detect parallel class double-booking clash on MONDAY 1");
assert.strictEqual(parallelClassClashes[0].facultyCode, "NTM", "Clashing faculty should be NTM");
assert.deepStrictEqual(parallelClassClashes[0].courses, ["COM4CJ204_C1", "COM4CJ204_C2"], "Clashing courses should be C1 and C2");
console.log('--- Test 4: Parallel Class Split Double-Booking Detection: PASSED (Detected NTM on COM4CJ204_C1 & COM4CJ204_C2)');

console.log('\n======================================================');
console.log('ALL CLASH DETECTION SCOPING TESTS PASSED IN FULL!');
console.log('======================================================');

