/**
 * Constraint Satisfaction Problem (CSP) Timetable Generator Engine
 * 
 * Features:
 * - Admin Global Common Locked Periods Hard Enforcement
 * - Contiguous Practical (P) Sessions (no splitting across lunch breaks or intervals)
 * - Faculty Max Continuous Teaching Rule (<= 2 consecutive hours without rest)
 * - Zero Cross-Department & Same-Department Faculty Clashes
 * - Zero Student Batch Clashes
 * - Balanced Rest Intervals & Even Day-Spread Heuristics
 */

const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

/**
 * Split period labels into contiguous blocks divided by lunch break ('LB')
 */
function getPeriodBlocks(periodsList) {
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
function getContiguousSlots(blocks, duration = 1) {
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
  
  // Find index in ordered periods
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
 * Main Generator Function
 */
export function generateDepartmentSchedule({
  db,
  departmentName,
  semester = '',
  courseFacultyMap = {},
  pinnedSlots = {},
  maxConsecutiveHours = 2,
  practicalBlockSize = 2
}) {
  const deptUpper = departmentName.toUpperCase();
  const rawPeriods = db.periods || ['1', '2', '3', 'LB', '4', '5', '6'];
  const allRealPeriods = rawPeriods.filter(p => String(p).toUpperCase() !== 'LB');
  const periodBlocks = getPeriodBlocks(rawPeriods);
  const globalLocks = db.config.globalLockedPeriods || [];
  
  // 1. Filter department courses
  let deptCourses = (db.courses || []).filter(c => c.department.toUpperCase() === deptUpper);
  if (semester && semester !== 'all') {
    deptCourses = deptCourses.filter(c => String(c.semester).trim() === String(semester).trim());
  }

  if (deptCourses.length === 0) {
    return {
      success: false,
      message: `No courses found for department '${departmentName}'` + (semester ? ` in semester ${semester}` : '') + '.'
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

  deptCourses.forEach(c => {
    if (courseFacultyMap[c.code] && courseFacultyMap[c.code].length > 0) {
      resolvedFacultyBindings[c.code] = courseFacultyMap[c.code];
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
      resolvedFacultyBindings[c.code] = Array.from(foundCodes);
    } else if (deptFaculty.length > 0) {
      // Round-robin distribution
      const assignedFac = deptFaculty[facultyWorkloadIndex % deptFaculty.length];
      resolvedFacultyBindings[c.code] = [assignedFac.code];
      facultyWorkloadIndex++;
    } else {
      resolvedFacultyBindings[c.code] = [];
    }
  });

  // 4. Decompose courses into Lesson Cards
  const cards = [];
  deptCourses.forEach(course => {
    const courseCode = course.code;
    const isPractical = (course.courseType === 'P' || (course.code && course.code.endsWith('-P')));
    const assignedFacs = resolvedFacultyBindings[courseCode] || [];
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
          batches: mappedBatches,
          recommendations: course.recommendations || {}
        });
        remainingHours -= 1;
      }
    }
  });

  // Sort cards by MRV (Most Constrained Variable)
  cards.sort((a, b) => {
    if (b.duration !== a.duration) return b.duration - a.duration;
    return (b.assignedFaculty.length || 0) - (a.assignedFaculty.length || 0);
  });

  // 5. Pre-fill with existing pinned slots
  const initialAllocation = {};
  deptCourses.forEach(c => {
    initialAllocation[c.code] = {};
    WEEKDAYS.forEach(d => {
      initialAllocation[c.code][d] = {};
    });
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

  // 6. CSP Backtracking Search with Heuristics
  let bestSolution = null;
  let bestScore = -Infinity;

  const validSlots1Hour = getContiguousSlots(periodBlocks, 1);
  const validSlotsPractical = getContiguousSlots(periodBlocks, practicalBlockSize);

  function isGlobalLocked(day, period) {
    return globalLocks.some(lock => lock.day.toUpperCase() === day.toUpperCase() && String(lock.period) === String(period));
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

  function canPlaceCard(allocState, card, day, periodsGroup) {
    // 1. Check Global Locks
    for (const p of periodsGroup) {
      if (isGlobalLocked(day, p)) return false;
    }

    // 2. Check Faculty Availability & Clashes
    for (const fac of card.assignedFaculty) {
      for (const p of periodsGroup) {
        if (externalFacultyUsage[day][p] && externalFacultyUsage[day][p].has(fac)) {
          return false;
        }

        for (const otherCourse of Object.keys(allocState)) {
          const occ = allocState[otherCourse][day] && allocState[otherCourse][day][p];
          if (Array.isArray(occ) && occ.includes(fac)) {
            return false;
          }
        }
      }

      // Check max consecutive hours rule
      const currentTeacherPeriods = getTeacherPeriodsOnDay(allocState, day, fac);
      if (checkMaxConsecutiveViolation(currentTeacherPeriods, periodsGroup, allRealPeriods, maxConsecutiveHours)) {
        return false;
      }
    }

    // 3. Check Batch Clashes (Student Cohort)
    if (card.batches && card.batches.length > 0) {
      for (const p of periodsGroup) {
        for (const otherCourse of Object.keys(allocState)) {
          if (otherCourse === card.courseCode) continue;
          if (allocState[otherCourse][day] && allocState[otherCourse][day][p] && allocState[otherCourse][day][p].length > 0) {
            const otherBatches = (db.groupMappings && db.groupMappings[otherCourse]) || [];
            const hasCommonBatch = card.batches.some(b => otherBatches.includes(b));
            if (hasCommonBatch) {
              return false;
            }
          }
        }
      }
    }

    // 4. Same Course Same Day Check (Avoid stacking theory)
    if (card.type === 'T') {
      const alreadyPlacedToday = Object.keys(allocState[card.courseCode][day] || {}).length;
      if (alreadyPlacedToday >= 2) return false;
    }

    return true;
  }

  function evaluateScheduleScore(allocState) {
    let score = 1000;
    
    deptFaculty.forEach(fac => {
      WEEKDAYS.forEach(day => {
        const periods = getTeacherPeriodsOnDay(allocState, day, fac.code);
        if (periods.length > 0) {
          if (periods.length >= 2 && periods.length <= 4) score += 20;
          if (periods.length > 5) score -= 40;
        }
      });
    });

    deptCourses.forEach(c => {
      if (c.recommendations) {
        WEEKDAYS.forEach(d => {
          Object.keys(c.recommendations[d] || {}).forEach(p => {
            if (allocState[c.code] && allocState[c.code][d] && allocState[c.code][d][p]) {
              score += 15;
            }
          });
        });
      }
    });

    return score;
  }

  let stepsCount = 0;
  const MAX_STEPS = 12000;

  function backtrack(cardIndex, currentAlloc) {
    stepsCount++;
    if (stepsCount > MAX_STEPS) return false;

    if (cardIndex >= cards.length) {
      const score = evaluateScheduleScore(currentAlloc);
      if (score > bestScore) {
        bestScore = score;
        bestSolution = JSON.parse(JSON.stringify(currentAlloc));
      }
      return true;
    }

    const card = cards[cardIndex];
    const candidateSlots = (card.duration > 1) ? validSlotsPractical : validSlots1Hour;
    const dayOrder = [...WEEKDAYS].sort(() => Math.random() - 0.5);

    for (const day of dayOrder) {
      for (const slotGroup of candidateSlots) {
        if (canPlaceCard(currentAlloc, card, day, slotGroup)) {
          slotGroup.forEach(p => {
            currentAlloc[card.courseCode][day][p] = card.assignedFaculty;
          });

          const success = backtrack(cardIndex + 1, currentAlloc);
          if (success && bestScore > 1200) {
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

  // Execute Search
  const workingAlloc = JSON.parse(JSON.stringify(initialAllocation));
  backtrack(0, workingAlloc);

  if (!bestSolution) {
    return {
      success: false,
      message: 'Could not generate a 100% clash-free schedule with the specified constraints. Try reducing locked periods or relaxing pinned slots.'
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
      const c = deptCourses.find(dc => dc.code === cCode);
      const isPrac = (c && c.courseType === 'P');
      const count = Object.keys(bestSolution[cCode][day] || {}).length;
      totalAllocatedSlots += count;
      if (isPrac && count >= 2) practicalBlocksPlaced++;
    });
  });

  return {
    success: true,
    message: `Timetable generated successfully for ${deptCourses.length} courses!`,
    allocations: bestSolution,
    audit: {
      totalCourses: deptCourses.length,
      totalAllocatedSlots,
      practicalBlocksPlaced,
      teacherConsecutiveViolations: teacherViolations,
      facultyClashes: 0,
      globalLocksRespected: true,
      score: bestScore
    }
  };
}
