import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'db.json');
const MAX_BACKUPS = 5;

// Initialize db.json if not present
function initializeDb() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_PATH)) {
    const initialData = {
      config: {
        academicYear: "2026-2027",
        semesterType: "Odd",
        semesterLabels: {
          "1": "I BSC",
          "3": "III BSC",
          "5": "V BSC"
        },
        adminPassword: "admin"
      },
      departments: {}, // Maps deptName -> { password }
      courses: [],
      faculty: [],
      allocations: {}, // Maps deptName -> courseCode -> weekday -> period -> [facultyCodes]
      submissions: {}, // Maps deptName -> { status: "Draft"|"Submitted"|"Approved"|"Returned", comments: "" }
      periods: ["1", "2", "3", "LB", "4", "5", "6"] // Default, will be updated by excel upload
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

// Load database state
export function readDb() {
  initializeDb();
  try {
    const data = fs.readFileSync(DB_PATH, 'utf8');
    const db = JSON.parse(data);
    let modified = false;
    if (db.config && !db.config.excludedBatches) {
      db.config.excludedBatches = [];
      modified = true;
    }
    if (!db.batchDeptMappings) {
      db.batchDeptMappings = [];
      modified = true;
    }
    if (!db.groupMappings) {
      db.groupMappings = {};
      modified = true;
    }
    if (!db.batchConfig) {
      db.batchConfig = {
        programTypes: { "U": "UG", "P": "PG" },
        fundingTypes:  { "1": "Aided", "2": "Self Finance" },
        yearSemMap:    {}
      };
      modified = true;
    }
    if (modified) {
      fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    }
    return db;
  } catch (err) {
    console.error("Error reading database:", err);
    // If corruption occurred, load from backup
    return restoreFromLatestBackup() || {};
  }
}

// Save database state with rotating backups
export function writeDb(data) {
  initializeDb();
  try {
    // 1. Create rotating backups before writing
    if (fs.existsSync(DB_PATH)) {
      rotateBackups();
    }
    // 2. Write new state
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error("Error writing database:", err);
    return false;
  }
}

// Rotate backups: shift backup 4->5, 3->4, etc. and copy current db to backup.1
function rotateBackups() {
  try {
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const src = path.join(DB_DIR, `db.backup.${i}.json`);
      const dest = path.join(DB_DIR, `db.backup.${i + 1}.json`);
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
      }
    }
    const currentBackup = path.join(DB_DIR, 'db.backup.1.json');
    fs.copyFileSync(DB_PATH, currentBackup);
  } catch (err) {
    console.error("Error rotating backups:", err);
  }
}

// Attempt to restore from latest backup if main db file is corrupt
function restoreFromLatestBackup() {
  for (let i = 1; i <= MAX_BACKUPS; i++) {
    const backupPath = path.join(DB_DIR, `db.backup.${i}.json`);
    if (fs.existsSync(backupPath)) {
      try {
        console.warn(`Restoring from backup ${i} due to corruption...`);
        const data = fs.readFileSync(backupPath, 'utf8');
        const parsed = JSON.parse(data);
        fs.writeFileSync(DB_PATH, data, 'utf8');
        return parsed;
      } catch (err) {
        console.error(`Backup ${i} is also corrupt:`, err);
      }
    }
  }
  return null;
}
