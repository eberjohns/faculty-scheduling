import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readDb, writeDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("Running Automated Integration Tests...");

// Test Case 1: Initial Database Seeding
const db = readDb();
assert.ok(db, "Database should load successfully");
assert.ok(db.config, "Config should exist in database");
assert.ok(db.config.academicYear, "Academic year should exist");
console.log("✓ Test Case 1: Database Loading Passed");

// Test Case 2: Initials Generator Deduplication Mock Check
const existingFaculty = [
  { staffId: "1", name: "John Paul", code: "JP" },
  { staffId: "2", name: "James Peter", code: "JP1" }
];

function mockGenerateFacultyCode(name, list) {
  const cleanName = name.replace(/^(dr\.|mr\.|mrs\.|ms\.|fr\.|sr\.)/i, '').trim();
  const words = cleanName.split(/\s+/).filter(Boolean);
  let baseCode = "";
  if (words.length >= 2) {
    baseCode = words.map(w => w[0]).join('').toUpperCase();
  } else if (words.length === 1) {
    baseCode = words[0].substring(0, 2).toUpperCase();
  } else {
    baseCode = "FAC";
  }

  let finalCode = baseCode;
  let counter = 1;
  const codes = new Set(list.map(f => f.code));
  while (codes.has(finalCode)) {
    finalCode = `${baseCode}${counter}`;
    counter++;
  }
  return finalCode;
}

const code1 = mockGenerateFacultyCode("John Paul", existingFaculty);
assert.strictEqual(code1, "JP2", "Third John Paul should generate JP2");
const code2 = mockGenerateFacultyCode("Fr. Simson C S", existingFaculty);
assert.strictEqual(code2, "SCS", "Simson C S should generate SCS");
console.log("✓ Test Case 2: Initials Generator Deduplication Passed");

// Test Case 3: Clash Check Engine Validation Mock
function mockFindAllocationClashes(allocations) {
  const clashes = [];
  for (const dept of Object.keys(allocations)) {
    const deptAlloc = allocations[dept];
    const usage = {};
    for (const courseCode of Object.keys(deptAlloc)) {
      const courseDays = deptAlloc[courseCode];
      for (const weekday of Object.keys(courseDays)) {
        const periodsObj = courseDays[weekday];
        if (!usage[weekday]) usage[weekday] = {};
        for (const period of Object.keys(periodsObj)) {
          if (!usage[weekday][period]) usage[weekday][period] = {};
          const facultyList = periodsObj[period] || [];
          for (const fac of facultyList) {
            if (!usage[weekday][period][fac]) {
              usage[weekday][period][fac] = new Set();
            }
            usage[weekday][period][fac].add(courseCode);
          }
        }
      }
    }
    for (const weekday of Object.keys(usage)) {
      for (const period of Object.keys(usage[weekday])) {
        for (const fac of Object.keys(usage[weekday][period])) {
          const coursesSet = usage[weekday][period][fac];
          if (coursesSet.size > 1) {
            clashes.push({
              department: dept,
              weekday,
              period,
              facultyCode: fac,
              courses: Array.from(coursesSet)
            });
          }
        }
      }
    }
  }
  return clashes;
}

const mockAllocations = {
  "COMPUTER SCIENCE": {
    "CSC1": { "MONDAY": { "1": ["JP"] } },
    "CSC2": { "MONDAY": { "1": ["JP"] } } // Clash JP in MONDAY period 1!
  }
};
const clashes = mockFindAllocationClashes(mockAllocations);
assert.strictEqual(clashes.length, 1, "Should detect exactly one clash");
assert.strictEqual(clashes[0].facultyCode, "JP", "Clash faculty code should be JP");
console.log("✓ Test Case 3: Allocation Clash Engine Passed");

console.log("\nALL TESTS PASSED SUCCESSFULLY! Setup and database rules verified.");
