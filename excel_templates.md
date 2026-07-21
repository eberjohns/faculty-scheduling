# Excel Import Formats & Specifications

This document outlines the required structures and headers for the Excel/CSV files accepted by the Central Admin Timetable System. 

> [!NOTE]
> - Since the system searches columns dynamically by their **header names**, the **order of columns does not matter**.
> - Extra columns not specified below are ignored and will not cause errors.
> - Data reading starts from row 1 (the row directly below the header row at row 0).

---

## 1. Course Timetable Excel

This sheet defines the courses, visual types, semesters, programs, and recommended slot assignments.

### Required Columns (Case-Insensitive)

| Column Header | Accepted Alias | Description / Allowed Values |
| :--- | :--- | :--- |
| `Course Code` | `CourseCode` | Unique base code of the course (e.g. `BMM5FS112`). |
| `Course Name` | `CourseName` | Visual title displayed to users (e.g. `Presenting For Camera`). |
| `Type` | - | Visual slot categorization. Allowed values:<br> - `T` or `Theory`<br> - `P` or `Practical`<br> - `M` or `Common` (for slots with no recommended/warning messages). |
| `Group` | - | Numeric group indicator (default `0`). Set to `1`, `2` etc., if the course needs to split batches into groups (e.g. Science, Humanities). |
| `Semester` | `Sem` | Semester digit `1` to `8` (e.g., `5`). If empty, the system tries to extract the first digit found in the `Course Code`. |
| `Program` | `Prog`, `Program Type` | Program level. Allowed values: `UG`, `PG`, or `INT`. Default is `UG`. |
| `Department` | `Dept` | Upper-case code/name of the owning department. If blank, resolves automatically using the course code prefix. |
| **Slot Columns** | E.g. `MON-1`, `TUE-2` | Any header matching `DAY-PERIOD` (e.g., `MON-1`, `MON-2`, `TUE-5` etc.). Mark cells with `T` or `P` to signify recommended slots. |

> [!TIP]
> **Recommended Slots Configuration**: For a row with `Type` = `T`, slot cells matching `T` (e.g. cell value `T` under `MON-1`) will be highlighted as recommended Theory slots. Non-matching values are ignored.

### Sample Structure

| Course Code | Course Name | Type | Group | Semester | Program | Department | MON-1 | MON-2 | TUE-1 | TUE-2 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `ENG5MA101` | English Literature | T | 0 | 5 | UG | English | T | T | | |
| `CSC3CR201` | Database Systems | T | 0 | 3 | UG | Computer Science | | | T | T |
| `CSC3CR201` | Database Systems Lab | P | 0 | 3 | UG | Computer Science | | | P | P |
| `BMM5FS112` | Presenting For Camera | M | 1 | 5 | UG | Media Studies | | | | |

---

## 2. Staff / Faculty Excel

This sheet registers the teachers available for allocation in the system.

### Required Columns (Case-Insensitive)

| Column Header | Description / Allowed Values |
| :--- | :--- |
| `Staff ID` | Unique ID key of the faculty member (e.g. `FAC001`). |
| `Name` | Display name of the faculty member. |
| `Department` | Department name they are affiliated with (must match department list names exactly). |

### Sample Structure

| Staff ID | Name | Department |
| :--- | :--- | :--- |
| `STF1023` | Dr. Eber Johns | COMPUTER SCIENCE |
| `STF1054` | Prof. Mary Smith | CHEMISTRY |

---

## 3. Batch-Department Code Mappings Excel

Maps short department codes (e.g. `CS`, `CH`) to full department names, which is used to automatically generate standard batch codes like `U1CS2024`.

### Required Columns (Case-Insensitive)

- **Code Column**: Header must contain the word `batch` or `code` (e.g., `Batch`, `Code`, or `Batch Code`).
- **Department Name Column**: Header must contain the word `dept`, `department`, or `name` (e.g., `Department`, `Name`, or `Department Name`).

> [!NOTE]
> If these exact keywords are missing, the system will fall back to using **Column 0** as the Code and **Column 1** as the Department Name.

### Sample Structure

| Batch Code | Department Name |
| :--- | :--- |
| `CS` | COMPUTER SCIENCE |
| `CH` | CHEMISTRY |
| `EN` | ENGLISH |

---

## 4. Group Batches Mappings Excel

Used to bulk-import mappings from generated batches to course groups (`Group > 0`).

### Required Columns (Case-Insensitive)

| Column Header | Accepted Alias | Description / Allowed Values |
| :--- | :--- | :--- |
| `Course Code` | `CourseCode`, `Code` | Unique base code of the course (e.g. `BMM5FS112`). |
| `Group` | - | Numeric group indicator (e.g. `1`). |
| `Batches` | `Batch Name`, `Batch`, `Batches` | Semicolon or comma-separated list of batch IDs (e.g., `U1cs2024, U1py2024`). |

### Support for Merged Cells (Visual Layout)
The importer supports visual layout mapping where the `Course Code` and `Group` columns are left blank for subsequent rows representing mapped batches under the same course:

| Course Code | Group | Batch Name |
| :--- | :--- | :--- |
| `BMM5FS112` | 1 | `U1cb2024` |
| | | `U1ec2024` |
| | | `U1mc2024` |
| `BOT5FS112` | 1 | `U1bt2024` |
| | | `U1ec2024` |

---

## 5. Department Timetable Import Excel

Used by department coordinators to bulk-import teacher assignments into timetable slots automatically.

### Structure & Column Headers

The columns are constructed based on the logical database relationships:

| Column Header | Status | Description / Allowed Values |
| :--- | :--- | :--- |
| `Course Code` | **Required** | Unique course ID (e.g. `CSC3CR201` or `CSC3CR201_G1`). |
| `Course Name` | Optional | Visual display name of the course. |
| `Semester` | Optional | Semester digit (1 to 8). |
| `Category` | Optional | Category (e.g. `MAJOR`, `AEC`). |
| **Slot Columns** | **Allocations** | Headers matching `DAY-PERIOD` (e.g. `MON-1`, `MON-2` ... `FRI-6`). Mark cells with teacher visual codes (e.g. `EJ`), Staff IDs (e.g. `STF101`), or teacher names. Multiple teachers can be separated by `/` or `,` (e.g. `EJ / SJ`). |

### Sample Structure

| Course Code | Course Name | Semester | Category | MON-1 | MON-2 | MON-3 | MON-4 | TUE-1 | TUE-2 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `CSC3CR201` | Database Systems | 3 | MAJOR | `EJ` | `EJ` | | | `SJ / MM` | `SJ` |
| `CSC3CR201_P` | Database Systems Lab | 3 | MAJOR | | | `EJ / SJ` | `EJ / SJ` | | |

