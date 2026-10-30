# System Audit Logging Architecture & Operational Guide

## 1. Executive Summary & Purpose

The **Audit Logging System** in the College Timetable & Faculty Allocation Platform provides an immutable, transparent, and high-performance trail of all critical administrative, authentication, scheduling, data modification, and security events across the entire institution.

### Core Objectives
1. **Accountability & Traceability:** Pinpoint exactly who made changes, from which IP address, at what time, and what records were impacted.
2. **Administrative Oversight:** Enable the Master Administrator to review timetable submissions, approvals, data updates, cascading renames, and coordinator activity in real-time.
3. **Security & Threat Detection:** Flag brute-force login attempts, unauthorized cross-department access, and administrative password resets.
4. **Bounded Storage Management:** Enforce a strict disk budget with automatic file rotation and retention pruning so system storage is never exhausted.
5. **Ultra-Low Latency:** Utilize a dual-tier in-memory ring buffer (1,000 entries) alongside persistent disk files to render the Admin UI in less than 5ms without reading multi-megabyte log files on every request.

---

## 2. Dual-Layer Storage Architecture

The auditing architecture employs a hybrid storage strategy balancing sub-millisecond retrieval speeds with durable, append-only disk persistence:

```
[ Incoming HTTP Request / Mutation Action ]
                    │
                    ▼
          ┌───────────────────┐
          │  server/audit.js  │
          │    logAudit()     │
          └─────────┬─────────┘
                    │
       ┌────────────┴────────────┐
       ▼                         ▼
┌──────────────┐         ┌──────────────┐
│ In-Memory    │         │ Disk Log     │
│ Ring Buffer  │         │ (Append-Only)│
│ (Last 1,000  │         │ logs/audit.log
│  events)     │         └──────┬───────┘
└──────┬───────┘                │
       │                        ▼
       │               ┌──────────────────┐
       │               │ Rotation Trigger │
       │               │ (File size >= 5MB│
       │               └────────┬─────────┘
       │                        │
       ▼                        ▼
┌──────────────┐       ┌────────────────────┐
│ Instant UI   │       │ Archive & Pruning  │
│ Search/Paging│       │ - Max 10 archives  │
│ & Metrics    │       │ - Max 30-day age   │
└──────────────┘       │ - Bound ~50 MB max │
                       └────────────────────┘
```

### Layer 1: In-Memory Ring Buffer
- **Capacity:** Fixed limit of 1,000 most recent events (`MEMORY_BUFFER_LIMIT = 1000`).
- **Data Structure:** Unshift-prepend with tail pop.
- **Boot Preloading:** During server boot (`initAuditLogger()`), the server reads the tail of `logs/audit.log` into memory, ensuring recent history is preserved across server restarts.
- **Latency:** Instant in-memory filtering, keyword search, and pagination response in `< 5ms`.

### Layer 2: Disk Persistence & File Layout
- **Root Directory:** `logs/` (located directly at the repository root).
- **Git Tracking:** `logs/.gitkeep` preserves the directory in Git, while `.gitignore` contains `*.log` to prevent active log data from polluting repository commits.
- **Format:** JSON Lines (`.log`) where each line is a single, self-contained JSON object terminated with `\n`. This eliminates the need to parse entire JSON files on every write and guarantees safe append operations via `fs.appendFile`.

---

## 3. What the System Audits (Event Taxonomy)

Events are categorized into five core functional domains:

| Category | Typical Events | Description | Default Role |
| :--- | :--- | :--- | :--- |
| **`AUTH`** | `ADMIN_LOGIN_SUCCESS`, `ADMIN_LOGIN_FAILURE`, `DEPT_LOGIN_SUCCESS`, `DEPT_LOGIN_FAILURE`, `ADMIN_PASSWORD_CHANGED`, `DEPT_PASSWORD_CHANGED`, `DEPT_PASSWORD_UPDATED`, `DEPT_PASSWORD_RESET` | Authentication verification, coordinator logins, credential updates, and administrator password resets. | `ADMIN`, `COORDINATOR` |
| **`SCHEDULING`** | `TIMETABLE_SUBMIT`, `TIMETABLE_APPROVE`, `TIMETABLE_RETURN`, `TIMETABLE_STATUS_CHANGE`, `SCHEDULE_GENERATED` | Department timetable lifecycle transitions (draft, submission, approval, return) and auto-generation actions. | `ADMIN`, `COORDINATOR` |
| **`DATA`** | `DEPARTMENT_RENAME_CASCADE`, `COURSES_BATCH_SAVED`, `FACULTY_BATCH_SAVED`, `COURSE_DELETED`, `COURSE_BULK_DELETED`, `FACULTY_DELETED`, `GROUP_MAPPINGS_UPDATED` | Structural and relational data mutations, batch Excel imports, single/bulk deletions, and cascading renames. | `ADMIN`, `COORDINATOR` |
| **`SYSTEM`** | `SYSTEM_BOOT`, `DATABASE_BACKUP_DOWNLOADED`, `DATABASE_RESTORED`, `DATABASE_CLEARED`, `LOGS_PRUNED` | Platform lifecycle operations, JSON/SQLite backup downloads and restores, full database wipe, and log pruning. | `ADMIN`, `SYSTEM` |
| **`SECURITY`** | `RATE_LIMIT_TRIGGERED`, `UNAUTHORIZED_ACCESS_ATTEMPT`, `TOKEN_TAMPER_DETECTED` | Security warnings, invalid tokens, brute-force blocks, and unauthorized cross-department manipulation attempts. | `SYSTEM` |

---

## 4. Audit Record Schema

Each logged record conforms to the following strict JSON schema:

```json
{
  "id": "aud_1793385715975_f84725",
  "timestamp": "2026-10-31T00:15:30.123Z",
  "action": "DEPARTMENT_RENAME_CASCADE",
  "category": "DATA",
  "actor": "admin",
  "role": "ADMIN",
  "ip": "192.168.1.10",
  "status": "SUCCESS",
  "details": "Cascading rename of department 'CS' to 'COMP_SCI' (12 courses, 4 faculty, 3 batch mappings)",
  "metadata": {
    "oldName": "CS",
    "newName": "COMP_SCI",
    "coursesCount": 12,
    "facultyCount": 4
  }
}
```

### Field Definitions
- **`id`** *(string)*: Unique identifier formatted as `aud_<unix_timestamp>_<3-byte-hex>`.
- **`timestamp`** *(string)*: Standard ISO 8601 UTC timestamp of event creation.
- **`action`** *(string)*: Standardized uppercase action verb identifying the exact event.
- **`category`** *(string)*: One of `AUTH`, `SCHEDULING`, `DATA`, `SYSTEM`, or `SECURITY`.
- **`actor`** *(string)*: Identity of the initiator (`admin`, department name e.g. `COMP_SCI`, or `system`).
- **`role`** *(string)*: Role authorization level (`ADMIN`, `COORDINATOR`, or `SYSTEM`).
- **`ip`** *(string)*: Client IPv4 or IPv6 address resolved securely from request headers (`x-forwarded-for` fallback to socket `remoteAddress`).
- **`status`** *(string)*: `SUCCESS` (green), `WARNING` (amber), or `FAILURE` (red).
- **`details`** *(string)*: Concise human-readable explanation of the action, parameters, and affected count.
- **`metadata`** *(object)*: Optional structured key-value payload for deep diagnostic context.

---

## 5. Storage, Backup, Rotation & Pruning Policies

To guarantee that audit logging never overflows disk capacity, the system applies three automatic bounding rules:

```
┌──────────────────────────────────────────────────────────────────┐
│                      STORAGE THRESHOLDS                          │
├────────────────────────────┬─────────────────────────────────────┤
│ Max Active File Size       │ 5 Megabytes (5,242,880 bytes)       │
│ Max Archived Files Kept    │ 10 archive files                    │
│ Max Retention Window       │ 30 Days                             │
│ Hard Storage Footprint Cap │ ~50 to 55 Megabytes max total       │
└────────────────────────────┴─────────────────────────────────────┘
```

### 1. Automatic File Rotation
- The active log file is always located at `logs/audit.log`.
- After each append operation, `checkAndRotate()` verifies the file size of `audit.log`.
- When `size >= 5,242,880 bytes` (5 MB):
  1. An archive filename is created: `logs/audit_YYYY-MM-DDTHH-mm-ss.log`.
  2. `fs.renameSync()` moves `audit.log` to the timestamped archive path.
  3. A new, empty `logs/audit.log` is initialized immediately.
  4. The automatic pruning engine (`pruneLogFiles()`) is immediately triggered.

### 2. Automatic Pruning Engine
The pruning policy runs automatically upon file rotation and can also be triggered manually:
1. **Age-Based Pruning:** Scans all files matching `logs/audit_*.log`. Any archive whose last modified timestamp is older than **30 days** (`MAX_RETENTION_DAYS`) is deleted via `fs.unlinkSync()`.
2. **Count-Based Pruning:** If more than **10 archive files** (`MAX_ARCHIVED_FILES`) remain, the archives are sorted by modified date (oldest first), and the excess archives are pruned until exactly 10 remain.
3. **Safety Protection:** The active log file `logs/audit.log` is **never** pruned by automatic pruning.

### 3. Manual Pruning via Admin UI / API
Administrators can trigger pruning on-demand from the Admin Portal using the **"Prune Archives"** button. This calls `POST /api/admin/audit-logs/prune`, removing archives older than the specified retention window while preserving the active log.

---

## 6. Admin Portal UI Guide

The Admin Portal includes a dedicated **Audit Logs** dashboard accessible from the left sidebar navigation:

![Audit Logs Dashboard Preview](file:///e:/git_repos/college_time_table/public/admin/index.html)

### Features & Controls
1. **Summary Metric Cards:**
   - **Total Buffered Events:** Live count of all active events in the ring buffer.
   - **Auth Events:** Count of sign-ins, logouts, and credential modifications.
   - **Data Modifications:** Count of course, faculty, department, and mapping updates.
   - **Warnings & Alerts:** Highlighted count of failures, clash alerts, or database wipes.
2. **Real-Time Filtering Toolbar:**
   - **Search Input:** Filters in real-time across action code, actor name, description text, and IP address.
   - **Category Dropdown:** Narrow to `AUTH`, `SCHEDULING`, `DATA`, `SYSTEM`, or `SECURITY`.
   - **Status Dropdown:** Filter by `SUCCESS`, `WARNING`, or `FAILURE`.
   - **Disk Usage Badge:** Displays total megabytes consumed by the `logs/` directory and total file count.
3. **Export & Download:**
   - **Download CSV Button:** Generates an immediate RFC-4180 compliant CSV export containing all headers and formatted log rows for offline compliance archiving, external SIEM ingestion, or Excel analysis.
4. **Interactive Audit Table:**
   - Displays Timestamp (localized format), Category badge, Action name, Actor & Role, Full Details, IP Address, and color-coded Status Pill.
   - Bottom pagination controls allow browsing with customizable items-per-page (25, 50, 100).

---

## 7. REST API Reference

All audit log management endpoints are strictly protected by **RBAC** and require an Administrator JWT Bearer token (`requireAdmin`).

### 1. Retrieve Audit Logs
- **Endpoint:** `GET /api/admin/audit-logs`
- **Headers:** `Authorization: Bearer <admin_jwt_token>`
- **Query Parameters:**
  - `limit` *(integer, default: 50)*: Number of records to return.
  - `offset` *(integer, default: 0)*: Pagination offset.
  - `search` *(string)*: Case-insensitive search query.
  - `category` *(string)*: Filter by category (`AUTH`, `SCHEDULING`, `DATA`, `SYSTEM`, `SECURITY`).
  - `status` *(string)*: Filter by status (`SUCCESS`, `WARNING`, `FAILURE`).
- **Response Example (200 OK):**
```json
{
  "success": true,
  "logs": [
    {
      "id": "aud_1793385715975_f84725",
      "timestamp": "2026-10-31T00:15:30.123Z",
      "action": "ADMIN_LOGIN_SUCCESS",
      "category": "AUTH",
      "actor": "admin",
      "role": "ADMIN",
      "ip": "127.0.0.1",
      "status": "SUCCESS",
      "details": "Administrator signed in successfully"
    }
  ],
  "stats": {
    "totalBuffered": 142,
    "matching": 1,
    "authCount": 38,
    "dataCount": 85,
    "schedulingCount": 15,
    "systemCount": 4,
    "warningCount": 2,
    "diskInfo": {
      "totalBytes": 1048576,
      "totalMb": "1.00",
      "activeLogBytes": 1048576,
      "fileCount": 1,
      "maxFileSizeBytes": 5242880,
      "maxArchivedFiles": 10
    }
  },
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1
  }
}
```

### 2. Export / Download Audit Logs
- **Endpoint:** `GET /api/admin/audit-logs/download`
- **Headers:** `Authorization: Bearer <admin_jwt_token>`
- **Query Parameters:**
  - `format` *(string)*: `csv` (default) or `json`.
- **Response Headers:**
  - `Content-Disposition: attachment; filename="audit_logs_YYYY-MM-DD.csv"`
  - `Content-Type: text/csv; charset=utf-8`

### 3. Prune Archived Logs
- **Endpoint:** `POST /api/admin/audit-logs/prune`
- **Headers:** `Authorization: Bearer <admin_jwt_token>`, `Content-Type: application/json`
- **Request Body (Optional):**
```json
{
  "olderThanDays": 30,
  "keepLastCount": 5
}
```
- **Response Example (200 OK):**
```json
{
  "success": true,
  "message": "Pruned 2 archive log file(s). 5 archive file(s) retained.",
  "prunedCount": 2,
  "retainedCount": 5
}
```

---

## 8. Security & Immutability Considerations

1. **Role-Based Access Control (RBAC):** Department coordinators cannot view or query audit logs. Only authenticated users with `role: 'admin'` are authorized.
2. **No Edit/Overwrite Endpoints:** There is no API route that permits editing, altering, or selectively tampering with audit entries.
3. **Fail-Safe Logging:** Disk writing errors are handled asynchronously and gracefully so an audit write failure never crashes the application or blocks user transactions.
4. **Tamper Detection:** All authentication tokens are cryptographically signed with HMAC-SHA256, and all IP addresses are captured directly from network sockets or validated reverse proxy headers.

