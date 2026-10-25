# Database Architecture, Schema & Data Management Guide

This document provides a comprehensive technical reference for the **College Timetable & Faculty Scheduling System** database architecture, data persistence layers, schema models, Excel/CSV import/export pipelines, and environment configuration.

---

## Table of Contents
1. [Architectural Overview](#1-architectural-overview)
2. [Local SQLite vs. External PostgreSQL (`DATABASE_URL`)](#2-local-sqlite-vs-external-postgresql-database_url)
   - [Local SQLite (`better-sqlite3`)](#local-sqlite-better-sqlite3)
   - [External PostgreSQL (`DATABASE_URL`)](#external-postgresql-database_url)
   - [Automatic Fallback Mechanism](#automatic-fallback-mechanism)
3. [Database Models & Schemas](#3-database-models--schemas)
   - [Collection Store (`app_data`)](#collection-store-app_data)
   - [Normalized Relational Schema (`server/schema.js`)](#normalized-relational-schema-serverschemajs)
   - [Critical Composite Primary Keys](#critical-composite-primary-keys)
4. [Data Import Pipelines](#4-data-import-pipelines)
   - [Course Structure Import](#1-course-structure-import)
   - [Staff Roster Import](#2-staff-roster-import)
   - [Department Code Mappings Import](#3-department-code-mappings-import)
   - [Major Course Batch Allocation Import](#4-major-course-batch-allocation-import)
   - [Elective Group/Class Section Mapping Import](#5-elective-groupclass-section-mapping-import)
   - [Department Timetable Excel Import](#6-department-timetable-excel-import)
   - [Full Database Restore](#7-full-database-restore)
5. [Data Export Pipelines & Downloadable Templates](#5-data-export-pipelines--downloadable-templates)
   - [Downloadable Excel Templates](#downloadable-excel-templates)
   - [Institutional Master Timetable Export](#institutional-master-timetable-export)
   - [Major Mappings Export](#major-mappings-export)
   - [Classes Summary Export](#classes-summary-export)
   - [Database Backup Snapshot](#database-backup-snapshot)
   - [Client-Side CSV & Printable Reports](#client-side-csv--printable-reports)
6. [Data Synchronization & Migrations](#6-data-synchronization--migrations)
   - [Automatic Legacy Migration (`db.json` → SQLite)](#automatic-legacy-migration-dbjson--sqlite)
   - [Unified Class Nomenclature Migration (`_G` → `_C`)](#unified-class-nomenclature-migration-_g--_c)
   - [Normalized Table Auto-Sync](#normalized-table-auto-sync)
7. [Environment Variables & Setup Reference](#7-environment-variables--setup-reference)

---

## 1. Architectural Overview

The scheduling system implements a **dual-layer storage architecture** designed for both ultra-fast in-memory scheduling and relational integrity:

```
                      ┌──────────────────────────────────────────┐
                      │          In-Memory Cache (RAM)           │
                      │  - Fast O(1) reads for scheduling        │
                      │  - Live clash detection & validations    │
                      └─────────────────────┬────────────────────┘
                                            │
                             readDb() / writeDb()
                                            │
                      ┌─────────────────────┴────────────────────┐
                      ▼                                          ▼
   ┌─────────────────────────────────────┐    ┌───────────────────────────────────┐
   │     Layer 1: Document/Collection    │    │    Layer 2: Normalized Relational │
   │           (`app_data` table)        │    │         (11 SQL Tables)           │
   │  - JSON serialized collections      │    │  - Strict compound primary keys   │
   │  - Atomic transactions              │    │  - Foreign keys & Cascades        │
   │  - Flexible schema updates          │    │  - Optimized multi-column indexes │
   └─────────────────────────────────────┘    └───────────────────────────────────┘
```

1. **In-Memory Cache**: All API operations access an in-memory representation (`dbInstance`) via `readDb()`, providing sub-millisecond timetable clash checks and grid validations.
2. **Layer 1: Document/Collection Store (`app_data`)**: Stores core timetable entities (`courses`, `faculty`, `allocations`, `config`, etc.) as serialized JSON documents inside an `app_data (key TEXT PRIMARY KEY, value TEXT)` table.
3. **Layer 2: Normalized Relational Tables**: Automatically synchronized on every write, unpacking courses, faculty, slots, co-teachers, and unavailabilities into 11 relational tables with strict foreign keys and composite unique constraints.

---

## 2. Local SQLite vs. External PostgreSQL (`DATABASE_URL`)

The persistence engine dynamically selects between local file storage and an external cloud database based on environment configuration in [`server/db.js`](file:///e:/git_repos/college_time_table/server/db.js).

### Local SQLite (`better-sqlite3`)
- **Default Mode**: Used when no `DATABASE_URL` is set in the environment or `.env` file.
- **Storage Location**: Defaults to `server/data/timetable.db` (can be overridden via `DATABASE_PATH`).
- **Characteristics**:
  - High performance C-based native binding (`better-sqlite3`).
  - Synchronous execution model inside atomic transactions (`sqliteDb.transaction(...)`).
  - Fully self-contained; requires zero external server setup or internet connection.
  - WAL (Write-Ahead Logging) compatibility for high concurrent read operations.

### External PostgreSQL (`DATABASE_URL`)
- **Activation**: Enabled automatically when `DATABASE_URL` is populated in `.env` or process environment.
  ```env
  DATABASE_URL=postgresql://user:password@host:port/database?sslmode=require
  ```
- **Supported Providers**: Supabase, Neon.tech, Railway, AWS RDS, Heroku Postgres, Render, Google Cloud SQL, or self-hosted PostgreSQL.
- **Characteristics**:
  - Managed connection pooling via `pg.Pool`.
  - SSL enabled with `{ ssl: { rejectUnauthorized: false } }` for cloud providers.
  - Asynchronous background transactions using PostgreSQL's `UPSERT`:
    ```sql
    INSERT INTO app_data (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    ```
  - Enables horizontal scaling, centralized cloud backups, and shared multi-instance deployments.

### Automatic Fallback Mechanism
If `DATABASE_URL` is configured but the remote PostgreSQL host is unreachable (e.g. network partition, expired credentials, or host maintenance):
1. The server logs a warning: `[Database] PostgreSQL connection failed (...). Falling back to local SQLite...`.
2. The system seamlessly instantiates the local SQLite engine at `server/data/timetable.db`.
3. The server continues running without crashing or rejecting student/admin requests.

---

## 3. Database Models & Schemas

### Collection Store (`app_data`)

The collection store manages the primary operational entities:

| Key | Type | Description |
|---|---|---|
| `config` | `Object` | Global timetable configuration: `academicYear`, `semesterType` (Odd/Even), `semesterLabels`, `adminPassword`, `excludedBatches`, and `globalLockedPeriods`. |
| `departments` | `Object` | Dictionary of departments mapped to their encrypted passcodes and department metadata. |
| `courses` | `Array` | Master course catalog. Contains course codes, names, semester, class/split numbers, hours, theory/practical breakdown, and mapped batches. |
| `faculty` | `Array` | Faculty roster including staff code, name, department, designation, and max weekly hours (default 20). |
| `allocations` | `Object` | Department allocations keyed by `[deptName][day][period]`. Contains assigned courses, faculty, room, and co-teaching allocations. |
| `submissions` | `Object` | Department workflow status tracking (`Draft`, `Submitted`, `Approved`, `Returned for Changes`) with timestamps and administrative comments. |
| `batchDeptMappings` | `Array` | Mapping between short batch abbreviations (e.g. `ENG`, `CHE`, `MAT`) and official department names. |
| `groupMappings` | `Object` | Batch allocation dictionary mapping `courseCode` to array of participating batch IDs (e.g. `{"ENG101_C1": ["U1ENG1"]}`). |
| `teacherUnavailability` | `Object` | Blackout slots for faculty members keyed by `[facultyCode][day][period]` with optional reasons. |
| `subjectTeacherMapping` | `Object` | Department-level faculty assignments per course, specifying assigned weekly hours and course types. |
| `batchConfig` | `Object` | Dynamic batch nomenclature rules: `programTypes` (`U`=UG, `P`=PG), `fundingTypes` (`1`=Aided, `2`=SF), and `yearSemMap`. |
| `periods` | `Array` | Active period labels (default: `["1", "2", "3", "LB", "4", "5", "6"]`). |
| `crossDepartmentRequests`| `Array` | Workflow requests for faculty from other departments with required hours, slots, and status (`PENDING`, `APPROVED`, `REJECTED`). |

---

### Normalized Relational Schema (`server/schema.js`)

On every write to SQLite, data is synchronized into 11 relational tables:

```mermaid
erDiagram
    DEPARTMENTS ||--o{ FACULTY : employs
    DEPARTMENTS ||--o{ COURSES : offers
    DEPARTMENTS ||--o{ TIMETABLE_ALLOCATIONS : schedules
    COURSES ||--o{ TIMETABLE_ALLOCATIONS : scheduled_in
    COURSES ||--o{ CURRICULUM_RECOMMENDATIONS : recommends
    COURSES ||--o{ COURSE_FACULTY_MAPPINGS : assigned_to
    FACULTY ||--o{ COURSE_FACULTY_MAPPINGS : assigned_from
    FACULTY ||--o{ TEACHER_UNAVAILABILITY : has_blackouts
    TIMETABLE_ALLOCATIONS ||--o{ ALLOCATION_FACULTY : co_teaches
    FACULTY ||--o{ ALLOCATION_FACULTY : participates_in

    DEPARTMENTS {
        int id PK
        string code
        string name UK
        string passcode_hash
        string status
        datetime created_at
    }

    FACULTY {
        int id PK
        string staff_id
        string code
        string name
        int department_id FK
        string designation
        int max_weekly_hours
        int is_active
    }

    COURSES {
        int id PK
        string code
        string name
        string alias
        int department_id FK
        string semester
        int class
        string program_type
        string course_type
        string category
        int hours
    }

    TIMETABLE_ALLOCATIONS {
        int id PK
        string academic_year
        int department_id FK
        int course_id FK
        string day_of_week
        string period_label
        string slot_type
        string section_batch
        int is_pinned
    }
```

#### Table Definitions

1. **`departments`**
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `code TEXT NOT NULL`
   - `name TEXT UNIQUE NOT NULL`
   - `passcode_hash TEXT NOT NULL` (PBKDF2/scrypt hashed)
   - `status TEXT DEFAULT 'Draft'` (`Draft`, `Submitted`, `Approved`, `Returned for Changes`)

2. **`faculty`**
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `staff_id TEXT`, `code TEXT NOT NULL`, `name TEXT NOT NULL`
   - `department_id INTEGER NOT NULL REFERENCES departments(id)`
   - `designation TEXT`, `max_weekly_hours INTEGER DEFAULT 20`
   - **Unique Constraint**: `UNIQUE (staff_id, department_id)`

3. **`courses`**
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `code TEXT NOT NULL`, `name TEXT NOT NULL`, `alias TEXT`
   - `department_id INTEGER NOT NULL REFERENCES departments(id)`
   - `semester TEXT NOT NULL`, `class INTEGER DEFAULT 0`
   - `program_type TEXT DEFAULT 'UG'`, `course_type TEXT NOT NULL`, `category TEXT DEFAULT 'CORE'`
   - `pathway TEXT DEFAULT 'SINGLE MAJOR'`, `hours INTEGER NOT NULL`
   - `theory_hours INTEGER DEFAULT 0`, `practical_hours INTEGER DEFAULT 0`
   - **Unique Constraint**: `UNIQUE (code, class, department_id)`
   - **Index**: `CREATE INDEX idx_course_dept_sem ON courses(department_id, semester, program_type)`

4. **`course_faculty_mappings`**
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE`
   - `faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE`
   - `role TEXT NOT NULL`, `assigned_hours INTEGER DEFAULT 0`
   - **Unique Constraint**: `UNIQUE (course_id, faculty_id, role)`

5. **`curriculum_recommendations`**
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE`
   - `day_of_week TEXT NOT NULL`, `period_label TEXT NOT NULL`, `slot_type TEXT NOT NULL`
   - **Unique Constraint**: `UNIQUE (course_id, day_of_week, period_label)`

6. **`timetable_allocations`**
   - `id INTEGER PRIMARY KEY AUTOINCREMENT`
   - `academic_year TEXT NOT NULL`
   - `department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE`
   - `course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE`
   - `day_of_week TEXT NOT NULL`, `period_label TEXT NOT NULL`, `slot_type TEXT NOT NULL`
   - `room_no TEXT`, `section_batch TEXT DEFAULT 'C1'`, `is_pinned INTEGER DEFAULT 0`
   - **Unique Constraint**: `UNIQUE (academic_year, course_id, day_of_week, period_label, section_batch)`
   - **Index**: `CREATE INDEX idx_alloc_dept_day ON timetable_allocations(department_id, academic_year, day_of_week)`

7. **`allocation_faculty`** (Co-teaching & Multi-Faculty Support)
   - `allocation_id INTEGER NOT NULL REFERENCES timetable_allocations(id) ON DELETE CASCADE`
   - `faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE RESTRICT`
   - `is_primary INTEGER DEFAULT 1`
   - **Primary Key**: `PRIMARY KEY (allocation_id, faculty_id)`

8. **`teacher_unavailability`**
   - `faculty_id INTEGER NOT NULL REFERENCES faculty(id) ON DELETE CASCADE`
   - `day_of_week TEXT NOT NULL`, `period_label TEXT NOT NULL`, `reason TEXT`
   - **Unique Constraint**: `UNIQUE (faculty_id, day_of_week, period_label)`

9. **`global_locked_periods`**
   - `day_of_week TEXT NOT NULL`, `period_label TEXT NOT NULL`
   - `semester_scope TEXT DEFAULT 'ALL'`, `title TEXT NOT NULL`, `notes TEXT`
   - **Unique Constraint**: `UNIQUE (day_of_week, period_label, semester_scope)`

10. **`system_config`**
    - `config_key TEXT PRIMARY KEY`, `config_value TEXT NOT NULL`, `updated_at DATETIME`

11. **`cross_department_requests`**
    - `id TEXT PRIMARY KEY`, `requesting_dept TEXT`, `offering_dept TEXT`, `course_code TEXT`
    - `pinned_slots TEXT`, `status TEXT DEFAULT 'PENDING'`

---

### Critical Composite Primary Keys

The schema enforces strict composite keys reflecting academic realities:

> [!IMPORTANT]
> 1. **Course Identity**: `(course code + class + department)`
>    - A course code like `ENG2FA103(2)` is offered across multiple departments (e.g. `English` Aided and `English_SF` Self-Finance).
>    - Large cohorts are divided into parallel class sections (`C1`, `C2`, `C3`).
>    - A course is only unique when combining `code + class + department`.
>
> 2. **Faculty Identity**: `(staff code / staff ID + department)`
>    - Faculty members or shared guest lecturers may teach in more than one department.
>    - Primary key constraints are tied to `(code/staff_id, department)`.

---

## 4. Data Import Pipelines

All imports accept `.xlsx`, `.xls`, or `.csv` files and run through input sanitization to strip null bytes, prototype pollution vectors, and formatting whitespace.

```
       Excel / CSV Upload
               │
               ▼
       sanitizeExcelRows()
               │
               ▼
  Header Mapping (Flexible Synonyms)
               │
               ▼
  Entity Resolution & De-duplication
               │
               ▼
     In-Memory State + writeDb()
               │
               ▼
  Normalized SQLite Tables Sync
```

### 1. Course Structure Import
- **Endpoint**: `POST /api/import/courses` (Admin only)
- **Primary Key**: `(Course Code, Class, Department)`
- **Header Synonyms Recognized**:
  - Code: `Course Code`, `CourseCode`, `Subject Code`, `Code`
  - Name: `Course Name`, `CourseName`, `Subject Name`, `Title`
  - Hours: `Hours`, `Weekly Hours`, `Credits`, `L+T+P`
  - Semester: `Semester`, `Sem`, `Semester Number`
  - Department: `Department`, `Dept`, `Offering Department`
  - Type: `Course Type`, `Type` (Theory / Practical)
  - Category: `Category` (`MAJOR`, `CORE`, `AEC`, `SEC`, `MDC`, `VAC`)
  - Class: `Class`, `Section`, `Group`, `Division`

### 2. Staff Roster Import
- **Endpoint**: `POST /api/import/staff` (Admin only)
- **Primary Key**: `(Staff Code, Department)`
- **Header Synonyms Recognized**:
  - Staff Code: `Staff Code`, `StaffCode`, `Faculty Code`, `Initials`
  - Staff Name: `Staff Name`, `Faculty Name`, `Teacher Name`, `Name`
  - Department: `Department`, `Dept`
  - Designation: `Designation`, `Role`, `Title`
  - Max Hours: `Max Hours`, `Weekly Limit`, `Max Weekly Hours`

### 3. Department Code Mappings Import
- **Endpoint**: `POST /api/import/batch-dept-mappings` (Admin only)
- **Purpose**: Maps batch codes (e.g. `ENG`, `CHE`, `PHY`) to canonical department names.
- **Required Columns**: `Batch Code`, `Department Name`.

### 4. Major Course Batch Allocation Import
- **Endpoint**: `POST /api/import/major-mappings` (Admin only)
- **Purpose**: Bulk-assigns single batches (e.g. `U1ENG1`) to major curriculum courses.
- **Required Columns**: `Course Code`, `Assigned Batch`.
- **Behavior**: Updates `groupMappings[code]` and synchronizes `mappedBatches` across all matching course sections.

### 5. Elective Group/Class Section Mapping Import
- **Endpoint**: `POST /api/import/group-mappings` (Admin only)
- **Purpose**: Connects class sections (`C1`, `C2`) to multiple participating departmental batches.
- **Required Columns**: `Course Code`, `Batches` (comma-separated, e.g. `U1ENG1, U1HIS1`).

### 6. Department Timetable Excel Import
- **Endpoint**: `POST /api/department/import-timetable` (Department / Admin)
- **Purpose**: Allows individual departments to upload an Excel grid containing their manual schedule.
- **Validation**: Automatically performs external teacher clash detection, teacher availability validation, and locked status verification before committing.

### 7. Full Database Restore
- **Endpoint**: `POST /api/admin/restore` (Admin only, password verified)
- **Purpose**: Restores the complete database state from a `timetable_backup.json` archive.

---

## 5. Data Export Pipelines & Downloadable Templates

### Downloadable Excel Templates
Admins and department heads can download pre-formatted `.xlsx` templates containing sample rows and data headers:
- `GET /api/admin/template/courses` → `course_structure_template.xlsx`
- `GET /api/admin/template/staff` → `staff_roster_template.xlsx`
- `GET /api/admin/template/batch-dept` → `batch_department_template.xlsx`

### Institutional Master Timetable Export
- **Endpoint**: `GET /api/admin/export/strict-timetable?token=<JWT>`
- **Output**: `Institution_Strict_Timetable.xlsx`
- **Content**: Generates a consolidated institution-wide master workbook. Every department has a dedicated tab, with period times, faculty allocations, course codes, and room numbers formatted for printing.

### Major Mappings Export
- **Endpoint**: `GET /api/admin/export/major-mappings?token=<JWT>`
- **Output**: `Major_Mappings.xlsx`
- **Columns**: `Course Code`, `Course Name`, `Semester`, `Department`, `Program`, `Assigned Batch`.

### Classes Summary Export
- **Endpoint**: `GET /api/admin/export/classes-summary?token=<JWT>`
- **Output**: `Classes_Summary.xlsx`
- **Content**: Summary breakdown of courses having multiple class sections (`C1`, `C2`, etc.) and their assigned faculty.

### Database Backup Snapshot
- **Endpoint**: `GET /api/admin/backup?token=<JWT>`
- **Output**: `timetable_backup.json`
- **Content**: Full point-in-time JSON serialization of all collections, configurations, and allocations.

### Client-Side CSV & Printable Reports
- **Elective Batch CSV**: Generates `class_batches_export.csv` client-side from the active batch mapping state.
- **Free Faculty Availability Roster**:
  - Export CSV: `Free_Faculty_[Roster/Matrix]_[Day]_[Period]_[Date].csv`
  - Print View: Formatted landscape report displaying unoccupied faculty across staff rooms for proxy/substitution arrangements.
- **Department Timetable CSV / Print**: Generates instant printable timetables styled for physical staff-room posting.

---

## 6. Data Synchronization & Migrations

### Automatic Legacy Migration (`db.json` → SQLite)
During system initialization (`initDbSync` in [`server/db.js`](file:///e:/git_repos/college_time_table/server/db.js#L239-L252)):
1. If `server/data/timetable.db` has an empty `app_data` table and an existing `server/data/db.json` is found:
2. The JSON data is parsed and written to the SQLite database.
3. The old JSON file is renamed to `db.json.migrated` to prevent duplicate migrations.

### Unified Class Nomenclature Migration (`_G` → `_C`)
The codebase originally used `_G<num>` (Group) notation, which was unified into `_C<num>` (Class/Section):
- On boot, `parseDbData()` scans all course codes, allocations, and subject mappings.
- Keys matching `_G(\d+)` are converted to `_C$1` (e.g. `ENG101_G1` → `ENG101_C1`).
- `c.group` and `c.class` properties are synchronized.

### Normalized Table Auto-Sync
Every invocation of `writeDb(data)` calls `migrateDataToNormalizedTables(sqliteDb)` inside an atomic database transaction. Any changes made to courses, staff, or timetable slots in the web interface are immediately reflected in both the collection store and the normalized relational tables.

---

## 7. Environment Variables & Setup Reference

Configuration is managed via environment variables or a `.env` file at the repository root:

```env
# Server Port (Default: 5000)
PORT=5000

# Node Environment
NODE_ENV=production

# JWT Authentication Secret Key (Required in Production)
JWT_SECRET=your-secure-random-jwt-secret-string-here

# Database Configuration (Choose one):

# Option A: Local SQLite (Default, no configuration needed)
# DATABASE_PATH=server/data/timetable.db

# Option B: External PostgreSQL (Supabase / Neon / Railway / AWS RDS)
# DATABASE_URL=postgresql://postgres:password@db.example.supabase.co:5432/postgres?sslmode=require
```

### Verification & Testing
To verify the database layer and run the test suite:
```bash
# Run automated test suite
npm test

# Run individual test modules
node tests/test_security.js
node tests/test_scheduler.js
node tests/test_manual_assignment_rules.js
node tests/test_free_faculty.js
```
