import { readDb } from './db.js';
import { generateDepartmentSchedule } from './scheduler.js';

async function test() {
  const db = await readDb();
  const result = generateDepartmentSchedule({
    db,
    departmentName: 'COMPUTER SCIENCE',
    semester: 'all',
    selectedCourseCodes: [],
    allowRelaxedFallback: true
  });

  console.log('Success:', result.success);
  console.log('Status:', result.status);
  console.log('Message:', result.message);

  const allocations = result.allocations || {};
  const csCourses = (db.courses || []).filter(c => c.department.toUpperCase() === 'COMPUTER SCIENCE');
  const WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

  console.log('\n--- ALLOCATION AUDIT ---');
  csCourses.forEach(c => {
    let placed = 0;
    const dayMap = {};
    WEEKDAYS.forEach(d => {
      if (allocations[c.code] && allocations[c.code][d]) {
        const count = Object.keys(allocations[c.code][d]).length;
        placed += count;
        if (count > 0) dayMap[d] = count;
      }
    });
    const tag = placed < c.hours ? `<<< UNDER-ALLOCATED (${placed}/${c.hours})` : (placed > c.hours ? `<<< OVER-ALLOCATED (${placed}/${c.hours})` : 'OK');
    console.log(`${c.code.padEnd(12)} (${(c.alias || c.name).padEnd(25)}) Sem ${c.semester} ${(c.programType || 'UG').padEnd(3)}: target ${c.hours} hrs -> placed ${placed} hrs ${tag}`, JSON.stringify(dayMap));
  });
}

test();
