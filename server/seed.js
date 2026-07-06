import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import xlsx from 'xlsx';
const { readFile, utils } = xlsx;
import { initDb, readDb, writeDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKSPACE = path.join(__dirname, '..');
const COURSES_EXCEL = path.join(WORKSPACE, 'timetable_26_27 Odd.xlsx');
const STAFF_EXCEL = path.join(WORKSPACE, 'staff.xlsx');

// Visual Initials Code Generator
function generateFacultyCode(name, existingFaculty) {
  const cleanName = name
    .replace(/^(dr\.|mr\.|mrs\.|ms\.|fr\.|sr\.)/i, '')
    .trim();
  
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
  const codes = new Set(existingFaculty.map(f => f.code));
  while (codes.has(finalCode)) {
    finalCode = `${baseCode}${counter}`;
    counter++;
  }
  return finalCode;
}

export function seedDatabase() {
  console.log("Seeding database from Excel files...");
  
  if (!fs.existsSync(COURSES_EXCEL) || !fs.existsSync(STAFF_EXCEL)) {
    console.error("Excel files not found. Seed skipped.");
    return false;
  }

  try {
    // 1. Seed Staff
    const staffWb = readFile(STAFF_EXCEL);
    const staffSheet = staffWb.Sheets[staffWb.SheetNames[0]];
    const staffData = utils.sheet_to_json(staffSheet);
    
    const seededFaculty = [];
    staffData.forEach(row => {
      const staffId = String(row['Staff ID'] || '').trim();
      const name = String(row['Name'] || '').trim();
      const department = String(row['Department'] || '').trim().toUpperCase();
      
      if (staffId && name && department) {
        const code = generateFacultyCode(name, seededFaculty);
        seededFaculty.push({ staffId, name, code, department });
      }
    });
    console.log(`Parsed ${seededFaculty.length} staff records.`);

    // 2. Seed Courses & Timetable Structure
    const courseWb = readFile(COURSES_EXCEL);
    const courseSheet = courseWb.Sheets[courseWb.SheetNames[0]];
    const courseData = utils.sheet_to_json(courseSheet, { header: 1 });

    const row0 = courseData[1];
    const row1 = courseData[2];

    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
    const dayRanges = {};
    let currentDay = null;
    let dayStartIndex = -1;

    for (let c = 0; c < row0.length; c++) {
      const cellVal = String(row0[c] || '').trim().toUpperCase();
      if (weekdays.includes(cellVal)) {
        if (currentDay) dayRanges[currentDay] = { start: dayStartIndex, end: c - 1 };
        currentDay = cellVal;
        dayStartIndex = c;
      }
    }
    if (currentDay) {
      let endCol = row1.length - 1;
      for (let c = row1.length - 1; c >= dayStartIndex; c--) {
        if (String(row1[c] || '').trim() === 'Department') {
          endCol = c - 1;
          break;
        }
      }
      dayRanges[currentDay] = { start: dayStartIndex, end: endCol };
    }

    const periods = [];
    const monRange = dayRanges["MONDAY"];
    for (let c = monRange.start; c <= monRange.end; c++) {
      periods.push(String(row1[c] || '').trim());
    }

    const seededCourses = [];
    for (let r = 3; r < courseData.length; r++) {
      const row = courseData[r];
      if (!row || row.length === 0) continue;

      const courseCode = String(row[3] || '').trim();
      const department = String(row[42] || row[row.length - 1] || '').trim().toUpperCase();

      if (!courseCode || courseCode === 'undefined' || courseCode === 'Course') continue;
      if (!department || department === 'undefined') continue;

      const pathway = String(row[0] || '').trim();
      const semester = String(row[1] || '').trim();
      const category = String(row[2] || '').trim();
      const roomNo = String(row[4] || '').trim();
      const batch = String(row[5] || '').trim();
      const hours = Number(row[6]) || 0;

      const recommendations = {};
      weekdays.forEach(day => {
        const range = dayRanges[day];
        if (range) {
          recommendations[day] = {};
          for (let c = range.start; c <= range.end; c++) {
            const periodVal = String(row1[c] || '').trim();
            const slotVal = String(row[c] || '').trim().toUpperCase();
            if (slotVal === 'T' || slotVal === 'P') {
              recommendations[day][periodVal] = slotVal;
            }
          }
        }
      });

      // Default course alias
      let alias = courseCode;
      const cleanCode = courseCode.replace(/-\w+$/, '');
      const parts = cleanCode.match(/[A-Z]+(\d+[A-Z]*\d*)/i);
      if (parts && parts[1]) {
        alias = parts[1] + (courseCode.endsWith('-P') ? ' PR' : '');
      }

      seededCourses.push({
        code: courseCode,
        name: courseCode.replace(/-/g, ' '),
        department,
        pathway,
        semester,
        category,
        roomNo,
        batch,
        hours,
        alias,
        recommendations
      });
    }
    console.log(`Parsed ${seededCourses.length} course structure rows.`);

    // 3. Write all into database JSON
    const db = readDb();
    db.courses = seededCourses;
    db.faculty = seededFaculty;
    db.periods = periods;

    // Build default labels mapping
    const semestersSet = new Set(seededCourses.map(c => c.semester));
    const roman = { "1": "I BSC", "2": "II BSC", "3": "III BSC", "4": "IV BSC", "5": "V BSC", "6": "VI BSC" };
    semestersSet.forEach(sem => {
      if (!db.config.semesterLabels[sem]) {
        db.config.semesterLabels[sem] = roman[sem] || `${sem} Sem`;
      }
    });

    // Create default department login accounts (default passwords: e.g. "english123", "computerscience123")
    const deptSet = new Set();
    seededCourses.forEach(c => deptSet.add(c.department));
    seededFaculty.forEach(f => deptSet.add(f.department));
    
    deptSet.forEach(deptName => {
      const cleanName = deptName.toLowerCase().replace(/\s+/g, '');
      if (!db.departments[deptName]) {
        db.departments[deptName] = {
          password: `${cleanName}123`
        };
      }
    });

    writeDb(db);
    console.log("Database seeded successfully!");
    return true;
  } catch (err) {
    console.error("Database seed failed:", err);
    return false;
  }
}

// If run directly
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  initDb().then(() => {
    seedDatabase();
  }).catch(err => {
    console.error("Failed to initialize database for seeding:", err);
  });
}
