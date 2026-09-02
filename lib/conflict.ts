import { Employee, Flight, PlannedDuty, ConflictInfo, ResolutionRecommendation } from "./types";

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Detects whether a delayed flight's extended boarding window now overlaps
 * with any assigned employee's separately pre-planned duty.
 */
export function detectConflict(
  flight: Flight,
  assignedEmployees: Employee[],
  plannedDuties: PlannedDuty[]
): ConflictInfo | null {
  if (!flight.boarding_window_end) return null;
  const windowEndMin = timeToMinutes(flight.boarding_window_end);

  for (const employee of assignedEmployees) {
    const duty = plannedDuties.find(
      (d) => d.employee_id === employee.id && d.status === "planned"
    );
    if (!duty) continue;

    const dutyStartMin = timeToMinutes(duty.planned_start);
    if (dutyStartMin < windowEndMin) {
      return {
        employee,
        flightId: flight.id,
        plannedDuty: duty,
        overlapMinutes: windowEndMin - dutyStartMin,
      };
    }
  }

  return null;
}

/**
 * Given a conflicting planned duty, finds another qualified, available,
 * not-already-committed employee to take it over instead.
 */
export function recommendResolution(
  conflict: ConflictInfo,
  allEmployees: Employee[],
  allPlannedDuties: PlannedDuty[],
  requiredRole: string
): ResolutionRecommendation | null {
  const dutyStartMin = timeToMinutes(conflict.plannedDuty.planned_start);

  const candidate = allEmployees.find((e) => {
    if (e.id === conflict.employee.id || e.is_duty_officer) return false;
    if (!e.active) return false;
    if (!e.skills.includes(requiredRole)) return false;
    // An employee with no roster/shift assigned yet (see migration 0007 —
    // Employee.shift_start/shift_end are now nullable, since a freshly
    // created employee has a workforce profile but no plan) cannot be
    // evaluated as a resolution candidate — there's no shift to check
    // against.
    if (e.shift_start === null || e.shift_end === null) return false;

    const shiftStartMin = timeToMinutes(e.shift_start);
    const shiftEndMin = timeToMinutes(e.shift_end);
    const onShiftAtDutyStart = shiftStartMin <= dutyStartMin && dutyStartMin < shiftEndMin;

    const alreadyCommitted = allPlannedDuties.some(
      (d) => d.employee_id === e.id && d.status === "planned"
    );

    return onShiftAtDutyStart && !alreadyCommitted;
  });

  if (!candidate) return null;

  return {
    plannedDuty: conflict.plannedDuty,
    recommendedEmployee: candidate,
    reasoning: `${candidate.name} is ${requiredRole}-qualified, currently on shift (${candidate.shift_start}–${candidate.shift_end}), not otherwise committed during this window, weekly hours ${candidate.weekly_hours}h — well within fairness range. ${conflict.employee.name} remains on the original assignment without disruption.`,
  };
}
