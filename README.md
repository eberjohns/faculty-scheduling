# College Timetable & Faculty Scheduling System

A secure, high-contrast, state-of-the-art academic scheduling and faculty allocation web application built with **Node.js, Express, better-sqlite3, PostgreSQL (hybrid), and Vanilla JavaScript**.

The platform provides a dual-portal interface:
- **Central Admin Portal (`/admin/`)**: Comprehensive institutional oversight, automated schedule generation, curriculum structure imports, batch generation rules, class split management, institution-wide locked periods, and master timetable exports.
- **Department Coordinator Portal (`/`)**: Interactive weekly timetable allocation matrix, live teacher conflict prevention, multi-faculty co-teaching, workload progress metrics, and substitution availability rosters.

---

## Table of Contents
1. [Key Features](#key-features)
2. [System Architecture](#system-architecture)
3. [Project Directory Structure](#project-directory-structure)
4. [Installation & Setup](#installation--setup)
5. [Database Configuration (Local SQLite vs. External PostgreSQL)](#database-configuration)
6. [Available Scripts](#available-scripts)
7. [User Workflows](#user-workflows)
   - [Central Administrator Workflow](#central-administrator-workflow)
   - [Department Coordinator Workflow](#department-coordinator-workflow)
8. [Data Imports, Exports & Templates](#data-imports-exports--templates)
9. [Version Tracking & Remote Deployment Verification](#version-tracking--remote-deployment-verification)
10. [Related Documentation](#related-documentation)

---

## Key Features

### 1. Automated Timetable Generation Engine
- **Constraint Satisfaction Backtracking Algorithm**: Generates optimal, clash-free department timetables balancing hard rules and soft curriculum guidelines.
- **Two-Phase Solver**:
  - **Phase 1 (Strict)**: Solves under strict faculty blackout slots, global locked periods, max 2 consecutive teaching hours, anti-mono-period spread, and 50/50 morning vs. afternoon shift balance.
  - **Phase 2 (Relaxed with Diagnostics)**: If overconstrained, automatically activates a fallback engine that provides diagnostic explanations and suggestions to resolve scheduling deadlocks.
- **Practical Block Continuity**: Automatically clusters practical lab sessions (`P`) into continuous multi-period blocks (e.g. Periods 4–5 or 5–6) with mandatory co-teaching support.

### 2. Manual Timetable Allocation Matrix (Department Portal)
- **Cell Click-to-Allocate**: Click any grid cell to view eligible faculty, co-teaching partners, and course types.
- **Real-Time Double-Booking Clash Detection**: Prevents scheduling faculty across multiple departments during the same period and weekday with instant conflict alerts.
- **Teacher Availability & Blackout Periods**: Honors custom teacher blackout slots with explanatory warnings.
- **Workload Indicator**: Live progress bars tracking each faculty member's assigned hours against their weekly maximum (default: 20 hours).
- **Auto-Fill Recommended Slots**: Toggleable setting that automatically maps connected periods for curriculum-recommended courses.
- **Multi-Faculty Co-Teaching**: Place multiple faculty in the same practical or theory slot with primary and secondary instructor designations.
- **Visual Aliases & Initials Codes**: In-place editing of course codes, friendly aliases, and visual initials codes.

### 3. Batch Allocation & Mapping (Major & Electives)
- **Dynamic Batch Code Generator**: Automatically generates cohort batch codes as `{ProgramCode}{FundingCode}{DeptCode}{Year}` (e.g. `U1ENG1`).
- **Major / Single Batch Courses**:
  - **Assign Recommended Batches**: One-click bulk assignment for all major courses that have system recommendations.
  - **Unassigned Courses First**: Automatically sorts unassigned courses to the top of the table.
  - **Live UI Updates**: Instant table updates upon batch assignment without requiring a page refresh.
  - **Direct Assign**: Quick inline "Assign" button inside the modal for rapid batch selection.
- **Elective / Class Section Mappings**: Connect parallel sections (`C1`, `C2`) to participating department batches with multi-select chips and search filters.
- **Allocation Status Tracker**: Summary table displaying batch utilization and unallocated cohorts with exclusion controls.

### 4. Central Common Subject & Multi-Department Mapping
- **Institutional Coordination**: Central management for common curriculum courses (AEC, SEC, MDC, VAC).
- **Offering vs. Participating Workflows**: The offering department assigns instructors; assigned faculty automatically populate on participating departments' locked timetable slots.

### 5. Free Faculty Availability Roster & Staff Room Report
- **Live Free Faculty Lookup**: Filter by weekday, period, department, program, or semester to find available teachers for substitution and proxy coverage.
- **Dual Views**: Switch between **Roster View** (detailed tabular list) and **Matrix View** (period-by-period density grid).
- **Printable Staff Room Report**: Instant print-ready landscape document and CSV export designed for notice-board posting.

### 6. Inspect Records & Admin Class Split Control
- **Unified Catalog**: Inspect, filter, and search courses across Department, Semester, and Category (`MAJOR`, `CORE`, `AEC`, `SEC`, `MDC`, `VAC`).
- **Bulk Operations**: Multi-row selection with "Select All" / "Deselect All" and bulk deletion.
- **Admin-Controlled Class Split**: Configure the number of parallel class divisions (`C1`, `C2`, etc.) centrally from the Admin portal.

### 7. Global Locked Periods
- **Institution-Wide Lockouts**: Lock specific weekday periods globally across all departments (e.g. College Assembly on Wednesday Period 4) or scope them to specific semesters.

### 8. Non-Blocking Toast Notification System & State Persistence
- **Modern Auto-Dismissing Toasts**: Replaced disruptive modal confirmation dialogs with sleek, non-blocking toast notifications.
- **Session State Persistence**: Refreshing the admin dashboard preserves the exact active tab and subtab (e.g. Batch Allocation -> Major Courses) without reverting to the Status Dashboard.

### 9. Enterprise Security & Access Control
- **Salted Password Hashing**: Administrator credentials protected with scrypt/PBKDF2.
- **Role-Based HMAC JWTs**: Signed authentication tokens distinguishing `admin` and `department` roles.
- **Department Password Reset**: Administrators can select any department on the **Change Password** page to reset their coordinator access password back to the default (`123456`), protected with a required `CONFIRM` verification step.
- **Course & Faculty Alias Filtering**: Department coordinator editors include instant search, program (`UG`, `PG`, `INT`), semester, and category filtering with a one-click grid filter sync.
- **BOLA / IDOR Protection**: Cross-department timetable modifications are strictly verified and forbidden.
- **Rate Limiting & Security Headers**: Integrated brute-force login protection, HSTS, CSP, and dotfile deny filters.

### 10. Version Tracking & Remote Deployment Verification
- **Automated Git Metadata Extraction**: Captures semantic version, active commit hash, branch, and commit message dynamically at runtime.
- **Visual Portal Badges**: Surfaces the active build version in both Department Coordinator and Central Admin login and header bars.
- **Live College Server Verification**: Compare your local development repository with the live hosted college server (`http://tt.stthomas.ac.in:8021`) directly from the Admin Portal or CLI (`npm run check-deploy`) to detect if a `git pull` is required.

---

## System Architecture

The platform uses a **dual-layer persistence architecture**:

```
                      ┌──────────────────────────────────────────┐
                      │          In-Memory Cache (RAM)           │
                      │  - Fast O(1) reads for scheduling        │
                      │  - Real-time clash detection             │
                      └─────────────────────┬────────────────────┘
                                            │
                             readDb() / writeDb()
                                            │
                      ┌─────────────────────┴────────────────────┐
                      ▼                                          ▼
   ┌─────────────────────────────────────┐    ┌───────────────────────────────────┐
   │     Layer 1: Document/Collection    │    │    Layer 2: Normalized Relational │
   │           (`app_data` table)        │    │         (11 SQL Tables)           │
   │  - JSON serialized collections      │    │  - Composite primary keys         │
   │  - Atomic transactions              │    │  - Foreign keys & Cascades        │
   │  - Flexible schema updates          │    │  - Multi-column indexes           │
   └─────────────────────────────────────┘    └───────────────────────────────────┘
```

- **Local SQLite Engine (`better-sqlite3`)**: Zero-configuration local database stored at `server/data/timetable.db`.
- **Hybrid External PostgreSQL (`pg.Pool`)**: Cloud database support enabled via `DATABASE_URL`. If the cloud connection is unavailable, it automatically falls back to local SQLite without service interruption.
- **Composite Primary Keys**:
  - Courses: `(Course Code + Class + Department)`
  - Faculty: `(Staff ID / Code + Department)`

---

## Project Directory Structure

```text
college_time_table/
├── public/                                # Frontend client applications
│   ├── admin/
│   │   └── index.html                     # Central Admin Portal
│   ├── index.html                         # Department Coordinator Portal
│   ├── css/
│   │   └── style.css                      # Primary Design System & UI Stylesheet
│   └── js/
│       ├── admin.js                       # Admin portal controllers, modals & state
│       └── app.js                         # Department coordinator controllers
├── server/                                # Backend server application
│   ├── data/
│   │   └── timetable.db                   # Local SQLite Database
│   ├── db.js                              # Database driver (SQLite + PostgreSQL hybrid)
│   ├── migrate_normalized.js              # Synchronization to normalized relational tables
│   ├── scheduler.js                       # Auto-schedule generation engine (Phase 1 & 2)
│   ├── schema.js                          # 11-table normalized relational SQL schema
│   ├── security.js                        # Crypto, password hashing, JWTs & sanitizers
│   ├── seed.js                            # Sample database seed generator
│   └── server.js                          # Express application controller & API router
├── templates/                             # Pre-formatted Excel import templates
│   ├── batch_dept_mappings_template.xlsx  # Department code mapping template
│   ├── course_structure_template.xlsx     # Course catalog template
│   └── staff_template.xlsx                # Faculty roster template
├── tests/                                 # Automated test suite
│   ├── test.js                            # Core database integration tests
│   ├── test_admin_inspect_and_class_split.js
│   ├── test_autofill_and_nonrec.js        # Autofill and non-recommended slot tests
│   ├── test_coloring_and_printing.js      # Print view and legend color tests
│   ├── test_e2e_http_security.js          # E2E RBAC, headers & security tests
│   ├── test_free_faculty.js               # Free faculty roster calculation tests
│   ├── test_manual_assignment_rules.js    # Clash prevention & manual assignment tests
│   ├── test_scheduler.js                  # Scheduler engine constraint tests
│   ├── test_security.js                   # Scrypt, token & encryption unit tests
│   └── test_subject_mapping_sync.js       # Subject-teacher sync tests
├── database_architecture_and_data_management.md # Full DB schema & import/export guide
├── manual_period_allocation_features.md   # Department manual allocation feature guide
├── requirements.md                        # Academic requirements specification
├── package.json                           # NPM dependencies and script runner
└── README.md                              # Main system documentation
```

---

## Installation & Setup

### Prerequisites
- **Node.js** (v18.0.0 or higher; v20+ recommended)
- **npm** (bundled with Node.js)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment (Optional)
Create a `.env` file at the root of the project to customize settings:
```env
# Server Port (Default: 5000)
PORT=5000

# Node Environment
NODE_ENV=development

# JWT Secret for Token Signatures (Recommended in production)
JWT_SECRET=your-secure-random-secret-key-here

# Optional: External PostgreSQL Database URL (Supabase, Neon, Railway, AWS RDS)
# DATABASE_URL=postgresql://user:password@host:5432/database?sslmode=require

# Optional: Custom SQLite database path
# DATABASE_PATH=server/data/timetable.db
```

### 3. Run the Application
- **Development Mode** (auto-reloads on file changes using nodemon):
  ```bash
  npm run dev
  ```
- **Standard Production Mode**:
  ```bash
  npm start
  ```

### Accessing the Portals
- **Department Portal**: [http://localhost:5000/](http://localhost:5000/)
- **Admin Portal**: [http://localhost:5000/admin/](http://localhost:5000/admin/)

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Starts the server in development mode with `nodemon` live-reload. |
| `npm start` | Starts the server in standard production mode with `node`. |
| `npm run check-deploy [url]` | Compares local Git commit with the live college server (default: `http://tt.stthomas.ac.in:8021`). |
| `npm test` | Runs the automated test suite (`test_security.js`, `test_scheduler.js`, `test_manual_assignment_rules.js`). |

---

## User Workflows

### Central Administrator Workflow
1. **Login**: Navigate to `http://localhost:5000/admin/` and sign in with the admin password (default: `admin`).
2. **Initial Configuration**:
   - In **Batch Configuration**, set up program codes (`U` = UG, `P` = PG), funding codes (`1` = Aided, `2` = SF), and year-to-semester mappings.
   - In **Batch-Dept Mappings**, define department code abbreviations (e.g. `ENG` for English).
3. **Data Import**:
   - Go to **Inspect Records & Data Setup** to download templates and import:
     - Course Structure Excel (`POST /api/import/courses`)
     - Staff Roster Excel (`POST /api/import/staff`)
4. **Batch Allocation**:
   - Under **Batch Allocation & Mapping -> Major / Single Batch Courses**, click **Assign Recommended Batches** to auto-assign cohorts.
   - Under **Elective / Common Courses**, map shared class sections (`C1`, `C2`) to participating batches.
5. **Global Locks & Period Times**:
   - Define period timings (Period 1 to Period 7).
   - Set institution-wide locked periods (e.g. Value Education, Assembly).
6. **Passcode Management**:
   - Under **Coordinator Passcodes**, set or reset department sign-in passwords.
7. **Schedule Review & Approval**:
   - On the **Status Dashboard**, inspect submitted department timetables.
   - **Approve**, **Revert to Draft**, or **Return for Changes** with coordinator feedback notes.
8. **Export**:
   - Download the consolidated master institutional timetable (`GET /api/admin/export/strict-timetable`).

### Department Coordinator Workflow
1. **Login**: Navigate to `http://localhost:5000/`, select your department name, and enter your coordinator passcode.
2. **Schedule Timetable**:
   - In the weekly matrix, click any slot to allocate an instructor. Recommended slots for department courses are highlighted.
   - Co-teaching: assign multiple faculty members to lab or seminar sessions.
   - Auto-Generation: click **Auto-Generate** to automatically create a conflict-free schedule meeting all constraints.
3. **Teacher Availability**:
   - Open **Teacher Availability** to mark faculty blackout periods (leaves, administrative duties).
4. **Workload Tracking**:
   - Inspect the real-time workload indicator bar to ensure all instructors receive balanced hours.
5. **Print & Review**:
   - Click **View & Print Table** to inspect, print, or export departmental grids to CSV.
6. **Submit**:
   - Click **Submit Timetable** to send your schedule for administrator review and lock further edits.

---

## Data Imports, Exports & Templates

### Imports
- **Course Catalog**: `POST /api/import/courses` (Excel/CSV)
- **Staff Directory**: `POST /api/import/staff` (Excel/CSV)
- **Department Codes**: `POST /api/import/batch-dept-mappings` (Excel/CSV)
- **Major Batch Mappings**: `POST /api/import/major-mappings` (Excel/CSV)
- **Elective Group Mappings**: `POST /api/import/group-mappings` (Excel/CSV)
- **Department Timetable**: `POST /api/department/import-timetable` (Excel/CSV)
- **Full Database Restore**: `POST /api/admin/restore` (`timetable_backup.json` or raw `timetable.db`)

### Exports & Backups
- **Master Institutional Timetable**: `GET /api/admin/export/strict-timetable` (`Institution_Strict_Timetable.xlsx`)
- **Major Mappings**: `GET /api/admin/export/major-mappings` (`Major_Mappings.xlsx`)
- **Classes Summary**: `GET /api/admin/export/classes-summary` (`Classes_Summary.xlsx`)
- **Full Database JSON Backup**: `GET /api/admin/backup` (`timetable_backup_<timestamp>.json`)
- **Raw SQLite Database Backup**: `GET /api/admin/backup/sqlite` (`timetable_<timestamp>.db`)
- **Free Faculty Availability Roster**: CSV download + formatted landscape print view.

---

## Related Documentation

- [**Audit System Architecture & Operational Guide**](file:///e:/git_repos/college_time_table/audit_system_architecture_and_management.md): Comprehensive reference for event auditing, dual-tier buffering, automatic rotation (5 MB) & retention pruning (30 days/10 files), and CSV export capabilities.
- [**Deployment & Version Management Guide**](file:///e:/git_repos/college_time_table/deployment_and_version_management.md): Architecture of runtime Git metadata extraction, remote server status verification proxy, and production update procedures.
- [**Database Architecture & Data Management Guide**](file:///e:/git_repos/college_time_table/database_architecture_and_data_management.md): Detailed relational schema, SQLite/PostgreSQL drivers, import/export formats, and data integrity specifications.
- [**Manual Period Allocation Features Guide**](file:///e:/git_repos/college_time_table/manual_period_allocation_features.md): Comprehensive reference for all department coordinator UI capabilities and workflows.
- [**Requirements Specification**](file:///e:/git_repos/college_time_table/requirements.md): Original functional, academic, and scheduling rule requirements.
