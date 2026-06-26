# College Timetable Faculty Allocation System

A secure, high-contrast, interactive web application built with Express and Vanilla JavaScript. It enables college administrators and department coordinators to allocate faculty to recommended timetable slots, customize visual initials codes, prevent double bookings, and track workload metrics.

---

## Key Features

### 1. Database & Security Controls
* **Eyeball Passcode Toggles**: Coordinator passwords in the Admin panel are masked. Administrator verification is requested on first click to unlock password visibility for the session.
* **Edit Locks**: Once a department coordinator submits their timetable draft, editing is locked. Any save or detail update requests are rejected with `403 Forbidden` to prevent unintended updates.
* **Revert Submission**: Coordinators can revert a pending submission back to `Draft` to unlock allocations.
* **Admin Verification Reset**: A "Danger Zone" in the Admin panel allows clearing all timetables, courses, faculty, and submissions after typing `CLEAR` to verify intent.

### 2. Configurable Batch Generation
* **Academic Config Blocks**: Admin defines program types (e.g. `U -> UG`), funding types (e.g. `1 -> Aided`), and cohort year-to-semester mappings.
* **Automatic Generation**: All batch codes are generated dynamically as `{ProgramCode}{FundingCode}{DeptCode}{Year}` (e.g. `U1CS2024`) by cross-referencing department codes.

### 3. Group Mapping, Hover Tooltips & Custom Columns
* **Group Mappings**: Connect batches to course groups (courses with `Group > 0`). 
* **Smart Filter Defaults**: Opening the batch selection modal automatically pre-fills the program level, admission year (derived from the course's semester), and sets funding to Aided (`1`).
* **Enhanced Searches**: Searching inside the batch modal matches on batch ID, department code (`CS`), or full name (`Computer Science`).
* **Visual Representation**: Mapped batches are shown as hover `title` tooltips on `G` badges in Week View, and in a dedicated **Batches** column in Single Day View.
* **Import/Export Mappings**: Export courses needing batches to CSV, and bulk upload mappings. The parser supports merged cells/rows (Course Code and Group left blank for subsequent rows representing batches).

### 4. Advanced Course Timetable Excel Import
* **Semester & Program Columns**: Extracts semesters and program types (`UG`, `PG`, `INT`) directly from the Excel columns by header name, falling back to course code parsing for semesters if columns are missing.
* **Course Type 'M' (Common Slot)**: Supports Mentor/Meeting courses. These are styled in a soft purple legend color and automatically bypass the "non-recommended slot" unlock confirmation warning dialog when clicked in the allocation matrix.

### 5. Print Preview & Formatting
* **Print Preview Formatting**: Supports Short, Medium, and Full printable formats. Features high-contrast color key indicators for theory/practical/common slots, tooltips revealing full names on hover, and custom legends.

---

## Project Structure

```text
├── public/                     # Frontend client assets
│   ├── admin.html              # Central Admin Dashboard
│   ├── index.html              # Coordinator Portal
│   ├── styles.css              # Custom Vanilla CSS Stylesheet
│   └── js/
│       ├── admin.js            # Admin client controllers & modals
│       └── app.js              # Coordinator client controllers
├── server/                     # Backend server code
│   ├── data/
│   │   └── db.json             # Local JSON Database
│   ├── db.js                   # JSON file database reads/writes with rotating backups
│   ├── seed.js                 # Seed generator scripts
│   ├── server.js               # Express application controller & API router
│   └── test.js                 # Automated API integration tests
├── templates/                  # Excel Template Models for client use
│   ├── course_timetable_template.xlsx
│   ├── staff_template.xlsx
│   ├── batch_dept_mappings_template.xlsx
│   └── group_batches_mappings_template.xlsx
├── package.json                # Project dependencies and script runner configurations
└── README.md                   # Project documentation
```

---

## Installation & Setup

### Prerequisites
* **Node.js** (v18.0.0 or higher is recommended)
* **npm** (comes bundled with Node.js)

### 1. Install Dependencies
In the root directory of the project, run:
```bash
npm install
```

### 2. Running the Application
You can run the application in development mode (with nodemon reloading) or in production:

* **Development mode** (reloads automatically on code modifications):
  ```bash
  npm run dev
  ```

* **Standard Start**:
  ```bash
  npm start
  ```

The server will bind and be accessible at:
* **Department Portal**: [http://localhost:5000](http://localhost:5000)
* **Admin Portal**: [http://localhost:5000/admin.html](http://localhost:5000/admin.html)

---

## Workflows

### Admin Workflow
1. Access the Admin portal at [http://localhost:5000/admin.html](http://localhost:5000/admin.html).
2. Sign in using the admin password (default password: `admin`).
3. Set up Department Codes under the **Batch-Dept Mappings** tab, and Program, Funding, and Year parameters.
4. Upload the **Course Structure Excel** and **Staff Directory Excel** under the **Import Excel Data** tab.
5. Establish passcode credentials for each department coordinator under the **Coordinator Passwords** tab.
6. Manage group assignments under the **Group Mappings** tab, or export/import mappings in bulk.
7. Review Submitted schedules under the **Status Dashboard**. You can approve them, revert them, or return them for changes with custom review feedback instructions.

### Department Coordinator Workflow
1. Access the Department portal at [http://localhost:5000](http://localhost:5000).
2. Select your department name and type the passcode managed by the administrator to sign in.
3. Allocate faculty members to recommended theory (`T`), practical (`P`), and common (`M`) slots by clicking on grid cells.
4. Make adjustment edits to visual aliases or visual initials codes in the editors below the grid.
5. Click **View & Print Table** to inspect, print, or export CSV grids.
6. Click **Submit Timetable** to send your draft timetable to the admin.
