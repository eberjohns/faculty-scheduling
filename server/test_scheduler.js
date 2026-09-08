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
