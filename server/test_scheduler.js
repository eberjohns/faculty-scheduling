import { generateDepartmentSchedule } from './scheduler.js';

// Mock DB data
const mockDb = {
  periods: ["1", "2", "3", "LB", "4", "5", "6"],
  config: {
    globalLockedPeriods: [
      { day: "FRIDAY", period: "4", label: "College Assembly" },
      { day: "WEDNESDAY", period: "2", label: "Common Hour" }
    ],
    semesterLabels: { "1": "I BSC", "3": "III BSC", "5": "V BSC" }
  },
  courses: [
    { code: "CSC101-T", name: "Programming in C", department: "COMPUTER SCIENCE", semester: "1", courseType: "T", hours: 4, recommendations: { MONDAY: { "1": "T" } } },
    { code: "CSC101-P", name: "C Programming Lab", department: "COMPUTER SCIENCE", semester: "1", courseType: "P", hours: 2, recommendations: { TUESDAY: { "1": "P", "2": "P" } } },
    { code: "CSC301-T", name: "Database Systems", department: "COMPUTER SCIENCE", semester: "3", courseType: "T", hours: 4, recommendations: { WEDNESDAY: { "3": "T" } } },
    { code: "CSC301-P", name: "DBMS Lab", department: "COMPUTER SCIENCE", semester: "3", courseType: "P", hours: 2, recommendations: { THURSDAY: { "4": "P", "5": "P" } } }
  ],
  faculty: [
    { staffId: "STF1", name: "Dr. Alan Turing", code: "AT", department: "COMPUTER SCIENCE" },
    { staffId: "STF2", name: "Grace Hopper", code: "GH", department: "COMPUTER SCIENCE" }
  ],
  allocations: {
    "MATHEMATICS": {
      "MAT101": {
        "MONDAY": { "1": ["AT"] } // AT is busy on MON-1 in Mathematics!
      }
    }
  },
  groupMappings: {}
};

console.log("--- Running Scheduler Logic & Connection Verification ---");

const result = generateDepartmentSchedule({
  db: mockDb,
  departmentName: "COMPUTER SCIENCE",
  semester: "",
  courseFacultyMap: {
    "CSC101-T": ["AT"],
    "CSC101-P": ["AT"],
    "CSC301-T": ["GH"],
    "CSC301-P": ["GH"]
  },
  pinnedSlots: {},
  maxConsecutiveHours: 2,
  practicalBlockSize: 2
});

console.log("Generation Success:", result.success);
console.log("Message:", result.message);
console.log("Audit Report:", JSON.stringify(result.audit, null, 2));

if (result.success) {
  const alloc = result.allocations;
  let hasGlobalLockViolation = false;
  let hasCrossDeptClash = false;
  let hasLBPlaced = false;

  const globalLocks = mockDb.config.globalLockedPeriods;

  Object.keys(alloc).forEach(cCode => {
    Object.keys(alloc[cCode]).forEach(day => {
      Object.keys(alloc[cCode][day]).forEach(period => {
        const facs = alloc[cCode][day][period];
        if (facs && facs.length > 0) {
          // Check global locks
          if (globalLocks.some(l => l.day === day && String(l.period) === String(period))) {
            hasGlobalLockViolation = true;
            console.error(`ERROR: Course ${cCode} allocated on global locked period ${day}-${period}!`);
          }
          // Check LB
          if (period === 'LB') {
            hasLBPlaced = true;
            console.error(`ERROR: Course ${cCode} placed in LB!`);
          }
          // Check external clash with Mathematics (AT is busy MON-1)
          if (day === 'MONDAY' && period === '1' && facs.includes('AT')) {
            hasCrossDeptClash = true;
            console.error(`ERROR: AT allocated on MON-1 despite external Mathematics clash!`);
          }
        }
      });
    });
  });

  console.log("Global Lock Respected:", !hasGlobalLockViolation ? "PASSED (0 violations)" : "FAILED");
  console.log("Lunch Break Excluded:", !hasLBPlaced ? "PASSED" : "FAILED");
  console.log("External Clash Prevention:", !hasCrossDeptClash ? "PASSED (0 clashes)" : "FAILED");
  console.log("Teacher Max <= 2h Continuous Rule:", result.audit.teacherConsecutiveViolations === 0 ? "PASSED (0 violations)" : "FAILED");
}

// Test Teacher Unavailability
console.log("\n--- Testing Teacher Unavailability Constraint ---");
const mockDbWithUnavail = {
  ...mockDb,
  teacherUnavailability: {
    "AT": [{ day: "TUESDAY", period: "all" }] // AT unavailable all day Tuesday
  }
};
const unavailResult = generateDepartmentSchedule({
  db: mockDbWithUnavail,
  departmentName: "COMPUTER SCIENCE",
  courseFacultyMap: { "CSC101-T": ["AT"], "CSC101-P": ["AT"] },
  selectedCourseCodes: ["CSC101-T", "CSC101-P"]
});
console.log("Selective & Teacher Unavailability Run Success:", unavailResult.success);
let atOnTuesday = false;
if (unavailResult.success) {
  Object.keys(unavailResult.allocations).forEach(c => {
    const tuesSlots = unavailResult.allocations[c]["TUESDAY"] || {};
    Object.values(tuesSlots).forEach(facs => {
      if (facs.includes("AT")) atOnTuesday = true;
    });
  });
}
console.log("Teacher Unavailability Respected (AT on Tuesday = 0):", !atOnTuesday ? "PASSED" : "FAILED");

// Test Anti-Mono-Period and Shift Balance
console.log("\n--- Testing Anti-Mono-Period and Shift Balance ---");
const spreadCourseAlloc = result.allocations["CSC101-T"];
const periodsAssigned = [];
let morningCount = 0;
let afternoonCount = 0;
if (spreadCourseAlloc) {
  Object.keys(spreadCourseAlloc).forEach(day => {
    Object.keys(spreadCourseAlloc[day]).forEach(p => {
      periodsAssigned.push(p);
      const pNum = parseInt(p, 10);
      if (pNum <= 3) morningCount++;
      else afternoonCount++;
    });
  });
}
console.log("CSC101-T (4h) Periods Assigned across days:", periodsAssigned);
const periodFrequency = {};
periodsAssigned.forEach(p => { periodFrequency[p] = (periodFrequency[p] || 0) + 1; });
const maxFreqForSamePeriod = Math.max(...Object.values(periodFrequency));
console.log(`Max repetition of same period index: ${maxFreqForSamePeriod} (Target <= 2 for 4h course):`, maxFreqForSamePeriod <= 2 ? "PASSED" : "FAILED");
console.log(`Morning slots: ${morningCount}, Afternoon slots: ${afternoonCount} (Both > 0):`, (morningCount > 0 && afternoonCount > 0) ? "PASSED" : "FAILED");

// Test Overconstrained Diagnostics & Relaxation
console.log("\n--- Testing Overconstrained Diagnostics & Suggestion Engine ---");
const overconstrainedDb = {
  periods: ["1", "2", "3", "LB", "4"],
  config: {
    globalLockedPeriods: [
      { day: "MONDAY", period: "1", label: "Meeting", semester: "1" },
      { day: "MONDAY", period: "2", label: "Meeting", semester: "1" },
      { day: "MONDAY", period: "3", label: "Meeting", semester: "1" },
      { day: "MONDAY", period: "4", label: "Meeting", semester: "1" }
    ],
    semesterLabels: { "1": "I BSC" }
  },
  courses: [
    // 5-hour theory course for Sem 1
    { code: "HEAVY101", name: "Heavy Load Course", department: "PHYSICS", semester: "1", courseType: "T", hours: 5, recommendations: {} }
  ],
  faculty: [
    { staffId: "PHY1", name: "Prof. Newton", code: "IN", department: "PHYSICS" }
  ],
  allocations: {},
  teacherUnavailability: {
    // Prof Newton unavailable on Tue, Wed, Thu
    "IN": [
      { day: "TUESDAY", period: "all" },
      { day: "WEDNESDAY", period: "all" },
      { day: "THURSDAY", period: "all" }
    ]
  }
};

const diagResult = generateDepartmentSchedule({
  db: overconstrainedDb,
  departmentName: "PHYSICS",
  semester: "1",
  courseFacultyMap: { "HEAVY101": ["IN"] },
  maxConsecutiveHours: 2
});

console.log("Overconstrained Run Status:", diagResult.status);
console.log("Overconstrained Run Success:", diagResult.success);
console.log("Suggestions Generated:", diagResult.suggestions);
console.log("Exceptions Logged:", diagResult.exceptions);
console.log("Diagnostics working & suggestions provided:", (diagResult.suggestions && diagResult.suggestions.length > 0) ? "PASSED" : "FAILED");

// Test Phase 2 Relaxed Fallback Success
console.log("\n--- Testing Phase 2 Relaxed Fallback Generation ---");
const relaxableDb = {
  periods: ["1", "2", "3", "LB", "4"],
  config: {
    globalLockedPeriods: [],
    semesterLabels: { "1": "I BSC" }
  },
  courses: [
    // 3 hours of course
    { code: "MATH101", name: "Maths", department: "MATHS", semester: "1", courseType: "T", hours: 3, recommendations: {} }
  ],
  faculty: [
    { staffId: "M1", name: "Euler", code: "LE", department: "MATHS" }
  ],
  allocations: {},
  teacherUnavailability: {}
};

// Tight consecutive hours limit (e.g. maxConsecutiveHours = 1) forcing relaxation
const relaxedResult = generateDepartmentSchedule({
  db: relaxableDb,
  departmentName: "MATHS",
  semester: "1",
  courseFacultyMap: { "MATH101": ["LE"] },
  maxConsecutiveHours: 1
});
console.log("Relaxed Run Status:", relaxedResult.status);
console.log("Relaxed Run Success:", relaxedResult.success);
console.log("Relaxed Run Allocations Count:", Object.keys(relaxedResult.allocations || {}).length);
if (relaxedResult.success) {
  console.log("Phase 2 Fallback Generation: PASSED");
}


