import { spawn } from 'child_process';
import { readDb } from '../db.js';

const db = readDb();
const deptUpper = 'COMMERCE';
const courses = db.courses.filter(c => c.department === deptUpper);
const mapping = db.subjectTeacherMapping[deptUpper] || {};

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const rawPeriods = db.periods || ['1', '2', '3', 'LB', '4', '5', '6'];
const realPeriods = rawPeriods.filter(p => p !== 'LB' && !p.includes('BREAK'));

const globalLocks = (db.config && db.config.globalLockedPeriods) || [];
const deptLocks = globalLocks.filter(l => (l.department || '').toUpperCase() === deptUpper);

function getCohortInfo(course) {
  const cCode = course.code;
  const prog = String(
    course.programType ||
    (cCode.startsWith('MCM') || cCode.startsWith('CMS') || cCode.startsWith('MATP') ? 'PG' : 'UG')
  ).toUpperCase();
  const semDigits = String(course.semester || '1').replace(/\D+/g, '') || '1';
  const yearKey = `${prog}_SEM_${semDigits}`;

  const classMatch = String(cCode).match(/(_C|_G)(\d+)/i);
  if (classMatch) {
    const groupKey = `${yearKey}_C${classMatch[2]}`;
    return { yearKey, groupKey, studentTarget: groupKey, semDigits, prog };
  }

  const streamMatch = cCode.match(/\((\d+)\)/);
  const cat = String(course.category || '').toUpperCase().trim();
  if (streamMatch || cat === 'ELECTIVE' || cat === 'MINOR' || cat === 'MDC') {
    const streamId = streamMatch ? streamMatch[1] : (cCode.includes('EJ') ? 'E1' : cCode);
    const groupKey = `${yearKey}_STR_${streamId}`;
    return { yearKey, groupKey, studentTarget: groupKey, semDigits, prog };
  }

  if (cCode.includes('CJ349') || cat === 'INTERNSHIP') {
    const groupKey = `${yearKey}_INTERN`;
    return { yearKey, groupKey, studentTarget: groupKey, semDigits, prog };
  }

  const groupKey = `${yearKey}_MAIN`;
  return { yearKey, groupKey, studentTarget: groupKey, semDigits, prog };
}

const teachersSet = new Set();
courses.forEach(c => {
  const m = mapping[c.code] || {};
  (m.teachers || c.teachers || []).forEach(f => teachersSet.add(f));
});

const activities = [];
let actIdCounter = 1;
const recsMap = {};

courses.forEach(c => {
  const m = mapping[c.code] || {};
  let teachers = (m.theoryTeachers && m.theoryTeachers.length > 0) ? m.theoryTeachers : (m.teachers || c.teachers || []);
  if (!teachers || teachers.length === 0) return;

  const totalHours = parseInt(m.totalHours || c.hours || 4, 10);
  const { studentTarget } = getCohortInfo(c);

  recsMap[c.code] = c.recommendations || {};

  const classMatch = String(c.code).match(/(_C|_G)(\d+)/i);
  const classNum = classMatch ? parseInt(classMatch[2], 10) : 1;

  let tPool = teachers.slice();
  if (classNum === 2) tPool.reverse();
  else if (classNum > 2) {
    const shift = classNum - 1;
    tPool = tPool.slice(shift).concat(tPool.slice(0, shift));
  }

  const teacherHours = m.theoryTeacherHours || m.teacherHours || null;
  const assignedList = [];
  if (teacherHours && typeof teacherHours === 'object' && Object.keys(teacherHours).length > 0) {
    tPool.forEach(fac => {
      const h = parseInt(teacherHours[fac], 10) || 0;
      for (let i = 0; i < h; i++) assignedList.push(fac);
    });
  } else {
    const per = Math.floor(totalHours / tPool.length);
    const rem = totalHours % tPool.length;
    tPool.forEach((fac, idx) => {
      const count = per + (idx < rem ? 1 : 0);
      for (let i = 0; i < count; i++) assignedList.push(fac);
    });
  }

  for (let i = 0; i < totalHours; i++) {
    const t = assignedList[i] || teachers[0];
    activities.push({
      id: actIdCounter++,
      course: c.code,
      teacher: t,
      cohort: studentTarget,
      is_practical: (m.courseType === 'P' || c.courseType === 'P')
    });
  }
});

// Blocked slots
const blockedSlots = [];
// 1. Dept global locks
deptLocks.forEach(l => {
  blockedSlots.push({ day: l.day.toUpperCase(), period: String(l.period) });
});
// 2. Course specific 'B'
courses.forEach(c => {
  const recs = c.recommendations || {};
  WEEKDAYS.forEach(d => {
    Object.keys(recs[d] || {}).forEach(p => {
      if (recs[d][p] === 'B') {
        blockedSlots.push({ day: d, period: String(p) });
      }
    });
  });
});

const inputPayload = {
  courses: courses.map(c => c.code),
  teachers: Array.from(teachersSet),
  weekdays: WEEKDAYS,
  periods: realPeriods,
  blocked_slots: blockedSlots,
  recommendations: recsMap,
  activities
};

console.log(`Sending ${activities.length} activities to OR-Tools Solver...`);
const t0 = Date.now();

const py = spawn('python', ['-c', `
import json, sys
from server.engine.ortools_solver import solve_timetable
data = json.loads(sys.stdin.read())
result = solve_timetable(data)
print(json.dumps(result))
`]);

let out = '';
py.stdout.on('data', d => out += d);
py.stderr.on('data', d => console.error('Python Stderr:', d.toString()));
py.on('close', code => {
  const dur = (Date.now() - t0) / 1000;
  console.log(`OR-Tools completed in ${dur}s with code ${code}!`);
  try {
    const res = JSON.parse(out);
    console.log('Result Status:', res.status);
    console.log('Total Activities:', res.total_activities);
    console.log('Placed Activities:', res.placed_activities);
    console.log('Recommended Slots Matched:', res.recommended_slots_matched);
  } catch (e) {
    console.error('Parse error:', out);
  }
});

py.stdin.write(JSON.stringify(inputPayload));
py.stdin.end();

