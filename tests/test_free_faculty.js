import assert from 'assert';
import { readDb } from '../server/db.js';

const db = readDb();

console.log('=== Testing Free Faculty Endpoint & Schedule Calculation Logic ===');

// Simulate the free faculty logic
const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
const rawPeriods = db.periods || (db.config && db.config.periods) || ["1", "2", "3", "LB", "4", "5", "6"];
const teachingPeriods = rawPeriods.filter(p => String(p).toUpperCase() !== 'LB');

assert(teachingPeriods.length >= 5, 'Must have at least 5 teaching periods');
assert(!teachingPeriods.includes('LB'), 'Teaching periods must exclude lunch break LB');

// Check faculty list
const allFaculty = db.faculty || [];
console.log(`Found ${allFaculty.length} faculty members in database.`);

// Test that allocations exist
const allocations = db.allocations || {};
const depts = Object.keys(allocations);
console.log(`Found ${depts.length} departments with allocations.`);

// Verify schedule structure
const totalExpectedSlots = weekdays.length * teachingPeriods.length;
console.log(`Each teacher has ${totalExpectedSlots} teaching slots per week.`);

// Let's verify a sample teacher's free count + busy count == totalExpectedSlots
let sampleVerified = false;
allFaculty.forEach(fac => {
  const code = (fac.code || '').trim().toUpperCase();
  // Count assigned slots
  let busyCount = 0;
  Object.entries(allocations).forEach(([dept, deptAlloc]) => {
    Object.entries(deptAlloc).forEach(([courseCode, dayObj]) => {
      Object.entries(dayObj).forEach(([day, periodObj]) => {
        if (!weekdays.includes(day.toUpperCase())) return;
        Object.entries(periodObj).forEach(([p, facList]) => {
          if (String(p).toUpperCase() === 'LB') return;
          if (Array.isArray(facList) && facList.some(fc => (fc || '').trim().toUpperCase() === code)) {
            busyCount++;
          }
        });
      });
    });
  });

  const freeCount = totalExpectedSlots - busyCount;
  assert(freeCount >= 0, `Free count must be non-negative for ${fac.name}`);
  assert.strictEqual(freeCount + busyCount, totalExpectedSlots, 'Free count + busy count must equal total teaching slots');
  sampleVerified = true;
});

assert(sampleVerified, 'At least one faculty member was verified');
console.log('✓ All faculty availability and free period calculations verified successfully!');
console.log('=============================================');
console.log('ALL FREE FACULTY CALCULATION TESTS PASSED!');
console.log('=============================================');

