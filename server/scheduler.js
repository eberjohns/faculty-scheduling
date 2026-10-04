/**
 * Constraint Satisfaction Problem (CSP) Timetable Generator Engine
 * 
 * Features:
 * - Admin Global Common Locked Periods Enforcement (with Semester Scoping)
 * - Contiguous Practical (P) Sessions (no splitting across lunch breaks or intervals)
 * - Faculty Max Continuous Teaching Rule (<= 2 consecutive hours without rest)
 * - Zero Cross-Department & Same-Department Faculty Clashes
 * - Zero Student Batch Cohort Clashes
 * - Morning & Afternoon/Evening Shift Distribution (Balanced dispersion, no all-morning / all-evening bias)
 * - Anti-Mono-Period Scheduling (prevents subject from occupying the exact same period index every day)
 * - Teacher Unavailability / Blackout Days & Periods Enforcement
 * - Selective Subject Scheduling (schedule individual subjects or all)
 * - Deep Constraint Failure Diagnostics & Intelligent Suggestions Generator
 * - Relaxed Fallback Solver with Explicit Exception Logging
 */

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

/**
 * Split period labels into contiguous blocks divided by lunch break ('LB')
 */
export function getPeriodBlocks(periodsList) {
  const blocks = [];
  let currentBlock = [];
  
  periodsList.forEach(p => {
    const pStr = String(p).trim();
    if (pStr.toUpperCase() === 'LB') {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
    } else {
      currentBlock.push(pStr);
    }
  });
  
  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }
  return blocks;
}

/**
 * Generate valid contiguous period segments within blocks
 * e.g. for length 2 in block ['1','2','3'] -> [['1','2'], ['2','3']]
 */
export function getContiguousSlots(blocks, duration = 1) {
  const slots = [];
  blocks.forEach(block => {
    for (let i = 0; i <= block.length - duration; i++) {
      slots.push(block.slice(i, i + duration));
    }
  });
  return slots;
}

/**
 * Check if a teacher's schedule on a given day exceeds max consecutive hours
 */
function checkMaxConsecutiveViolation(currentPeriodsOnDay, newPeriods, allPeriodsOrdered, maxConsecutive = 2) {
  const combined = Array.from(new Set([...currentPeriodsOnDay, ...newPeriods]));
  
  const indices = combined
    .map(p => allPeriodsOrdered.indexOf(p))
    .filter(idx => idx !== -1)
    .sort((a, b) => a - b);
  
  let currentRun = 0;
  for (let i = 0; i < indices.length; i++) {
    if (i === 0) {
      currentRun = 1;
    } else if (indices[i] === indices[i - 1] + 1) {
      currentRun++;
    } else {
      currentRun = 1;
    }
    
    if (currentRun > maxConsecutive) {
      return true; // Violation
    }
  }
  
  return false;
}

/**
 * Determine if a period belongs to the Morning or Afternoon/Evening shift
 */
function getPeriodShift(period, periodBlocks) {
  if (periodBlocks.length > 0 && periodBlocks[0].includes(String(period))) {
    return 'MORNING';
  }
  return 'AFTERNOON';
}

/**
 * Main Generator Function
 */
export function generateDepartmentSchedule({
  db,
  departmentName,
  semester = '',
  selectedCourseCodes = [],
  courseFacultyMap = {},
  courseFacultyConfig = {},
  pinnedSlots = {},
  maxConsecutiveHours = 2,
  practicalBlockSize = 2,
  allowRelaxedFallback = false,
  forceRelaxed = false
}) {
  const deptUpper = departmentName.toUpperCase();
  const rawPeriods = db.periods || ['1', '2', '3', 'LB', '4', '5', '6'];
  const allRealPeriods = rawPeriods.filter(p => String(p).toUpperCase() !== 'LB');
  const periodBlocks = getPeriodBlocks(rawPeriods);
  const globalLocks = db.config.globalLockedPeriods || [];
  const teacherUnavail = db.teacherUnavailability || {};

  // 1. Filter department courses
  let deptCourses = (db.courses || []).filter(c => c.department.toUpperCase() === deptUpper);
  if (semester && semester !== 'all') {
    deptCourses = deptCourses.filter(c => String(c.semester).trim() === String(semester).trim());
  }

  // Selective courses filter
  const isSelective = Array.isArray(selectedCourseCodes) && selectedCourseCodes.length > 0;
  let targetCourses = deptCourses;
  if (isSelective) {
    const selectedSet = new Set(selectedCourseCodes.map(code => code.trim().toUpperCase()));
    targetCourses = deptCourses.filter(c => {
      const base = c.code.replace(/-(T|P)$/, '').replace(/_G\d+$/, '');
      return selectedSet.has(c.code.toUpperCase()) || selectedSet.has(base.toUpperCase());
    });
  }

  if (targetCourses.length === 0) {
    return {
      success: false,
      message: `No eligible courses found for department '${departmentName}'` + 
               (semester ? ` in semester ${semester}` : '') + 
               (isSelective ? ` matching the selected ${selectedCourseCodes.length} subject(s).` : '.')
    };
  }

  const deptFaculty = (db.faculty || []).filter(f => f.department.toUpperCase() === deptUpper);

  // 2. Build External Global Teacher Usage (Allocations in other departments)
  const externalFacultyUsage = {};
  WEEKDAYS.forEach(day => {
    externalFacultyUsage[day] = {};
    allRealPeriods.forEach(p => {
      externalFacultyUsage[day][p] = new Set();
    });
  });

  Object.keys(db.allocations || {}).forEach(otherDept => {
    if (otherDept.toUpperCase() === deptUpper) return; // skip own dept
    const otherAlloc = db.allocations[otherDept] || {};
    Object.keys(otherAlloc).forEach(cCode => {
      const cDays = otherAlloc[cCode] || {};
      Object.keys(cDays).forEach(day => {
        if (!externalFacultyUsage[day]) return;
        Object.keys(cDays[day]).forEach(period => {
          if (!externalFacultyUsage[day][period]) return;
          const facs = cDays[day][period] || [];
          facs.forEach(f => externalFacultyUsage[day][period].add(f));
        });
      });
    });
  });

  // 3. Resolve course-to-faculty bindings
  const resolvedFacultyBindings = {};
  let facultyWorkloadIndex = 0;

  targetCourses.forEach(c => {
    let facList = [];
    let isDistribute = true;

    if (courseFacultyConfig[c.code] && Array.isArray(courseFacultyConfig[c.code].teachers)) {
      facList = courseFacultyConfig[c.code].teachers.filter(Boolean);
      isDistribute = courseFacultyConfig[c.code].distribute !== false;
    } else if (courseFacultyMap[c.code] && Array.isArray(courseFacultyMap[c.code])) {
      facList = courseFacultyMap[c.code].filter(Boolean);
      isDistribute = (facList.length > 1);
    } else if (courseFacultyMap[c.code] && typeof courseFacultyMap[c.code] === 'string' && courseFacultyMap[c.code].trim()) {
      facList = [courseFacultyMap[c.code].trim()];
      isDistribute = false;
    }

    if (facList.length > 0) {
      resolvedFacultyBindings[c.code] = {
        teachers: facList,
        distribute: isDistribute && facList.length > 1
      };
      return;
    }

    // Check existing allocation
    const existingAlloc = (db.allocations[deptUpper] && db.allocations[deptUpper][c.code]) || {};
    const foundCodes = new Set();
    Object.values(existingAlloc).forEach(dayObj => {
      Object.values(dayObj).forEach(facArr => {
        if (Array.isArray(facArr)) facArr.forEach(fc => foundCodes.add(fc));
      });
    });

    if (foundCodes.size > 0) {
      const existingList = Array.from(foundCodes);
      resolvedFacultyBindings[c.code] = {
        teachers: existingList,
        distribute: existingList.length > 1
      };
    } else if (deptFaculty.length > 0) {
      // Round-robin distribution
      const assignedFac = deptFaculty[facultyWorkloadIndex % deptFaculty.length];
      resolvedFacultyBindings[c.code] = {
        teachers: [assignedFac.code],
        distribute: false
      };
      facultyWorkloadIndex++;
    } else {
      resolvedFacultyBindings[c.code] = {
        teachers: [],
        distribute: false
      };
    }
  });

  // 4. Decompose courses into Lesson Cards
  const cards = [];
  const courseTotalHours = {};

  targetCourses.forEach(course => {
    const courseCode = course.code;
    const isPractical = (course.courseType === 'P' || (course.code && course.code.endsWith('-P')));
    const binding = resolvedFacultyBindings[courseCode] || { teachers: [], distribute: false };
    const assignedFacs = binding.teachers || [];
    const isDistributed = binding.distribute && assignedFacs.length > 1;
    const mappedBatches = (db.groupMappings && db.groupMappings[courseCode]) || [];
    
    // Determine needed weekly hours
    let neededHours = parseInt(course.hours) || 0;
    if (neededHours <= 0) {
      if (course.recommendations) {
        let count = 0;
        WEEKDAYS.forEach(d => {
          count += Object.keys(course.recommendations[d] || {}).length;
        });
        neededHours = count > 0 ? count : (isPractical ? 2 : 4);
      } else {
        neededHours = isPractical ? 2 : 4;
      }
    }

    // Deduct pinned slots if any
    let pinnedCount = 0;
    const coursePinned = pinnedSlots[courseCode] || {};
    WEEKDAYS.forEach(d => {
      if (coursePinned[d]) {
        pinnedCount += Object.keys(coursePinned[d]).length;
      }
    });

    let remainingHours = Math.max(0, neededHours - pinnedCount);
    courseTotalHours[courseCode] = neededHours;

    if (isPractical) {
      const blockSize = Math.min(practicalBlockSize, Math.max(1, remainingHours));
      while (remainingHours > 0) {
        const curDuration = Math.min(blockSize, remainingHours);
        cards.push({
          id: `${courseCode}_P_${cards.length}`,
          courseCode,
          courseName: course.name,
          alias: course.alias,
          type: 'P',
          duration: curDuration,
          semester: course.semester,
          assignedFaculty: assignedFacs,
          isDistributed,
          facultyPool: assignedFacs,
          batches: mappedBatches,
          recommendations: course.recommendations || {}
        });
        remainingHours -= curDuration;
      }
    } else {
      while (remainingHours > 0) {
        cards.push({
          id: `${courseCode}_T_${cards.length}`,
          courseCode,
          courseName: course.name,
          alias: course.alias,
          type: course.courseType === 'M' ? 'M' : 'T',
          duration: 1,
          semester: course.semester,
          assignedFaculty: assignedFacs,
          isDistributed,
          facultyPool: assignedFacs,
          batches: mappedBatches,
          recommendations: course.recommendations || {}
        });
        remainingHours -= 1;
      }
    }
  });

  // Helper to count curriculum recommended slots for a card
  function countRecommendations(card) {
    if (!card.recommendations) return 0;
    let count = 0;
    WEEKDAYS.forEach(d => {
      Object.keys(card.recommendations[d] || {}).forEach(p => {
        if (card.recommendations[d][p] === card.type) count++;
      });
    });
    return count;
  }

  // Sort cards by MRV (Most Constrained Variable):
  // 1. Practicals first (large contiguous blocks hardest to place)
  // 2. Courses with specific curriculum recommendations first (tightest domain)
  // 3. Single-teacher before multi-teacher (fewer faculty choices)
  cards.sort((a, b) => {
    if (b.duration !== a.duration) return b.duration - a.duration;
    const aRec = countRecommendations(a);
    const bRec = countRecommendations(b);
    if (aRec > 0 && bRec === 0) return -1;
    if (bRec > 0 && aRec === 0) return 1;
    if (aRec > 0 && bRec > 0 && aRec !== bRec) {
      return aRec - bRec;
    }
    const aFacCount = (a.facultyPool && a.facultyPool.length) || a.assignedFaculty.length || 0;
    const bFacCount = (b.facultyPool && b.facultyPool.length) || b.assignedFaculty.length || 0;
    return aFacCount - bFacCount;
  });

  // 5. Pre-fill with existing pinned slots and existing unselected courses
  const initialAllocation = {};
  deptCourses.forEach(c => {
    initialAllocation[c.code] = {};
    WEEKDAYS.forEach(d => {
      initialAllocation[c.code][d] = {};
    });
  });

  // If selective mode or pinning enabled, preserve existing allocations
  const currentDeptAlloc = db.allocations[deptUpper] || {};
  deptCourses.forEach(c => {
    const isTarget = targetCourses.some(tc => tc.code === c.code);
    if (!isTarget) {
      // Unselected course: preserve its allocations as static obstacles
      const existing = currentDeptAlloc[c.code] || {};
      WEEKDAYS.forEach(d => {
        if (existing[d]) {
          Object.keys(existing[d]).forEach(p => {
            initialAllocation[c.code][d][p] = existing[d][p];
          });
        }
      });
    }
  });

  Object.keys(pinnedSlots).forEach(cCode => {
    if (!initialAllocation[cCode]) initialAllocation[cCode] = {};
    const pDays = pinnedSlots[cCode] || {};
    Object.keys(pDays).forEach(d => {
      if (!initialAllocation[cCode][d]) initialAllocation[cCode][d] = {};
      Object.keys(pDays[d]).forEach(p => {
        initialAllocation[cCode][d][p] = pDays[d][p];
      });
    });
  });

  // 6. Diagnostic tracking counters
  const diagnostics = {
    rejectionCounts: {
      GLOBAL_LOCK: 0,
      TEACHER_UNAVAILABLE: 0,
      EXTERNAL_CLASH: 0,
      INTERNAL_CLASH: 0,
      TEACHER_FATIGUE: 0,
      BATCH_CLASH: 0,
      SAME_DAY_STACKING: 0,
      SAME_PERIOD_REPETITION: 0,
      SHIFT_BALANCE: 0
    },
    bottleneckFaculty: {},
    bottleneckCourses: {}
  };

  function recordRejection(reason, card, faculty = null) {
    if (diagnostics.rejectionCounts[reason] !== undefined) {
      diagnostics.rejectionCounts[reason]++;
    }
    if (faculty) {
      diagnostics.bottleneckFaculty[faculty] = (diagnostics.bottleneckFaculty[faculty] || 0) + 1;
    }
    if (card && card.courseCode) {
      diagnostics.bottleneckCourses[card.courseCode] = (diagnostics.bottleneckCourses[card.courseCode] || 0) + 1;
    }
  }

  const validSlots1Hour = getContiguousSlots(periodBlocks, 1);
  const validSlotsPractical = getContiguousSlots(periodBlocks, practicalBlockSize);

  // Helper: check Admin Global Lock with Semester Scoping
  function isGlobalLocked(day, period, courseSemester) {
    return globalLocks.some(lock => {
      if (lock.day.toUpperCase() !== day.toUpperCase()) return false;
      if (String(lock.period) !== String(period)) return false;
      if (!lock.semester || lock.semester === 'all') return true;
      return String(lock.semester).trim() === String(courseSemester).trim();
    });
  }

  // Helper: check teacher unwanted/blackout slot
  function isTeacherUnavailable(facCode, day, period) {
    const list = teacherUnavail[facCode] || [];
    if (!Array.isArray(list)) return false;
    return list.some(item => {
      if (!item || !item.day) return false;
      if (item.day.toUpperCase() !== day.toUpperCase()) return false;
      if (item.period === 'all') return true;
      return String(item.period) === String(period);
    });
  }

  function getTeacherPeriodsOnDay(allocState, day, facultyCode) {
    const periods = [];
    Object.keys(allocState).forEach(cCode => {
      const cDay = allocState[cCode][day] || {};
      Object.keys(cDay).forEach(p => {
        const facs = cDay[p] || [];
        if (facs.includes(facultyCode)) {
          periods.push(p);
        }
      });
    });
    return periods;
  }

  // Get all periods assigned to a course across the whole week
  function getCourseWeeklySlots(allocState, courseCode) {
    const slots = [];
    WEEKDAYS.forEach(d => {
      const daySlots = allocState[courseCode] && allocState[courseCode][d];
      if (daySlots) {
        Object.keys(daySlots).forEach(p => {
          slots.push({ day: d, period: p, shift: getPeriodShift(p, periodBlocks) });
        });
      }
    });
    return slots;
  }

  /**
   * Constraint Checker (Strict vs Relaxed vs DeepRelaxed)
   */
  function canPlaceCard(allocState, card, day, periodsGroup, isRelaxed = false, deepRelaxed = false) {
    // 1. Admin Global Locks (with semester check) - Always strictly enforced
    for (const p of periodsGroup) {
      if (isGlobalLocked(day, p, card.semester)) {
        recordRejection('GLOBAL_LOCK', card);
        return false;
      }
    }

    // 2. Teacher Unavailability / Blackout Slots
    if (!deepRelaxed) {
      for (const fac of card.assignedFaculty) {
        for (const p of periodsGroup) {
          if (isTeacherUnavailable(fac, day, p)) {
            recordRejection('TEACHER_UNAVAILABLE', card, fac);
            return false;
          }
        }
      }
    }

    // 3. Faculty Clashes & Fatigue Limits
    for (const fac of card.assignedFaculty) {
      for (const p of periodsGroup) {
        // Cross-department - Strictly enforced
        if (externalFacultyUsage[day][p] && externalFacultyUsage[day][p].has(fac)) {
          recordRejection('EXTERNAL_CLASH', card, fac);
          return false;
        }

        // Own department - Strictly enforced
        for (const otherCourse of Object.keys(allocState)) {
          const occ = allocState[otherCourse][day] && allocState[otherCourse][day][p];
          if (Array.isArray(occ) && occ.includes(fac)) {
            recordRejection('INTERNAL_CLASH', card, fac);
            return false;
          }
        }
      }

      // Max consecutive hours rule (default 2 in strict, 3 in relaxed, 4 in deepRelaxed)
      const allowedConsecutive = deepRelaxed ? (maxConsecutiveHours + 2) : (isRelaxed ? (maxConsecutiveHours + 1) : maxConsecutiveHours);
      const currentTeacherPeriods = getTeacherPeriodsOnDay(allocState, day, fac);
      if (checkMaxConsecutiveViolation(currentTeacherPeriods, periodsGroup, allRealPeriods, allowedConsecutive)) {
        recordRejection('TEACHER_FATIGUE', card, fac);
        return false;
      }
    }

    // 4. Student Batch Cohort Clashes - Strictly enforced
    if (card.batches && card.batches.length > 0) {
      for (const p of periodsGroup) {
        for (const otherCourse of Object.keys(allocState)) {
          if (otherCourse === card.courseCode) continue;
          if (allocState[otherCourse][day] && allocState[otherCourse][day][p] && allocState[otherCourse][day][p].length > 0) {
            const otherBatches = (db.groupMappings && db.groupMappings[otherCourse]) || [];
            const hasCommonBatch = card.batches.some(b => otherBatches.includes(b));
            if (hasCommonBatch) {
              recordRejection('BATCH_CLASH', card);
              return false;
            }
          }
        }
      }
    }

    // 5. Same Course Same Day Stacking
    if (card.type === 'T') {
      const alreadyPlacedToday = Object.keys(allocState[card.courseCode][day] || {}).length;
      const maxPerDay = deepRelaxed ? 4 : (isRelaxed ? 3 : 2);
      if (alreadyPlacedToday >= maxPerDay) {
        recordRejection('SAME_DAY_STACKING', card);
        return false;
      }
    }

    const isRecommendedSlot = periodsGroup.some(p => card.recommendations[day] && card.recommendations[day][p] === card.type);

    // 6. Anti-Mono-Period Constraint: Avoid mono-period placement on unrecommended slots
    // Curriculum recommended slots are never blocked by this heuristic
    if (!isRelaxed && !isRecommendedSlot) {
      const existingWeeklySlots = getCourseWeeklySlots(allocState, card.courseCode);
      const usedPeriods = new Set(existingWeeklySlots.map(s => String(s.period)));
      
      if (usedPeriods.size < allRealPeriods.length) {
        for (const p of periodsGroup) {
          if (usedPeriods.has(String(p))) {
            recordRejection('SAME_PERIOD_REPETITION', card);
            return false;
          }
        }
      }

      // 7. Shift Balance: Distribute subject across Morning & Afternoon shifts on unrecommended slots
      const totalHours = courseTotalHours[card.courseCode] || 4;
      if (totalHours >= 3) {
        const morningCount = existingWeeklySlots.filter(s => s.shift === 'MORNING').length;
        const afternoonCount = existingWeeklySlots.filter(s => s.shift === 'AFTERNOON').length;
        const proposedShift = getPeriodShift(periodsGroup[0], periodBlocks);

        if (proposedShift === 'MORNING' && morningCount >= 3 && afternoonCount === 0) {
          recordRejection('SHIFT_BALANCE', card);
          return false;
        }
        if (proposedShift === 'AFTERNOON' && afternoonCount >= 3 && morningCount === 0) {
          recordRejection('SHIFT_BALANCE', card);
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Helper: Find available faculty candidates from a card's pool for a specific slot.
   * Distributes hours fairly according to each teacher's availability & rest rules.
   */
  function getAvailableCandidatesForCard(allocState, card, day, periodsGroup, courseFacultyHoursState, isRelaxed = false, deepRelaxed = false) {
    // 1. Course-level checks (Global Lock, Batch Cohort Clash, Daily Stacking, Anti-Mono-Period, Shift Balance)
    for (const p of periodsGroup) {
      if (isGlobalLocked(day, p, card.semester)) {
        recordRejection('GLOBAL_LOCK', card);
        return [];
      }
    }

    if (card.batches && card.batches.length > 0) {
      for (const p of periodsGroup) {
        for (const otherCourse of Object.keys(allocState)) {
          if (otherCourse === card.courseCode) continue;
          if (allocState[otherCourse][day] && allocState[otherCourse][day][p] && allocState[otherCourse][day][p].length > 0) {
            const otherBatches = (db.groupMappings && db.groupMappings[otherCourse]) || [];
            const hasCommonBatch = card.batches.some(b => otherBatches.includes(b));
            if (hasCommonBatch) {
              recordRejection('BATCH_CLASH', card);
              return [];
            }
          }
        }
      }
    }

    if (card.type === 'T') {
      const alreadyPlacedToday = Object.keys(allocState[card.courseCode][day] || {}).length;
      const maxPerDay = deepRelaxed ? 4 : (isRelaxed ? 3 : 2);
      if (alreadyPlacedToday >= maxPerDay) {
        recordRejection('SAME_DAY_STACKING', card);
        return [];
      }
    }

    const isRecommendedSlot = periodsGroup.some(p => card.recommendations[day] && card.recommendations[day][p] === card.type);

    if (!isRelaxed && !isRecommendedSlot) {
      const existingWeeklySlots = getCourseWeeklySlots(allocState, card.courseCode);
      const usedPeriods = new Set(existingWeeklySlots.map(s => String(s.period)));
      if (usedPeriods.size < allRealPeriods.length) {
        for (const p of periodsGroup) {
          if (usedPeriods.has(String(p))) {
            recordRejection('SAME_PERIOD_REPETITION', card);
            return [];
          }
        }
      }

      const totalHours = courseTotalHours[card.courseCode] || 4;
      if (totalHours >= 3) {
        const morningCount = existingWeeklySlots.filter(s => s.shift === 'MORNING').length;
        const afternoonCount = existingWeeklySlots.filter(s => s.shift === 'AFTERNOON').length;
        const proposedShift = getPeriodShift(periodsGroup[0], periodBlocks);
        if (proposedShift === 'MORNING' && morningCount >= 3 && afternoonCount === 0) {
          recordRejection('SHIFT_BALANCE', card);
          return [];
        }
        if (proposedShift === 'AFTERNOON' && afternoonCount >= 3 && morningCount === 0) {
          recordRejection('SHIFT_BALANCE', card);
          return [];
        }
      }
    }

    // 2. Filter available faculty from pool
    const pool = (card.facultyPool && card.facultyPool.length > 0) ? card.facultyPool : card.assignedFaculty;
    const totalCourseHours = courseTotalHours[card.courseCode] || (pool.length * 2);
    const fairQuota = Math.ceil(totalCourseHours / pool.length);
    const maxQuota = deepRelaxed ? (fairQuota + 1) : fairQuota;

    const candidates = [];
    for (const fac of pool) {
      const currentHours = (courseFacultyHoursState[card.courseCode] && courseFacultyHoursState[card.courseCode][fac]) || 0;
      if (currentHours + card.duration > maxQuota) {
        continue;
      }

      // Check teacher unwanted / blackout periods
      if (!deepRelaxed) {
        let isUnavail = false;
        for (const p of periodsGroup) {
          if (isTeacherUnavailable(fac, day, p)) {
            isUnavail = true;
            recordRejection('TEACHER_UNAVAILABLE', card, fac);
            break;
          }
        }
        if (isUnavail) continue;
      }

      // Check external cross-dept clash
      let hasExternalClash = false;
      for (const p of periodsGroup) {
        if (externalFacultyUsage[day][p] && externalFacultyUsage[day][p].has(fac)) {
          hasExternalClash = true;
          recordRejection('EXTERNAL_CLASH', card, fac);
          break;
        }
      }
      if (hasExternalClash) continue;

      // Check own dept clash
      let hasInternalClash = false;
      for (const p of periodsGroup) {
        for (const otherCourse of Object.keys(allocState)) {
          const occ = allocState[otherCourse][day] && allocState[otherCourse][day][p];
          if (Array.isArray(occ) && occ.includes(fac)) {
            hasInternalClash = true;
            recordRejection('INTERNAL_CLASH', card, fac);
            break;
          }
        }
        if (hasInternalClash) break;
      }
      if (hasInternalClash) continue;

      // Check max consecutive hours fatigue
      const allowedConsecutive = deepRelaxed ? (maxConsecutiveHours + 2) : (isRelaxed ? (maxConsecutiveHours + 1) : maxConsecutiveHours);
      const currentTeacherPeriods = getTeacherPeriodsOnDay(allocState, day, fac);
      if (checkMaxConsecutiveViolation(currentTeacherPeriods, periodsGroup, allRealPeriods, allowedConsecutive)) {
        recordRejection('TEACHER_FATIGUE', card, fac);
        continue;
      }

      candidates.push({
        code: fac,
        courseHours: currentHours,
        dayHours: currentTeacherPeriods.length
      });
    }

    if (candidates.length === 0) {
      return [];
    }

    // Sort candidates:
    // 1. Teacher with FEWER hours on this course gets priority (fair distribution!)
    // 2. Teacher with FEWER periods on this day (spreads daily teaching load)
    candidates.sort((a, b) => {
      if (a.courseHours !== b.courseHours) return a.courseHours - b.courseHours;
      return a.dayHours - b.dayHours;
    });

    return candidates.map(c => c.code);
  }

  function evaluateScheduleScore(allocState) {
    let score = 1000;
    
    // 1. Teacher daily workload distribution
    deptFaculty.forEach(fac => {
      WEEKDAYS.forEach(day => {
        const periods = getTeacherPeriodsOnDay(allocState, day, fac.code);
        if (periods.length > 0) {
          if (periods.length >= 2 && periods.length <= 4) score += 20;
          if (periods.length > 5) score -= 40;
        }
      });
    });

    // 2. High reward for matching Curriculum Recommendations & Day Spread
    targetCourses.forEach(c => {
      const isPractical = (c.courseType === 'P' || (c.code && c.code.endsWith('-P')));
      const expectedType = isPractical ? 'P' : 'T';
      let recMatches = 0;
      let distinctDaysCount = 0;
      let multipleHoursDaysCount = 0;

      WEEKDAYS.forEach(d => {
        const dayPeriods = Object.keys(allocState[c.code][d] || {});
        if (dayPeriods.length > 0) {
          distinctDaysCount++;
          if (!isPractical && dayPeriods.length > 1) {
            multipleHoursDaysCount += (dayPeriods.length - 1);
          }
          dayPeriods.forEach(p => {
            if (c.recommendations && c.recommendations[d] && c.recommendations[d][p] === expectedType) {
              recMatches++;
            }
          });
        }
      });

      // +50 points per recommended slot placed!
      score += (recMatches * 50);

      // Reward spreading theory across distinct days (1 hr/day mandatory distribution)
      if (!isPractical) {
        score += (distinctDaysCount * 20);
        // Heavy penalty if 2+ hours placed on the same day for theory
        if (multipleHoursDaysCount > 0) {
          score -= (multipleHoursDaysCount * 80);
        }
      }

      // 3. Shift distribution bonus
      const weeklySlots = getCourseWeeklySlots(allocState, c.code);
      const morningCount = weeklySlots.filter(s => s.shift === 'MORNING').length;
      const afternoonCount = weeklySlots.filter(s => s.shift === 'AFTERNOON').length;
      if (weeklySlots.length >= 2) {
        if (morningCount > 0 && afternoonCount > 0) {
          score += 20;
        }
      }

      // 4. Period diversity bonus
      const distinctPeriods = new Set(weeklySlots.map(s => s.period));
      score += (distinctPeriods.size * 5);

      // 5. Multi-teacher distribution balance bonus
      const binding = resolvedFacultyBindings[c.code];
      if (binding && binding.distribute && binding.teachers && binding.teachers.length > 1) {
        const facHours = {};
        binding.teachers.forEach(f => { facHours[f] = 0; });
        WEEKDAYS.forEach(d => {
          Object.keys(allocState[c.code][d] || {}).forEach(p => {
            const assigned = allocState[c.code][d][p] || [];
            assigned.forEach(f => {
              if (facHours[f] !== undefined) facHours[f]++;
            });
          });
        });
        const counts = Object.values(facHours);
        const maxH = Math.max(...counts);
        const minH = Math.min(...counts);
        if (maxH - minH <= 1) {
          score += 30;
        }
      }
    });

    return score;
  }

  function initializeCourseFacultyHours() {
    const hours = {};
    targetCourses.forEach(c => {
      hours[c.code] = {};
    });
    Object.keys(pinnedSlots).forEach(cCode => {
      if (!hours[cCode]) hours[cCode] = {};
      const pDays = pinnedSlots[cCode] || {};
      Object.keys(pDays).forEach(d => {
        Object.keys(pDays[d] || {}).forEach(p => {
          const facs = pDays[d][p] || [];
          facs.forEach(f => {
            hours[cCode][f] = (hours[cCode][f] || 0) + 1;
          });
        });
      });
    });
    return hours;
  }

  // -----------------------------------------------------------
  // Backtracking Solver
  // -----------------------------------------------------------
  let bestSolution = null;
  let bestScore = -Infinity;
  let stepsCount = 0;
  let mostCardsPlacedAlloc = null;
  let maxCardsPlaced = -1;
  const MAX_STEPS = 20000;
  let currentCourseFacultyHours = initializeCourseFacultyHours();

  /**
   * Generates strictly prioritized candidate placements (day & slotGroup) for a card.
   * 
   * Strict Allocation Flow:
   * 1. Theory courses are spread across different days of the week (mandatory).
   * 2. The same subject will not have more than 1 hour in a day. (Practicals are exempt).
   * 3. Priority order for Theory:
   *    - Tier 1: Days with 0 hours today on Curriculum Recommended 'T' slots.
   *    - Tier 2: Days with 0 hours today on Neutral / Non-recommended slots.
   *    - Tier 3: Days with 0 hours today on other available slots.
   *    - Tier 4: Days with 1 hour today on Recommended 'T' slots (Balance/overflow hours only).
   *    - Tier 5: Days with 1 hour today on Neutral slots (Balance/overflow hours only).
   *    - Tier 6: Days with 1 hour today on other slots.
   *    - Tier 7: Deep relaxed fallback (days with >= 2 hours).
   * 4. Priority order for Practical (exempt from 1 hr/day):
   *    - Tier 1: Curriculum Recommended 'P' slots.
   *    - Tier 2: Neutral slots.
   *    - Tier 3: Other fallback slots.
   */
  function getPrioritizedCandidatePlacements(allocState, card, isRelaxed = false, deepRelaxed = false) {
    const isPractical = (card.duration > 1);
    const candidateSlots = isPractical ? validSlotsPractical : validSlots1Hour;
    
    // Count existing hours for this course on each weekday
    const placedOnDays = {};
    WEEKDAYS.forEach(d => {
      placedOnDays[d] = Object.keys((allocState[card.courseCode] && allocState[card.courseCode][d]) || {}).length;
    });

    if (isPractical) {
      const tier1 = []; // Recommended 'P'
      const tier2 = []; // Neutral slots
      const tier3 = []; // Other fallback

      WEEKDAYS.forEach(day => {
        candidateSlots.forEach(slotGroup => {
          const isRecP = slotGroup.every(p => card.recommendations[day] && card.recommendations[day][p] === 'P');
          const isRecT = slotGroup.some(p => card.recommendations[day] && card.recommendations[day][p] === 'T');

          if (isRecP && !isRecT) {
            tier1.push({ day, slotGroup });
          } else if (!isRecT) {
            tier2.push({ day, slotGroup });
          } else {
            tier3.push({ day, slotGroup });
          }
        });
      });

      tier1.sort(() => Math.random() - 0.5);
      tier2.sort(() => Math.random() - 0.5);
      tier3.sort(() => Math.random() - 0.5);

      return [...tier1, ...tier2, ...tier3];
    }

    // Theory courses:
    const tier1 = []; // 0 hours today + Recommended 'T'
    const tier2 = []; // 0 hours today + Neutral
    const tier3 = []; // 0 hours today + Fallback
    const tier4 = []; // 1 hour today + Recommended 'T' (balance hours)
    const tier5 = []; // 1 hour today + Neutral (balance hours)
    const tier6 = []; // 1 hour today + Fallback
    const tier7 = []; // >= 2 hours today (deep relaxation only)

    WEEKDAYS.forEach(day => {
      const hoursToday = placedOnDays[day];

      candidateSlots.forEach(slotGroup => {
        const isRecT = slotGroup.some(p => card.recommendations[day] && card.recommendations[day][p] === 'T');
        const isRecP = slotGroup.some(p => card.recommendations[day] && card.recommendations[day][p] === 'P');

        if (hoursToday === 0) {
          if (isRecT && !isRecP) {
            tier1.push({ day, slotGroup });
          } else if (!isRecP) {
            tier2.push({ day, slotGroup });
          } else {
            tier3.push({ day, slotGroup });
          }
        } else if (hoursToday === 1) {
          if (isRecT && !isRecP) {
            tier4.push({ day, slotGroup });
          } else if (!isRecP) {
            tier5.push({ day, slotGroup });
          } else {
            tier6.push({ day, slotGroup });
          }
        } else if (deepRelaxed || isRelaxed) {
          tier7.push({ day, slotGroup });
        }
      });
    });

    tier1.sort(() => Math.random() - 0.5);
    tier2.sort(() => Math.random() - 0.5);
    tier3.sort(() => Math.random() - 0.5);
    tier4.sort(() => Math.random() - 0.5);
    tier5.sort(() => Math.random() - 0.5);
    tier6.sort(() => Math.random() - 0.5);
    tier7.sort(() => Math.random() - 0.5);

    return [...tier1, ...tier2, ...tier3, ...tier4, ...tier5, ...tier6, ...tier7];
  }

  function backtrack(cardIndex, currentAlloc, isRelaxed = false, deepRelaxed = false) {
    stepsCount++;
    if (stepsCount > MAX_STEPS) return false;

    if (cardIndex > maxCardsPlaced) {
      maxCardsPlaced = cardIndex;
      mostCardsPlacedAlloc = JSON.parse(JSON.stringify(currentAlloc));
    }

    if (cardIndex >= cards.length) {
      const score = evaluateScheduleScore(currentAlloc);
      if (score > bestScore) {
        bestScore = score;
        bestSolution = JSON.parse(JSON.stringify(currentAlloc));
      }
      return true;
    }

    const card = cards[cardIndex];
    const candidatePlacements = getPrioritizedCandidatePlacements(currentAlloc, card, isRelaxed, deepRelaxed);

    for (const { day, slotGroup } of candidatePlacements) {
      if (card.isDistributed && card.facultyPool && card.facultyPool.length > 1) {
        const availableTeachers = getAvailableCandidatesForCard(currentAlloc, card, day, slotGroup, currentCourseFacultyHours, isRelaxed, deepRelaxed);
        if (availableTeachers.length > 0) {
          for (const chosenFac of availableTeachers) {
            slotGroup.forEach(p => {
              currentAlloc[card.courseCode][day][p] = [chosenFac];
            });
            if (!currentCourseFacultyHours[card.courseCode]) currentCourseFacultyHours[card.courseCode] = {};
            currentCourseFacultyHours[card.courseCode][chosenFac] = (currentCourseFacultyHours[card.courseCode][chosenFac] || 0) + card.duration;

            const success = backtrack(cardIndex + 1, currentAlloc, isRelaxed, deepRelaxed);
            if (success && bestScore > 1350) {
              return true;
            }

            currentCourseFacultyHours[card.courseCode][chosenFac] -= card.duration;
            slotGroup.forEach(p => {
              delete currentAlloc[card.courseCode][day][p];
            });

            if (availableTeachers.length > 2) break;
          }
        }
      } else {
        if (canPlaceCard(currentAlloc, card, day, slotGroup, isRelaxed, deepRelaxed)) {
          slotGroup.forEach(p => {
            currentAlloc[card.courseCode][day][p] = card.assignedFaculty;
          });

          const success = backtrack(cardIndex + 1, currentAlloc, isRelaxed, deepRelaxed);
          if (success && bestScore > 1350) {
            return true;
          }

          slotGroup.forEach(p => {
            delete currentAlloc[card.courseCode][day][p];
          });
        }
      }
    }

    return false;
  }

  // Phase 1: Strict Execution (only if not forcing relaxed generation directly)
  const workingAlloc = JSON.parse(JSON.stringify(initialAllocation));
  currentCourseFacultyHours = initializeCourseFacultyHours();
  if (!forceRelaxed) {
    backtrack(0, workingAlloc, false, false);
  }

  let isRelaxedSolution = false;
  const loggedExceptions = [];

  // Phase 2: Relaxed Fallback Pass if strict search failed or forceRelaxed requested
  if (!bestSolution && (allowRelaxedFallback || forceRelaxed)) {
    stepsCount = 0;
    currentCourseFacultyHours = initializeCourseFacultyHours();
    const relaxedWorkingAlloc = JSON.parse(JSON.stringify(initialAllocation));
    backtrack(0, relaxedWorkingAlloc, true, false);
    if (bestSolution) {
      isRelaxedSolution = true;
    }
  }

  // Phase 3: Deep Relaxation Pass (handles tight teacher availability and extended rest limits)
  if (!bestSolution && forceRelaxed) {
    stepsCount = 0;
    currentCourseFacultyHours = initializeCourseFacultyHours();
    const deepRelaxedAlloc = JSON.parse(JSON.stringify(initialAllocation));
    backtrack(0, deepRelaxedAlloc, true, true);
    if (bestSolution) {
      isRelaxedSolution = true;
    }
  }

  // Phase 4: Best-effort complete allocation guarantee
  if (!bestSolution && forceRelaxed && mostCardsPlacedAlloc) {
    bestSolution = mostCardsPlacedAlloc;
    isRelaxedSolution = true;
  }

  if (bestSolution && isRelaxedSolution) {
    // Audit exceptions in relaxed solution
    WEEKDAYS.forEach(day => {
      deptFaculty.forEach(fac => {
        const pList = getTeacherPeriodsOnDay(bestSolution, day, fac.code);
        if (checkMaxConsecutiveViolation(pList, [], allRealPeriods, maxConsecutiveHours)) {
          loggedExceptions.push({
            type: 'TEACHER_FATIGUE',
            facultyCode: fac.code,
            facultyName: fac.name,
            day,
            reason: `Faculty ${fac.name} (${fac.code}) assigned extended consecutive hours on ${day} to resolve timetable.`
          });
        }
        // Audit teacher unavailability exceptions if utilized
        pList.forEach(p => {
          if (isTeacherUnavailable(fac.code, day, p)) {
            loggedExceptions.push({
              type: 'TEACHER_UNAVAILABLE_OVERRIDE',
              facultyCode: fac.code,
              facultyName: fac.name,
              day,
              period: p,
              reason: `Utilized blackout slot on ${day} Period ${p} for ${fac.name} (${fac.code}) to avoid schedule deadlock.`
            });
          }
        });
      });
    });

    // Check if any courses had fewer slots than required
    targetCourses.forEach(c => {
      let placed = 0;
      WEEKDAYS.forEach(d => {
        if (bestSolution[c.code] && bestSolution[c.code][d]) {
          placed += Object.keys(bestSolution[c.code][d]).length;
        }
      });
      const required = courseTotalHours[c.code] || 4;
      if (placed < required) {
        loggedExceptions.push({
          type: 'PARTIAL_ALLOCATION',
          courseCode: c.code,
          courseName: c.name,
          reason: `Course ${c.name} (${c.code}) allocated ${placed}/${required} hours due to total weekly room/slot limits. Remaining ${required - placed} hours can be placed manually.`
        });
      }
    });
  }

  // Generate Suggestions from Diagnostics
  const actionableSuggestions = [];
  const topRejections = Object.entries(diagnostics.rejectionCounts)
    .filter(([_, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);

  if (diagnostics.rejectionCounts.TEACHER_FATIGUE > 0) {
    const topFaculty = Object.entries(diagnostics.bottleneckFaculty).sort((a, b) => b[1] - a[1])[0];
    const facName = topFaculty ? topFaculty[0] : 'teachers';
    actionableSuggestions.push(`Faculty rest limits were constrained for ${facName}. Consider relaxing the consecutive hours rule or assigning co-teachers.`);
  }

  if (diagnostics.rejectionCounts.TEACHER_UNAVAILABLE > 0) {
    actionableSuggestions.push('One or more teachers have blackout/unwanted periods that blocked scheduling. Check the Teacher Availability tab to relax these slots.');
  }

  if (diagnostics.rejectionCounts.BATCH_CLASH > 0) {
    actionableSuggestions.push('Parallel courses share identical student cohort batches. Verify your batch mappings or allow alternate semester scheduling.');
  }

  if (diagnostics.rejectionCounts.GLOBAL_LOCK > 0) {
    actionableSuggestions.push('Admin Global Locked Periods restricted available slots for this semester. You can adjust the lock semester scope or assign teachers manually in the department grid.');
  }

  if (diagnostics.rejectionCounts.SHIFT_BALANCE > 0 || diagnostics.rejectionCounts.SAME_PERIOD_REPETITION > 0) {
    actionableSuggestions.push('Shift distribution rules required slots in both morning and afternoon. Some slots were shifted to maintain balance across the week.');
  }

  if (!bestSolution) {
    return {
      success: false,
      status: 'failed',
      canAutoResolve: true,
      message: 'Could not generate a conflict-free schedule with current strict constraints.',
      diagnostics: {
        reasons: topRejections.map(([r, c]) => ({ reason: r, count: c })),
        rejectionCounts: diagnostics.rejectionCounts,
        bottleneckFaculty: diagnostics.bottleneckFaculty,
        bottleneckCourses: diagnostics.bottleneckCourses,
        topBottlenecks: Object.keys(diagnostics.bottleneckFaculty).slice(0, 3)
      },
      suggestions: actionableSuggestions.length > 0 ? actionableSuggestions : [
        'Try unpinning manual slots to allow the solver more scheduling room.',
        'Review Teacher Availability to ensure enough open periods are available.',
        'Distribute teaching loads across additional faculty members.'
      ]
    };
  }

  // 7. Generate Audit Report
  let totalAllocatedSlots = 0;
  let practicalBlocksPlaced = 0;
  let teacherViolations = 0;

  WEEKDAYS.forEach(day => {
    deptFaculty.forEach(fac => {
      const pList = getTeacherPeriodsOnDay(bestSolution, day, fac.code);
      if (checkMaxConsecutiveViolation(pList, [], allRealPeriods, maxConsecutiveHours)) {
        teacherViolations++;
      }
    });

    Object.keys(bestSolution).forEach(cCode => {
      const c = targetCourses.find(dc => dc.code === cCode);
      const isPrac = (c && c.courseType === 'P');
      const count = Object.keys(bestSolution[cCode][day] || {}).length;
      totalAllocatedSlots += count;
      if (isPrac && count >= 2) practicalBlocksPlaced++;
    });
  });

  return {
    success: true,
    status: isRelaxedSolution ? 'relaxed_with_exceptions' : 'optimal',
    message: isRelaxedSolution
      ? `Timetable generated with ${loggedExceptions.length} soft exception(s) to resolve constraint bottlenecks.`
      : `Conflict-free timetable generated successfully for ${targetCourses.length} course(s) with balanced morning/afternoon distribution!`,
    allocations: bestSolution,
    audit: {
      totalCourses: targetCourses.length,
      totalAllocatedSlots,
      practicalBlocksPlaced,
      teacherConsecutiveViolations: teacherViolations,
      facultyClashes: 0,
      globalLocksRespected: true,
      score: bestScore
    },
    exceptions: loggedExceptions,
    suggestions: actionableSuggestions
  };
}
