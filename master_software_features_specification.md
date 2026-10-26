# Master Software Features & System Specification

> **Target Audience:** System Administrators, Academic Coordinators, Software Engineers, and AI Development Agents.  
> **Status:** Final & Certified Production Baseline.  
> **Purpose:** This document is the **single source of truth** detailing every capability, interface workflow, algorithmic rule, database entity, and operational constraint of the College Timetable & Faculty Scheduling System. Future development agents must consult this document to verify that all existing features remain **strictly intact and untouched**.

---

## Table of Contents
1. [System Architecture & Tech Stack](#1-system-architecture--tech-stack)
2. [Automated Timetable Generation Engine (CSP Solver)](#2-automated-timetable-generation-engine-csp-solver)
3. [Department Coordinator Portal & Manual Allocation Matrix](#3-department-coordinator-portal--manual-allocation-matrix)
4. [Central Administration Portal](#4-central-administration-portal)
5. [Class & Batch Division Management](#5-class--batch-division-management)
6. [Institutional Coordination & Common Courses](#6-institutional-coordination--common-courses)
7. [Free Faculty Roster & Substitution Engine](#7-free-faculty-roster--substitution-engine)
8. [Database Architecture & Persistence](#8-database-architecture--persistence)
9. [Data Import & Export Pipelines](#9-data-import--export-pipelines)
10. [Security, Authentication & Lifecycle Governance](#10-security-authentication--lifecycle-governance)
11. [Strict Invariants & Prohibitions for Future Development](#11-strict-invariants--prohibitions-for-future-development)

---

## 1. System Architecture & Tech Stack

### 1.1 Technology Stack
- **Backend Runtime:** Node.js (ES Modules, Node v18+).
- **Web Framework:** Express.js with custom RESTful JSON endpoints.
- **Primary Database:** Local SQLite via `better-sqlite3` (`server/data/timetable.db`) with synchronous WAL-mode reliability and transactional integrity.
- **Enterprise Database Support:** Hybrid PostgreSQL connector (`pg`) with automatic fallback to SQLite when `DATABASE_URL` is unavailable.
- **Frontend Core:** Pure Vanilla JavaScript (ES6+), HTML5 semantic markup, and custom CSS design system (zero Tailwind dependency, dark-mode/light-mode tokens, rich glassmorphism, responsive grid layouts).
- **Icons & Typography:** FontAwesome 6, Google Fonts Inter / Outfit.

### 1.2 Dual-Layer Memory & Persistence Architecture
- **In-Memory Cache (RAM):** Global state held in memory for sub-millisecond timetable grid queries, collision validation, and backtracking candidate checks (`readDb()`).
- **Disk Persistence:** `writeDb()` commits state synchronously to SQLite (and asynchronously to Postgres if configured), ensuring zero data loss on unexpected process termination.
- **Automated Schema Migration:** Built-in triggers automatically synchronize legacy schema structures (`app_data` key-value pairs) into relational normalized tables (`departments`, `courses`, `faculty`, `allocations`, `recommendations`, `common_batches`).

---

## 2. Automated Timetable Generation Engine (CSP Solver)

The timetable engine resides in [`server/scheduler.js`](file:///server/scheduler.js). It employs an advanced Constraint Satisfaction Problem (CSP) Backtracking Solver with heuristic pruning, domain reduction, and a two-phase priority pipeline.

### 2.1 Two-Phase Scheduling Hierarchy
1. **Phase 1: Recommended Slots Allocation (HIGHEST PRIORITY)**
   - Courses with predefined curriculum recommendations (`course.recommendations`) **MUST be scheduled first**.
   - **Faculty Locking:** Assigned theory and practical teachers must be placed directly into their curriculum-recommended slots (`T`, `P`, `M`).
   - If strict Phase 1 encounters tight soft constraints (e.g. consecutive hours), a relaxed Phase 1 pass executes immediately to ensure recommended slots remain occupied rather than deferred.
2. **Phase 2: Balance & Overflow Hours Allocation**
   - Allocates remaining course hours (beyond recommended slots) and courses without curriculum recommendations into neutral open slots.
   - **Weekday Spread Priority:** Hours must be distributed across weekdays before periods (e.g. a 5-hour course receives exactly 1 hour on Monday, Tuesday, Wednesday, Thursday, and Friday).
   - **Period Diversity (Anti-Mono-Period):** Prevents a course from repeatedly landing on the same period index every day.
   - **Shift Balancing:** Disperses lectures between morning (Periods 1–3) and afternoon (Periods 4–6) sessions without bias.

### 2.2 Hard Constraint Enforcement
- **Zero Faculty Clashes:** No teacher can be scheduled in two courses, classes, or departments in the same weekday and period.
- **Admin Global Locked Periods:** Institution-wide locks (e.g. Wednesday Period 4 Assembly) and semester-scoped locks are strictly respected and cannot be overwritten.
- **Contiguous Practical Sessions:** Lab practicals (`P`) must be scheduled in contiguous 2-hour blocks (e.g. Periods 1–2, 4–5, 5–6) and must **never cross interval boundaries** (between Periods 2–3 or Periods 3–4) or Lunch Break (`LB`).
- **Parallel Class Division Support (`_C1` vs `_C2`):** Parallel divisions of the same base course (e.g. `MAT4CJ205_C1` and `MAT4CJ205_C2`) represent disjoint student cohorts. They are permitted to run concurrently, and their practical blocks can occupy the laboratory at the same recommended time with their respective teachers without triggering lab collision errors.
- **Effective Semester Resolution:** Identifies student cohort semesters from course code prefixes (e.g. `MAT4...` = Sem 4, `MAT6...` = Sem 6) to eliminate false cohort clashing across different academic years.
- **Teacher Blackout Slots:** Pre-configured teacher unavailability slots are strictly honored.
- **Faculty Fatigue Rule:** Teachers are restricted to <= 2 consecutive teaching periods without a rest break.

### 2.3 Diagnostic Engine & Combination Audit
- Tracks combination attempts via `audit.combinationsChecked` and reports solver duration, placed practical blocks, and fitness scores.
- When overconstrained, provides intelligent diagnostic failure messages and suggestion prompts (e.g. identifying bottleneck teachers or conflicting global locks).

---

## 3. Department Coordinator Portal & Manual Allocation Matrix

The department portal (`/index.html`) is the coordinator's primary workspace for building, auditing, and submitting department timetables.

### 3.1 Workspace Views
- **Single-Day View (Default):** Dedicated weekday tabs (`MONDAY`, `TUESDAY`, `WEDNESDAY`, `THURSDAY`, `FRIDAY`) with period columns (`1`, `2`, `3`, `LB`, `4`, `5`, `6`).
- **Full-Week Timetable Matrix Mode (`btn-toggle-grid-mode`):** Complete 30-period weekly overview merging theory (`-T`) and practical (`-P`) rows into unified course lines.
- **Multidimensional Filters:** Quick Term Switcher (`All`, `Odd`, `Even`), Program (`UG`, `PG`, `INT`), Semester dropdown (`1`–`8`), and Subject Category (`Major`, `Minor`, `MDC`, `AEC`, `SEC`, `VAC`).

### 3.2 Cell Allocation & Faculty Picker Modal
- **Contextual Visual Badging:**
  - Gold tint with amber border: Theory Recommended (`Theory Rec`).
  - Mint green with emerald border: Practical Recommended (`Practical Rec`).
  - Padlock icon with banner: Admin Common / Locked Period.
  - Dashed red background: Curriculum Blocked Period (`B`).
  - Muted gray: Non-recommended slot (prompts confirmation in Sem 1–4, open in Sem 5+).
- **Interactive Faculty Picker Modal (`#modal-faculty-select`):** Displays real-time teacher availability, active hours, and co-teaching options.
- **One-Click Co-Teacher Shortcut:** Dedicated shortcut button in practical slots (*"Assign All Co-Teachers"*) to bind all lab instructors simultaneously.
- **Auto-Fill Recommended Slots Toggle:** Top-legend switch cascading a teacher's assignment across all matching recommended slots for that course across the week, skipping conflicting slots safely.
- **Inline One-Click Removal (`×`):** Hovering over assigned teacher badges displays teacher names; clicking the red cross unassigns them instantly.

### 3.3 Data Persistence & Self-Service Tools
- **Debounced Autosave (5000ms):** Automatically queues and persists draft changes 5 seconds after interaction ceases, displaying live status indicators.
- **Course Alias & Faculty Visual Code Editor:** In-portal table enabling coordinators to rename course labels, specify 2–4 letter friendly aliases (e.g. `PYTHON`, `OOPS`), and adjust faculty initials (e.g. `JA`, `SAS`). Includes instant search and filter sync with the main grid.
- **Pre-Filled Excel Export & Import:** Exports cleanly formatted `.xlsx` templates pre-filled with department offerings, and re-imports edited schedules matching teachers by initials or staff IDs.
- **Semester Reset Tool (`#btn-clear-sem-timetable`):** Scoped clearing action to purge allocations for the active semester with safety confirmation.
- **Institutional Print Engine:** Formats schedules for export/print in Short (`EJ OOPS`), Medium (`EJ - OOPS`), and Full (`Eber Johns - Object Oriented Programming`) styles.
- **Teacher Timetable Modal (`#modal-teacher-timetable`):** Accessible via the top toolbar to inspect master weekly teaching slips for individual department faculty.

---

## 4. Central Administration Portal

Accessible at `/admin/index.html`, protected by password authentication and dedicated administrative JWT tokens.

### 4.1 Department Timetable Governance
- **Submission Status Tracker:** Central dashboard displaying departments in `Draft`, `Submitted`, `Approved`, or `Returned for Changes` states.
- **Review & Approval Workflow:**
  - Coordinators submit drafts when complete.
  - Admins inspect and either mark `Approved` (locking the timetable) or `Returned for Changes` with required revision notes.
  - Coordinators retain a self-service **"Revert Submission"** button while in `Submitted` status.
- **Department Password Reset:** Admins can select any department and reset their coordinator passcode to default (`123456`) with a mandatory `CONFIRM` safety input.

### 4.2 Institution-Wide Timetable Settings
- **Academic Configuration:** Academic Year, Semester Type (`Odd` / `Even`), Semester labels (`I BSC`, `III BSC`, etc.), and Period structure definitions.
- **Global Common Locked Periods:** Schedule college-wide assemblies, prayer hours, sports periods, or test hours globally across all departments or scoped to specific semesters.
- **Database Backup & Restoration:**
  - One-click full database export (`/api/admin/export-database`).
  - File-upload restore utility validating and restoring SQLite data seamlessly (`/api/admin/restore-database`).

---

## 5. Class & Batch Division Management

To accommodate large student cohorts, the system supports dynamic division into multiple parallel classes and student batches.

### 5.1 Parallel Class Representation
- Classes are designated with unified suffixes (`_C1`, `_C2`, `_C3`, up to `_C5`).
- Suffixes like `_G1` are automatically normalized into `_C1`.
- Each class section has independent teacher bindings, separate student batch cohorts, and independent slot allocations.
- Disjoint classes are permitted to run in parallel in the same period without student cohort clash rejections.

### 5.2 Dynamic Batch Allocation & Mapping
- **Cohort Code Generation:** Automated naming standard `{ProgramCode}{FundingCode}{DeptCode}{Year}` (e.g. `U1ENG1`, `U2CSC2`).
- **Single-Batch Major Courses:** "Assign Recommended Batches" shortcut maps major courses to their primary cohort in a single click, surfacing unassigned courses first.
- **Elective / Class Mappings:** Multi-select interactive chip selector connecting parallel elective classes to participating student cohorts.
- **Batch Utilization Tracker:** Monitors allocated vs unallocated batches, with an exclusion list for inactive student groups.

---

## 6. Institutional Coordination & Common Courses

Handles cross-department subjects where one department teaches students enrolled in other departments (AEC, MDC, SEC, VAC).

### 6.1 Offering vs. Participating Model
- **Offering Department:** Owns the course and assigns faculty instructors.
- **Participating Departments:** Have student batches enrolled in the course.
- **Synchronization:** When the offering department allocates faculty to common course slots, those allocations automatically reflect in all participating departments' timetables under an Admin-locked badge.
- **Cross-Department Request Pipeline:** Department coordinators can file requests to borrow faculty from other departments, which administrators review and approve with designated locked periods.

---

## 7. Free Faculty Roster & Substitution Engine

A real-time staff room substitution and teacher availability finder accessible in the admin portal (`/admin/index.html`).

### 7.1 Real-Time Roster & Matrix
- **Filtering:** Filters teachers dynamically by Weekday, Period (`1`–`6`), Department, Program, and Semester.
- **Roster View:** Detailed tabular view listing all unassigned teachers for the selected period, showing department, staff ID, and contact details.
- **Matrix View:** Period-by-period visual density heat-map across the entire college showing free teacher counts per period.
- **Printable Notice-Board Export:** Produces clean landscape print slips and CSV exports designed for morning staff room substitution notices.

---

## 8. Database Architecture & Persistence

### 8.1 Primary Entity Stores
- `departments`: Registered academic departments, login credentials, and coordinator profiles.
- `courses`: Master course catalog, code, name, pathway, category, theory hours, practical hours, class number, and recommended timetable slots (`recommendations`).
- `faculty`: Master faculty roster, staff ID, visual initials code, department, and weekly teaching quotas.
- `allocations`: Multi-level timetable allocation mapping:
  ```json
  {
    "MATHEMATICS": {
      "MAT4CJ205_C1": {
        "THURSDAY": {
          "4": ["JA"],
          "5": ["JA"]
        }
      }
    }
  }
  ```
- `subjectTeacherMapping`: Pre-configured teacher assignments, co-teaching partners, and hour distributions per course.
- `teacherUnavailability`: Matrix of blackout periods per faculty member (`teacherUnavailability[facultyCode][day][period] = true`).
- `config.globalLockedPeriods`: Institution-wide locked periods with semester filters.
- `submissions`: Timetable approval state per department (`status`, `submittedAt`, `feedback`).
- `groupMappings` & `commonBatches`: Mapping between courses, class divisions, and enrolled student cohorts.

---

## 9. Data Import & Export Pipelines

Comprehensive Excel processing detailed in [`data_import_behavior.md`](file:///data_import_behavior.md).

### 9.1 Course Structure Import (`.xlsx`)
- **Flexible Header Matching:** Supports case-insensitive, underscored, and spaced column headers (`Course Code`, `course_code`, `Course Title`, `Theory Hours`, `Practical Hours`, etc.).
- **Timetable Marker Parsing:** Translates grid cells marked `T`, `P`, or `M` into structured weekday/period recommendations (`course.recommendations[DAY][PERIOD] = 'T'`).
- **Composite Courses:** Correctly parses courses containing both theory and practical components, defaulting practical hours to an even number (e.g. 2 practical + 2 theory for 4 total hours).

### 9.2 Faculty Master Import (`.xlsx`)
- Parses Staff ID, Full Name, Department, and optional pre-assigned visual initials.
- Ensures unique initials codes across the institution to prevent timetable badge collisions.

---

## 10. Security, Authentication & Lifecycle Governance

- **Authentication Tokens:** Role-based HTTP Authorization headers (`admin-token`, `dept-token-{deptName}`).
- **BOLA / IDOR Verification:** API routes strictly verify department identity; a coordinator from Chemistry cannot modify or overwrite Mathematics allocations.
- **Department Lockout:** When a timetable is in `Submitted` or `Approved` status, all write endpoints (`/api/allocations`, `/api/courses/class-config`, `/api/subject-teacher-mapping`) are rejected with `403 Forbidden`.
- **Administrative Override:** Administrators can unlock or return any timetable with feedback notes.

---

## 11. Strict Invariants & Prohibitions for Future Development

> [!CAUTION]
> **MANDATORY RULES FOR FUTURE AGENTS AND DEVELOPERS**  
> Any modification that violates the invariants listed below is considered a regression and must **NEVER** be committed:

1. **PROHIBITED: Modifying Core Manual Allocation Features**
   - Do NOT alter cell click behavior, faculty modal layout, co-teaching assignment workflows, 5000ms autosave debounce timing, or inline `×` badge deletion.
2. **PROHIBITED: Changing the Priority Hierarchy in the Scheduler Engine**
   - The scheduler engine MUST place curriculum-recommended slots (`course.recommendations`) **FIRST in Phase 1**.
   - Teachers MUST be allocated to their recommended slots before balance hours are filled.
   - Balance hours MUST be spread across weekdays first, then across periods.
   - Practical blocks MUST remain contiguous 2-hour blocks without splitting across intervals or lunch break.
   - Max 2 consecutive teaching hours for faculty must never be violated in optimal solutions.
3. **PROHIBITED: Altering Parallel Class Division (`_C1`, `_C2`) Support**
   - Parallel class divisions of the same base course are disjoint student cohorts. They must remain capable of running concurrently and sharing designated lab periods without triggering false collisions.
4. **PROHIBITED: Re-introducing Teacher Timetable into Advanced Features Modal**
   - The teacher timetable option was intentionally removed from the Advanced Features dialog and centralized into the top-toolbar modal (`#modal-teacher-timetable`). Do NOT re-add tabs for it inside the Advanced Settings dialog.
5. **PROHIBITED: Altering Schema & Normalization Contracts**
   - Do NOT rename or remove fields from `courses`, `faculty`, `allocations`, `subjectTeacherMapping`, or `submissions`.
   - Do NOT break backward compatibility with the SQLite / PostgreSQL dual-persistence adapter in `server/db.js`.
6. **PROHIBITED: Modifying Reference Specifications**
   - The files [`manual_period_allocation_features.md`](file:///manual_period_allocation_features.md), [`database_architecture_and_data_management.md`](file:///database_architecture_and_data_management.md), and [`data_import_behavior.md`](file:///data_import_behavior.md) are protected foundational specifications and must remain untouched.
