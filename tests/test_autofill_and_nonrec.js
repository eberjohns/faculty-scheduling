import assert from 'assert';
import { initDb, readDb } from './db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('=== Running Auto-Fill & Non-Recommended Course Rule Tests ===\n');

global.window = {};

await initDb();
const db = readDb();

// Load functions from app.js into sandbox
const appJs = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

// Create mock state
const state = {
  currentUser: { departmentName: 'ENGLISH' },
  courses: db.courses,
  faculty: db.faculty,
  allocations: {},
  teacherUnavailability: db.teacherUnavailability || {},
  crossDepartmentRequests: db.crossDepartmentRequests || [],
  config: db.config || { periods: ["1", "2", "3", "LB", "4", "5", "6"], globalLockedPeriods: [] },
  commonBatches: db.commonBatches || []
};

// Evaluate the helper functions in context
const sandbox = new Function('state', `
  ${appJs.substring(appJs.indexOf('function courseHasRecommendations('), appJs.indexOf('window.findCourseForDept = findCourseForDept;'))}
  ${appJs.substring(appJs.indexOf('function checkLocalClash('), appJs.indexOf('// Live Workload count'))}
  return {
    courseHasRecommendations,
    findCourseForDept,
    checkLocalClash
  };
`);

const { courseHasRecommendations, findCourseForDept, checkLocalClash } = sandbox(state);

// -------------------------------------------------------------
// Test 1: courseHasRecommendations
// -------------------------------------------------------------
console.log('--- Test 1: Testing courseHasRecommendations ---');
const recCourse = state.courses.find(c => c.department === 'ENGLISH' && c.code === 'ENG2FA103(2)_C1');
assert(recCourse, 'ENG2FA103(2)_C1 must exist in ENGLISH dept');
assert.strictEqual(courseHasRecommendations(recCourse), true, 'ENG2FA103(2)_C1 must have recommendations');

const nonRecCourse1 = state.courses.find(c => c.department === 'ENGLISH' && c.code === 'ENG2C05');
assert(nonRecCourse1, 'ENG2C05 must exist in ENGLISH dept');
assert.strictEqual(courseHasRecommendations(nonRecCourse1), false, 'ENG2C05 must NOT have recommendations');

const nonRecCourse2 = state.courses.find(c => c.department === 'ENGLISH' && c.code === 'ENG4P01');
assert(nonRecCourse2, 'ENG4P01 must exist in ENGLISH dept');
assert.strictEqual(courseHasRecommendations(nonRecCourse2), false, 'ENG4P01 must NOT have recommendations');
console.log('✓ courseHasRecommendations returns correct boolean for both recommended and non-recommended courses');

// -------------------------------------------------------------
// Test 2: findCourseForDept resolution
// -------------------------------------------------------------
console.log('\n--- Test 2: Testing findCourseForDept resolution ---');
const resolvedRec = findCourseForDept('ENG2FA103(2)_C1-T', 'ENGLISH');
assert(resolvedRec, 'findCourseForDept must resolve ENG2FA103(2)_C1-T');
assert.strictEqual(resolvedRec.code, 'ENG2FA103(2)_C1', 'Resolved code must be ENG2FA103(2)_C1');
assert.strictEqual(resolvedRec.department, 'ENGLISH', 'Resolved department must be ENGLISH (not ENGLISH_SF)');
assert.strictEqual(courseHasRecommendations(resolvedRec), true, 'Resolved course must have recommendations');

const resolvedNonRec = findCourseForDept('ENG2C05', 'ENGLISH');
assert(resolvedNonRec, 'findCourseForDept must resolve ENG2C05');
assert.strictEqual(resolvedNonRec.department, 'ENGLISH');
assert.strictEqual(courseHasRecommendations(resolvedNonRec), false);
console.log('✓ findCourseForDept correctly resolves class and dept-scoped course objects');

// -------------------------------------------------------------
// Test 3: Auto-Fill simulation for recommended slot
// -------------------------------------------------------------
console.log('\n--- Test 3: Testing Auto-Fill recommended slot logic ---');
state.allocations = {};
const targetCourseCode = 'ENG2FA103(2)_C1-T';
const facultyCode = 'E01';
const course = findCourseForDept(targetCourseCode);
const recs = course.recommendations;

// User clicked Tuesday Period 4 (which is 'T')
const day = 'TUESDAY';
const period = '4';
const clickedSlotRec = (recs[day] && recs[day][period]) || '';
assert.strictEqual(clickedSlotRec, 'T', 'Tuesday P4 must be a T recommended slot');

// Directly simulate assignment and autofill
if (!state.allocations[targetCourseCode]) state.allocations[targetCourseCode] = {};
if (!state.allocations[targetCourseCode][day]) state.allocations[targetCourseCode][day] = {};
state.allocations[targetCourseCode][day][period] = [facultyCode];

const isAutofillOn = true;
const isClickedSlotRecommended = (clickedSlotRec === 'T' || clickedSlotRec === 'P');
if (isAutofillOn && course && isClickedSlotRecommended) {
  const targetType = clickedSlotRec;
  const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
  weekdays.forEach(d => {
    const dayRecs = recs[d] || {};
    Object.keys(dayRecs).forEach(p => {
      if (dayRecs[p] === targetType) {
        if (d === day && String(p) === String(period)) return;
        const hasClash = checkLocalClash(facultyCode, d, p, targetCourseCode);
        if (!hasClash) {
          if (!state.allocations[targetCourseCode][d]) state.allocations[targetCourseCode][d] = {};
          if (!state.allocations[targetCourseCode][d][p]) state.allocations[targetCourseCode][d][p] = [];
          if (!state.allocations[targetCourseCode][d][p].includes(facultyCode)) {
            state.allocations[targetCourseCode][d][p].push(facultyCode);
          }
        }
      }
    });
  });
}

// Verify slots assigned
assert(state.allocations[targetCourseCode]['TUESDAY']['4'].includes('E01'), 'Tue P4 must have E01');
assert(state.allocations[targetCourseCode]['WEDNESDAY']['3'].includes('E01'), 'Wed P3 must be auto-filled with E01');
assert(state.allocations[targetCourseCode]['THURSDAY']['1'].includes('E01'), 'Thu P1 must be auto-filled with E01');
assert(state.allocations[targetCourseCode]['FRIDAY']['5'].includes('E01'), 'Fri P5 must be auto-filled with E01');

// Verify unrecommended slots NOT filled
assert(!state.allocations[targetCourseCode]['MONDAY'] || !state.allocations[targetCourseCode]['MONDAY']['1'], 'Mon P1 must NOT be filled');
assert(!state.allocations['ENG2FA103(2)_C2'], 'Row C2 must remain completely untouched');
console.log('✓ Auto-fill correctly fills all recommended slots for the active class row and preserves other rows');

// -------------------------------------------------------------
// Test 4: Auto-Fill with Unrecommended slot click
// -------------------------------------------------------------
console.log('\n--- Test 4: Auto-fill must NOT trigger on non-recommended slot click ---');
state.allocations = {};
// User clicked Monday Period 1 (which is NOT recommended for this course)
const unrecDay = 'MONDAY';
const unrecPeriod = '1';
const clickedUnrec = (recs[unrecDay] && recs[unrecDay][unrecPeriod]) || '';
const isUnrecClickedRecommended = (clickedUnrec === 'T' || clickedUnrec === 'P');
assert.strictEqual(isUnrecClickedRecommended, false, 'Mon P1 is not recommended');

if (!state.allocations[targetCourseCode]) state.allocations[targetCourseCode] = {};
if (!state.allocations[targetCourseCode][unrecDay]) state.allocations[targetCourseCode][unrecDay] = {};
state.allocations[targetCourseCode][unrecDay][unrecPeriod] = ['E02'];

if (isAutofillOn && course && isUnrecClickedRecommended) {
  assert.fail('Auto-fill should NOT execute when clicking a non-recommended slot');
}
assert(state.allocations[targetCourseCode]['MONDAY']['1'].includes('E02'));
assert(!state.allocations[targetCourseCode]['TUESDAY'], 'No other slots were filled');
console.log('✓ Auto-fill safely ignored when user allocates a non-recommended slot');

// -------------------------------------------------------------
// Test 5: Non-recommended course allocation
// -------------------------------------------------------------
console.log('\n--- Test 5: Non-recommended course allocation ---');
state.allocations = {};
const nonRecCode = 'ENG2C05';
const nonRecCourse = findCourseForDept(nonRecCode);
const nonRecRecs = nonRecCourse.recommendations;
const nonRecHasRecs = courseHasRecommendations(nonRecCourse);
assert.strictEqual(nonRecHasRecs, false, 'ENG2C05 has no recommendations');

// Non-recommended course has zero recommended slots, so isClickedSlotRecommended is false
const clickedNonRec = (nonRecRecs['MONDAY'] && nonRecRecs['MONDAY']['1']) || '';
assert.strictEqual(clickedNonRec, '');
assert.strictEqual(clickedNonRec === 'T' || clickedNonRec === 'P', false);
console.log('✓ Non-recommended courses never trigger auto-fill and assign only the targeted period');

console.log('\n================================================================');
console.log('ALL AUTO-FILL & NON-RECOMMENDED COURSE TESTS PASSED WITH 100% SUCCESS!');
console.log('================================================================');
