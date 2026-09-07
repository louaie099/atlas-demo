import {
  Employee,
  Flight,
  StaffingRequirement,
  Assignment,
  WeeklyPlan,
  WeeklyPlanRosterEntry,
  RosterRequirementView,
  AgentScheduleEntry,
  AgentDayEntry,
  AgentScheduleDuty,
} from "../types";
import { buildRosterViewsFromItems, CoverageItem } from "./weekly-plan-view";
import { getRequirementWindow } from "./requirement-window";
import { getEmployeeForeignCommitments } from "../foreign-company-window";
import { getShiftTimesAs } from "../shift-templates";
import { PlanIssue } from "./validation";

/**
 * Reads an ALREADY-PERSISTED WeeklyPlan back into the same
 * RosterRequirementView[]/AgentScheduleEntry[] shapes Flight Coverage and
 * Agent Schedule have always consumed -- but from durable rows
 * (WeeklyPlanRosterEntry + Assignment), never by re-running
 * generateDraftWeeklyPlan. This is the entire point of the persistence
 * milestone: a browser refresh reads this, it never triggers a fresh
 * computation. See lib/planning/weekly-plan-service.ts for how a plan
 * gets INTO this durable shape in the first place (Generate/Regenerate),
 * and lib/planning/weekly-plan-view.ts's buildWeeklyPlanView for the
 * LIVE, pre-persistence equivalent that service calls internally.
 *
 * `assignments` and `rosterEntries` must already be filtered to this
 * plan's `plan_id` by the caller (a thin DB-read concern, not this pure
 * function's).
 */
export interface PersistedWeeklyPlanView {
  plan: WeeklyPlan;
  roster: RosterRequirementView[];
  schedule: AgentScheduleEntry[];
}

export function buildPersistedWeeklyPlanView(
  plan: WeeklyPlan,
  rosterEntries: WeeklyPlanRosterEntry[],
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[],
  employees: Employee[],
  daysOrder: string[]
): PersistedWeeklyPlanView {
  const items: CoverageItem[] = assignments.map((a) => ({
    requirementId: a.staffing_requirement_id,
    employeeId: a.employee_id,
    // Provenance IS the display bucket now that every assignment is a
    // real row: a human-attributable action reads as "assigned"/
    // "confirmed" (plain/gray, green), ATLAS's own normal generated
    // output reads as "proposed"/"assigned" (brand blue) -- same visual
    // language the UI already used, now driven by source instead of
    // row-existence (see weekly-plan-view.ts's CoverageItem doc comment).
    bucket: a.source === "human_modified" ? "assigned" : "proposed",
  }));

  const roster = buildRosterViewsFromItems(requirements, flights, employees, items);
  const schedule = buildPersistedAgentScheduleEntries(employees, assignments, requirements, flights, daysOrder, plan.issues, rosterEntries);

  return { plan, roster, schedule };
}

function buildPersistedAgentScheduleEntries(
  employees: Employee[],
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[],
  daysOrder: string[],
  planIssues: PlanIssue[],
  rosterEntries: WeeklyPlanRosterEntry[]
): AgentScheduleEntry[] {
  const requirementsById = new Map<string, StaffingRequirement>(requirements.map((r) => [r.id, r]));
  const flightsById = new Map<string, Flight>(flights.map((f) => [f.id, f]));
  const rosterByEmployeeDay = new Map<string, WeeklyPlanRosterEntry>(
    rosterEntries.map((r) => [`${r.employee_id}|${r.day_of_week}`, r])
  );

  const issuesByEmployeeDay = new Map<string, PlanIssue[]>();
  const weeklyIssuesByEmployee = new Map<string, PlanIssue[]>();
  for (const issue of planIssues) {
    if (!issue.employeeId) continue;
    if (issue.dayOfWeek) {
      const key = `${issue.employeeId}|${issue.dayOfWeek}`;
      issuesByEmployeeDay.set(key, [...(issuesByEmployeeDay.get(key) ?? []), issue]);
    } else {
      weeklyIssuesByEmployee.set(issue.employeeId, [...(weeklyIssuesByEmployee.get(issue.employeeId) ?? []), issue]);
    }
  }

  const schedule: AgentScheduleEntry[] = employees
    .filter((e) => !e.is_duty_officer)
    .map((employee) => {
      const employeeAssignments = assignments.filter((a) => a.employee_id === employee.id);
      const humanAssignments = employeeAssignments.filter((a) => a.source === "human_modified");
      const atlasAssignments = employeeAssignments.filter((a) => a.source === "atlas_generated");

      const toDuty = (a: Assignment) => {
        const requirement = requirementsById.get(a.staffing_requirement_id);
        const flight = requirement ? flightsById.get(requirement.flight_id) : undefined;
        if (!requirement || !flight) return null;
        return { flightNumber: flight.flight_number, role: requirement.role, dayOfWeek: flight.day_of_week };
      };
      const duties = humanAssignments.map(toDuty).filter((d): d is { flightNumber: string; role: string; dayOfWeek: string } => Boolean(d));
      const proposedDuties = atlasAssignments.map(toDuty).filter((d): d is { flightNumber: string; role: string; dayOfWeek: string } => Boolean(d));

      // All of this employee's assignments (either provenance) feed
      // foreign-commitment display -- both are equally real, persisted
      // rows now, unlike the live (pre-persistence) preview, which could
      // only see a commitment via an already-confirmed row.
      const foreignCommitmentsAll = getEmployeeForeignCommitments(employee.id, employeeAssignments, requirements, flights);

      const days: AgentDayEntry[] = daysOrder.map((day) => {
        const rosterEntry = rosterByEmployeeDay.get(`${employee.id}|${day}`);
        const isOff = !rosterEntry || rosterEntry.status === "off";
        const shiftCode = isOff ? null : rosterEntry!.shift_code;
        const shiftTimes = shiftCode ? getShiftTimesAs(shiftCode) : null;

        const dayDuties: AgentScheduleDuty[] = [];
        for (const a of employeeAssignments) {
          const requirement = requirementsById.get(a.staffing_requirement_id);
          const flight = requirement ? flightsById.get(requirement.flight_id) : undefined;
          if (!requirement || !flight || flight.day_of_week !== day) continue;
          dayDuties.push({
            flightId: flight.id,
            flightNumber: flight.flight_number,
            role: requirement.role,
            window: getRequirementWindow(requirement, flight),
            status: a.source === "human_modified" ? "confirmed" : "assigned",
          });
        }
        dayDuties.sort((a, b) => a.window.start.localeCompare(b.window.start));

        return {
          dayOfWeek: day,
          status: isOff ? "off" : "working",
          shiftCode,
          shiftStart: shiftTimes?.shift_start ?? null,
          shiftEnd: shiftTimes?.shift_end ?? null,
          foreignCommitments: foreignCommitmentsAll.filter((c) => c.dayOfWeek === day),
          duties: dayDuties,
          issues: issuesByEmployeeDay.get(`${employee.id}|${day}`) ?? [],
        };
      });

      return {
        employee,
        dayOff: employee.off_days.length > 0,
        duties,
        proposedDuties,
        days,
        weeklyIssues: weeklyIssuesByEmployee.get(employee.id) ?? [],
      };
    });

  schedule.sort((a, b) => a.employee.name.localeCompare(b.employee.name));

  return schedule;
}
