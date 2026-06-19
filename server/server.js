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

// -------------------------------------------------------------
// Course & Faculty Administration Endpoints
// -------------------------------------------------------------
app.get('/api/courses', (req, res) => {
  const { department } = req.query;
  const db = readDb();
  let result = db.courses;
  if (department) {
    result = result.filter(c => c.department.toUpperCase() === department.toUpperCase());
  }
  res.json(result);
});

app.post('/api/courses/alias', (req, res) => {
  const { code, alias, name, departmentName } = req.body;
  if (!code) return res.status(400).json({ success: false, message: 'Course code is required' });
  
  const db = readDb();
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
    // Read sheet to a 2D array
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    if (data.length < 2) {
      return res.status(400).json({ error: 'Invalid course sheet structure: Too few rows.' });
    }

    const row0 = data[1]; // Day names row
    const row1 = data[2]; // Period headers row

    // Find column ranges for MON, TUE, WED, THU, FRI
    const weekdays = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
    const dayRanges = {};

    let currentDay = null;
    let dayStartIndex = -1;

    for (let c = 0; c < row0.length; c++) {
      const cellVal = String(row0[c] || '').trim().toUpperCase();
      if (weekdays.includes(cellVal)) {
        if (currentDay) {
          dayRanges[currentDay] = { start: dayStartIndex, end: c - 1 };
        }
        currentDay = cellVal;
        dayStartIndex = c;
      }
    }
    if (currentDay) {
      // Find end index for the last day
      let endCol = row1.length - 1;
      // Subtract columns that represent non-day metadata
      for (let c = row1.length - 1; c >= dayStartIndex; c--) {
        const hVal = String(row1[c] || '').trim();
        if (hVal === 'Department') {
          endCol = c - 1;
          break;
        }
      }
      dayRanges[currentDay] = { start: dayStartIndex, end: endCol };
    }

    // Capture dynamic periods list from Monday range (ignoring headers like Pathway, Course, etc.)
    const monRange = dayRanges["MONDAY"];
    if (!monRange) {
      return res.status(400).json({ error: 'Could not find MONDAY columns in Row 0' });
    }
    const periods = [];
    for (let c = monRange.start; c <= monRange.end; c++) {
      periods.push(String(row1[c] || '').trim());
    }

    const importedCourses = [];
    const warnings = [];

    // Parse course rows starting at index 2
    for (let r = 3; r < data.length; r++) {
      const row = data[r];
      if (!row || row.length === 0) continue;

      const courseCode = String(row[3] || '').trim();
      const department = String(row[42] || row[row.length - 1] || '').trim().toUpperCase();

      if (!courseCode || courseCode === 'undefined' || courseCode === 'Course') continue;
      if (!department || department === 'undefined') {
        warnings.push(`Row ${r + 1}: Missing Department for course ${courseCode}. Course skipped.`);
        continue;
      }

      const pathway = String(row[0] || '').trim();
      const semester = String(row[1] || '').trim();
      const category = String(row[2] || '').trim();
      const roomNo = String(row[4] || '').trim();
      const batch = String(row[5] || '').trim();
      const hours = Number(row[6]) || 0;

      // Extract recommended slots
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

      // Default course alias based on course code extraction (e.g. CSC1CJ101-T -> CJ101)
      let alias = courseCode;
      const cleanCode = courseCode.replace(/-\w+$/, ''); // Remove suffix like -T or -P
      const parts = cleanCode.match(/[A-Z]+(\d+[A-Z]*\d*)/i);
      if (parts && parts[1]) {
        alias = parts[1] + (courseCode.endsWith('-P') ? ' PR' : '');
      }

      importedCourses.push({
        code: courseCode,
        name: courseCode.replace(/-/g, ' '), // Initial placeholder name
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

    // Commit to database
    const db = readDb();
    
    // Merge or overwrite courses
    db.courses = importedCourses;
    db.periods = periods;
    
    // Seed default mappings for semesters
    const semestersSet = new Set(importedCourses.map(c => c.semester));
    const roman = { "1": "I BSC", "2": "II BSC", "3": "III BSC", "4": "IV BSC", "5": "V BSC", "6": "VI BSC" };
    semestersSet.forEach(sem => {
      if (!db.config.semesterLabels[sem]) {
        db.config.semesterLabels[sem] = roman[sem] || `${sem} Sem`;
      }
    });

    writeDb(db);

    res.json({
      success: true,
      message: `Successfully imported ${importedCourses.length} courses with dynamic periods: [${periods.join(', ')}].`,
      warnings
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

// Fallback to serve index.html for undefined requests
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start Server
app.listen(PORT, () => {
  console.log(`Timetable Allocation Server running at http://localhost:${PORT}`);
});
