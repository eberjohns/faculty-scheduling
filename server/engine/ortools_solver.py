import json
import sys
from ortools.sat.python import cp_model

def canonical_sem(s):
    if not s:
        return ""
    s_clean = str(s).upper().replace('SEM', '').replace('_', '').replace(' ', '')
    return s_clean

def solve_timetable(data):
    model = cp_model.CpModel()

    courses = data['courses']
    teachers = data['teachers']
    weekdays = data['weekdays'] # ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']
    periods = data['periods']   # ['1', '2', '3', '4', '5', '6']
    blocked_slots = data.get('blocked_slots', []) # list of { day, period, sem, course }
    recs = data.get('recommendations', {}) # course -> day -> period -> 'T' / 'P' / 'B'

    # Activities: list of { id, course, teacher, cohort, sem, is_practical, pinned_day, pinned_period }
    activities = data['activities']

    # Decision variables: x[act_id, day, period] in {0, 1}
    x = {}
    for a in activities:
        aid = a['id']
        for d in weekdays:
            for p in periods:
                x[aid, d, p] = model.NewBoolVar(f"x_{aid}_{d}_{p}")

    # Constraint 1: Each activity must be scheduled exactly once
    for a in activities:
        aid = a['id']
        model.Add(sum(x[aid, d, p] for d in weekdays for p in periods) == 1)

    # Constraint 2: Pinned Slots (Hard constraint)
    for a in activities:
        aid = a['id']
        p_day = a.get('pinned_day')
        p_period = a.get('pinned_period')
        if p_day and p_period and (aid, p_day, p_period) in x:
            model.Add(x[aid, p_day, p_period] == 1)

    # Constraint 3: Strictly NO activities in Blocked slots
    for b in blocked_slots:
        d = b['day']
        p = str(b['period'])
        b_sem = canonical_sem(b.get('sem'))
        c_code = b.get('course')

        for a in activities:
            aid = a['id']
            # If blocked slot is course-specific, only block that course
            if c_code is not None and a.get('course') != c_code:
                continue
            # If blocked slot is semester-specific, only block that semester
            if b_sem:
                a_sem = canonical_sem(a.get('sem'))
                if a_sem and a_sem != b_sem:
                    continue
            if (aid, d, p) in x:
                model.Add(x[aid, d, p] == 0)

    # Constraint 3b: Strictly NO activities when teacher is already busy (e.g. from other semesters)
    teacher_busy_slots = data.get('teacher_busy_slots', [])
    for busy in teacher_busy_slots:
        t = busy.get('teacher')
        d = busy.get('day')
        p = str(busy.get('period'))
        for a in activities:
            if a.get('teacher') == t:
                aid = a['id']
                if (aid, d, p) in x:
                    model.Add(x[aid, d, p] == 0)

    # Constraint 4: Teacher Clash Prevention (No teacher in 2 places at once)
    for t in teachers:
        for d in weekdays:
            for p in periods:
                teacher_acts = [a['id'] for a in activities if a['teacher'] == t and (a['id'], d, p) in x]
                if len(teacher_acts) > 1:
                    model.Add(sum(x[aid, d, p] for aid in teacher_acts) <= 1)

    # Constraint 5: Student Cohort Clash Prevention (Same class division cannot have 2 classes at once)
    cohorts = set(a.get('cohort') for a in activities if a.get('cohort'))
    for coh in cohorts:
        for d in weekdays:
            for p in periods:
                coh_acts = [a['id'] for a in activities if a.get('cohort') == coh and (a['id'], d, p) in x]
                if len(coh_acts) > 1:
                    model.Add(sum(x[aid, d, p] for aid in coh_acts) <= 1)

    # Constraint 6: Daily hour limit for Theory of the same course
    for c_code in set(a['course'] for a in activities if not a.get('is_practical')):
        c_acts = [a['id'] for a in activities if a['course'] == c_code]
        c_recs = recs.get(c_code, {})
        for d in weekdays:
            d_recs = c_recs.get(d, {})
            rec_count_today = sum(1 for p in periods if d_recs.get(p) in ['T', 'P'])
            # If recommendations specify multiple hours on this day (e.g. 2 hours), allow that count;
            # otherwise limit to at most 1 hour per day so balance hours are distributed across remaining days
            max_h = max(1, rec_count_today)
            model.Add(sum(x[aid, d, p] for aid in c_acts for p in periods) <= max_h)

    # Objective: Strict Recommended Slots Maximization!
    # Strict Rule: Recommended slots MUST be filled first, balance hours placed in balance slots without clash.
    objective_terms = []
    for a in activities:
        aid = a['id']
        c_code = a['course']
        c_recs = recs.get(c_code, {})
        for d in weekdays:
            d_recs = c_recs.get(d, {})
            for p in periods:
                if d_recs.get(p) in ['T', 'P']:
                    objective_terms.append(x[aid, d, p] * 10000)

    model.Maximize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10.0
    solver.parameters.num_workers = 4
    status = solver.Solve(model)

    if status in [cp_model.OPTIMAL, cp_model.FEASIBLE]:
        placements = []
        rec_matches = 0
        for a in activities:
            aid = a['id']
            c_code = a['course']
            c_recs = recs.get(c_code, {})
            for d in weekdays:
                for p in periods:
                    if solver.Value(x[aid, d, p]) == 1:
                        is_rec = (c_recs.get(d, {}).get(p) in ['T', 'P'])
                        if is_rec:
                            rec_matches += 1
                        placements.append({
                            'id': aid,
                            'course': c_code,
                            'teacher': a['teacher'],
                            'day': d,
                            'period': p,
                            'is_rec': is_rec
                        })
        return {
            'success': True,
            'status': solver.StatusName(status),
            'total_activities': len(activities),
            'placed_activities': len(placements),
            'recommended_slots_matched': rec_matches,
            'placements': placements
        }
    else:
        return {
            'success': False,
            'status': solver.StatusName(status)
        }

if __name__ == '__main__':
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            print(json.dumps({"success": False, "error": "No input provided"}))
            sys.exit(1)
        data = json.loads(raw_input)
        res = solve_timetable(data)
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)
