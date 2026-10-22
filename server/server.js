import express from 'express';
import cors from 'cors';
import multer from 'multer';
import xlsx from 'xlsx';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, readDb, writeDb } from './db.js';
import { generateDepartmentSchedule } from './scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and parsing of JSON bodies
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files with no-cache to ensure browsers always receive latest updates
app.use(express.static(path.join(__dirname, '../public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Health check / ping endpoints for uptime bots & monitors (keeps Render from sleeping)
app.get(['/health', '/api/health', '/ping'], (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    message: 'Timetable server is active and running'
  });
});

app.head(['/', '/health', '/api/health', '/ping'], (req, res) => {
  res.status(200).end();
});

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
// Authentication & Authorization Middlewares
// -------------------------------------------------------------
function requireAdmin(req, res, next) {
  const token = req.headers['authorization'] || req.query.token;
  if (token !== 'admin-token') {
    return res.status(401).json({ success: false, message: 'Unauthorized: Admin access required.' });
  }
  next();
}

function requireDepartment(req, res, next) {
  const token = req.headers['authorization'];
  if (!token || !token.startsWith('dept-token-')) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Department access required.' });
  }
  
  const tokenDept = token.substring('dept-token-'.length).toUpperCase();
  const reqDept = (req.body.departmentName || req.query.department || '').toUpperCase();
  
  if (reqDept && reqDept !== tokenDept) {
    return res.status(403).json({ success: false, message: 'Forbidden: You do not have access to this department.' });
  }
  
  req.departmentName = tokenDept;
  next();
}

function requireUser(req, res, next) {
  const token = req.headers['authorization'] || req.query.token;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Access token required.' });
  }
  if (token === 'admin-token' || token.startsWith('dept-token-')) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Unauthorized: Invalid access token.' });
}

// -------------------------------------------------------------
// Health Check Endpoint (For Uptime Robot monitoring)
// -------------------------------------------------------------
app.head('/healthcheck', (req, res) => {
  res.status(200).end();
});

app.get('/healthcheck', (req, res) => {
  res.status(200).end();
});


// Helper to ensure all departments (existing or newly discovered) have a default password of '123456'
function ensureDepartmentDefaults(db) {
  if (!db.departments) db.departments = {};
  let changed = false;
  const deptSet = new Set();
  (db.courses || []).forEach(c => c.department && deptSet.add(c.department.trim()));
  (db.faculty || []).forEach(f => f.department && deptSet.add(f.department.trim()));
  Object.keys(db.departments).forEach(name => deptSet.add(name.trim()));

  deptSet.forEach(name => {
    const existingKey = Object.keys(db.departments).find(k => k.trim().toLowerCase() === name.toLowerCase());
    if (!existingKey) {
      db.departments[name] = { password: '123456' };
      changed = true;
    } else if (!db.departments[existingKey].password) {
      db.departments[existingKey].password = '123456';
      changed = true;
    }
  });

  return changed;
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
    if (!db.departments) db.departments = {};

    // Match department case-insensitively
    const existingKey = Object.keys(db.departments).find(
      k => k.trim().toLowerCase() === departmentName.trim().toLowerCase()
    );

    let deptKey = existingKey || departmentName.trim();
    let dept = db.departments[deptKey];

    // Any newly added department has default password "123456"
    if (!dept) {
      db.departments[deptKey] = { password: '123456' };
      writeDb(db);
      dept = db.departments[deptKey];
    } else if (!dept.password) {
      dept.password = '123456';
      writeDb(db);
    }

    if (password === dept.password) {
      return res.json({
        success: true,
        token: `dept-token-${deptKey}`,
        user: { role: 'department', departmentName: deptKey }
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
    periods: db.periods || ["1", "2", "3", "LB", "4", "5", "6"],
    globalLockedPeriods: db.config.globalLockedPeriods || [],
    commonBatches: db.commonBatches || []
  });
});

app.post('/api/config', requireAdmin, (req, res) => {
  const { academicYear, semesterType, semesterLabels } = req.body;
  const db = readDb();
  
  if (academicYear) db.config.academicYear = academicYear;
  if (semesterType) db.config.semesterType = semesterType;
  if (semesterLabels) db.config.semesterLabels = semesterLabels;
  
  writeDb(db);
  res.json({ success: true, message: 'Academic configuration updated.' });
});

app.get('/api/admin/global-locked-periods', requireUser, (req, res) => {
  const db = readDb();
  res.json(db.config.globalLockedPeriods || []);
});

app.post('/api/admin/global-locked-periods', requireAdmin, (req, res) => {
  const { locks } = req.body;
  if (!Array.isArray(locks)) {
    return res.status(400).json({ success: false, message: 'Locks must be an array.' });
  }
  const db = readDb();
  db.config.globalLockedPeriods = locks;
  writeDb(db);
  res.json({ success: true, message: 'Global locked periods updated successfully.' });
});

// Common Subject Batches Endpoints
app.get('/api/common-batches', requireUser, (req, res) => {
  const db = readDb();
  res.json(db.commonBatches || []);
});

app.post('/api/common-batches', requireUser, (req, res) => {
  const { batch, batches } = req.body;
  const db = readDb();
  if (!db.commonBatches) db.commonBatches = [];

  if (Array.isArray(batches)) {
    db.commonBatches = batches;
  } else if (batch && typeof batch === 'object') {
    if (!batch.id) {
      batch.id = 'cb_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    }
    const idx = db.commonBatches.findIndex(b => b.id === batch.id);
    if (idx >= 0) {
      db.commonBatches[idx] = { ...db.commonBatches[idx], ...batch };
    } else {
      db.commonBatches.push(batch);
    }
  } else {
    return res.status(400).json({ success: false, message: 'Invalid batch data provided.' });
  }

  writeDb(db);
  res.json({ success: true, message: 'Common batches saved successfully.', batches: db.commonBatches });
});

app.delete('/api/common-batches/:id', requireUser, (req, res) => {
  const { id } = req.params;
  const db = readDb();
  if (!db.commonBatches) db.commonBatches = [];
  const initialLen = db.commonBatches.length;
  db.commonBatches = db.commonBatches.filter(b => b.id !== id);

  if (db.commonBatches.length !== initialLen) {
    writeDb(db);
  }
  res.json({ success: true, message: 'Batch removed successfully.', batches: db.commonBatches });
});

// -------------------------------------------------------------
// Department & Password Management Endpoints
// -------------------------------------------------------------
app.get('/api/departments', (req, res) => {
  const db = readDb();
  if (ensureDepartmentDefaults(db)) {
    writeDb(db);
  }

  // Get all unique departments from courses, faculty & db.departments
  const deptSet = new Set();
  (db.courses || []).forEach(c => c.department && deptSet.add(c.department.trim()));
  (db.faculty || []).forEach(f => f.department && deptSet.add(f.department.trim()));
  Object.keys(db.departments || {}).forEach(name => deptSet.add(name.trim()));

  const depts = Array.from(deptSet).sort();

  const result = depts.map(name => {
    const existingKey = Object.keys(db.departments).find(k => k.trim().toLowerCase() === name.toLowerCase());
    const hasPassword = !!(existingKey && db.departments[existingKey] && db.departments[existingKey].password);
    const submission = (db.submissions && db.submissions[name]) || { status: 'Draft', comments: '' };
    return {
      name,
      hasPassword,
      status: submission.status,
      comments: submission.comments
    };
  });

  res.json(result);
});

// Change Department Password Endpoint (used by departments in Advanced Features)
app.post('/api/department/change-password', (req, res) => {
  const token = req.headers['authorization'];
  let deptName = '';
  if (token && token.startsWith('dept-token-')) {
    deptName = token.substring('dept-token-'.length).trim();
  } else if (token === 'admin-token' && req.body.departmentName) {
    deptName = req.body.departmentName.trim();
  } else {
    return res.status(401).json({ success: false, message: 'Unauthorized: Department access token required.' });
  }

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Current password and new password are required.' });
  }

  if (newPassword.trim().length < 4) {
    return res.status(400).json({ success: false, message: 'New password must be at least 4 characters long.' });
  }

  const db = readDb();
  if (!db.departments) db.departments = {};

  const existingKey = Object.keys(db.departments).find(k => k.trim().toLowerCase() === deptName.toLowerCase());
  const currentDbPassword = (existingKey && db.departments[existingKey]?.password) ? db.departments[existingKey].password : '123456';

  if (currentPassword !== currentDbPassword) {
    return res.status(400).json({ success: false, message: 'Incorrect current password.' });
  }

  const targetKey = existingKey || deptName.toUpperCase();
  if (!db.departments[targetKey]) {
    db.departments[targetKey] = {};
  }
  db.departments[targetKey].password = newPassword.trim();
  writeDb(db);

  res.json({ success: true, message: `Password changed successfully for department ${targetKey}.` });
});

app.post('/api/departments/password', requireAdmin, (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ success: false, message: 'Department name and password required' });
  }
  const db = readDb();
  if (!db.departments) db.departments = {};
  const existingKey = Object.keys(db.departments).find(k => k.trim().toLowerCase() === name.trim().toLowerCase()) || name.trim();
  if (!db.departments[existingKey]) {
    db.departments[existingKey] = {};
  }
  db.departments[existingKey].password = password.trim();
  writeDb(db);
  res.json({ success: true, message: `Password updated for department ${existingKey}.` });
});

app.get('/api/admin/departments', requireAdmin, (req, res) => {
  const db = readDb();
  if (ensureDepartmentDefaults(db)) {
    writeDb(db);
  }

  const deptSet = new Set();
  (db.courses || []).forEach(c => c.department && deptSet.add(c.department.trim()));
  (db.faculty || []).forEach(f => f.department && deptSet.add(f.department.trim()));
  Object.keys(db.departments || {}).forEach(name => deptSet.add(name.trim()));

  const depts = Array.from(deptSet).sort();

  const result = depts.map(name => {
    const existingKey = Object.keys(db.departments).find(k => k.trim().toLowerCase() === name.toLowerCase());
    const passcode = (existingKey && db.departments[existingKey]) ? db.departments[existingKey].password || '123456' : '123456';
    const submission = (db.submissions && db.submissions[name]) || { status: 'Draft', comments: '' };
    return {
      name,
      hasPassword: true,
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

app.get('/api/courses', requireUser, (req, res) => {
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

app.post('/api/courses/alias', requireUser, (req, res) => {
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

app.post('/api/courses/alias/batch', requireUser, (req, res) => {
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

// Class Configuration Endpoint
app.post('/api/courses/class-config', requireUser, (req, res) => {
  const { courseCode, classes, batches, departmentName } = req.body;
  if (!courseCode || classes === undefined || !Array.isArray(batches) || !departmentName) {
    return res.status(400).json({ success: false, message: 'Missing parameters.' });
  }

  const db = readDb();
  const deptUpper = departmentName.toUpperCase();

  // Verify Edit Lock Status
  if (isDepartmentLocked(db, deptUpper)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[deptUpper].status}.`
    });
  }

  // Find course and verify ownership
  const targetBaseCode = courseCode.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '');
  const course = db.courses.find(c => c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '') === targetBaseCode);
  if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });

  if (course.department.toUpperCase() !== deptUpper) {
    return res.status(403).json({ success: false, message: 'Unauthorized to edit this course.' });
  }

  // Token ownership check
  const token = req.headers['authorization'] || req.query.token;
  if (token !== 'admin-token') {
    const tokenDept = token.substring('dept-token-'.length).toUpperCase();
    if (deptUpper !== tokenDept) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have access to this department.' });
    }
  }

  const targetClassesCount = parseInt(classes) || 1;

  // Set the classes count property directly on all theory/practical variations of the base course
  const matchingCourses = db.courses.filter(c => c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '') === targetBaseCode);
  matchingCourses.forEach(c => {
    c.classes = targetClassesCount;
  });

  // Clear old mapped batches for this base code and C1..C5 classes
  delete db.groupMappings[targetBaseCode];
  for (let i = 1; i <= 5; i++) {
    delete db.groupMappings[`${targetBaseCode}_C${i}`];
  }

  if (targetClassesCount > 1) {
    for (let i = 1; i <= targetClassesCount; i++) {
      const mapped = batches[i - 1] ? [batches[i - 1].trim().toUpperCase()] : [];
      db.groupMappings[`${targetBaseCode}_C${i}`] = mapped;
    }
  } else {
    db.groupMappings[targetBaseCode] = batches.map(b => b.trim().toUpperCase());
  }

  writeDb(db);

  res.json({
    success: true,
    message: `Successfully updated class configuration to ${targetClassesCount} classes.`
  });
});

// -------------------------------------------------------------
// Curriculum & Recommended Slots Allocation Endpoint
// -------------------------------------------------------------
app.post('/api/curriculum-slots', requireUser, (req, res) => {
  const { departmentName, semester, courseRecommendations, semesterBlocks } = req.body;
  if (!departmentName) {
    return res.status(400).json({ success: false, message: 'Department name is required.' });
  }

  const db = readDb();
  const deptUpper = departmentName.toUpperCase();

  if (isDepartmentLocked(db, deptUpper)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[deptUpper].status}.`
    });
  }

  // 1. Update course recommendations
  if (courseRecommendations && typeof courseRecommendations === 'object') {
    Object.keys(courseRecommendations).forEach(courseCode => {
      const recs = courseRecommendations[courseCode];
      const baseCode = courseCode.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
      const coursesToUpdate = db.courses.filter(c => {
        const cBase = c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
        return (c.code === courseCode || cBase === baseCode) && c.department.toUpperCase() === deptUpper;
      });

      coursesToUpdate.forEach(c => {
        if (!c.masterRecommendations) {
          c.masterRecommendations = JSON.parse(JSON.stringify(c.recommendations || {}));
        }
        c.recommendations = JSON.parse(JSON.stringify(recs));
      });
    });
  }

  // 2. Update semester blocked periods if provided
  if (Array.isArray(semesterBlocks) && semester) {
    if (!db.config.globalLockedPeriods) db.config.globalLockedPeriods = [];
    const semStr = String(semester).replace(/^Sem(ester)?\s*/i, '').trim();
    // Remove existing "Blocked" locks for this department's semester
    db.config.globalLockedPeriods = db.config.globalLockedPeriods.filter(l => {
      const lSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();
      const isBlockedLabel = (l.label || '').toUpperCase().startsWith('BLOCKED');
      return !(lSem === semStr && isBlockedLabel);
    });

    // Add new blocks
    semesterBlocks.forEach(b => {
      if (b && b.day && b.period) {
        db.config.globalLockedPeriods.push({
          day: b.day.toUpperCase(),
          period: String(b.period),
          semester: semStr,
          label: 'Blocked'
        });
      }
    });
  }

  writeDb(db);
  res.json({
    success: true,
    message: 'Curriculum recommended slots and blocked periods saved successfully.',
    courses: db.courses,
    globalLockedPeriods: db.config.globalLockedPeriods
  });
});

// -------------------------------------------------------------
// Reset Curriculum & Recommended Slots to Master Baseline
// -------------------------------------------------------------
app.post('/api/curriculum-slots/reset', requireUser, (req, res) => {
  const { departmentName, semester, courseFilter } = req.body;
  if (!departmentName) {
    return res.status(400).json({ success: false, message: 'Department name is required.' });
  }

  const db = readDb();
  const deptUpper = departmentName.toUpperCase();

  if (isDepartmentLocked(db, deptUpper)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[deptUpper].status}.`
    });
  }

  const semStr = String(semester || '').replace(/^Sem(ester)?\s*/i, '').trim();

  // Find courses to reset
  const coursesToReset = db.courses.filter(c => {
    const cDept = (c.department || '').toUpperCase();
    const cSem = String(c.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();
    const cBase = c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
    const matchDept = cDept === deptUpper;
    const matchSem = !semStr || cSem === semStr;
    const matchCourse = (!courseFilter || courseFilter === 'ALL' || cBase === courseFilter || c.code === courseFilter);
    return matchDept && matchSem && matchCourse;
  });

  coursesToReset.forEach(c => {
    if (c.masterRecommendations) {
      c.recommendations = JSON.parse(JSON.stringify(c.masterRecommendations));
    }
  });

  // If resetting whole semester (courseFilter is 'ALL'), remove user-created semester blocked periods for this semester
  if (!courseFilter || courseFilter === 'ALL') {
    if (db.config.globalLockedPeriods) {
      db.config.globalLockedPeriods = db.config.globalLockedPeriods.filter(l => {
        const lSem = String(l.semester || '').replace(/^Sem(ester)?\s*/i, '').trim();
        const isBlocked = (l.label || '').toUpperCase().startsWith('BLOCKED');
        return !(lSem === semStr && isBlocked);
      });
    }
  }

  writeDb(db);
  res.json({
    success: true,
    message: 'Curriculum allocations reset to master timetable recommended slots.',
    courses: db.courses,
    globalLockedPeriods: db.config.globalLockedPeriods
  });
});


app.get('/api/faculty', requireUser, (req, res) => {
  const { department } = req.query;
  const db = readDb();
  let result = db.faculty;
  if (department) {
    result = result.filter(f => f.department.toUpperCase() === department.toUpperCase());
  }
  res.json(result);
});

app.post('/api/faculty/code', requireUser, (req, res) => {
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

app.post('/api/faculty/code/batch', requireUser, (req, res) => {
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
// Backup & Restore Routes
// -------------------------------------------------------------
app.get('/api/admin/backup', requireAdmin, (req, res) => {
  try {
    const db = readDb();
    res.setHeader('Content-Disposition', 'attachment; filename="timetable_backup.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(db, null, 2));
  } catch (err) {
    console.error("Backup generation failed:", err);
    res.status(500).json({ success: false, message: 'Failed to generate backup.' });
  }
});

app.post('/api/admin/restore', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No backup file uploaded.' });
  }

  try {
    const backupData = JSON.parse(req.file.buffer.toString('utf8'));
    
    // Validate required fields
    if (!backupData.config || !backupData.courses || !backupData.faculty) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid backup file. It must containconfig, courses, and faculty records.' 
      });
    }

    // Write back to database
    writeDb(backupData);
    res.json({ success: true, message: 'Database successfully restored from backup file.' });
  } catch (err) {
    console.error("Backup restoration failed:", err);
    res.status(400).json({ success: false, message: 'Failed to restore database. Ensure the file is valid JSON.' });
  }
});


// -------------------------------------------------------------
// Excel Import Routes
// -------------------------------------------------------------
app.post('/api/import/courses', requireAdmin, upload.single('file'), (req, res) => {
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

    let codeColIdx  = -1;
    let groupColIdx = -1;
    let typeColIdx  = -1;
    let nameColIdx  = -1;
    let deptColIdx  = -1;
    let semColIdx   = -1;
    let programColIdx = -1;
    let categoryColIdx = -1;
 
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
       if (hdrLow === 'semester'    || hdrLow === 'sem')         { semColIdx   = c; continue; }
       if (hdrLow === 'program'     || hdrLow === 'prog' || hdrLow === 'program type' || hdrLow === 'programtype') { programColIdx = c; continue; }
       if (hdrLow === 'category'    || hdrLow === 'cat' || hdrLow === 'course category' || hdrLow === 'coursecategory') { categoryColIdx = c; continue; }
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

      // Parse type (T = Theory, P = Practical, M = Mentor/Meeting)
      let type_val = 'T';
      if (type_raw !== undefined && type_raw !== null) {
        const t_str = String(type_raw).trim().toUpperCase();
        if (t_str === 'P' || t_str === 'PRACTICAL') {
          type_val = 'P';
        } else if (t_str === 'M' || t_str === 'MENTOR' || t_str === 'MEETING') {
          type_val = 'M';
        }
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

      // Parse Semester
      let semester = '';
      if (semColIdx >= 0 && row[semColIdx] !== undefined && row[semColIdx] !== null) {
        semester = String(row[semColIdx]).trim();
      }
      if (!semester) {
        semester = extractSemesterFromCode(baseCode);
      }

      const dbMatch = existingCourses.find(c => c.code === courseCode);

      // Parse Program Type
      let program_val = 'UG';
      if (programColIdx >= 0 && row[programColIdx] !== undefined && row[programColIdx] !== null) {
        const p_str = String(row[programColIdx]).trim().toUpperCase();
        if (p_str === 'UG' || p_str === 'PG' || p_str === 'INT') {
          program_val = p_str;
        }
      } else if (dbMatch && dbMatch.programType) {
        program_val = dbMatch.programType;
      }

      // Parse Course Category
      let category_val = 'MAJOR';
      if (categoryColIdx >= 0 && row[categoryColIdx] !== undefined && row[categoryColIdx] !== null) {
        category_val = String(row[categoryColIdx]).trim().toUpperCase();
      } else if (dbMatch && dbMatch.category) {
        category_val = dbMatch.category;
      }

      // -------------------------------------------------------
      // Step 3: Extract recommended slots from slot columns
      // A cell is marked if it contains the same value as type_val (T or P)
      // For type 'M' courses, there are no recommended slots.
      // -------------------------------------------------------
      const recommendations = {};
      weekdays.forEach(day => {
        recommendations[day] = {};
        slotsByDay[day].forEach(({ idx, period }) => {
          const slotVal = String(row[idx] || '').trim().toUpperCase();
          if (type_val !== 'M' && slotVal === type_val) {
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
        
        if (existingImported.courseType !== 'M' && type_val === 'M') {
          existingImported.courseType = 'M';
        }
        continue;
      }

      // -------------------------------------------------------
      // Step 5: Determine course name and alias
      // Course Name column → display name; alias auto-generated or preserved from DB
      // -------------------------------------------------------
      const nameFromExcel = nameColIdx >= 0 ? String(row[nameColIdx] || '').trim() : '';
      let name  = nameFromExcel || `Course ${baseCode}`;
      let alias = '';

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
        category:    category_val,
        roomNo:      '',
        batch:       '',
        hours,
        alias,
        recommendations,
        group:       group_num,
        programType: program_val,
        courseType:  dbMatch ? (dbMatch.courseType || type_val) : type_val
      });
    }

    // -------------------------------------------------------
    // Step 6: Commit to database (Non-destructive merge)
    // -------------------------------------------------------
    const mergedCourses = [...db.courses];
    let newCount = 0;
    let updatedCount = 0;

    importedCourses.forEach(imported => {
      const matchIdx = mergedCourses.findIndex(c => c.code === imported.code);
      if (matchIdx >= 0) {
        const existing = mergedCourses[matchIdx];
        mergedCourses[matchIdx] = {
          ...existing,
          name: imported.name,
          department: imported.department,
          pathway: imported.pathway,
          semester: imported.semester,
          category: imported.category,
          hours: imported.hours,
          recommendations: imported.recommendations,
          group: imported.group,
          programType: imported.programType,
          courseType: imported.courseType,
          // Preserve visual alias if coordinator has edited it
          alias: existing.alias || imported.alias
        };
        updatedCount++;
      } else {
        mergedCourses.push(imported);
        newCount++;
      }
    });

    db.courses = mergedCourses;
    db.periods = periods;

    // Seed default semester label mappings
    const semestersSet = new Set(mergedCourses.map(c => c.semester));
    const roman = { '1': 'I BSC', '2': 'II BSC', '3': 'III BSC', '4': 'IV BSC', '5': 'V BSC', '6': 'VI BSC' };
    semestersSet.forEach(sem => {
      if (!db.config.semesterLabels[sem]) {
        db.config.semesterLabels[sem] = roman[sem] || `${sem} Sem`;
      }
    });

    writeDb(db);

    res.json({
      success: true,
      message: `Import completed. Added ${newCount} new courses, updated ${updatedCount} existing courses. Total: ${db.courses.length} courses. Periods: [${periods.join(', ')}].`,
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



app.post('/api/import/staff', requireAdmin, upload.single('file'), (req, res) => {
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
    const warnings = [];
    
    const mergedFaculty = [...db.faculty];
    let newCount = 0;
    let updatedCount = 0;

    data.forEach((row, index) => {
      const staffId = String(row['Staff ID'] || '').trim();
      const name = String(row['Name'] || '').trim();
      const department = String(row['Department'] || '').trim().toUpperCase();

      if (!staffId || !name || !department) {
        warnings.push(`Row ${index + 2}: Missing Staff ID, Name, or Department. Record skipped.`);
        return;
      }

      const matchIdx = mergedFaculty.findIndex(f => f.staffId === staffId);
      if (matchIdx >= 0) {
        // Update details, but preserve their existing unique visual code initials
        mergedFaculty[matchIdx].name = name;
        mergedFaculty[matchIdx].department = department;
        updatedCount++;
      } else {
        // Generate a new unique visual code initials
        const code = generateFacultyCode(name, mergedFaculty);
        
        mergedFaculty.push({
          staffId,
          name,
          code,
          department
        });
        newCount++;
      }
    });

    // Commit to DB
    db.faculty = mergedFaculty;
    writeDb(db);

    res.json({
      success: true,
      message: `Import completed. Added ${newCount} new faculty members, updated ${updatedCount} existing members. Total: ${db.faculty.length} faculty members.`,
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
app.post('/api/import/batch-dept-mappings', requireAdmin, upload.single('file'), (req, res) => {
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

app.post('/api/admin/batch-dept-mappings', requireAdmin, (req, res) => {
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

app.get('/api/admin/batch-dept-mappings', requireAdmin, (req, res) => {
  const db = readDb();
  res.json(db.batchDeptMappings || []);
});

app.put('/api/admin/batch-dept-mappings/:code', requireAdmin, (req, res) => {
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

app.delete('/api/admin/batch-dept-mappings/:code', requireAdmin, (req, res) => {
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
app.get('/api/admin/batch-config', requireAdmin, (req, res) => {
  const db = readDb();
  res.json(db.batchConfig || { programTypes: {}, fundingTypes: {}, yearSemMap: {} });
});

app.put('/api/admin/batch-config', requireAdmin, (req, res) => {
  const { programTypes, fundingTypes, yearSemMap } = req.body;
  if (!programTypes || !fundingTypes || !yearSemMap) {
    return res.status(400).json({ success: false, message: 'programTypes, fundingTypes, and yearSemMap are required.' });
  }
  const db = readDb();
  db.batchConfig = { programTypes, fundingTypes, yearSemMap };
  writeDb(db);
  res.json({ success: true, message: 'Batch config saved.' });
});

app.get('/api/batches', requireUser, (req, res) => {
  const db = readDb();
  const cfg = db.batchConfig || {};
  const programTypes = cfg.programTypes || {};
  const fundingTypes  = cfg.fundingTypes  || {};
  const yearSemMap    = cfg.yearSemMap    || {};
  const mappings = db.batchDeptMappings || [];
  const excluded = db.config.excludedBatches || [];

  // Generate all combinations: {progCode}{fundingCode}{deptCode}{year}
  const batches = [];
  Object.keys(programTypes).forEach(prog => {
    Object.keys(fundingTypes).forEach(fund => {
      mappings.forEach(m => {
        Object.keys(yearSemMap).forEach(yr => {
          const semesters = yearSemMap[yr] || [];
          const batchId   = `${prog}${fund}${m.code}${yr}`;
          if (excluded.includes(batchId)) return;
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

app.post('/api/admin/batches/exclude', requireAdmin, (req, res) => {
  const { batchId } = req.body;
  if (!batchId) return res.status(400).json({ success: false, message: 'batchId is required.' });
  const db = readDb();
  if (!db.config.excludedBatches) db.config.excludedBatches = [];
  const cleanId = batchId.trim().toUpperCase();
  if (!db.config.excludedBatches.includes(cleanId)) {
    db.config.excludedBatches.push(cleanId);
  }
  writeDb(db);
  res.json({ success: true, message: `Batch ${cleanId} excluded successfully.` });
});

app.post('/api/admin/batches/include', requireAdmin, (req, res) => {
  const { batchId } = req.body;
  if (!batchId) return res.status(400).json({ success: false, message: 'batchId is required.' });
  const db = readDb();
  if (!db.config.excludedBatches) db.config.excludedBatches = [];
  const cleanId = batchId.trim().toUpperCase();
  db.config.excludedBatches = db.config.excludedBatches.filter(id => id !== cleanId);
  writeDb(db);
  res.json({ success: true, message: `Batch ${cleanId} re-included successfully.` });
});



// -------------------------------------------------------------
// Group Mappings & Courses PUT Endpoints
// -------------------------------------------------------------
app.get('/api/admin/group-mappings', requireUser, (req, res) => {
  const db = readDb();
  res.json(db.groupMappings || {});
});

app.post('/api/admin/group-mappings', requireAdmin, (req, res) => {
  const { courseCode, batches } = req.body;
  if (!courseCode || !Array.isArray(batches)) {
    return res.status(400).json({ success: false, message: 'Course code and batches array are required' });
  }

  const db = readDb();
  db.groupMappings[courseCode] = batches.map(b => b.trim().toUpperCase());
  writeDb(db);
  res.json({ success: true, message: 'Group mapping updated successfully.' });
});

app.put('/api/admin/courses/:code', requireAdmin, (req, res) => {
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

// Delete Course
app.delete('/api/admin/courses/:code', requireAdmin, (req, res) => {
  const code = req.params.code.trim();
  const db = readDb();
  const initialLength = db.courses.length;
  db.courses = db.courses.filter(c => c.code !== code);
  if (db.courses.length === initialLength) {
    return res.status(404).json({ success: false, message: 'Course not found' });
  }
  // Also clean up any allocations
  Object.keys(db.allocations).forEach(dept => {
    if (db.allocations[dept] && db.allocations[dept][code]) {
      delete db.allocations[dept][code];
    }
  });
  // Also clean up groupMappings
  if (db.groupMappings && db.groupMappings[code]) {
    delete db.groupMappings[code];
  }
  writeDb(db);
  res.json({ success: true, message: 'Course deleted successfully.' });
});

// Delete Faculty member
app.delete('/api/admin/faculty/:staffId', requireAdmin, (req, res) => {
  const staffId = req.params.staffId.trim();
  const db = readDb();
  const facultyObj = db.faculty.find(f => f.staffId === staffId);
  if (!facultyObj) {
    return res.status(404).json({ success: false, message: 'Faculty member not found' });
  }
  const facCode = facultyObj.code;
  db.faculty = db.faculty.filter(f => f.staffId !== staffId);
  
  // Clean up allocations
  Object.keys(db.allocations).forEach(dept => {
    const deptAlloc = db.allocations[dept];
    Object.keys(deptAlloc).forEach(courseCode => {
      const courseAlloc = deptAlloc[courseCode];
      Object.keys(courseAlloc).forEach(day => {
        const periodAlloc = courseAlloc[day];
        Object.keys(periodAlloc).forEach(period => {
          if (Array.isArray(periodAlloc[period])) {
            periodAlloc[period] = periodAlloc[period].filter(code => code !== facCode);
          }
        });
      });
    });
  });
  
  writeDb(db);
  res.json({ success: true, message: 'Faculty member deleted successfully.' });
});

// -------------------------------------------------------------
// Allocation & Clash Check Endpoints
// -------------------------------------------------------------
app.get('/api/allocations', requireUser, (req, res) => {
  const { department } = req.query;
  const db = readDb();
  if (department) {
    const deptAlloc = db.allocations[department.toUpperCase()] || {};
    return res.json(deptAlloc);
  }
  res.json(db.allocations);
});

// Clash Detection Validation API
app.post('/api/allocations/validate', requireUser, (req, res) => {
  const { departmentName, courseCode, weekday, period, facultyCodes } = req.body;
  if (!departmentName || !weekday || !period || !facultyCodes) {
    return res.status(400).json({ success: false, message: 'Missing parameters' });
  }

  const db = readDb();
  const conflicts = [];

  // Check Teacher Unavailability / Blackout Slots
  const teacherUnavail = db.teacherUnavailability || {};
  for (const fac of facultyCodes) {
    const unavail = teacherUnavail[fac] || [];
    const isUnavail = unavail.some(u => {
      if (u.day.toUpperCase() !== weekday.toUpperCase()) return false;
      if (u.period === 'all') return true;
      return String(u.period) === String(period);
    });

    if (isUnavail) {
      const facInfo = db.faculty.find(f => f.code === fac) || { name: fac };
      conflicts.push({
        facultyCode: fac,
        facultyName: facInfo.name,
        clashingCourseCode: 'TEACHER-UNAVAILABLE',
        clashingCourseName: `Faculty ${facInfo.name} has marked ${weekday} Period ${period} as an unavailable / off period.`,
        department: departmentName
      });
    }
  }

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
            const otherBase = otherCourseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
            const courseInfo = db.courses.find(c => c.code === otherCourseCode)
                            || db.courses.find(c => c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === otherBase)
                            || { name: otherCourseCode };
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

  // Check if slot has an Admin Global Lock note (permits manual assignment but returns notice)
  const globalLocks = db.config.globalLockedPeriods || [];
  const lockObj = globalLocks.find(l => l.day.toUpperCase() === weekday.toUpperCase() && String(l.period) === String(period));

  return res.json({ 
    valid: true, 
    adminLockNotice: lockObj ? (lockObj.label || 'College Common Activity') : null 
  });
});

// Teacher Unavailability Endpoints
app.get('/api/department/teacher-unavailability', requireUser, (req, res) => {
  const db = readDb();
  res.json(db.teacherUnavailability || {});
});

app.post('/api/department/teacher-unavailability', requireUser, (req, res) => {
  const { facultyCode, unavailableSlots, departmentName } = req.body;
  if (!facultyCode || !Array.isArray(unavailableSlots)) {
    return res.status(400).json({ success: false, message: 'facultyCode and unavailableSlots array are required.' });
  }

  const db = readDb();
  const deptUpper = departmentName ? departmentName.toUpperCase() : null;
  if (deptUpper && isDepartmentLocked(db, deptUpper)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[deptUpper].status}.`
    });
  }

  if (!db.teacherUnavailability) db.teacherUnavailability = {};
  db.teacherUnavailability[facultyCode.trim().toUpperCase()] = unavailableSlots;

  writeDb(db);
  res.json({ success: true, message: 'Teacher availability updated successfully.' });
});

// Subject Teacher Mapping Endpoints
app.get('/api/department/subject-mapping', requireUser, (req, res) => {
  const { departmentName } = req.query;
  const db = readDb();
  if (!db.subjectTeacherMapping) db.subjectTeacherMapping = {};
  if (departmentName) {
    const deptUpper = departmentName.toUpperCase();
    return res.json(db.subjectTeacherMapping[deptUpper] || {});
  }
  res.json(db.subjectTeacherMapping || {});
});

app.post('/api/department/subject-mapping', requireDepartment, (req, res) => {
  const { departmentName, mappings } = req.body;
  const deptUpper = (req.departmentName || departmentName || '').toUpperCase();
  if (!mappings || typeof mappings !== 'object') {
    return res.status(400).json({ success: false, message: 'mappings object is required.' });
  }

  const db = readDb();
  if (isDepartmentLocked(db, deptUpper)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[deptUpper].status}.`
    });
  }

  if (!db.subjectTeacherMapping) db.subjectTeacherMapping = {};
  db.subjectTeacherMapping[deptUpper] = mappings;

  // Sync course definitions with mapping properties
  Object.entries(mappings).forEach(([courseCode, mapData]) => {
    const course = db.courses.find(c => c.code === courseCode && c.department.toUpperCase() === deptUpper);
    if (course) {
      if (mapData.hours !== undefined && !isNaN(parseInt(mapData.hours))) {
        course.hours = parseInt(mapData.hours);
      }
      if (mapData.courseType && (mapData.courseType === 'T' || mapData.courseType === 'P')) {
        course.courseType = mapData.courseType;
      }
      if (mapData.theoryHours !== undefined) {
        course.theoryHours = parseInt(mapData.theoryHours) || 0;
      }
      if (mapData.practicalHours !== undefined) {
        course.practicalHours = parseInt(mapData.practicalHours) || 0;
      }
      if (Array.isArray(mapData.teachers)) {
        course.teachers = mapData.teachers;
      }
      if (mapData.teacherHours && typeof mapData.teacherHours === 'object') {
        course.teacherHours = mapData.teacherHours;
      }
      if (Array.isArray(mapData.practicalTeachers)) {
        course.practicalTeachers = mapData.practicalTeachers;
      }
      if (Array.isArray(mapData.theoryTeachers)) {
        course.theoryTeachers = mapData.theoryTeachers;
      }
      if (mapData.theoryTeacherHours && typeof mapData.theoryTeacherHours === 'object') {
        course.theoryTeacherHours = mapData.theoryTeacherHours;
      }
    }
  });

  writeDb(db);
  res.json({ success: true, message: 'Subject teacher mappings updated successfully.' });
});


// Clear Semester Timetable Endpoint
app.post('/api/department/clear-semester', requireDepartment, (req, res) => {
  const { departmentName, semester } = req.body;
  const deptUpper = (req.departmentName || departmentName || '').toUpperCase();
  const db = readDb();

  if (isDepartmentLocked(db, deptUpper)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[deptUpper].status}.`
    });
  }

  const deptAlloc = db.allocations[deptUpper] || {};
  let deptCourses = db.courses.filter(c => c.department.toUpperCase() === deptUpper);
  if (semester && semester !== 'all') {
    if (semester === 'odd') {
      deptCourses = deptCourses.filter(c => parseInt(String(c.semester).replace(/\D+/g, ''), 10) % 2 === 1);
    } else if (semester === 'even') {
      deptCourses = deptCourses.filter(c => parseInt(String(c.semester).replace(/\D+/g, ''), 10) % 2 === 0);
    } else {
      deptCourses = deptCourses.filter(c => String(c.semester).trim() === String(semester).trim());
    }
  }

  const targetBases = new Set(deptCourses.map(c => c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '')));
  let clearedCount = 0;

  Object.keys(deptAlloc).forEach(cCode => {
    const base = cCode.replace(/-(T|P)$/, '').replace(/_G\d+$/, '').replace(/_C\d+$/, '');
    if (targetBases.has(base) || targetBases.has(cCode)) {
      delete deptAlloc[cCode];
      clearedCount++;
    }
  });

  db.allocations[deptUpper] = deptAlloc;
  writeDb(db);
  const semLabel = semester === 'odd' ? 'Odd Semesters' : (semester === 'even' ? 'Even Semesters' : (semester && semester !== 'all' ? `Semester ${semester}` : 'all semesters'));
  res.json({ 
    success: true, 
    message: `Allocations cleared for ${semLabel} (${clearedCount} course allocations removed).` 
  });
});

// Auto-generate Timetable Endpoint
app.post('/api/department/auto-generate', requireDepartment, (req, res) => {
  const { departmentName, semester, selectedCourseCodes, courseFacultyMap, courseFacultyConfig, pinnedSlots, maxConsecutiveHours, practicalBlockSize } = req.body;
  const deptUpper = (req.departmentName || departmentName || '').toUpperCase();
  const db = readDb();

  if (isDepartmentLocked(db, deptUpper)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[deptUpper].status}.`
    });
  }

  try {
    const result = generateDepartmentSchedule({
      db,
      departmentName: deptUpper,
      semester: semester || '',
      selectedCourseCodes: selectedCourseCodes || [],
      courseFacultyMap: courseFacultyMap || {},
      courseFacultyConfig: courseFacultyConfig || {},
      pinnedSlots: pinnedSlots || {},
      maxConsecutiveHours: parseInt(maxConsecutiveHours) || 2,
      practicalBlockSize: parseInt(practicalBlockSize) || 2,
      forceRelaxed: !!req.body.forceRelaxed
    });

    res.json(result);
  } catch (err) {
    console.error("Auto-generate error:", err);
    res.status(500).json({ success: false, message: 'Auto-generation failed: ' + err.message });
  }
});

// Save Allocations Endpoint (with safety validations)
app.post('/api/allocations', requireDepartment, (req, res) => {
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
// Department Timetable Excel Import & Format Template Endpoints
// -------------------------------------------------------------
app.get('/api/department/import-template', requireUser, (req, res) => {
  const db = readDb();
  let deptName = (req.query.department || req.departmentName || '').toUpperCase();
  
  if (!deptName && req.headers['authorization'] && req.headers['authorization'].startsWith('dept-token-')) {
    deptName = req.headers['authorization'].substring('dept-token-'.length).toUpperCase();
  }
  
  if (!deptName) {
    return res.status(400).json({ success: false, message: 'Department name is required.' });
  }

  const deptCourses = db.courses.filter(c => c.department.toUpperCase() === deptName);
  const weekdays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  const DAY_SHORT = { MONDAY: 'MON', TUESDAY: 'TUE', WEDNESDAY: 'WED', THURSDAY: 'THU', FRIDAY: 'FRI' };
  const rawPeriods = db.periods || ["1", "2", "3", "LB", "4", "5", "6"];
  const periods = rawPeriods.filter(p => String(p).toUpperCase() !== 'LB');

  const slotHeaders = [];
  weekdays.forEach(d => {
    periods.forEach(p => {
      slotHeaders.push(`${DAY_SHORT[d]}-${p}`);
    });
  });

  const headers = ['Course Code', 'Course Name', 'Semester', 'Category', ...slotHeaders];
  const rows = [];

  const deptAlloc = db.allocations[deptName] || {};

  deptCourses.forEach(c => {
    const row = [
      c.code,
      c.name,
      c.semester || '',
      c.category || ''
    ];

    const courseAlloc = deptAlloc[c.code] || {};
    weekdays.forEach(d => {
      const dayAlloc = courseAlloc[d] || {};
      periods.forEach(p => {
        const facs = dayAlloc[p] || [];
        row.push(Array.isArray(facs) ? facs.join(' / ') : '');
      });
    });

    rows.push(row);
  });

  const ws = xlsx.utils.aoa_to_sheet([headers, ...rows]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, `${deptName.substring(0, 31)} Timetable`);

  const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `${deptName.replace(/[^a-zA-Z0-9_\-]/g, '_')}_Timetable_Format.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

app.post('/api/department/import-timetable', requireDepartment, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const db = readDb();
  const deptUpper = (req.departmentName || req.body.departmentName || '').toUpperCase();

  if (isDepartmentLocked(db, deptUpper)) {
    return res.status(403).json({
      success: false,
      message: `This department's timetable is locked because it is currently ${db.submissions[deptUpper].status}.`
    });
  }

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    if (data.length < 2) {
      return res.status(400).json({ error: 'Excel sheet must contain a header row and at least one data row.' });
    }

    const headerRow = data[0];
    const DAY_MAP = { MON: 'MONDAY', TUE: 'TUESDAY', WED: 'WEDNESDAY', THU: 'THURSDAY', FRI: 'FRIDAY', MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY' };

    let codeColIdx = -1;
    let nameColIdx = -1;
    const slotCols = [];

    for (let c = 0; c < headerRow.length; c++) {
      const hdr = String(headerRow[c] || '').trim();
      const hdrLow = hdr.toLowerCase();

      const slotMatch = hdr.match(/^(MON|TUE|WED|THU|FRI|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY)[-_\s]?(.+)$/i);
      if (slotMatch) {
        const dayFull = DAY_MAP[slotMatch[1].toUpperCase()];
        const period = slotMatch[2].trim();
        if (dayFull && period.toUpperCase() !== 'LB') {
          slotCols.push({ idx: c, day: dayFull, period });
        }
        continue;
      }

      if (hdrLow === 'course code' || hdrLow === 'coursecode' || hdrLow === 'code') {
        codeColIdx = c;
        continue;
      }
      if (hdrLow === 'course name' || hdrLow === 'coursename' || hdrLow === 'name') {
        nameColIdx = c;
        continue;
      }
    }

    if (codeColIdx === -1) {
      return res.status(400).json({ error: 'Could not find a "Course Code" column in header row.' });
    }

    if (slotCols.length === 0) {
      return res.status(400).json({ error: 'No timetable slot columns found in header (expected headers like MON-1, MON-2, etc.).' });
    }

    const warnings = [];
    const deptCourses = db.courses.filter(c => c.department.toUpperCase() === deptUpper);
    const facultyList = db.faculty || [];

    function resolveFacultyCode(token) {
      const clean = token.trim();
      if (!clean) return null;
      const cleanUpper = clean.toUpperCase();

      let fac = facultyList.find(f => f.code.toUpperCase() === cleanUpper);
      if (fac) return fac.code;

      fac = facultyList.find(f => f.staffId.toUpperCase() === cleanUpper);
      if (fac) return fac.code;

      fac = facultyList.find(f => f.name.toUpperCase() === cleanUpper);
      if (fac) return fac.code;

      const cleanTitleName = cleanUpper.replace(/^(DR\.|MR\.|MRS\.|MS\.|FR\.|SR\.)\s*/i, '').trim();
      fac = facultyList.find(f => f.name.toUpperCase().replace(/^(DR\.|MR\.|MRS\.|MS\.|FR\.|SR\.)\s*/i, '').trim() === cleanTitleName);
      if (fac) return fac.code;

      return null;
    }

    const newDeptAlloc = JSON.parse(JSON.stringify(db.allocations[deptUpper] || {}));
    let updatedCoursesCount = 0;
    let allocatedSlotsCount = 0;

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (!row || row.length === 0) continue;

      const rawCode = String(row[codeColIdx] || '').trim();
      if (!rawCode || rawCode.toLowerCase() === 'course code') continue;

      const matchedCourse = deptCourses.find(c => c.code === rawCode || c.alias === rawCode || c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === rawCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, ''));

      if (!matchedCourse) {
        warnings.push(`Row ${r + 1}: Course code '${rawCode}' not found in ${deptUpper} department catalog. Skipped.`);
        continue;
      }

      const targetCourseCode = matchedCourse.code;
      if (!newDeptAlloc[targetCourseCode]) {
        newDeptAlloc[targetCourseCode] = {};
      }

      let courseSlotCount = 0;

      slotCols.forEach(({ idx, day, period }) => {
        const cellVal = String(row[idx] || '').trim();
        if (!cellVal) {
          if (newDeptAlloc[targetCourseCode][day]) {
            delete newDeptAlloc[targetCourseCode][day][period];
          }
          return;
        }

        const rawTokens = cellVal.split(/[/,;+&]/).map(t => t.trim()).filter(Boolean);
        const resolvedFacs = [];

        rawTokens.forEach(token => {
          const code = resolveFacultyCode(token);
          if (code) {
            if (!resolvedFacs.includes(code)) resolvedFacs.push(code);
          } else {
            warnings.push(`Row ${r + 1} (${targetCourseCode}, ${day}-${period}): Unrecognized faculty '${token}'.`);
          }
        });

        if (resolvedFacs.length > 0) {
          if (!newDeptAlloc[targetCourseCode][day]) {
            newDeptAlloc[targetCourseCode][day] = {};
          }
          newDeptAlloc[targetCourseCode][day][period] = resolvedFacs;
          courseSlotCount++;
          allocatedSlotsCount++;
        }
      });

      if (courseSlotCount > 0) {
        updatedCoursesCount++;
      }
    }

    const testAllocations = JSON.parse(JSON.stringify(db.allocations));
    testAllocations[deptUpper] = newDeptAlloc;

    const clashes = findAllocationClashes(testAllocations);
    if (clashes.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Import failed due to faculty clashes across timetables.',
        clashes
      });
    }

    db.allocations[deptUpper] = newDeptAlloc;
    if (!db.submissions[deptUpper]) {
      db.submissions[deptUpper] = { status: 'Draft', comments: '' };
    } else {
      db.submissions[deptUpper].status = 'Draft';
    }

    writeDb(db);

    res.json({
      success: true,
      message: `Import completed successfully! Allocated ${allocatedSlotsCount} slot assignments across ${updatedCoursesCount} courses.`,
      warnings
    });
  } catch (err) {
    console.error("Department Excel import failed:", err);
    res.status(500).json({ error: 'Failed to process department timetable Excel: ' + err.message });
  }
});

// -------------------------------------------------------------
// Submissions (Lifecycle) Endpoints
// -------------------------------------------------------------
app.get('/api/submissions', requireUser, (req, res) => {
  const db = readDb();
  res.json(db.submissions);
});

app.post('/api/submissions/status', requireUser, (req, res) => {
  const { departmentName, status, comments } = req.body;
  if (!departmentName || !status) {
    return res.status(400).json({ success: false, message: 'Department name and status are required' });
  }

  // Authorize request: Either admin-token, or dept-token matching the departmentName
  const token = req.headers['authorization'] || req.query.token;
  if (token !== 'admin-token') {
    if (!token.startsWith('dept-token-')) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Invalid token' });
    }
    const tokenDept = token.substring('dept-token-'.length).toUpperCase();
    if (departmentName.toUpperCase() !== tokenDept) {
      return res.status(403).json({ success: false, message: 'Forbidden: You do not have access to this department.' });
    }
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
app.get('/api/reports/workload', requireUser, (req, res) => {
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
        const base = courseCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
        const course = db.courses.find(c => c.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '') === base);
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
app.post('/api/admin/clear-database', requireAdmin, (req, res) => {
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

// Change Admin Password Endpoint
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, message: 'Current and new passwords are required.' });
  }

  const db = readDb();
  if (currentPassword !== db.config.adminPassword) {
    return res.status(400).json({ success: false, message: 'Incorrect current password.' });
  }

  db.config.adminPassword = newPassword.trim();
  writeDb(db);
  res.json({ success: true, message: 'Administrator password changed successfully.' });
});

// Import group-to-batch mappings Excel/CSV
app.post('/api/import/group-mappings', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    if (data.length < 2) {
      return res.status(400).json({ error: 'No records found in group mappings Excel.' });
    }

    const headerRow = data[0];
    let codeColIdx  = -1;
    let groupColIdx = -1;
    let batchesColIdx = -1;

    for (let c = 0; c < headerRow.length; c++) {
      const hdr = String(headerRow[c] || '').trim().toLowerCase();
      if (hdr === 'course code' || hdr === 'coursecode' || hdr === 'code') {
        codeColIdx = c;
      } else if (hdr === 'group') {
        groupColIdx = c;
      } else if (hdr === 'batches' || hdr === 'batch name' || hdr === 'batchname' || hdr === 'batch' || hdr === 'batch_name') {
        batchesColIdx = c;
      }
    }

    if (codeColIdx === -1 || batchesColIdx === -1) {
      return res.status(400).json({
        error: 'Could not find required columns in sheet. Needs "Course Code" and "Batches" or "Batch Name".'
      });
    }

    const db = readDb();
    const existingCourses = db.courses || [];
    const groupMappings = db.groupMappings || {};

    let lastCourseCode = '';
    let lastGroup = 0;
    let importCount = 0;
    const initializedCodes = new Set();

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (!row || row.length === 0) continue;

      const codeVal_raw = row[codeColIdx];
      const groupVal_raw = groupColIdx >= 0 ? row[groupColIdx] : undefined;
      const batchVal_raw = row[batchesColIdx];

      // Update state for merged/grouped cells
      if (codeVal_raw !== undefined && codeVal_raw !== null && String(codeVal_raw).trim() !== '') {
        lastCourseCode = String(codeVal_raw).trim();
      }
      if (groupVal_raw !== undefined && groupVal_raw !== null && String(groupVal_raw).trim() !== '') {
        const parsedG = parseInt(String(groupVal_raw).trim());
        lastGroup = !isNaN(parsedG) ? parsedG : 0;
      }

      if (!lastCourseCode) continue;

      // Extract batches
      const batches = [];
      if (batchVal_raw !== undefined && batchVal_raw !== null) {
        const bStr = String(batchVal_raw).trim();
        // Split by comma or semicolon
        bStr.split(/[,;]+/).forEach(b => {
          const cleanB = b.trim().toUpperCase();
          if (cleanB) batches.push(cleanB);
        });
      }

      if (batches.length === 0) continue;

      // Resolve actual course code key in database (e.g. BMM5FS112_G1)
      let resolvedCode = lastCourseCode;
      let dbCourse = existingCourses.find(c => c.code === resolvedCode);

      if (!dbCourse && lastGroup > 0) {
        resolvedCode = `${lastCourseCode}_G${lastGroup}`;
        dbCourse = existingCourses.find(c => c.code === resolvedCode);
      }

      if (!dbCourse) {
        // Fallback: try case-insensitive code search
        dbCourse = existingCourses.find(c => c.code.toUpperCase() === resolvedCode.toUpperCase());
        if (dbCourse) {
          resolvedCode = dbCourse.code;
        }
      }

      if (!dbCourse) {
        // Fallback: search for first course that starts with lastCourseCode
        dbCourse = existingCourses.find(c => c.code.startsWith(lastCourseCode));
        if (dbCourse) {
          resolvedCode = dbCourse.code;
        }
      }

      if (!dbCourse) {
        continue;
      }

      // Initialize mapping if first time seeing this course in this file
      if (!initializedCodes.has(resolvedCode)) {
        groupMappings[resolvedCode] = [];
        initializedCodes.add(resolvedCode);
      }

      batches.forEach(b => {
        if (!groupMappings[resolvedCode].includes(b)) {
          groupMappings[resolvedCode].push(b);
        }
      });
      importCount++;
    }

    db.groupMappings = groupMappings;
    writeDb(db);

    res.json({
      success: true,
      message: `Imported group mappings for ${importCount} rows successfully.`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process group mappings Excel: ' + err.message });
  }
});

// -------------------------------------------------------------
// Period Times Endpoints
// -------------------------------------------------------------
app.get('/api/admin/period-times', requireAdmin, (req, res) => {
  const db = readDb();
  const defaults = {
    "1": "09:00 AM - 10:00 AM",
    "2": "10:00 AM - 11:00 AM",
    "3": "11:00 AM - 12:00 PM",
    "4": "12:00 PM - 01:00 PM",
    "5": "02:00 PM - 03:00 PM",
    "6": "03:00 PM - 04:00 PM",
    "7": "04:00 PM - 05:00 PM"
  };
  res.json(db.config.periodTimes || defaults);
});

app.put('/api/admin/period-times', requireAdmin, (req, res) => {
  const times = req.body;
  if (!times || typeof times !== 'object') {
    return res.status(400).json({ success: false, message: 'Invalid payload.' });
  }
  const db = readDb();
  db.config.periodTimes = times;
  writeDb(db);
  res.json({ success: true, message: 'Period times updated successfully.' });
});

// -------------------------------------------------------------
// Strict Excel Exporter
// -------------------------------------------------------------
app.get('/api/admin/export/strict-timetable', requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const cfg = db.batchConfig || {};
    const programTypes = cfg.programTypes || {};
    const fundingTypes  = cfg.fundingTypes  || {};
    const yearSemMap    = cfg.yearSemMap    || {};
    const mappings = db.batchDeptMappings || [];
    const periodTimes = db.config.periodTimes || {
      "1": "09:00 AM - 10:00 AM",
      "2": "10:00 AM - 11:00 AM",
      "3": "11:00 AM - 12:00 PM",
      "4": "12:00 PM - 01:00 PM",
      "5": "02:00 PM - 03:00 PM",
      "6": "03:00 PM - 04:00 PM",
      "7": "04:00 PM - 05:00 PM"
    };

    // Generate list of all batch codes
    const batchesList = [];
    Object.keys(programTypes).forEach(prog => {
      Object.keys(fundingTypes).forEach(fund => {
        mappings.forEach(m => {
          Object.keys(yearSemMap).forEach(yr => {
            const batchId = `${prog}${fund}${m.code}${yr}`;
            batchesList.push(batchId);
          });
        });
      });
    });

    // Excel sheet data
    const sheetData = [];

    // Row 0: Blank
    sheetData.push([null]);

    // Row 1: Days
    const row1 = [null, null];
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    days.forEach(day => {
      row1.push(day);
      for (let i = 1; i < 7; i++) {
        row1.push(null);
      }
    });
    sheetData.push(row1);

    // Row 2: Periods
    const row2 = ["Batch Name", "Week"];
    for (let d = 0; d < 5; d++) {
      for (let p = 1; p <= 7; p++) {
        row2.push(p);
      }
    }
    sheetData.push(row2);

    // Render 4 rows for each batch
    batchesList.sort().forEach(batchId => {
      const mappedCourses = db.courses.filter(c => {
        const assigned = db.groupMappings[c.code] || [];
        return assigned.includes(batchId);
      });

      const staffRow = [batchId, null];
      const subjectRow = [null, null];
      const timeRow = [null, null];
      const roomRow = [null, null];

      let hasAllocations = false;

      // Monday to Friday
      for (let d = 0; d < 5; d++) {
        const dayKey = days[d].toUpperCase(); // MONDAY, TUESDAY, etc.
        // Periods 1 to 7
        for (let p = 1; p <= 7; p++) {
          const staffIds = [];
          const subjectCodes = [];
          let roomNo = "";

          mappedCourses.forEach(course => {
            Object.keys(db.allocations).forEach(dept => {
              const deptAlloc = db.allocations[dept];
              // Find all allocations keys matching this course code base
              const targetBase = course.code.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
              Object.keys(deptAlloc).forEach(allocCode => {
                const allocBase = allocCode.replace(/-(T|P)$/, '').replace(/(_G|_C)\d+$/, '');
                // Match Theory/Practical suffix type if course.code has it
                const courseType = course.code.match(/-(T|P)$/) ? course.code.match(/-(T|P)$/)[0] : '';
                const allocType = allocCode.match(/-(T|P)$/) ? allocCode.match(/-(T|P)$/)[0] : '';
                if (allocBase === targetBase && allocType === courseType) {
                  if (deptAlloc[allocCode] && deptAlloc[allocCode][dayKey]) {
                    const pAlloc = deptAlloc[allocCode][dayKey][p];
                    if (Array.isArray(pAlloc) && pAlloc.length > 0) {
                      pAlloc.forEach(fac => {
                        const fObj = db.faculty.find(f => f.code === fac);
                        const staffId = fObj ? fObj.staffId : fac;
                        if (!staffIds.includes(staffId)) {
                          staffIds.push(staffId);
                        }
                      });
                      const cleanDisplayCode = allocCode.replace(/-(T|P)$/, '').replace(/_C\d+$/, '');
                      if (!subjectCodes.includes(cleanDisplayCode)) {
                        subjectCodes.push(cleanDisplayCode);
                      }
                      if (course.roomNo) {
                        roomNo = course.roomNo;
                      }
                      hasAllocations = true;
                    }
                  }
                }
              });
            });
          });

          if (subjectCodes.length > 0) {
            staffRow.push(staffIds.join(','));
            subjectRow.push(subjectCodes.join(','));
            timeRow.push(periodTimes[p] || `${p} Period`);
            roomRow.push(roomNo || null);
          } else {
            staffRow.push(null);
            subjectRow.push(null);
            timeRow.push(null);
            roomRow.push(null);
          }
        }
      }

      if (hasAllocations) {
        sheetData.push(staffRow);
        sheetData.push(subjectRow);
        sheetData.push(timeRow);
        sheetData.push(roomRow);
      }
    });

    const ws = xlsx.utils.aoa_to_sheet(sheetData);
    
    // Add cell merges for the days
    ws['!merges'] = [
      { s: { r: 1, c: 2 }, e: { r: 1, c: 8 } },
      { s: { r: 1, c: 9 }, e: { r: 1, c: 15 } },
      { s: { r: 1, c: 16 }, e: { r: 1, c: 22 } },
      { s: { r: 1, c: 23 }, e: { r: 1, c: 29 } },
      { s: { r: 1, c: 30 }, e: { r: 1, c: 36 } }
    ];

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Classes_Summary");
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="Classes_Summary.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate Excel: ' + err.message });
  }
});

// -------------------------------------------------------------
// Major Mappings Import/Export
// -------------------------------------------------------------
app.get('/api/admin/export/major-mappings', requireAdmin, (req, res) => {
  try {
    const db = readDb();
    const majorCourses = db.courses.filter(c => !c.group || c.group === 0);

    const sheetData = [
      ['Course Code', 'Course Name', 'Semester', 'Department', 'Program', 'Assigned Batch']
    ];

    majorCourses.forEach(c => {
      const assigned = db.groupMappings[c.code] || [];
      const batchId = assigned.length > 0 ? assigned[0] : '';
      sheetData.push([
        c.code,
        c.name,
        c.semester,
        c.department,
        c.programType || 'UG',
        batchId
      ]);
    });

    const ws = xlsx.utils.aoa_to_sheet(sheetData);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Major_Mappings");
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', 'attachment; filename="Major_Mappings.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to export major mappings: ' + err.message });
  }
});

app.post('/api/import/major-mappings', requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    if (data.length <= 1) {
      return res.status(400).json({ error: 'Excel sheet has no data rows.' });
    }

    const headerRow = data[0].map(h => String(h || '').trim().toLowerCase());
    let codeColIdx = -1;
    let batchColIdx = -1;

    for (let c = 0; c < headerRow.length; c++) {
      const hdr = headerRow[c];
      if (hdr === 'course code' || hdr === 'coursecode' || hdr === 'code') {
        codeColIdx = c;
      } else if (hdr === 'assigned batch' || hdr === 'assignedbatch' || hdr === 'batch' || hdr === 'batch name' || hdr === 'batchid' || hdr === 'batch id') {
        batchColIdx = c;
      }
    }

    if (codeColIdx === -1 || batchColIdx === -1) {
      return res.status(400).json({
        error: 'Could not find required columns in sheet. Needs "Course Code" and "Assigned Batch".'
      });
    }

    const db = readDb();
    const existingCourses = db.courses || [];
    const groupMappings = db.groupMappings || {};
    let importCount = 0;

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (!row || row.length === 0) continue;

      const codeVal_raw = row[codeColIdx];
      const batchVal_raw = row[batchColIdx];

      if (!codeVal_raw) continue;
      const courseCode = String(codeVal_raw).trim();

      const dbCourse = existingCourses.find(c => c.code === courseCode || c.code.toUpperCase() === courseCode.toUpperCase());
      if (!dbCourse) continue;

      const batchVal = batchVal_raw ? String(batchVal_raw).trim().toUpperCase() : '';
      
      if (batchVal) {
        groupMappings[dbCourse.code] = [batchVal];
      } else {
        groupMappings[dbCourse.code] = [];
      }
      importCount++;
    }

    db.groupMappings = groupMappings;
    writeDb(db);

    res.json({
      success: true,
      message: `Imported major mappings for ${importCount} rows successfully.`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process major mappings Excel: ' + err.message });
  }
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

  // Ensure masterRecommendations baseline is permanently preserved on all courses
  const dbMaster = readDb();
  if (Array.isArray(dbMaster.courses)) {
    let changedMaster = false;
    dbMaster.courses.forEach(c => {
      if (!c.masterRecommendations) {
        c.masterRecommendations = JSON.parse(JSON.stringify(c.recommendations || {}));
        changedMaster = true;
      }
    });
    if (changedMaster) {
      writeDb(dbMaster);
    }
  }
} catch (err) {
  console.error("Failed to consolidate duplicate courses on startup:", err);
}

// Start Server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Timetable Allocation Server running at http://localhost:${PORT}`);

    // Automatic Keep-Alive Self-Ping for Render (Render free services sleep after 15m inactivity)
    // Note: Render automatically sets process.env.RENDER_EXTERNAL_URL on deployed web services
    const keepAliveUrl = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
    if (keepAliveUrl) {
      const pingInterval = 10 * 60 * 1000; // Ping every 10 minutes (before 15m idle timeout)
      const targetUrl = keepAliveUrl.endsWith('/health') ? keepAliveUrl : `${keepAliveUrl.replace(/\/$/, '')}/health`;
      console.log(`[Keep-Alive] Initialized self-ping service targeting ${targetUrl} every 10 minutes`);
      setInterval(async () => {
        try {
          const res = await fetch(targetUrl);
          console.log(`[Keep-Alive] Pinged ${targetUrl} - HTTP ${res.status}`);
        } catch (e) {
          console.warn(`[Keep-Alive] Ping to ${targetUrl} failed:`, e.message);
        }
      }, pingInterval);
    }
  });
}).catch(err => {
  console.error("Critical database initialization error:", err);
  process.exit(1);
});
