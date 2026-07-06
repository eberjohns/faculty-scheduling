import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import pg from 'pg';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'timetable.db');
const DB_DIR = path.dirname(DB_PATH);
const JSON_DB_PATH = path.join(DB_DIR, 'db.json');

// Ensure DB directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Setup Postgres Pool if DATABASE_URL is present
const isPostgres = !!process.env.DATABASE_URL;
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
      console.error("Error initializing PostgreSQL database:", err);
      throw err;
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
    batchConfig: data.batchConfig,
    periods: data.periods
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
