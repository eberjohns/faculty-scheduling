# Data Import, Merging, & Deleting Guide

This document outlines how the timetable system merges imported files, checks for duplicate/new records using primary keys, handles slot changes, and allows deleting records.

---

## 1. Primary Keys & Merge (Upsert) Behavior

When you upload Excel files, the system **does not wipe your existing database**. Instead, it performs a **merge (upsert)** based on primary keys:

### Courses & Timetables
- **Primary Key**: `Course Code` (e.g. `ENG5MA101` or `ENG5MA101_G1`).
- **If Key Exists**: The course details (Name, Department, Semester, Program Type, Recommended slots) are updated with the Excel values. Coordinators' manually edited **Visual Aliases are preserved**.
- **If Key is New**: The course is appended to the system database.
- **Old Data Persistence**: Any courses already in the database that are **not** present in the newly uploaded Excel file **will persist** and will **not** be deleted.

### Staff / Faculty Directories
- **Primary Key**: `Staff ID` (e.g. `STF101`).
- **If Key Exists**: The teacher's Name and Department are updated. Their unique **Visual Initials Code is preserved** so that existing slot allocations are not disrupted.
- **If Key is New**: The teacher is added to the system and a new unique visual initials code is automatically generated.
- **Old Data Persistence**: Any staff members already in the database that are **not** present in the new Excel **will persist**.

---

## 2. Recommended Slot Updates & Assignments

If you change the recommended slots in the Excel sheet (e.g. MON-1 was recommended, but is now cleared, and MON-2 is set to recommended):
- **Color Change**: The grid cells update their color representation (MON-1 will turn gray; MON-2 will turn green/yellow).
- **Existing Assignments**: If a teacher was already assigned to MON-1, **their assignment is preserved** and is still shown in the MON-1 slot, despite it changing to a gray (non-recommended) color. No allocations are automatically wiped.

---

## 3. Deleting Records (Inspect Records Tab)

To remove courses or staff members permanently, administrators can use the **Delete** buttons inside the **Inspect Academic Records** tab:

### Deleting a Course
- Clicking **Delete** on a course will:
  1. Remove the course from the catalog.
  2. Permanently delete all slot allocations associated with that course code.
  3. Clear any mapped batches for that course group.

### Deleting a Faculty Member
- Clicking **Delete** on a staff record will:
  1. Remove the teacher from the faculty directory.
  2. **Automatically scrub** their initials code from all allocated timetable slots across all departments, keeping the timetables clean and preventing ghost entries.

---

## 4. Import Reports

Upon a successful upload, the system will output a detailed report in the top alert banner showing:
- How many records were **added as new**.
- How many records were **updated**.
- The **total count** of records now in the database.
