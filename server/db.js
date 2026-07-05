import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'timetable.db');
const JSON_DB_PATH = path.join(DB_DIR, 'db.json');

// Ensure DB directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Connect to SQLite
const sqliteDb = new Database(DB_PATH);

// Initialize DB schema
sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS app_data (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

let dbInstance = null;

// Synchronize memory cache with SQLite
export function readDb() {
  if (dbInstance) {
    return dbInstance;
  }

  try {
    const rows = sqliteDb.prepare('SELECT key, value FROM app_data').all();
    const rawData = {};
    rows.forEach(row => {
      try {
        rawData[row.key] = JSON.parse(row.value);
      } catch (e) {
        rawData[row.key] = null;
      }
    });

    const db = {
      config: rawData.config || {
        academicYear: "2026-2027",
        semesterType: "Odd",
        semesterLabels: {
          "1": "I BSC",
          "3": "III BSC",
          "5": "V BSC"
        },
        adminPassword: "admin",
        excludedBatches: []
      },
      departments: rawData.departments || {},
      courses: rawData.courses || [],
      faculty: rawData.faculty || [],
      allocations: rawData.allocations || {},
      submissions: rawData.submissions || {},
      batchDeptMappings: rawData.batchDeptMappings || [],
      groupMappings: rawData.groupMappings || {},
      batchConfig: rawData.batchConfig || {
        programTypes: { "U": "UG", "P": "PG" },
        fundingTypes:  { "1": "Aided", "2": "Self Finance" },
        yearSemMap:    {}
      },
      periods: rawData.periods || ["1", "2", "3", "LB", "4", "5", "6"]
    };

    // Ensure default structures are present
    if (!db.config.excludedBatches) db.config.excludedBatches = [];
    if (!db.batchConfig.programTypes) {
      db.batchConfig.programTypes = { "U": "UG", "P": "PG" };
    }
    if (!db.batchConfig.fundingTypes) {
      db.batchConfig.fundingTypes = { "1": "Aided", "2": "Self Finance" };
    }
    if (!db.batchConfig.yearSemMap) {
      db.batchConfig.yearSemMap = {};
    }

    dbInstance = db;
    return db;
  } catch (err) {
    console.error("Error reading database from SQLite:", err);
    return {};
  }
}

export function writeDb(data) {
  dbInstance = data;

  const stmt = sqliteDb.prepare('INSERT OR REPLACE INTO app_data (key, value) VALUES (?, ?)');
  
  const saveTransaction = sqliteDb.transaction((dbData) => {
    Object.entries(dbData).forEach(([key, val]) => {
      stmt.run(key, JSON.stringify(val));
    });
  });

  try {
    saveTransaction({
      config: data.config,
      departments: data.departments,
      courses: data.courses,
      faculty: data.faculty,
      allocations: data.allocations,
      submissions: data.submissions,
      batchDeptMappings: data.batchDeptMappings,
      groupMappings: data.groupMappings,
      batchConfig: data.batchConfig,
      periods: data.periods
    });
    return true;
  } catch (err) {
    console.error("Error writing to SQLite database:", err);
    return false;
  }
}

// Auto-migrate from db.json if it exists and SQLite is empty
const checkEmpty = sqliteDb.prepare('SELECT count(*) as count FROM app_data').get();
if (checkEmpty.count === 0 && fs.existsSync(JSON_DB_PATH)) {
  try {
    console.log("Found existing db.json. Migrating to SQLite...");
    const rawData = fs.readFileSync(JSON_DB_PATH, 'utf8');
    const oldDb = JSON.parse(rawData);
    writeDb(oldDb);
    fs.renameSync(JSON_DB_PATH, JSON_DB_PATH + '.migrated');
    console.log("Successfully migrated db.json to timetable.db");
  } catch (e) {
    console.error("Failed to migrate existing db.json database:", e);
  }
}
