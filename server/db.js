import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import pg from 'pg';
import { createNormalizedTables } from './schema.js';
import { migrateDataToNormalizedTables } from './migrate_normalized.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'timetable.db');
const DB_DIR = path.dirname(DB_PATH);
const JSON_DB_PATH = path.join(DB_DIR, 'db.json');

// Ensure DB directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Setup Postgres Pool if DATABASE_URL is present
let isPostgres = !!process.env.DATABASE_URL;
let pool = null;
let sqliteDb = null;

if (isPostgres) {
  console.log("DATABASE_URL detected. Setting up hybrid PostgreSQL connection pool...");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
} else {
  console.log("No DATABASE_URL detected. Using local SQLite database file...");
  sqliteDb = new Database(DB_PATH);
}

let dbInstance = null;

// Initialize database schema and load values (asynchronous)
export async function initDb() {
  if (isPostgres) {
    try {
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS app_data (
            key TEXT PRIMARY KEY,
            value TEXT
          )
        `);
        const res = await client.query('SELECT key, value FROM app_data');
        const rawData = {};
        res.rows.forEach(row => {
          try {
            rawData[row.key] = JSON.parse(row.value);
          } catch (e) {
            rawData[row.key] = null;
          }
        });
        dbInstance = parseDbData(rawData);
        console.log("PostgreSQL database successfully initialized and loaded.");
      } finally {
        client.release();
      }
    } catch (err) {
      console.warn(`[Database] PostgreSQL connection failed (${err.message}). Falling back to local SQLite...`);
      isPostgres = false;
      if (!sqliteDb) {
        sqliteDb = new Database(DB_PATH);
      }
      initDbSync();
      console.log("[Database] Local SQLite database successfully initialized and loaded as fallback.");
    }
  } else {
    try {
      initDbSync();
      console.log("SQLite database successfully initialized and loaded.");
    } catch (err) {
      console.error("Error initializing SQLite database:", err);
      throw err;
    }
  }
}

// Helper to fill default fields in data structures
function parseDbData(rawData) {
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
    teacherUnavailability: rawData.teacherUnavailability || {},
    subjectTeacherMapping: rawData.subjectTeacherMapping || {},
    commonBatches: rawData.commonBatches || [],
    batchConfig: rawData.batchConfig || {
      programTypes: { "U": "UG", "P": "PG" },
      fundingTypes:  { "1": "Aided", "2": "Self Finance" },
      yearSemMap:    {}
    },
    periods: rawData.periods || ["1", "2", "3", "LB", "4", "5", "6"],
    crossDepartmentRequests: rawData.crossDepartmentRequests || []
  };

  // Ensure default structures are present
  if (!db.crossDepartmentRequests) db.crossDepartmentRequests = [];
  if (!db.teacherUnavailability) db.teacherUnavailability = {};
  if (!db.subjectTeacherMapping) db.subjectTeacherMapping = {};
  if (!db.commonBatches) db.commonBatches = [];
  if (!db.config.excludedBatches) db.config.excludedBatches = [];
  if (!db.config.globalLockedPeriods) db.config.globalLockedPeriods = [];
  if (!db.batchConfig.programTypes) {
    db.batchConfig.programTypes = { "U": "UG", "P": "PG" };
  }
  if (!db.batchConfig.fundingTypes) {
    db.batchConfig.fundingTypes = { "1": "Aided", "2": "Self Finance" };
  }
  if (!db.batchConfig.yearSemMap) {
    db.batchConfig.yearSemMap = {};
  }

  // Auto-migrate legacy _G<num> to unified _C<num> class representation
  let needsDbSave = false;
  if (Array.isArray(db.courses)) {
    db.courses.forEach(c => {
      if (typeof c.code === 'string' && c.code.includes('_G')) {
        c.code = c.code.replace(/_G(\d+)/g, '_C$1');
        needsDbSave = true;
      }
      if (c.group && !c.class) {
        c.class = c.group;
        needsDbSave = true;
      }
      if (c.class && !c.group) {
        c.group = c.class;
        needsDbSave = true;
      }
    });
  }

  if (db.groupMappings && typeof db.groupMappings === 'object') {
    const updatedGroupMappings = {};
    let mappingsChanged = false;
    Object.entries(db.groupMappings).forEach(([k, v]) => {
      const newKey = k.replace(/_G(\d+)/g, '_C$1');
      updatedGroupMappings[newKey] = v;
      if (newKey !== k) mappingsChanged = true;
    });
    if (mappingsChanged) {
      db.groupMappings = updatedGroupMappings;
      needsDbSave = true;
    }
  }

  if (db.allocations && typeof db.allocations === 'object') {
    const updatedAllocs = {};
    let allocsChanged = false;
    Object.entries(db.allocations).forEach(([k, v]) => {
      const newKey = k.replace(/_G(\d+)/g, '_C$1');
      updatedAllocs[newKey] = v;
      if (newKey !== k) allocsChanged = true;
    });
    if (allocsChanged) {
      db.allocations = updatedAllocs;
      needsDbSave = true;
    }
  }

  if (db.subjectTeacherMapping && typeof db.subjectTeacherMapping === 'object') {
    let stmChanged = false;
    Object.values(db.subjectTeacherMapping).forEach(deptMap => {
      if (deptMap && typeof deptMap === 'object') {
        Object.keys(deptMap).forEach(k => {
          if (k.includes('_G')) {
            const newKey = k.replace(/_G(\d+)/g, '_C$1');
            deptMap[newKey] = deptMap[k];
            delete deptMap[k];
            stmChanged = true;
          }
        });
      }
    });
    if (stmChanged) needsDbSave = true;
  }
  db.__needsDbSave = needsDbSave;

  return db;
}

// Synchronous initializer for SQLite (used locally/on startup and as fallback)
function initDbSync() {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS app_data (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  const rows = sqliteDb.prepare('SELECT key, value FROM app_data').all();
  const rawData = {};
  rows.forEach(row => {
    try {
      rawData[row.key] = JSON.parse(row.value);
    } catch (e) {
      rawData[row.key] = null;
    }
  });
  dbInstance = parseDbData(rawData);

  createNormalizedTables(sqliteDb);
  const checkNormalized = sqliteDb.prepare('SELECT count(*) as count FROM courses').get();
  if (checkNormalized.count === 0) {
    migrateDataToNormalizedTables(sqliteDb);
    console.log("[Database] Automatically initialized and migrated normalized relational tables.");
  }

  if (dbInstance && dbInstance.__needsDbSave) {
    delete dbInstance.__needsDbSave;
    writeDb(dbInstance);
    console.log("Automatically migrated legacy _G group keys to unified _C class format in SQLite.");
  }

  // Auto-migrate from db.json if SQLite is empty
  const checkEmpty = sqliteDb.prepare('SELECT count(*) as count FROM app_data').get();
  if (checkEmpty.count === 0 && fs.existsSync(JSON_DB_PATH)) {
    try {
      console.log("Found existing db.json. Migrating to SQLite...");
      const jsonRaw = fs.readFileSync(JSON_DB_PATH, 'utf8');
      const oldDb = JSON.parse(jsonRaw);
      writeDb(oldDb);
      fs.renameSync(JSON_DB_PATH, JSON_DB_PATH + '.migrated');
      console.log("Successfully migrated db.json to timetable.db");
    } catch (e) {
      console.error("Failed to migrate existing db.json database:", e);
    }
  }
}

// Synchronous read from in-memory cache
export function readDb() {
  if (!dbInstance) {
    if (!isPostgres) {
      initDbSync();
    } else {
      console.warn("readDb called before initDb resolved on PostgreSQL. Returning skeleton.");
      return parseDbData({});
    }
  }
  return dbInstance;
}

// Write to cache and update physical database (Postgres asynchronously, SQLite synchronously)
export function writeDb(data) {
  dbInstance = data;

  const payload = {
    config: data.config,
    departments: data.departments,
    courses: data.courses,
    faculty: data.faculty,
    allocations: data.allocations,
    submissions: data.submissions,
    batchDeptMappings: data.batchDeptMappings,
    groupMappings: data.groupMappings,
    teacherUnavailability: data.teacherUnavailability || {},
    subjectTeacherMapping: data.subjectTeacherMapping || {},
    commonBatches: data.commonBatches || [],
    batchConfig: data.batchConfig,
    periods: data.periods,
    crossDepartmentRequests: data.crossDepartmentRequests || []
  };

  if (isPostgres) {
    // Fire-and-forget background async query to keep writeDb synchronous in server.js
    saveToPostgres(payload).catch(err => {
      console.error("PostgreSQL background update failed:", err);
    });
    return true;
  } else {
    try {
      const stmt = sqliteDb.prepare('INSERT OR REPLACE INTO app_data (key, value) VALUES (?, ?)');
      const saveTransaction = sqliteDb.transaction((dbData) => {
        Object.entries(dbData).forEach(([key, val]) => {
          stmt.run(key, JSON.stringify(val));
        });
        migrateDataToNormalizedTables(sqliteDb);
      });
      saveTransaction(payload);
      return true;
    } catch (err) {
      console.error("Error writing to SQLite database:", err);
      return false;
    }
  }
}

// Postgres async transaction writer helper
async function saveToPostgres(data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const queryText = 'INSERT INTO app_data (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';
    for (const [key, val] of Object.entries(data)) {
      await client.query(queryText, [key, JSON.stringify(val)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error("PostgreSQL transaction save error:", e);
    throw e;
  } finally {
    client.release();
  }
}

// Re-initialize SQLite connection (used when restoring a raw .db file)
export function getSqliteDb() {
  return sqliteDb;
}

export function reinitSqliteDb() {
  if (sqliteDb) {
    try { sqliteDb.close(); } catch (e) {}
    sqliteDb = null;
  }
  sqliteDb = new Database(DB_PATH);
  initDbSync();
}

// Restore SQLite from raw .db buffer safely
export function restoreSqliteDbFile(buffer) {
  if (sqliteDb) {
    try { sqliteDb.close(); } catch (e) {}
    sqliteDb = null;
  }
  fs.writeFileSync(DB_PATH, buffer);
  sqliteDb = new Database(DB_PATH);
  initDbSync();
  return { success: true };
}

// Atomically restore full database from backup data payload
export function restoreDb(data) {
  const parsed = parseDbData(data);
  dbInstance = parsed;

  const payload = {
    config: parsed.config,
    departments: parsed.departments,
    courses: parsed.courses,
    faculty: parsed.faculty,
    allocations: parsed.allocations,
    submissions: parsed.submissions,
    batchDeptMappings: parsed.batchDeptMappings,
    groupMappings: parsed.groupMappings,
    teacherUnavailability: parsed.teacherUnavailability || {},
    subjectTeacherMapping: parsed.subjectTeacherMapping || {},
    commonBatches: parsed.commonBatches || [],
    batchConfig: parsed.batchConfig,
    periods: parsed.periods,
    crossDepartmentRequests: parsed.crossDepartmentRequests || []
  };

  if (isPostgres) {
    saveToPostgres(payload).catch(err => {
      console.error("PostgreSQL background update failed during restore:", err);
    });
    return {
      success: true,
      count: {
        courses: (parsed.courses || []).length,
        faculty: (parsed.faculty || []).length,
        departments: Object.keys(parsed.departments || {}).length
      }
    };
  } else {
    try {
      const restoreTransaction = sqliteDb.transaction((dbData) => {
        // Clear old records in child-to-parent order to avoid foreign key conflicts
        try { sqliteDb.prepare('DELETE FROM allocation_faculty').run(); } catch (e) {}
        try { sqliteDb.prepare('DELETE FROM timetable_allocations').run(); } catch (e) {}
        try { sqliteDb.prepare('DELETE FROM curriculum_recommendations').run(); } catch (e) {}
        try { sqliteDb.prepare('DELETE FROM course_faculty_mappings').run(); } catch (e) {}
        try { sqliteDb.prepare('DELETE FROM teacher_unavailability').run(); } catch (e) {}
        try { sqliteDb.prepare('DELETE FROM courses').run(); } catch (e) {}
        try { sqliteDb.prepare('DELETE FROM faculty').run(); } catch (e) {}
        try { sqliteDb.prepare('DELETE FROM departments').run(); } catch (e) {}
        try { sqliteDb.prepare('DELETE FROM app_data').run(); } catch (e) {}

        const stmt = sqliteDb.prepare('INSERT OR REPLACE INTO app_data (key, value) VALUES (?, ?)');
        Object.entries(dbData).forEach(([key, val]) => {
          stmt.run(key, JSON.stringify(val));
        });

        migrateDataToNormalizedTables(sqliteDb);
      });

      restoreTransaction(payload);

      return {
        success: true,
        count: {
          courses: (parsed.courses || []).length,
          faculty: (parsed.faculty || []).length,
          departments: Object.keys(parsed.departments || {}).length
        }
      };
    } catch (err) {
      console.error("Error restoring SQLite database:", err);
      return { success: false, message: err.message };
    }
  }
}

