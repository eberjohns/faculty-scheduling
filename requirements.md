I want you to act as a senior software architect and product designer.

Do not start coding immediately.

First, analyze the requirements, identify ambiguities, suggest improvements, point out potential issues in data modelling, workflows, UI/UX, permissions, validation rules, scalability, and maintainability, and then produce a complete implementation plan and system design.

Challenge assumptions where appropriate and recommend better approaches if they improve usability or maintainability.

---

# Project Goal

Build a web-based College Timetable Faculty Allocation System.

The purpose is to replace the current manual process of assigning faculty to courses and generating departmental timetables.

The system should allow a central administrator to upload course structure data and faculty data, after which departments can allocate faculty to courses and timetable slots through a simple interface.

The final output should be printable departmental timetables matching the existing college timetable format as closely as possible.

---

# Existing Inputs

## Course Structure Excel

Contains information such as:

* Department
* Course Code
* Course Name
* Semester
* Category / Title

  * Major
  * Minor
  * AEC
  * MDC
  * SEC
  * Elective
  * Any future category
* Timetable allocation markers

  * T (Theory)
  * P (Practical)

Fields such as:

* Room Number
* Batch
* Pathway

can be ignored for now.

The T/P markers indicate recommended timetable slots.

These recommendations should remain visible throughout the allocation process.

Departments may still assign faculty outside those slots if required.

---

## Staff Excel

Contains:

* Faculty Name
* Department

Faculty belong to only one department.

Cross-department teaching is not supported.

---

# User Roles

## Admin

Password protected.

Responsibilities:

* Upload course data
* Upload faculty data
* Edit imported data
* Configure academic year
* Configure semester labels
* Configure course aliases
* Configure faculty codes
* View all departments
* Review department submissions
* Generate final outputs
* View workload summaries

---

## Department User

No password required.

User selects department from a list and enters.

Department users can:

* View only their department's courses
* Assign faculty
* Save drafts
* Submit completed timetable

---

# Faculty Assignment Rules

A course may have:

* One faculty
* Multiple faculty

A practical may have:

* One faculty
* Multiple faculty

The same faculty must never be assigned to two different courses in the same day and period.

This should be enforced as a hard validation rule.

Not merely a warning.

---

# Assignment Workflow

The department interface should be compact and easy to use.

Instead of a large timetable grid, show one weekday at a time.

Example:

MON | TUE | WED | THU | FRI

For the selected day:

Course Code | Course Name | P1 | P2 | P3 | P4 | P5 | P6

Each course appears as a row.

Recommended slots remain highlighted.

Non-recommended slots are greyed out but still editable after confirmation.

---

# Auto Fill Behaviour

If a faculty member is assigned to a theory slot of a course, the system should offer:

"Apply this faculty assignment to all theory slots of this course?"

Similarly for practical slots.

Departments should still be able to override individual slots later.

---

# Faculty Codes

Automatically generate short faculty codes from names.

Examples:

Susan Joseph → SJ

John Paul → JP

Allow manual editing.

Prevent duplicates.

---

# Course Aliases

Course codes are fixed and cannot be edited.

However, courses should support human-friendly aliases.

Examples:

Object Oriented Programming → OOPS

Data Structures → DS

Computer Fundamentals → CF

Aliases will be used in timetable displays and PDFs.

---

# Academic Configuration

Admin should define:

* Academic Year
* Semester Type

  * Odd
  * Even

Default mappings should exist:

Odd:

S1 → I BSC
S3 → III BSC
S5 → V BSC

Even:

S2 → II BSC
S4 → IV BSC
S6 → VI BSC

These labels should be editable.

The system must not hardcode these mappings.

---

# Timetable Validation

Before submission:

Check:

* Faculty clashes
* Missing assignments
* Invalid data references

Provide a validation report.

Departments should be able to save drafts with incomplete assignments.

Final submission should perform full validation.

Admin may override if necessary.

---

# Department Workflow

Department timetable lifecycle:

Draft

→ Submitted

→ Approved

or

→ Returned for Changes

---

# Workload Calculations

Automatically generate workload summaries.

Examples:

Faculty Summary

Susan Joseph

* CJ101 Theory = 5
* CJ102 Practical = 4
* CJ201 Theory = 3

Total = 12

Department-level summaries should also exist.

---

# Search Features

Support searching:

By Faculty

Return all assigned slots.

By Course

Return all assigned slots.

---

# Output Requirements

Generate departmental timetables matching the current college format as closely as possible.

Support:

1. Short Mode

SJ OOPS

2. Medium Mode

SJ - OOPS

3. Full Mode

Susan Joseph
Object Oriented Programming

Practical and theory sessions should be visually distinguishable.

Include legends where appropriate.

Support:

* Printable PDF
* Spreadsheet export

---

# Administrative Dashboard

Show:

* Academic Year
* Semester Type
* Department Status
* Completion Status
* Submission Status
* Workload Overview

Example:

Computer Science ✓

Mathematics ✓

Physics ⚠ Incomplete

---

# Data Management

Admin should be able to edit imported course and faculty data after upload.

The system should validate imports and show warnings before committing data.

Examples:

* Duplicate faculty codes
* Missing departments
* Invalid semester references
* Duplicate courses

---

# Design Expectations

Before proposing implementation:

1. Analyze the domain model.
2. Identify missing requirements.
3. Identify edge cases.
4. Recommend improvements.
5. Propose database schema.
6. Propose API structure.
7. Propose UI architecture.
8. Propose workflow diagrams.
9. Propose validation strategy.
10. Propose PDF generation strategy.
11. Propose future extensibility options.

Only after completing analysis and planning should implementation begin.

Treat this as a production-grade college administration system and produce a comprehensive architecture and implementation plan before generating code.
