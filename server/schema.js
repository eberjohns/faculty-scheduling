import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'data', 'timetable.db');

export function createNormalizedTables(db) {
  db.exec(`
    -- 1. DEPARTMENTS
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT UNIQUE NOT NULL,
      passcode_hash TEXT NOT NULL,
      status TEXT DEFAULT 'Draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. FACULTY
    CREATE TABLE IF NOT EXISTS faculty (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
      designation TEXT,
      max_weekly_hours INTEGER DEFAULT 20,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_fac_dept ON faculty(department_id);

    -- 3. COURSES
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      alias TEXT,
      department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
      semester TEXT NOT NULL,
      program_type TEXT DEFAULT 'UG',
      course_type TEXT NOT NULL,
      category TEXT DEFAULT 'CORE',
      pathway TEXT DEFAULT 'SINGLE MAJOR',
      hours INTEGER NOT NULL,
      theory_hours INTEGER DEFAULT 0,
      practical_hours INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_course_dept_sem ON courses(department_id, semester, program_type);

    -- 4. COURSE FACULTY MAPPINGS
    CREATE TABLE IF NOT EXISTS course_faculty_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      assigned_hours INTEGER DEFAULT 0,
      UNIQUE (course_id, faculty_id, role)
    );

    -- 5. CURRICULUM RECOMMENDATIONS
    CREATE TABLE IF NOT EXISTS curriculum_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      day_of_week TEXT NOT NULL,
      period_label TEXT NOT NULL,
      slot_type TEXT NOT NULL,
      UNIQUE (course_id, day_of_week, period_label)
    );

    -- 6. TIMETABLE ALLOCATIONS
    CREATE TABLE IF NOT EXISTS timetable_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      academic_year TEXT NOT NULL,
      department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      day_of_week TEXT NOT NULL,
      period_label TEXT NOT NULL,
      slot_type TEXT NOT NULL,
      room_no TEXT,
      section_batch TEXT DEFAULT 'C1',
      is_pinned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (academic_year, course_id, day_of_week, period_label, section_batch)
    );
    CREATE INDEX IF NOT EXISTS idx_alloc_dept_day ON timetable_allocations(department_id, academic_year, day_of_week);

    -- 7. ALLOCATION FACULTY (Co-teaching)
    CREATE TABLE IF NOT EXISTS allocation_faculty (
      allocation_id INTEGER NOT NULL REFERENCES timetable_allocations(id) ON DELETE CASCADE,
      faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE RESTRICT,
      is_primary INTEGER DEFAULT 1,
      PRIMARY KEY (allocation_id, faculty_id)
    );

    -- 8. TEACHER UNAVAILABILITY
    CREATE TABLE IF NOT EXISTS teacher_unavailability (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
      day_of_week TEXT NOT NULL,
      period_label TEXT NOT NULL,
      reason TEXT,
      UNIQUE (faculty_id, day_of_week, period_label)
    );

    -- 9. GLOBAL LOCKED PERIODS
    CREATE TABLE IF NOT EXISTS global_locked_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_of_week TEXT NOT NULL,
      period_label TEXT NOT NULL,
      semester_scope TEXT DEFAULT 'ALL',
      title TEXT NOT NULL,
      notes TEXT,
      UNIQUE (day_of_week, period_label, semester_scope)
    );

    -- 10. SYSTEM CONFIG
    CREATE TABLE IF NOT EXISTS system_config (
      config_key TEXT PRIMARY KEY,
      config_value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
