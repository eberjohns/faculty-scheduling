// server/test_subject_mapping_sync.js
import assert from 'assert';

// Simulate the syncAllocationsToSubjectMapping logic extracted from public/js/app.js
function calculateDefaultTeacherSplit(totalHours, teachers) {
  totalHours = Math.max(0, parseInt(totalHours) || 0);
  if (!Array.isArray(teachers) || teachers.length === 0) return {};
  const perTeacher = Math.floor(totalHours / teachers.length);
  let rem = totalHours % teachers.length;
  const result = {};
  teachers.forEach(fCode => {
    result[fCode] = perTeacher + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
  });
  return result;
}

function validateAndBalanceTeacherHours(totalHours, teachers, existingHours) {
  totalHours = Math.max(1, parseInt(totalHours) || 4);
  if (!Array.isArray(teachers) || teachers.length === 0) return {};
  if (teachers.length === 1) return { [teachers[0]]: totalHours };

  const hoursObj = existingHours ? { ...existingHours } : {};
  let currentSum = 0;
  let allPresent = true;
  teachers.forEach(t => {
    if (hoursObj[t] === undefined || isNaN(parseInt(hoursObj[t])) || parseInt(hoursObj[t]) < 1) {
      allPresent = false;
    } else {
      currentSum += parseInt(hoursObj[t]);
    }
  });

  if (!allPresent || currentSum !== totalHours) {
    return calculateDefaultTeacherSplit(totalHours, teachers);
  }

  return hoursObj;
}

function simulateSync(course, allocations) {
  const cCode = course.code || '';
  const baseCode = cCode.replace(/-(T|P)$/, '').replace(/(_C|_G)\d+$/, '');
  const candidateKeys = [cCode, `${cCode}-T`, `${cCode}-P`, `${baseCode}-T`, `${baseCode}-P`, baseCode];
  const uniqueKeys = Array.from(new Set(candidateKeys));

  const classStats = {
    C1: {
      theorySlots: new Set(),
      practicalSlots: new Set(),
      teacherTheoryCount: {},
      teacherPracCount: {}
    }
  };
  let hasAnyAllocation = false;

  uniqueKeys.forEach(key => {
    const dayObj = allocations[key];
    if (!dayObj) return;

    const isKeyPractical = key.endsWith('-P') || key.includes('-P');
    const isKeyTheory = key.endsWith('-T') || key.includes('-T');

    Object.entries(dayObj).forEach(([day, periodObj]) => {
      const dayUpper = day.toUpperCase();
      Object.entries(periodObj || {}).forEach(([period, facList]) => {
        if (!Array.isArray(facList) || facList.length === 0) return;
        if (String(period).toUpperCase() === 'LB') return;

        hasAnyAllocation = true;
        const slotPeriodKey = `${dayUpper}_${period}`;

        let slotType = 'T';
        if (isKeyPractical) {
          slotType = 'P';
        } else if (isKeyTheory) {
          slotType = 'T';
        } else {
          const rec = (course.recommendations && course.recommendations[dayUpper] && course.recommendations[dayUpper][period]) || '';
          if (rec === 'P') slotType = 'P';
          else if (rec === 'T') slotType = 'T';
          else if (course.courseType === 'P' || cCode.endsWith('-P')) slotType = 'P';
          else slotType = 'T';
        }

        if (slotType === 'P') {
          classStats.C1.practicalSlots.add(slotPeriodKey);
          facList.forEach(fc => {
            const code = (fc || '').trim();
            if (code) {
              classStats.C1.teacherPracCount[code] = (classStats.C1.teacherPracCount[code] || 0) + 1;
            }
          });
        } else {
          classStats.C1.theorySlots.add(slotPeriodKey);
          facList.forEach(fc => {
            const code = (fc || '').trim();
            if (code) {
              classStats.C1.teacherTheoryCount[code] = (classStats.C1.teacherTheoryCount[code] || 0) + 1;
            }
          });
        }
      });
    });
  });

  if (!hasAnyAllocation) return null;

  const theoryHours = classStats.C1.theorySlots.size;
  const practicalHours = classStats.C1.practicalSlots.size;
  const totalWeeklyHours = theoryHours + practicalHours;
  const isPrac = practicalHours > 0;
  const detectedCourseType = isPrac ? 'P' : 'T';

  const theoryTeachersSet = new Set(Object.keys(classStats.C1.teacherTheoryCount));
  const practicalTeachersSet = new Set(Object.keys(classStats.C1.teacherPracCount));
  const theoryTeacherHours = { ...classStats.C1.teacherTheoryCount };

  const theoryTeachers = Array.from(theoryTeachersSet);
  const practicalTeachers = Array.from(practicalTeachersSet);
  const unifiedTeachers = Array.from(new Set([...practicalTeachers, ...theoryTeachers]));

  let balancedTheoryTeacherHours = {};
  if (theoryTeachers.length > 0 && theoryHours > 0) {
    balancedTheoryTeacherHours = validateAndBalanceTeacherHours(theoryHours, theoryTeachers, theoryTeacherHours);
  }

  const unifiedTeacherHours = {};
  unifiedTeachers.forEach(fc => {
    let hrs = 0;
    if (isPrac && practicalTeachers.includes(fc)) {
      hrs += practicalHours;
    }
    if (theoryTeachers.includes(fc)) {
      hrs += (balancedTheoryTeacherHours[fc] || 0);
    }
    unifiedTeacherHours[fc] = hrs;
  });

  return {
    hours: totalWeeklyHours,
    courseType: detectedCourseType,
    practicalHours: isPrac ? practicalHours : 0,
    theoryHours: theoryHours,
    practicalTeachers: isPrac ? practicalTeachers : [],
    theoryTeachers: theoryTeachers,
    theoryTeacherHours: balancedTheoryTeacherHours,
    teachers: unifiedTeachers,
    teacherHours: isPrac ? unifiedTeacherHours : balancedTheoryTeacherHours
  };
}

console.log('=== Running Subject Teacher Mapping Dynamic Sync Tests ===');

// Test 1: User's exact prompt scenario: 1 teacher assigned 3 theory and 2 practical
{
  console.log('\n--- Test 1: Single Teacher 3 Theory + 2 Practical ---');
  const course = { code: 'CSC101', name: 'Computer Fundamentals', department: 'COMPUTER SCIENCE', courseType: 'T' };
  const allocations = {
    'CSC101-T': {
      MONDAY: { '1': ['AT'] },
      TUESDAY: { '2': ['AT'] },
      WEDNESDAY: { '3': ['AT'] }
    },
    'CSC101-P': {
      FRIDAY: { '4': ['AT'], '5': ['AT'] }
    }
  };

  const result = simulateSync(course, allocations);
  assert.strictEqual(result.hours, 5, 'Total hours must be 5');
  assert.strictEqual(result.courseType, 'P', 'Subject category must be Practical (P)');
  assert.strictEqual(result.practicalHours, 2, 'Practical hours must be 2');
  assert.strictEqual(result.theoryHours, 3, 'Theory hours must be 3');
  assert.deepStrictEqual(result.practicalTeachers, ['AT'], 'Practical teachers must contain AT');
  assert.deepStrictEqual(result.theoryTeachers, ['AT'], 'Theory teachers must contain AT');
  assert.strictEqual(result.theoryTeacherHours['AT'], 3, 'AT theory hours must be 3');
  assert.strictEqual(result.teacherHours['AT'], 5, 'AT total hours must be 5 (3 TH + 2 PR)');
  console.log('Test 1 Passed: 3 TH + 2 PR -> Total Hours: 5, Practical: P, Division: AT=3 TH, Total=5');
}

// Test 2: Multiple Teachers: Teacher A with 2 Theory, Teacher B with 1 Theory, both A & B co-teaching 2 Practical
{
  console.log('\n--- Test 2: Multiple Teachers Co-Teaching & Theory Split ---');
  const course = { code: 'CSC201', name: 'Data Structures', department: 'COMPUTER SCIENCE' };
  const allocations = {
    'CSC201-T': {
      MONDAY: { '1': ['TA'] },
      TUESDAY: { '2': ['TA'] },
      WEDNESDAY: { '3': ['TB'] }
    },
    'CSC201-P': {
      THURSDAY: { '4': ['TA', 'TB'], '5': ['TA', 'TB'] }
    }
  };

  const result = simulateSync(course, allocations);
  assert.strictEqual(result.hours, 5, 'Total hours must be 5');
  assert.strictEqual(result.courseType, 'P', 'Subject category must be Practical (P)');
  assert.strictEqual(result.practicalHours, 2, 'Practical hours must be 2');
  assert.strictEqual(result.theoryHours, 3, 'Theory hours must be 3');
  assert.strictEqual(result.theoryTeacherHours['TA'], 2, 'TA gets 2 theory hours');
  assert.strictEqual(result.theoryTeacherHours['TB'], 1, 'TB gets 1 theory hour');
  assert.strictEqual(result.theoryTeacherHours['TA'] + result.theoryTeacherHours['TB'], 3, 'Sum of theory teacher hours must be 3');
  assert.deepStrictEqual(result.practicalTeachers.sort(), ['TA', 'TB'], 'Both TA and TB co-teach practical');
  assert.strictEqual(result.teacherHours['TA'], 4, 'TA gets 2 TH + 2 PR = 4');
  assert.strictEqual(result.teacherHours['TB'], 3, 'TB gets 1 TH + 2 PR = 3');
  console.log('Test 2 Passed: Multiple teachers correctly split theory (TA=2, TB=1) and co-teach practical (2 PR each)');
}

// Test 3: Multiple Teachers Pure Theory
{
  console.log('\n--- Test 3: Multiple Teachers in Pure Theory ---');
  const course = { code: 'MAT101', name: 'Calculus', department: 'MATHEMATICS' };
  const allocations = {
    'MAT101': {
      MONDAY: { '1': ['M1'] },
      TUESDAY: { '2': ['M1'] },
      WEDNESDAY: { '3': ['M1'] },
      THURSDAY: { '4': ['M2'] },
      FRIDAY: { '5': ['M2'] }
    }
  };

  const result = simulateSync(course, allocations);
  assert.strictEqual(result.hours, 5, 'Total hours must be 5');
  assert.strictEqual(result.courseType, 'T', 'Subject category must be Theory (T)');
  assert.strictEqual(result.practicalHours, 0, 'Practical hours must be 0');
  assert.strictEqual(result.theoryHours, 5, 'Theory hours must be 5');
  assert.strictEqual(result.teacherHours['M1'], 3, 'M1 gets 3 hours');
  assert.strictEqual(result.teacherHours['M2'], 2, 'M2 gets 2 hours');
  assert.strictEqual(result.teacherHours['M1'] + result.teacherHours['M2'], 5, 'Sum equals 5');
  console.log('Test 3 Passed: Pure theory multiple teachers correctly divisioned (M1=3, M2=2, Total=5)');
}

console.log('\n=============================================');
console.log('ALL SUBJECT TEACHER MAPPING SYNC TESTS PASSED!');
console.log('=============================================');
