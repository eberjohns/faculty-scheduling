import assert from 'assert';
import { readDb } from '../server/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== Running Theory/Practical Coloring & Printing Audit Tests ===\n');

const db = readDb();
const csDept = 'COMPUTER SCIENCE';
const csAllocs = db.allocations[csDept] || {};
const csCourses = db.courses || [];
const csFaculty = db.faculty.filter(f => (f.department || '').trim().toUpperCase() === csDept);

// 1. Verify determineSlotType logic in app.js and admin.js
const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const adminJs = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');

assert(appJs.includes('function determineSlotType'), 'app.js must declare determineSlotType');
assert(adminJs.includes('function determineSlotType'), 'admin.js must declare determineSlotType');
assert(stylesCss.includes('.slot-recommend-t.slot-has-assignments'), 'styles.css must style slot-recommend-t when assigned');
assert(stylesCss.includes('.slot-recommend-p.slot-has-assignments'), 'styles.css must style slot-recommend-p when assigned');

// Extract and test determineSlotType directly
const extractFn = (src) => {
  const start = src.indexOf('function determineSlotType(');
  const end = src.indexOf('window.determineSlotType = determineSlotType;', start);
  const code = src.slice(start, end);
  return new Function('course', 'cCode', 'day', 'period', 'facList', 'dayAllocations', 'deptMapping', 'state', `
    ${code}
    return determineSlotType(course, cCode, day, period, facList, dayAllocations, deptMapping);
  `);
};

const fnDetermineSlotType = extractFn(appJs);
const mockState = {
  subjectTeacherMapping: db.subjectTeacherMapping,
  currentUser: { departmentName: 'COMPUTER SCIENCE' },
  courses: db.courses,
  config: db.config
};

console.log('--- 1. Testing Slot Type Determination for CSC5FS112 (ITDM) ---');
const itdmCourse = csCourses.find(c => c.code === 'CSC5FS112');
assert(itdmCourse, 'CSC5FS112 course exists');

const itdmAlloc = csAllocs['CSC5FS112'];
const tue3Type = fnDetermineSlotType(itdmCourse, 'CSC5FS112', 'TUESDAY', '3', itdmAlloc['TUESDAY']['3'], itdmAlloc['TUESDAY'], null, mockState);
assert.strictEqual(tue3Type, 'T', 'Tuesday P3 for ITDM must be Theory (T)');

const wed6Type = fnDetermineSlotType(itdmCourse, 'CSC5FS112', 'WEDNESDAY', '6', itdmAlloc['WEDNESDAY']['6'], itdmAlloc['WEDNESDAY'], null, mockState);
assert.strictEqual(wed6Type, 'T', 'Wednesday P6 for ITDM must be Theory (T)');

const thu1Type = fnDetermineSlotType(itdmCourse, 'CSC5FS112', 'THURSDAY', '1', itdmAlloc['THURSDAY']['1'], itdmAlloc['THURSDAY'], null, mockState);
assert.strictEqual(thu1Type, 'P', 'Thursday P1 for ITDM must be Practical (P)');

const thu2Type = fnDetermineSlotType(itdmCourse, 'CSC5FS112', 'THURSDAY', '2', itdmAlloc['THURSDAY']['2'], itdmAlloc['THURSDAY'], null, mockState);
assert.strictEqual(thu2Type, 'P', 'Thursday P2 for ITDM must be Practical (P)');

const fri5Type = fnDetermineSlotType(itdmCourse, 'CSC5FS112', 'FRIDAY', '5', itdmAlloc['FRIDAY']['5'], itdmAlloc['FRIDAY'], null, mockState);
assert.strictEqual(fri5Type, 'T', 'Friday P5 for ITDM must be Theory (T)');
console.log('ITDM (CSC5FS112) Slot Type Determination: PASSED (Tue3=T, Wed6=T, Thu1=P, Thu2=P, Fri5=T)');

console.log('\n--- 2. Testing Teacher Individual Timetable Breakdown for Dr. Jiju A Mathew (JAM1) ---');
// Simulate computeFacultyWeeklySchedules
const schedules = {};
csFaculty.forEach(fac => {
  schedules[fac.code] = { info: fac, totalHours: 0, theoryHours: 0, practicalHours: 0, slots: {} };
  ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].forEach(d => schedules[fac.code].slots[d] = {});
});

Object.entries(csAllocs).forEach(([cCode, dayObj]) => {
  const baseCode = cCode.replace(/-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
  const course = csCourses.find(c => c.code === cCode) || csCourses.find(c => c.code === baseCode);
  Object.entries(dayObj || {}).forEach(([day, periodObj]) => {
    const dayUpper = day.toUpperCase();
    Object.entries(periodObj || {}).forEach(([period, facList]) => {
      if (Array.isArray(facList) && facList.length > 0) {
        const slotType = fnDetermineSlotType(course, cCode, dayUpper, period, facList, periodObj, null, mockState);
        const isPrac = (slotType === 'P');
        facList.forEach(facCode => {
          const fc = (facCode || '').trim();
          const schedKey = Object.keys(schedules).find(k => k.toUpperCase() === fc.toUpperCase()) || fc;
          if (schedules[schedKey]) {
            if (!schedules[schedKey].slots[dayUpper][period]) {
              schedules[schedKey].slots[dayUpper][period] = [];
            }
            schedules[schedKey].slots[dayUpper][period].push({ courseCode: cCode, type: isPrac ? 'P' : 'T' });
            schedules[schedKey].totalHours++;
            if (isPrac) schedules[schedKey].practicalHours++;
            else schedules[schedKey].theoryHours++;
          }
        });
      }
    });
  });
});

const jam1 = schedules['JAM1'];
assert(jam1, 'JAM1 schedule computed');
assert.strictEqual(jam1.totalHours, 8, 'JAM1 total hours must be 8');
assert.strictEqual(jam1.theoryHours, 6, 'JAM1 theory hours must be 6');
assert.strictEqual(jam1.practicalHours, 2, 'JAM1 practical hours must be 2');
assert.strictEqual(jam1.slots['TUESDAY']['3'][0].type, 'T', 'JAM1 Tuesday P3 must be Theory (T)');
assert.strictEqual(jam1.slots['WEDNESDAY']['6'][0].type, 'T', 'JAM1 Wednesday P6 must be Theory (T)');
assert.strictEqual(jam1.slots['THURSDAY']['1'][0].type, 'P', 'JAM1 Thursday P1 must be Practical (P)');
assert.strictEqual(jam1.slots['THURSDAY']['2'][0].type, 'P', 'JAM1 Thursday P2 must be Practical (P)');
console.log('JAM1 Workload & Schedule Verification: PASSED (Total: 8 hrs, Theory: 6 hrs, Practical: 2 hrs)');

console.log('\n--- 3. Testing CSS Palette and Print Color Consistency ---');
assert(stylesCss.includes('-webkit-print-color-adjust: exact'), 'styles.css must include print-color-adjust');
assert(stylesCss.includes('.teacher-grid-table td.teacher-slot-th'), 'styles.css must include teacher-slot-th');
assert(stylesCss.includes('.teacher-grid-table td.teacher-slot-pr'), 'styles.css must include teacher-slot-pr');
console.log('CSS Print Color Preservation: PASSED');

console.log('\n======================================================');
console.log('ALL THEORY/PRACTICAL COLORING & PRINTING TESTS PASSED!');
console.log('======================================================');

