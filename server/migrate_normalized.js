import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { createNormalizedTables } from './schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'data', 'timetable.db');

export function migrateDataToNormalizedTables(sqliteDb) {
  createNormalizedTables(sqliteDb);

  // Read raw JSON data from app_data
  const rows = sqliteDb.prepare('SELECT key, value FROM app_data').all();
  if (!rows || rows.length === 0) return { success: false, message: 'app_data is empty' };

  const raw = {};
  rows.forEach(r => {
    try { raw[r.key] = JSON.parse(r.value); } catch (e) { raw[r.key] = null; }
  });

  const migrationTx = sqliteDb.transaction(() => {
    // 1. Migrate DEPARTMENTS
    const insertDept = sqliteDb.prepare(`
      INSERT INTO departments (code, name, passcode_hash, status)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        passcode_hash = excluded.passcode_hash,
        status = excluded.status
    `);
    const deptsObj = raw.departments || {};
    const submissionsObj = raw.submissions || {};
    const deptIdMap = {}; // name -> id
    const usedDeptCodes = new Set();

    sqliteDb.prepare('SELECT id, code, name FROM departments').all().forEach(d => {
      deptIdMap[d.name.toUpperCase().trim()] = d.id;
      if (d.code) usedDeptCodes.add(d.code.toUpperCase().trim());
    });

    function generateDeptCode(name, explicitCode) {
      if (explicitCode && !usedDeptCodes.has(explicitCode.toUpperCase().trim())) {
        const c = explicitCode.toUpperCase().trim();
        usedDeptCodes.add(c);
        return c;
      }
      const clean = (name || 'DEPT').toUpperCase().trim();
      let base = '';
      if (clean.includes('_SF')) {
        const prefix = clean.replace(/_SF.*/, '').replace(/[^A-Z0-9]/g, '');
        base = `${prefix.substring(0, 4)}_SF`;
      } else {
        const words = clean.split(/[\s,]+/).filter(Boolean);
        if (words.length >= 2) {
          base = words.map(w => w[0]).join('').substring(0, 6);
        } else {
          base = clean.substring(0, 5).replace(/[^A-Z0-9]/g, '');
        }
      }
      if (!base) base = 'DEPT';
      let candidate = base;
      let counter = 1;
      while (usedDeptCodes.has(candidate)) {
        candidate = `${base}${counter}`;
        counter++;
      }
      usedDeptCodes.add(candidate);
      return candidate;
    }

    Object.entries(deptsObj).forEach(([name, dData]) => {
      const dName = name.toUpperCase().trim();
      const code = generateDeptCode(dName, dData.code);
      const status = (submissionsObj[name] && submissionsObj[name].status) || 'Draft';
      insertDept.run(code, dName, dData.passcode || '', status);
    });

    sqliteDb.prepare('SELECT id, name FROM departments').all().forEach(d => {
      deptIdMap[d.name.toUpperCase().trim()] = d.id;
    });

    // 2. Migrate FACULTY
    const insertFaculty = sqliteDb.prepare(`
      INSERT INTO faculty (staff_id, code, name, department_id, designation, max_weekly_hours, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(staff_id, department_id) DO UPDATE SET
        code = excluded.code,
        name = excluded.name,
        designation = excluded.designation,
        max_weekly_hours = excluded.max_weekly_hours
    `);
    const facList = raw.faculty || [];
    const facultyIdMap = {}; // code / compound key -> id

    facList.forEach(f => {
      const dName = (f.department || '').toUpperCase().trim();
      let dId = deptIdMap[dName];
      if (!dId) {
        // Create department if missing
        const code = generateDeptCode(dName);
        insertDept.run(code, dName, '', 'Draft');
        const dRow = sqliteDb.prepare('SELECT id FROM departments WHERE name = ?').get(dName);
        dId = dRow ? dRow.id : null;
        if (dId) deptIdMap[dName] = dId;
      }
      const staffIdVal = (f.staffId || f.code || '').trim();
      insertFaculty.run(staffIdVal, f.code.trim(), f.name.trim(), dId, f.designation || 'Faculty', f.maxHours || 20);
    });

    sqliteDb.prepare('SELECT id, staff_id, code, department_id FROM faculty').all().forEach(f => {
      if (f.code) {
        facultyIdMap[f.code.trim().toUpperCase()] = f.id;
        facultyIdMap[`${f.code.trim().toUpperCase()}_${f.department_id}`] = f.id;
      }
      if (f.staff_id) {
        facultyIdMap[`${f.staff_id.trim().toUpperCase()}_${f.department_id}`] = f.id;
      }
    });

    // 3. Migrate COURSES & RECOMMENDATIONS
    const insertCourse = sqliteDb.prepare(`
      INSERT INTO courses (code, name, alias, department_id, semester, class, program_type, course_type, category, pathway, hours, theory_hours, practical_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code, class, department_id) DO UPDATE SET
        name = excluded.name,
        alias = excluded.alias,
        semester = excluded.semester,
        program_type = excluded.program_type,
        course_type = excluded.course_type,
        category = excluded.category,
        pathway = excluded.pathway,
        hours = excluded.hours,
        theory_hours = excluded.theory_hours,
        practical_hours = excluded.practical_hours
    `);
    const insertRec = sqliteDb.prepare(`
      INSERT INTO curriculum_recommendations (course_id, day_of_week, period_label, slot_type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(course_id, day_of_week, period_label) DO UPDATE SET
        slot_type = excluded.slot_type
    `);

    const courseList = raw.courses || [];
    const courseIdMap = {}; // code / compound key -> id

    courseList.forEach(c => {
      const dName = (c.department || '').toUpperCase().trim();
      let dId = deptIdMap[dName];
      if (!dId) {
        const code = generateDeptCode(dName);
        insertDept.run(code, dName, '', 'Draft');
        const dRow = sqliteDb.prepare('SELECT id FROM departments WHERE name = ?').get(dName);
        dId = dRow ? dRow.id : null;
        if (dId) deptIdMap[dName] = dId;
      }
      const cCode = c.code.trim();
      const cClass = parseInt(c.class !== undefined ? c.class : (c.group || 0), 10) || 0;
      const sem = String(c.semester || '1').trim();
      const prog = (c.programType || 'UG').toUpperCase().trim();
      const cType = (c.courseType || 'T').toUpperCase().trim();
      const cat = (c.category || 'CORE').toUpperCase().trim();
      const pathw = (c.pathway || 'SINGLE MAJOR').toUpperCase().trim();
      const h = parseInt(c.hours) || 4;
      const th = parseInt(c.theoryHours !== undefined ? c.theoryHours : h) || 0;
      const pr = parseInt(c.practicalHours !== undefined ? c.practicalHours : 0) || 0;

      insertCourse.run(cCode, c.name.trim(), c.alias || '', dId, sem, cClass, prog, cType, cat, pathw, h, th, pr);
    });

    sqliteDb.prepare('SELECT id, code, class, department_id FROM courses').all().forEach(c => {
      courseIdMap[c.code.trim().toUpperCase()] = c.id;
      courseIdMap[`${c.code.trim().toUpperCase()}_${c.department_id}`] = c.id;
      courseIdMap[`${c.code.trim().toUpperCase()}_${c.class || 0}_${c.department_id}`] = c.id;
    });

    // Populate recommendations
    courseList.forEach(c => {
      const cId = courseIdMap[c.code.trim().toUpperCase()];
      if (!cId || !c.recommendations) return;
      Object.entries(c.recommendations).forEach(([day, periodsObj]) => {
        const dayUpper = day.toUpperCase().trim();
        Object.entries(periodsObj || {}).forEach(([p, val]) => {
          if (val) {
            insertRec.run(cId, dayUpper, String(p).trim(), String(val).toUpperCase().trim());
          }
        });
      });
    });

    // 4. Migrate SUBJECT TEACHER MAPPINGS
    const insertCFM = sqliteDb.prepare(`
      INSERT OR REPLACE INTO course_faculty_mappings (course_id, faculty_id, role, assigned_hours)
      VALUES (?, ?, ?, ?)
    `);
    const stmObj = raw.subjectTeacherMapping || {};
    Object.values(stmObj).forEach(deptMap => {
      if (!deptMap || typeof deptMap !== 'object') return;
      Object.entries(deptMap).forEach(([cCode, mapping]) => {
        const cId = courseIdMap[cCode.trim().toUpperCase()];
        if (!cId || !mapping) return;

        // Theory teachers
        const thTeachers = mapping.theoryTeachers || [];
        const thHours = mapping.theoryTeacherHours || {};
        thTeachers.forEach(fCode => {
          const fId = facultyIdMap[fCode.trim().toUpperCase()];
          if (fId) {
            insertCFM.run(cId, fId, 'THEORY', thHours[fCode] || 0);
          }
        });

        // Practical teachers
        const prTeachers = mapping.practicalTeachers || [];
        prTeachers.forEach(fCode => {
          const fId = facultyIdMap[fCode.trim().toUpperCase()];
          if (fId) {
            insertCFM.run(cId, fId, 'PRACTICAL', 0);
          }
        });
      });
    });

    // 5. Migrate TIMETABLE ALLOCATIONS & ALLOCATION FACULTY
    const insertAlloc = sqliteDb.prepare(`
      INSERT OR REPLACE INTO timetable_allocations (academic_year, department_id, course_id, day_of_week, period_label, slot_type, room_no, section_batch, is_pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAllocFac = sqliteDb.prepare(`
      INSERT OR REPLACE INTO allocation_faculty (allocation_id, faculty_id, is_primary)
      VALUES (?, ?, ?)
    `);

    const acadYear = (raw.config && raw.config.academicYear) || '2026-2027';
    const allocsObj = raw.allocations || {};

    Object.entries(allocsObj).forEach(([dName, coursesObj]) => {
      const dId = deptIdMap[dName.toUpperCase().trim()];
      if (!dId || !coursesObj) return;

      Object.entries(coursesObj).forEach(([cCode, daysObj]) => {
        const cId = courseIdMap[cCode.trim().toUpperCase()];
        if (!cId || !daysObj) return;
        const cObj = courseList.find(x => x.code.trim().toUpperCase() === cCode.trim().toUpperCase());

        Object.entries(daysObj).forEach(([day, periodsObj]) => {
          const dayUpper = day.toUpperCase().trim();
          Object.entries(periodsObj || {}).forEach(([p, facList]) => {
            if (!Array.isArray(facList) || facList.length === 0) return;
            const isPrac = facList.length > 1 || (cObj && cObj.courseType === 'P');
            const slotType = isPrac ? 'P' : 'T';
            const roomNo = isPrac ? 'CS-Lab' : (cObj && cObj.roomNo ? cObj.roomNo : 'Room');

            const res = insertAlloc.run(acadYear, dId, cId, dayUpper, String(p).trim(), slotType, roomNo, 'C1', 0);
            const allocId = res.lastInsertRowid;

            facList.forEach((fCode, idx) => {
              const fId = facultyIdMap[fCode.trim().toUpperCase()];
              if (fId) {
                insertAllocFac.run(allocId, fId, idx === 0 ? 1 : 0);
              }
            });
          });
        });
      });
    });

    // 6. Migrate TEACHER UNAVAILABILITY
    const insertUnavail = sqliteDb.prepare(`
      INSERT OR REPLACE INTO teacher_unavailability (faculty_id, day_of_week, period_label, reason)
      VALUES (?, ?, ?, ?)
    `);
    const unavailObj = raw.teacherUnavailability || {};
    Object.entries(unavailObj).forEach(([fCode, slots]) => {
      const fId = facultyIdMap[fCode.trim().toUpperCase()];
      if (!fId || !Array.isArray(slots)) return;
      slots.forEach(slot => {
        if (typeof slot === 'string' && slot.includes('_')) {
          const [d, p] = slot.split('_');
          insertUnavail.run(fId, d.toUpperCase().trim(), p.trim(), 'Blackout');
        } else if (slot && slot.day && slot.period) {
          insertUnavail.run(fId, slot.day.toUpperCase().trim(), String(slot.period).trim(), slot.reason || 'Blackout');
        }
      });
    });

    // 7. Migrate GLOBAL LOCKED PERIODS
    const insertLock = sqliteDb.prepare(`
      INSERT OR REPLACE INTO global_locked_periods (day_of_week, period_label, semester_scope, title, notes)
      VALUES (?, ?, ?, ?, ?)
    `);
    const locks = (raw.config && raw.config.globalLockedPeriods) || [];
    locks.forEach(l => {
      insertLock.run(l.day.toUpperCase().trim(), String(l.period).trim(), String(l.semester || 'ALL').trim(), l.label || 'Locked', '');
    });

    // 8. Migrate SYSTEM CONFIG
    const insertConfig = sqliteDb.prepare(`
      INSERT OR REPLACE INTO system_config (config_key, config_value)
      VALUES (?, ?)
    `);
    if (raw.config) {
      Object.entries(raw.config).forEach(([k, v]) => {
        insertConfig.run(k, JSON.stringify(v));
      });
    }
  });

  migrationTx();
  return { success: true };
}
