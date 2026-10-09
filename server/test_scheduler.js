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

// --- Testing Multi-Teacher Assignment & Availability Distribution ---
console.log("\n--- Testing Multi-Teacher Assignment & Availability Distribution ---");
const multiTeacherDb = {
  periods: ["1", "2", "3", "LB", "4", "5", "6"],
  days: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
  config: { globalLockedPeriods: [] },
  courses: [
    { code: "CS501", name: "Cloud Computing", department: "CSE", semester: "5", courseType: "T", hours: 4, hoursPerWeek: 4 }
  ],
  faculty: [
    { staffId: "F1", name: "Alice", code: "AL", department: "CSE", weeklyLoadLimit: 16, dailyMaxHours: 4 },
    { staffId: "F2", name: "Bob", code: "BO", department: "CSE", weeklyLoadLimit: 16, dailyMaxHours: 4 }
  ],
  teacherUnavailability: {
    "AL": [{ day: "MONDAY", period: "all" }],  // Alice unavailable Monday
    "BO": [{ day: "TUESDAY", period: "all" }]  // Bob unavailable Tuesday
  },
  allocations: {}
};

const multiResult = generateDepartmentSchedule({
  db: multiTeacherDb,
  departmentName: "CSE",
  semester: "5",
  courseFacultyMap: { "CS501": ["AL", "BO"] },
  courseFacultyConfig: { "CS501": { distribute: true } }
});

console.log("Multi-Teacher Run Success:", multiResult.success);
if (multiResult.success && multiResult.allocations["CS501"]) {
  const cAlloc = multiResult.allocations["CS501"];
  const tCounts = { AL: 0, BO: 0 };
  let aliceOnMonday = false;
  let bobOnTuesday = false;

  Object.entries(cAlloc).forEach(([day, periods]) => {
    Object.entries(periods).forEach(([p, facs]) => {
      facs.forEach(f => {
        tCounts[f] = (tCounts[f] || 0) + 1;
        if (f === "AL" && day === "MONDAY") aliceOnMonday = true;
        if (f === "BO" && day === "TUESDAY") bobOnTuesday = true;
      });
    });
  });

  console.log("Multi-Teacher Period Distribution:", tCounts);
  console.log("Alice assigned on Monday:", aliceOnMonday ? "FAILED" : "PASSED (0 slots, respected blackout)");
  console.log("Bob assigned on Tuesday:", bobOnTuesday ? "FAILED" : "PASSED (0 slots, respected blackout)");
  console.log("Fair distribution (both AL & BO have >= 1 slot):", (tCounts.AL > 0 && tCounts.BO > 0) ? "PASSED" : "FAILED");
}

// --- Testing Curriculum Recommendation Priority & Mandatory 1 hr/day Spread ---
console.log("\n--- Testing Recommendation Priority & Mandatory 1 hr/day Spread ---");
const recSpreadDb = {
  periods: ["1", "2", "3", "LB", "4", "5", "6"],
  days: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
  config: { globalLockedPeriods: [] },
  courses: [
    {
      code: "ENG101",
      name: "English Literature",
      department: "HUMANITIES",
      semester: "1",
      courseType: "T",
      hours: 4,
      hoursPerWeek: 4,
      recommendations: {
        "MONDAY": { "1": "T" },
        "TUESDAY": { "2": "T" },
        "WEDNESDAY": { "3": "T" },
        "THURSDAY": { "4": "T" },
        "FRIDAY": {}
      }
    },
    {
      code: "ENG102-P",
      name: "Language Lab",
      department: "HUMANITIES",
      semester: "1",
      courseType: "P",
      hours: 2,
      hoursPerWeek: 2,
      recommendations: {
        "FRIDAY": { "4": "P", "5": "P" }
      }
    }
  ],
  faculty: [
    { staffId: "H1", name: "Prof. Wordsworth", code: "WW", department: "HUMANITIES", weeklyLoadLimit: 16, dailyMaxHours: 4 }
  ],
  teacherUnavailability: {},
  allocations: {}
};

const recSpreadResult = generateDepartmentSchedule({
  db: recSpreadDb,
  departmentName: "HUMANITIES",
  semester: "1",
  courseFacultyMap: { "ENG101": ["WW"], "ENG102-P": ["WW"] }
});

console.log("Recommendation & Spread Run Success:", recSpreadResult.success);
if (recSpreadResult.success) {
  const eng101 = recSpreadResult.allocations["ENG101"];
  let eng101Days = 0;
  let eng101MaxDay = 0;
  let matchesRecCount = 0;

  Object.entries(eng101).forEach(([d, pObj]) => {
    const pKeys = Object.keys(pObj);
    if (pKeys.length > 0) {
      eng101Days++;
      if (pKeys.length > eng101MaxDay) eng101MaxDay = pKeys.length;
      pKeys.forEach(p => {
        if (recSpreadDb.courses[0].recommendations[d] && recSpreadDb.courses[0].recommendations[d][p] === "T") {
          matchesRecCount++;
        }
      });
    }
  });

  console.log("ENG101 Theory Distinct Days (Expected 4):", eng101Days === 4 ? "PASSED (4 distinct days)" : "FAILED (" + eng101Days + ")");
  console.log("ENG101 Max Hours Per Day (Expected 1):", eng101MaxDay === 1 ? "PASSED (Max 1 hr/day)" : "FAILED (" + eng101MaxDay + ")");
  console.log("ENG101 Recommended Slots Matched (Expected 4/4):", matchesRecCount === 4 ? "PASSED (100% matched)" : "FAILED (" + matchesRecCount + "/4)");

  const eng102 = recSpreadResult.allocations["ENG102-P"];
  const friPeriods = Object.keys((eng102 && eng102.FRIDAY) || {});
  const pracMatched = friPeriods.includes("4") && friPeriods.includes("5");
  console.log("ENG102-P Practical Block Placed on Friday P4-P5:", pracMatched ? "PASSED" : "FAILED (" + friPeriods + ")");
}

// -------------------------------------------------------------
// Test Practical Co-Teaching (Simultaneous in same period) & Theory Split
// -------------------------------------------------------------
console.log("\n--- Testing Practical Co-Teaching & Theory Hour Allotment ---");
const coteachDb = {
  periods: ["1", "2", "3", "LB", "4", "5", "6"],
  config: { globalLockedPeriods: [] },
  courses: [
    {
      code: "CSC501-P",
      name: "Cloud Computing & Lab",
      department: "COMPUTER SCIENCE",
      semester: "5",
      courseType: "P",
      hours: 4,
      practicalHours: 2,
      theoryHours: 2,
      practicalTeachers: ["AT", "GH"],
      theoryTeachers: ["AT"],
      theoryTeacherHours: { AT: 2 }
    },
    {
      code: "CSC502-T",
      name: "Software Engineering",
      department: "COMPUTER SCIENCE",
      semester: "5",
      courseType: "T",
      hours: 5,
      teachers: ["AT", "GH"],
      teacherHours: { AT: 3, GH: 2 }
    }
  ],
  faculty: [
    { staffId: "STF1", name: "Dr. Alan Turing", code: "AT", department: "COMPUTER SCIENCE" },
    { staffId: "STF2", name: "Grace Hopper", code: "GH", department: "COMPUTER SCIENCE" }
  ],
  teacherUnavailability: {},
  allocations: {},
  groupMappings: {}
};

const coteachResult = generateDepartmentSchedule({
  db: coteachDb,
  departmentName: "COMPUTER SCIENCE",
  semester: "5",
  courseFacultyConfig: {
    "CSC501-P": {
      courseType: "P",
      practicalHours: 2,
      theoryHours: 2,
      practicalTeachers: ["AT", "GH"],
      theoryTeachers: ["AT"],
      theoryTeacherHours: { AT: 2 }
    },
    "CSC502-T": {
      courseType: "T",
      hours: 5,
      teachers: ["AT", "GH"],
      teacherHours: { AT: 3, GH: 2 },
      distribute: true
    }
  }
});

console.log("Co-teach & Theory Split Run Success:", coteachResult.success);
if (coteachResult.success) {
  const alloc501 = coteachResult.allocations["CSC501-P"];
  let practicalSlotsWithBothTeachers = 0;
  let theorySlotsCount = 0;

  Object.entries(alloc501).forEach(([d, pObj]) => {
    Object.entries(pObj).forEach(([p, facs]) => {
      if (Array.isArray(facs) && facs.length === 2 && facs.includes("AT") && facs.includes("GH")) {
        practicalSlotsWithBothTeachers++;
      } else if (Array.isArray(facs) && facs.length === 1 && facs.includes("AT")) {
        theorySlotsCount++;
      }
    });
  });

  console.log("CSC501-P Practical Slots with Both AT & GH Co-Teaching (Expected 2):", practicalSlotsWithBothTeachers === 2 ? "PASSED (2 co-taught slots)" : "FAILED (" + practicalSlotsWithBothTeachers + ")");
  console.log("CSC501-P Theory Slots with AT (Expected 2):", theorySlotsCount === 2 ? "PASSED (2 theory slots)" : "FAILED (" + theorySlotsCount + ")");

  const alloc502 = coteachResult.allocations["CSC502-T"];
  let at502Hours = 0;
  let gh502Hours = 0;
  Object.entries(alloc502).forEach(([d, pObj]) => {
    Object.entries(pObj).forEach(([p, facs]) => {
      if (Array.isArray(facs)) {
        if (facs.includes("AT")) at502Hours++;
        if (facs.includes("GH")) gh502Hours++;
      }
    });
  });

  console.log("CSC502-T Theory Hour Allotment (Expected AT: 3, GH: 2):", (at502Hours === 3 && gh502Hours === 2) ? `PASSED (AT: ${at502Hours}, GH: ${gh502Hours})` : `FAILED (AT: ${at502Hours}, GH: ${gh502Hours})`);
}

// Test practical co-teaching fallback when only generic teachers array is supplied
const autoPracResult = generateDepartmentSchedule({
  db: coteachDb,
  departmentName: "COMPUTER SCIENCE",
  semester: "5",
  courseFacultyConfig: {
    "CSC501-P": {
      courseType: "P",
      practicalHours: 2,
      theoryHours: 0,
      teachers: ["AT", "GH"], // generic teachers array without explicit practicalTeachers
      distribute: true // should be overridden to false for practicals
    }
  }
});

let autoCoTaught = 0;
if (autoPracResult.success && autoPracResult.allocations["CSC501-P"]) {
  Object.values(autoPracResult.allocations["CSC501-P"]).forEach(pObj => {
    Object.values(pObj).forEach(facs => {
      if (Array.isArray(facs) && facs.includes("AT") && facs.includes("GH")) {
        autoCoTaught += 1;
      }
    });
  });
}
console.log("Practical Generic Teachers Override to Co-Teaching (Expected 2):", autoCoTaught === 2 ? "PASSED (Both teachers in same slot)" : "FAILED (" + autoCoTaught + ")");


