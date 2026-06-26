import express from 'express';
import cors from 'cors';
import multer from 'multer';
import xlsx from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';
import { readDb, writeDb } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and parsing of JSON bodies
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// Configure Multer for in-memory uploads
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Helper to generate unique initials code for faculty
function generateFacultyCode(name, existingFaculty) {
  // Remove common titles
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

  // Ensure unique code
  let finalCode = baseCode;
  let counter = 1;
  const codes = new Set(existingFaculty.map(f => f.code));
  while (codes.has(finalCode)) {
    finalCode = `${baseCode}${counter}`;
    counter++;
  }
  return finalCode;
}

// Helper to extract semester from course code
function extractSemesterFromCode(code) {
  const match = code.match(/\d/);
  if (match) {
    const digit = parseInt(match[0]);
    if (digit >= 1 && digit <= 8) {
      return `${digit}`;
    }
  }
  return "1";
}

// Helper to generate course alias
function generateCourseAlias(name) {
  if (!name) return "";
  if (name.startsWith("Course ")) {
    const parts = name.split(" ");
    if (parts.length >= 2) return parts[1];
  }
  const clean = name.replace(/[^a-zA-Z0-9\s]/g, "");
  const parts = clean.split(/\s+/).filter(Boolean);
  const alias = parts.map(p => p[0].toUpperCase()).join("");
  return alias || name.substring(0, 3).toUpperCase();
}


// Global Clash Check Helper
// Returns list of clashes: { weekday, period, facultyCode, courses: [courseCodes] }
function findAllocationClashes(allocations) {
  const clashes = [];
  // For each department
  for (const dept of Object.keys(allocations)) {
    const deptAlloc = allocations[dept];
    // Map of weekday -> period -> facultyCode -> Set(courseCodes)
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

    // Check for double bookings
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

// -------------------------------------------------------------
// Authentication Endpoints
// -------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { role, password, departmentName } = req.body;
  const db = readDb();

  if (role === 'admin') {
    if (password === db.config.adminPassword) {
      return res.json({ success: true, token: 'admin-token', user: { role: 'admin' } });
    }
    return res.status(401).json({ success: false, message: 'Invalid Admin password' });
  } else if (role === 'department') {
    if (!departmentName) {
      return res.status(400).json({ success: false, message: 'Department name is required' });
    }
    const dept = db.departments[departmentName];
    if (!dept) {
      return res.status(404).json({ success: false, message: 'Department not found in database. Ask Admin to set a password.' });
    }
    if (password === dept.password) {
      return res.json({
        success: true,
        token: `dept-token-${departmentName}`,
        user: { role: 'department', departmentName }
      });
    }
    return res.status(401).json({ success: false, message: 'Invalid Department password' });
  }

  return res.status(400).json({ success: false, message: 'Invalid role specified' });
});

// -------------------------------------------------------------
// Configuration Endpoints
// -------------------------------------------------------------
app.get('/api/config', (req, res) => {
  const db = readDb();
  res.json({
    academicYear: db.config.academicYear,
    semesterType: db.config.semesterType,
    semesterLabels: db.config.semesterLabels,
    periods: db.periods || ["1", "2", "3", "LB", "4", "5", "6"]
  });
});

app.post('/api/config', (req, res) => {
  const { academicYear, semesterType, semesterLabels } = req.body;
  const db = readDb();
  
  if (academicYear) db.config.academicYear = academicYear;
  if (semesterType) db.config.semesterType = semesterType;
  if (semesterLabels) db.config.semesterLabels = semesterLabels;
  
  writeDb(db);
  res.json({ success: true, message: 'Academic configuration updated.' });
});

// -------------------------------------------------------------
// Department & Password Management Endpoints
// -------------------------------------------------------------
app.get('/api/departments', (req, res) => {
  const db = readDb();
  // Get all unique departments from courses & faculty
  const deptSet = new Set();
  db.courses.forEach(c => deptSet.add(c.department));
  db.faculty.forEach(f => deptSet.add(f.department));
  
  const depts = Array.from(deptSet).sort();
  
  const result = depts.map(name => {
    const hasPassword = !!(db.departments[name] && db.departments[name].password);
    const submission = db.submissions[name] || { status: 'Draft', comments: '' };
    return {
      name,
      hasPassword,
      status: submission.status,
      comments: submission.comments
    };
  });
  
  res.json(result);
});

app.post('/api/departments/password', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ success: false, message: 'Department name and password required' });
  }
  const db = readDb();
  if (!db.departments[name]) {
    db.departments[name] = {};
  }
  db.departments[name].password = password;
  writeDb(db);
  res.json({ success: true, message: `Password updated for department ${name}.` });
});

app.get('/api/admin/departments', (req, res) => {
  const token = req.headers['authorization'];
  if (token !== 'admin-token') {
    return res.status(401).json({ success: false, message: 'Unauthorized access' });
  }

  const db = readDb();
  const deptSet = new Set();
  db.courses.forEach(c => deptSet.add(c.department));
  db.faculty.forEach(f => deptSet.add(f.department));
  
  const depts = Array.from(deptSet).sort();
  
  const result = depts.map(name => {
    const passcode = db.departments[name] ? db.departments[name].password || '' : '';
    const hasPassword = !!passcode;
    const submission = db.submissions[name] || { status: 'Draft', comments: '' };
    return {
      name,
      hasPassword,
      passcode,
      status: submission.status,
      comments: submission.comments
    };
  });
  
  res.json(result);
});

// -------------------------------------------------------------
// Course & Faculty Administration Endpoints
// -------------------------------------------------------------
function isDepartmentLocked(db, departmentName) {
  if (!departmentName) return false;
  const deptUpper = departmentName.toUpperCase();
  const submission = db.submissions[deptUpper] || { status: 'Draft' };
  return submission.status === 'Submitted' || submission.status === 'Approved';
}

app.get('/api/courses', (req, res) => {
  const { department } = req.query;
  const db = readDb();
  let result = db.courses || [];
  if (department) {
    result = result.filter(c => c.department.toUpperCase() === department.toUpperCase());
  }
  const groupMappings = db.groupMappings || {};
  result = result.map(c => {
    return {
      ...c,
      mappedBatches: groupMappings[c.code] || []
    };
  });
  res.json(result);
});

app.post('/api/courses/alias', (req, res) => {
  const { code, alias, name, departmentName } = req.body;
  if (!code) return res.status(400).json({ success: false, message: 'Course code is required' });
  
  const db = readDb();
  if (departmentName && isDepartmentLocked(db, departmentName)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[departmentName.toUpperCase()].status}.`
    });
  }

  const course = db.courses.find(c => c.code === code);
  if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

  if (departmentName && course.department.toUpperCase() !== departmentName.toUpperCase()) {
    return res.status(403).json({ success: false, message: 'Unauthorized to edit this course.' });
  }
  
  if (alias !== undefined) course.alias = alias.trim();
  if (name !== undefined) course.name = name.trim();
  
  writeDb(db);
  res.json({ success: true, message: 'Course details updated.' });
});

app.post('/api/courses/alias/batch', (req, res) => {
  const { courses, departmentName } = req.body;
  if (!Array.isArray(courses)) {
    return res.status(400).json({ success: false, message: 'Courses must be an array.' });
  }
  
  const db = readDb();
  if (departmentName && isDepartmentLocked(db, departmentName)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[departmentName.toUpperCase()].status}.`
    });
  }

  for (const item of courses) {
    const { code, alias, name } = item;
    if (!code) continue;
    
    const course = db.courses.find(c => c.code === code);
    if (!course) continue;
    
    if (departmentName && course.department.toUpperCase() !== departmentName.toUpperCase()) {
      return res.status(403).json({ success: false, message: 'Unauthorized to edit some courses.' });
    }
    
    if (alias !== undefined) course.alias = alias.trim();
    if (name !== undefined) course.name = name.trim();
  }
  
  writeDb(db);
  res.json({ success: true, message: 'All course details updated successfully.' });
});


app.get('/api/faculty', (req, res) => {
  const { department } = req.query;
  const db = readDb();
  let result = db.faculty;
  if (department) {
    result = result.filter(f => f.department.toUpperCase() === department.toUpperCase());
  }
  res.json(result);
});

app.post('/api/faculty/code', (req, res) => {
  const { staffId, code, departmentName } = req.body;
  if (!staffId || !code) return res.status(400).json({ success: false, message: 'Staff ID and code are required' });
  
  const db = readDb();
  if (departmentName && isDepartmentLocked(db, departmentName)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[departmentName.toUpperCase()].status}.`
    });
  }

  const cleanCode = code.trim().toUpperCase();
  
  // Verify code uniqueness
  const conflict = db.faculty.find(f => f.code === cleanCode && f.staffId !== staffId);
  if (conflict) {
    return res.status(400).json({ success: false, message: `Visual code '${cleanCode}' is already assigned to ${conflict.name}.` });
  }
  
  const fac = db.faculty.find(f => f.staffId === staffId);
  if (!fac) return res.status(404).json({ success: false, message: 'Faculty not found' });

  if (departmentName && fac.department.toUpperCase() !== departmentName.toUpperCase()) {
    return res.status(403).json({ success: false, message: 'Unauthorized to edit this faculty.' });
  }
  
  const oldCode = fac.code;
  fac.code = cleanCode;

  // Update visual codes in allocations if changed
  for (const dept of Object.keys(db.allocations)) {
    const deptAlloc = db.allocations[dept];
    for (const courseCode of Object.keys(deptAlloc)) {
      const courseDays = deptAlloc[courseCode];
      for (const day of Object.keys(courseDays)) {
        for (const period of Object.keys(courseDays[day])) {
          let facs = courseDays[day][period] || [];
          if (facs.includes(oldCode)) {
            courseDays[day][period] = facs.map(c => c === oldCode ? cleanCode : c);
          }
        }
      }
    }
  }
  
  writeDb(db);
  res.json({ success: true, message: 'Faculty code updated.' });
});

app.post('/api/faculty/code/batch', (req, res) => {
  const { faculty, departmentName } = req.body;
  if (!Array.isArray(faculty)) {
    return res.status(400).json({ success: false, message: 'Faculty must be an array.' });
  }
  
  const db = readDb();
  if (departmentName && isDepartmentLocked(db, departmentName)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[departmentName.toUpperCase()].status}.`
    });
  }

  // Validate duplicate codes within database, except for self
  const tempCodes = new Map(); // staffId -> code
  db.faculty.forEach(f => tempCodes.set(f.staffId, f.code));
  
  for (const item of faculty) {
    const { staffId, code } = item;
    const cleanCode = code.trim().toUpperCase();
    if (!staffId || !cleanCode) continue;
    
    for (const [otherStaffId, otherCode] of tempCodes.entries()) {
      if (otherStaffId !== staffId && otherCode === cleanCode) {
        const conflictFac = db.faculty.find(f => f.staffId === otherStaffId);
        return res.status(400).json({ 
          success: false, 
          message: `Visual initials code '${cleanCode}' is already assigned to ${conflictFac.name}.` 
        });
      }
    }
    tempCodes.set(staffId, cleanCode);
  }
  
  // Apply all updates
  for (const item of faculty) {
    const { staffId, code } = item;
    const cleanCode = code.trim().toUpperCase();
    const fac = db.faculty.find(f => f.staffId === staffId);
    
    if (fac) {
      if (departmentName && fac.department.toUpperCase() !== departmentName.toUpperCase()) {
        return res.status(403).json({ success: false, message: 'Unauthorized to edit some faculty.' });
      }
      
      const oldCode = fac.code;
      fac.code = cleanCode;
      
      if (oldCode !== cleanCode) {
        // Update visual codes in allocations if changed
        for (const dept of Object.keys(db.allocations)) {
          const deptAlloc = db.allocations[dept];
          for (const courseCode of Object.keys(deptAlloc)) {
            const courseDays = deptAlloc[courseCode];
            for (const day of Object.keys(courseDays)) {
              for (const period of Object.keys(courseDays[day])) {
                let facs = courseDays[day][period] || [];
                if (facs.includes(oldCode)) {
                  courseDays[day][period] = facs.map(c => c === oldCode ? cleanCode : c);
                }
              }
            }
          }
        }
      }
    }
  }
  
  writeDb(db);
  res.json({ success: true, message: 'All faculty codes updated successfully.' });
});


// -------------------------------------------------------------
// Excel Import Routes
// -------------------------------------------------------------
app.post('/api/import/courses', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    if (data.length < 2) {
      return res.status(400).json({ error: 'Invalid course sheet: Too few rows.' });
    }

    // -------------------------------------------------------
    // Step 1: Read the single header row (row 0) and find all columns by name.
    // New format: headers like MON-1, TUE-3, LB, Course Code, Group, Type, etc.
    // -------------------------------------------------------
    const headerRow = data[0];
    const DAY_MAP = { MON: 'MONDAY', TUE: 'TUESDAY', WED: 'WEDNESDAY', THU: 'THURSDAY', FRI: 'FRIDAY' };
    const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

    // Named metadata column indices (detected by header name)
    let codeColIdx  = -1;
    let groupColIdx = -1;
    let typeColIdx  = -1;
    let nameColIdx  = -1;
    let deptColIdx  = -1;

    // Slot columns: { idx, day (full), period (label string) }
    const slotCols = [];
    const periodSet = new Set(); // unique period labels in order

    for (let c = 0; c < headerRow.length; c++) {
      const hdr = String(headerRow[c] || '').trim();
      const hdrLow = hdr.toLowerCase();

      // Check for slot columns: pattern DAY-N (e.g. MON-1, TUE-LB, etc.)
      const slotMatch = hdr.match(/^(MON|TUE|WED|THU|FRI)-(.+)$/i);
      if (slotMatch) {
        const dayFull = DAY_MAP[slotMatch[1].toUpperCase()];
        const period  = slotMatch[2].trim(); // e.g. "1", "2", "LB"
        if (dayFull && period.toUpperCase() !== 'LB') {
          // Only real period columns (skip lunch break)
          slotCols.push({ idx: c, day: dayFull, period });
          periodSet.add(period);
        }
        continue;
      }

      // Named metadata columns (case-insensitive)
      if (hdrLow === 'course code' || hdrLow === 'coursecode') { codeColIdx  = c; continue; }
      if (hdrLow === 'group')                                   { groupColIdx = c; continue; }
      if (hdrLow === 'type')                                    { typeColIdx  = c; continue; }
      if (hdrLow === 'course name' || hdrLow === 'coursename')  { nameColIdx  = c; continue; }
      if (hdrLow === 'department'  || hdrLow === 'dept')        { deptColIdx  = c; continue; }
    }

    const is_new_format = codeColIdx !== -1;

    if (!is_new_format) {
      return res.status(400).json({
        error: 'Could not find a "Course Code" column in the header row. ' +
               'Please make sure the first row contains column headers like "Course Code", "Group", "Type", "Course Name".'
      });
    }

    if (slotCols.length === 0) {
      return res.status(400).json({
        error: 'Could not find any slot columns (e.g. MON-1, TUE-2) in the header row.'
      });
    }

    // Derive the ordered period labels (from Monday's slots, in column order)
    const monSlots = slotCols.filter(s => s.day === 'MONDAY');
    if (monSlots.length === 0) {
      return res.status(400).json({ error: 'No MONDAY slot columns found (expected MON-1, MON-2, ...).' });
    }
    // periods = unique labels in the order they appear for MON (e.g. ["1","2","3","4","5","6"])
    const periods = monSlots.map(s => s.period);

    // Group slot columns by weekday for fast lookup: slotsByDay[day] = [{idx, period}]
    const slotsByDay = {};
    weekdays.forEach(d => { slotsByDay[d] = []; });
    slotCols.forEach(s => { slotsByDay[s.day].push({ idx: s.idx, period: s.period }); });

    const db = readDb();
    const existingCourses = db.courses || [];
    const importedCourses = [];
    const warnings = [];

    // -------------------------------------------------------
    // Step 2: Parse each data row (starting at row index 1)
    // -------------------------------------------------------
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (!row || row.length === 0) continue;

      // Read metadata fields from named columns
      const group_raw = groupColIdx >= 0 ? row[groupColIdx] : undefined;
      const type_raw  = typeColIdx  >= 0 ? row[typeColIdx]  : undefined;
      const code_raw  = codeColIdx  >= 0 ? row[codeColIdx]  : undefined;

      // Parse group number (0 = no group)
      let group_num = 0;
      if (group_raw !== undefined && group_raw !== null) {
        let g_str = String(group_raw).trim();
        if (g_str.endsWith('.0')) g_str = g_str.slice(0, -2);
        const parsedG = parseInt(g_str);
        if (!isNaN(parsedG)) group_num = parsedG;
      }

      // Parse type (T = Theory, P = Practical)
      let type_val = 'T';
      if (type_raw !== undefined && type_raw !== null) {
        const t_str = String(type_raw).trim().toUpperCase();
        if (t_str === 'P' || t_str === 'PRACTICAL') type_val = 'P';
      }

      // Parse course code — this is the base code (e.g. MAT1CJ101)
      const baseCode = String(code_raw || '').trim();
      if (!baseCode || baseCode === 'undefined' || baseCode.toLowerCase() === 'course code') continue;

      // Build the course code: if grouped, suffix with _G<n>
      const courseCode = group_num === 0 ? baseCode : `${baseCode}_G${group_num}`;

      // Resolve department from batch-dept mappings (using code prefix)
      let department = '';
      if (deptColIdx >= 0) {
        department = String(row[deptColIdx] || '').trim().toUpperCase();
      }
      if (!department) {
        const deptMatch = baseCode.match(/^([a-zA-Z]+)/);
        const deptPrefix = deptMatch ? deptMatch[1].toUpperCase() : 'GEN';
        const mapping = db.batchDeptMappings.find(m => m.code.toUpperCase() === deptPrefix);
        department = mapping ? mapping.deptName.toUpperCase() : deptPrefix;
      }

      const semester = extractSemesterFromCode(baseCode);

      // -------------------------------------------------------
      // Step 3: Extract recommended slots from slot columns
      // A cell is marked if it contains the same value as type_val (T or P)
      // -------------------------------------------------------
      const recommendations = {};
      weekdays.forEach(day => {
        recommendations[day] = {};
        slotsByDay[day].forEach(({ idx, period }) => {
          const slotVal = String(row[idx] || '').trim().toUpperCase();
          if (slotVal === type_val) {
            recommendations[day][period] = slotVal;
          }
        });
      });

      // -------------------------------------------------------
      // Step 4: Merge if same courseCode already seen (T and P rows of same course)
      // -------------------------------------------------------
      const existingImported = importedCourses.find(c => c.code === courseCode);
      if (existingImported) {
        weekdays.forEach(day => {
          Object.keys(recommendations[day]).forEach(p => {
            if (!existingImported.recommendations[day]) existingImported.recommendations[day] = {};
            existingImported.recommendations[day][p] = recommendations[day][p];
          });
        });
        // Recalculate hours
        let recHours = 0;
        weekdays.forEach(d => {
          Object.values(existingImported.recommendations[d] || {}).forEach(v => {
            if (v === 'T' || v === 'P') recHours++;
          });
        });
        existingImported.hours = recHours;
        continue;
      }

      // -------------------------------------------------------
      // Step 5: Determine course name and alias
      // Course Name column → display name; alias auto-generated or preserved from DB
      // -------------------------------------------------------
      const nameFromExcel = nameColIdx >= 0 ? String(row[nameColIdx] || '').trim() : '';
      let name  = nameFromExcel || `Course ${baseCode}`;
      let alias = '';

      const dbMatch = existingCourses.find(c => c.code === courseCode);
      if (dbMatch) {
        name  = nameFromExcel || dbMatch.name;
        alias = dbMatch.alias; // preserve custom alias
      }
      if (!alias) alias = generateCourseAlias(name);

      // Count hours from recommendations
      let hours = 0;
      weekdays.forEach(d => {
        Object.values(recommendations[d] || {}).forEach(v => {
          if (v === 'T' || v === 'P') hours++;
        });
      });

      importedCourses.push({
        code:   courseCode,
        name,
        department,
        pathway:     String(row[0] || 'SINGLE MAJOR').trim(),
        semester,
        category:    'MAJOR',
        roomNo:      '',
        batch:       '',
        hours,
        alias,
        recommendations,
        group:       group_num,
        programType: dbMatch ? (dbMatch.programType || 'UG') : 'UG'
      });
    }

    // -------------------------------------------------------
    // Step 6: Commit to database
    // -------------------------------------------------------
    db.courses = importedCourses;
    db.periods = periods;

    // Seed default semester label mappings
    const semestersSet = new Set(importedCourses.map(c => c.semester));
    const roman = { '1': 'I BSC', '2': 'II BSC', '3': 'III BSC', '4': 'IV BSC', '5': 'V BSC', '6': 'VI BSC' };
    semestersSet.forEach(sem => {
      if (!db.config.semesterLabels[sem]) {
        db.config.semesterLabels[sem] = roman[sem] || `${sem} Sem`;
      }
    });

    writeDb(db);

    res.json({
      success: true,
      message: `Imported ${importedCourses.length} courses. Periods: [${periods.join(', ')}].`,
      warnings,
      debug: {
        slotColumnsFound: slotCols.length,
        periods,
        codeColIdx,
        groupColIdx,
        typeColIdx,
        nameColIdx,
        deptColIdx
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process courses Excel: ' + err.message });
  }
});



app.post('/api/import/staff', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet);

    if (data.length === 0) {
      return res.status(400).json({ error: 'No records found in staff Excel.' });
    }

    const db = readDb();
    const importedFaculty = [];
    const warnings = [];
    
    // Temporary list to build visual codes sequentially
    const currentFacultyList = [];

    data.forEach((row, index) => {
      const staffId = String(row['Staff ID'] || '').trim();
      const name = String(row['Name'] || '').trim();
      const department = String(row['Department'] || '').trim().toUpperCase();

      if (!staffId || !name || !department) {
        warnings.push(`Row ${index + 2}: Missing Staff ID, Name, or Department. Record skipped.`);
        return;
      }

      // Generate a unique visual code initials
      const code = generateFacultyCode(name, currentFacultyList);
      
      const record = {
        staffId,
        name,
        code,
        department
      };
      
      currentFacultyList.push(record);
      importedFaculty.push(record);
    });

    // Commit to DB
    db.faculty = importedFaculty;
    writeDb(db);

    res.json({
      success: true,
      message: `Successfully imported ${importedFaculty.length} faculty members.`,
      warnings
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process staff Excel: ' + err.message });
  }
});

// -------------------------------------------------------------
// Batch-Department Mapping & Dynamic Batches Endpoints
// -------------------------------------------------------------
app.post('/api/import/batch-dept-mappings', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet);

    if (data.length === 0) {
      return res.status(400).json({ error: 'No records found in Excel.' });
    }

    const firstRow = data[0];
    let codeCol = null;
    let deptCol = null;

    Object.keys(firstRow).forEach(key => {
      const kLow = key.toLowerCase();
      if (kLow.includes('batch') || kLow.includes('code')) {
        codeCol = key;
      }
      if (kLow.includes('dept') || kLow.includes('department') || kLow.includes('name')) {
        deptCol = key;
      }
    });

    if (!codeCol || !deptCol) {
      const keys = Object.keys(firstRow);
      if (keys.length >= 2) {
        codeCol = keys[0];
        deptCol = keys[1];
      } else {
        return res.status(400).json({ error: 'Excel must have at least 2 columns: Batch Code and Department Name.' });
      }
    }

    const db = readDb();
    const imported = [];
    data.forEach(row => {
      const code = String(row[codeCol] || '').trim().toUpperCase();
      const deptName = String(row[deptCol] || '').trim().toUpperCase();
      if (code && deptName) {
        if (!imported.some(m => m.code === code)) {
          imported.push({ code, deptName });
        }
      }
    });

    db.batchDeptMappings = imported;
    writeDb(db);

    res.json({
      success: true,
      message: `Successfully imported ${imported.length} batch-department mappings.`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process batch-department mappings Excel: ' + err.message });
  }
});

app.post('/api/admin/batch-dept-mappings', (req, res) => {
  const { code, deptName } = req.body;
  if (!code || !deptName) return res.status(400).json({ success: false, message: 'Both code and department name are required' });

  const db = readDb();
  const cleanCode = code.trim().toUpperCase();
  const cleanDeptName = deptName.trim().toUpperCase();

  const conflict = db.batchDeptMappings.find(m => m.code === cleanCode);
  if (conflict) return res.status(400).json({ success: false, message: `Batch Code '${cleanCode}' already exists.` });

  db.batchDeptMappings.push({ code: cleanCode, deptName: cleanDeptName });
  writeDb(db);
  res.json({ success: true, message: 'Mapping added successfully.' });
});

app.get('/api/admin/batch-dept-mappings', (req, res) => {
  const db = readDb();
  res.json(db.batchDeptMappings || []);
});

app.put('/api/admin/batch-dept-mappings/:code', (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  const { deptName } = req.body;
  if (!deptName) return res.status(400).json({ success: false, message: 'Department name is required' });

  const db = readDb();
  const mapping = db.batchDeptMappings.find(m => m.code === code);
  if (!mapping) return res.status(404).json({ success: false, message: 'Mapping not found' });

  mapping.deptName = deptName.trim().toUpperCase();
  writeDb(db);
  res.json({ success: true, message: 'Mapping updated successfully.' });
});

app.delete('/api/admin/batch-dept-mappings/:code', (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  const db = readDb();
  const index = db.batchDeptMappings.findIndex(m => m.code === code);
  if (index === -1) return res.status(404).json({ success: false, message: 'Mapping not found' });

  db.batchDeptMappings.splice(index, 1);
  writeDb(db);
  res.json({ success: true, message: 'Mapping deleted successfully.' });
});

// -------------------------------------------------------------
// Batch Config Endpoints
// -------------------------------------------------------------
app.get('/api/admin/batch-config', (req, res) => {
  const db = readDb();
  res.json(db.batchConfig || { programTypes: {}, fundingTypes: {}, yearSemMap: {} });
});

app.put('/api/admin/batch-config', (req, res) => {
  const { programTypes, fundingTypes, yearSemMap } = req.body;
  if (!programTypes || !fundingTypes || !yearSemMap) {
    return res.status(400).json({ success: false, message: 'programTypes, fundingTypes, and yearSemMap are required.' });
  }
  const db = readDb();
  db.batchConfig = { programTypes, fundingTypes, yearSemMap };
  writeDb(db);
  res.json({ success: true, message: 'Batch config saved.' });
});

app.get('/api/batches', (req, res) => {
  const db = readDb();
  const cfg = db.batchConfig || {};
  const programTypes = cfg.programTypes || {};
  const fundingTypes  = cfg.fundingTypes  || {};
  const yearSemMap    = cfg.yearSemMap    || {};
  const mappings = db.batchDeptMappings || [];

  // Generate all combinations: {progCode}{fundingCode}{deptCode}{year}
  const batches = [];
  Object.keys(programTypes).forEach(prog => {
    Object.keys(fundingTypes).forEach(fund => {
      mappings.forEach(m => {
        Object.keys(yearSemMap).forEach(yr => {
          const semesters = yearSemMap[yr] || [];
          const batchId   = `${prog}${fund}${m.code}${yr}`;
          const batchLabel = `${programTypes[prog]} ${fundingTypes[fund]} — ${m.deptName || m.code} (${yr})`;
          batches.push({
            batchId,
            batchLabel,
            // metadata for filtering
            prog,      // "U", "P"
            fund,      // "1", "2"
            deptCode: m.code,
            deptName: m.deptName,
            year: parseInt(yr),
            semesters  // e.g. [5, 6]
          });
        });
      });
    });
  });

  res.json(batches);
});



// -------------------------------------------------------------
// Group Mappings & Courses PUT Endpoints
// -------------------------------------------------------------
app.get('/api/admin/group-mappings', (req, res) => {
  const db = readDb();
  res.json(db.groupMappings || {});
});

app.post('/api/admin/group-mappings', (req, res) => {
  const { courseCode, batches } = req.body;
  if (!courseCode || !Array.isArray(batches)) {
    return res.status(400).json({ success: false, message: 'Course code and batches array are required' });
  }

  const db = readDb();
  db.groupMappings[courseCode] = batches.map(b => b.trim().toUpperCase());
  writeDb(db);
  res.json({ success: true, message: 'Group mapping updated successfully.' });
});

app.put('/api/admin/courses/:code', (req, res) => {
  const code = req.params.code.trim();
  const { name, alias, programType } = req.body;

  const db = readDb();
  const course = db.courses.find(c => c.code === code);
  if (!course) return res.status(404).json({ success: false, message: 'Course not found' });

  if (name        !== undefined) course.name        = name.trim();
  if (alias       !== undefined) course.alias       = alias.trim();
  if (programType !== undefined) {
    const valid = ['UG', 'PG', 'INT'];
    const pt = programType.trim().toUpperCase();
    course.programType = valid.includes(pt) ? pt : 'UG';
  }

  writeDb(db);
  res.json({ success: true, message: 'Course details updated successfully.' });
});

// -------------------------------------------------------------
// Allocation & Clash Check Endpoints
// -------------------------------------------------------------
app.get('/api/allocations', (req, res) => {
  const { department } = req.query;
  const db = readDb();
  if (department) {
    const deptAlloc = db.allocations[department.toUpperCase()] || {};
    return res.json(deptAlloc);
  }
  res.json(db.allocations);
});

// Clash Detection Validation API
app.post('/api/allocations/validate', (req, res) => {
  const { departmentName, courseCode, weekday, period, facultyCodes } = req.body;
  if (!departmentName || !weekday || !period || !facultyCodes) {
    return res.status(400).json({ success: false, message: 'Missing parameters' });
  }

  const db = readDb();
  const conflicts = [];

  // Check if any selected faculty is already allocated in another course for the same weekday & period
  for (const dept of Object.keys(db.allocations)) {
    const deptAlloc = db.allocations[dept];
    for (const otherCourseCode of Object.keys(deptAlloc)) {
      if (otherCourseCode === courseCode) continue; // Skip active course
      
      const days = deptAlloc[otherCourseCode];
      if (days && days[weekday] && days[weekday][period]) {
        const otherFacs = days[weekday][period] || [];
        for (const fac of facultyCodes) {
          if (otherFacs.includes(fac)) {
            const facInfo = db.faculty.find(f => f.code === fac) || { name: fac };
            const courseInfo = db.courses.find(c => c.code === otherCourseCode) || { name: otherCourseCode };
            conflicts.push({
              facultyCode: fac,
              facultyName: facInfo.name,
              clashingCourseCode: otherCourseCode,
              clashingCourseName: courseInfo.name,
              department: dept
            });
          }
        }
      }
    }
  }

  if (conflicts.length > 0) {
    return res.json({ valid: false, conflicts });
  }
  return res.json({ valid: true });
});

// Save Allocations Endpoint (with safety validations)
app.post('/api/allocations', (req, res) => {
  const { departmentName, allocations } = req.body;
  if (!departmentName || !allocations) {
    return res.status(400).json({ success: false, message: 'Missing parameters' });
  }

  const db = readDb();
  const deptUpper = departmentName.toUpperCase();

  // Edit Lock Verification
  const submission = db.submissions[deptUpper] || { status: 'Draft' };
  if (submission.status === 'Submitted' || submission.status === 'Approved') {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${submission.status}.`
    });
  }

  // Dry run clash validation
  const testAllocations = JSON.parse(JSON.stringify(db.allocations));
  testAllocations[deptUpper] = allocations;
  
  const clashes = findAllocationClashes(testAllocations);
  if (clashes.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Timetable submission has faculty clashes. Save aborted.',
      clashes
    });
  }

  // Save allocations
  db.allocations[deptUpper] = allocations;
  
  // Set submission status to Draft when modified
  if (!db.submissions[deptUpper]) {
    db.submissions[deptUpper] = { status: 'Draft', comments: '' };
  } else {
    db.submissions[deptUpper].status = 'Draft';
  }

  writeDb(db);
  res.json({ success: true, message: 'Draft allocations saved successfully.' });
});

// -------------------------------------------------------------
// Submissions (Lifecycle) Endpoints
// -------------------------------------------------------------
app.get('/api/submissions', (req, res) => {
  const db = readDb();
  res.json(db.submissions);
});

app.post('/api/submissions/status', (req, res) => {
  const { departmentName, status, comments } = req.body;
  if (!departmentName || !status) {
    return res.status(400).json({ success: false, message: 'Department name and status are required' });
  }

  const db = readDb();
  const deptUpper = departmentName.toUpperCase();
  
  if (!db.submissions[deptUpper]) {
    db.submissions[deptUpper] = {};
  }
  
  db.submissions[deptUpper].status = status;
  db.submissions[deptUpper].comments = comments || '';
  
  writeDb(db);
  res.json({ success: true, message: `Status updated to ${status} for department ${deptUpper}.` });
});

// -------------------------------------------------------------
// Workload & Search Endpoints
// -------------------------------------------------------------
app.get('/api/reports/workload', (req, res) => {
  const db = readDb();
  
  // Compute workload summaries for all faculty
  // Result format: [{ staffId, name, department, code, workload: { courseCode: { theory: X, practical: Y } }, totalHours }]
  const summary = db.faculty.map(fac => {
    const workload = {};
    let totalHours = 0;
    
    // Search in allocations
    for (const dept of Object.keys(db.allocations)) {
      const deptAlloc = db.allocations[dept];
      for (const courseCode of Object.keys(deptAlloc)) {
        const course = db.courses.find(c => c.code === courseCode);
        if (!course) continue;
        
        const courseDays = deptAlloc[courseCode];
        for (const day of Object.keys(courseDays)) {
          for (const period of Object.keys(courseDays[day])) {
            const assignedFacs = courseDays[day][period] || [];
            if (assignedFacs.includes(fac.code)) {
              if (!workload[courseCode]) {
                workload[courseCode] = { theory: 0, practical: 0 };
              }
              
              // Recommended slot type
              const slotType = (course.recommendations && course.recommendations[day] && course.recommendations[day][period]) || 'T';
              if (slotType === 'P') {
                workload[courseCode].practical += 1;
              } else {
                workload[courseCode].theory += 1;
              }
              totalHours += 1;
            }
          }
        }
      }
    }
    
    return {
      staffId: fac.staffId,
      name: fac.name,
      code: fac.code,
      department: fac.department,
      workload,
      totalHours
    };
  });
  
  res.json(summary);
});

// Clear database endpoint
app.post('/api/admin/clear-database', (req, res) => {
  const db = readDb();
  
  db.courses = [];
  db.faculty = [];
  db.allocations = {};
  db.submissions = {};
  db.departments = {};
  db.batchDeptMappings = [];
  db.groupMappings = {};
  db.config.semesterLabels = {
    "1": "I BSC",
    "3": "III BSC",
    "5": "V BSC"
  };
  db.periods = ["1", "2", "3", "LB", "4", "5", "6"];
  
  writeDb(db);
  res.json({ success: true, message: 'Database cleared successfully.' });
});

// Fallback to serve index.html for undefined requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Clean up existing duplicates in db.json on startup
try {
  const db = readDb();
  if (db && db.courses && db.courses.length > 0) {
    const uniqueCourses = [];
    db.courses.forEach(c => {
      const existing = uniqueCourses.find(ec => ec.code === c.code);
      if (existing) {
        if (c.recommendations) {
          Object.keys(c.recommendations).forEach(day => {
            if (!existing.recommendations[day]) {
              existing.recommendations[day] = {};
            }
            Object.keys(c.recommendations[day]).forEach(period => {
              existing.recommendations[day][period] = c.recommendations[day][period];
            });
          });
        }
        existing.hours += c.hours;
        if (c.roomNo && !existing.roomNo.includes(c.roomNo)) {
          existing.roomNo += `, ${c.roomNo}`;
        }
        if (c.batch && !existing.batch.includes(c.batch)) {
          existing.batch += `, ${c.batch}`;
        }
      } else {
        uniqueCourses.push(c);
      }
    });
    if (uniqueCourses.length !== db.courses.length) {
      console.log(`Consolidated ${db.courses.length} courses down to ${uniqueCourses.length} unique courses.`);
      db.courses = uniqueCourses;
      writeDb(db);
    }
  }
} catch (err) {
  console.error("Failed to consolidate duplicate courses on startup:", err);
}

// Start Server
app.listen(PORT, () => {
  console.log(`Timetable Allocation Server running at http://localhost:${PORT}`);
});
