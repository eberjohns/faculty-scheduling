# College Timetable Faculty Allocation System

A secure, high-contrast, interactive web application built with Express and Vanilla JavaScript. It enables college administrators and department coordinators to allocate faculty to recommended timetable slots, customize visual initials codes, prevent double bookings, and track workload metrics.

---

## Key Features

### 1. Database & Security Controls
* **Eyeball Passcode Toggles**: Coordinator passwords in the Admin panel are masked. Administrator verification is requested on first click to unlock password visibility for the session.
* **Edit Locks**: Once a department coordinator submits their timetable draft, editing is locked. Any backend save or detail update requests are rejected with `403 Forbidden` to prevent unintended updates.
* **Revert Submission**: Co-ordinators can revert a pending submission back to `Draft` to unlock allocations.
* **Admin Verification Reset**: A "Danger Zone" in the Admin panel allows clearing all timetables, courses, faculty, and submissions after typing `CLEAR` to verify intent.

### 2. Timetable Generation & Course Consolidation
* **Consolidated Imports**: Course Excel row inputs mapping the same code across multiple rows (e.g. theory and practical splits) are aggregated automatically during Excel uploads and merged on startup.
* **Validation and Warnings**: Prevents double-booking clashes in real-time. Highlights missing recommended slots prior to submission to avoid scheduling gaps.
* **Format Print Formats**: Supports Short, Medium, and Full printable formats. Features high-contrast color key indicators for theory/practical slots, tooltips revealing full names on hover, and custom legends.

### 3. Dynamic Interactive Matrix
* **Day & Week Views**: Switch between day-by-day views and a week-by-week grid matrix.
* **Unrecommended Slot Unlock**: Unrecommended slots are visually muted. Coordinators must confirm intent to unlock and assign them.
* **Autosave**: Debounced background autosave updates the database 5 seconds after any layout changes.
* **Course and Faculty Editors**: Allow modifying course visual aliases and unique visual initials codes for faculty, ensuring names are displayed cleanly.

### 4. Workload Tracker & Reporting
* **Live trackers**: Live dashboard pills in the coordinator portal show accumulated hours.
* **Global Reports**: Administrators can inspect course allocations and export global faculty workload reports to CSV.

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
├── staff.xlsx                  # Sample staff directories
├── course_layout.xlsx    # Sample course layout structures
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
3. Upload the **Course Structure Excel** and **Staff Directory Excel** under the **Import Excel Data** tab.
4. Establish passcode credentials for each department coordinator under the **Coordinator Passwords** tab.
5. Review Submitted schedules under the **Status Dashboard**. You can approve them, revert them, or return them for changes with custom review feedback instructions.

### Department Coordinator Workflow
1. Access the Department portal at [http://localhost:5000](http://localhost:5000).
2. Select your department name and type the passcode managed by the administrator to sign in.
3. Allocate faculty members to the recommended theory (`T`) and practical (`P`) slots by clicking on grid cells.
4. Make adjustment edits to visual aliases or visual initials codes in the editors below the grid.
5. Click **View & Print Table** to inspect, print, or export CSV grids.
6. Click **Submit Timetable** to send your draft timetable to the admin.
