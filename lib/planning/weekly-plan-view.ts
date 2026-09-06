import {
  Employee,
  Flight,
  StaffingRequirement,
  Assignment,
  Config,
  RosterRequirementView,
  RequirementCoverageStatus,
  AgentScheduleEntry,
  AgentDayEntry,
  AgentScheduleDuty,
} from "../types";
import { generateDraftWeeklyPlan, DraftWeeklyPlan } from "./generate-draft-plan";
import { GeneratedDuty, effectiveShiftCodeForDay } from "./duty-generation";
import { GeneratedShiftAssignment } from "./shift-generation";
import { getRequirementWindow } from "./requirement-window";
import { getEmployeeForeignCommitments } from "../foreign-company-window";
import { getShiftTimesAs } from "../shift-templates";
import { PlanIssue } from "./validation";

/**
 * Single source of truth for everything Weekly Planning shows: Flight
 * Coverage (`roster`), Agent Schedule (`schedule`), and the summary counts
 * the page derives from `roster` all come from this one computation —
 * one `generateDraftWeeklyPlan()` run, one snapshot of
 * flights/employees/assignments/requirements, no independent recomputation
 * per view. `/api/roster` and `/api/agent-schedule` used to each fetch
 * their own snapshot and run the whole pipeline separately — the pipeline
 * is a pure function so same inputs should always produce the same
 * output, but two separate DB reads at two separate moments (e.g. mid
 * page-load, while an assignment is being made via Find Agent) is a real
 * race, and running the full pipeline twice per page load was pure waste
 * on top of that. This module — and the single `/api/planning/weekly-view`
 * endpoint built on it — removes both problems: Flight Coverage, Agent
 * Schedule, and the summary bar can no longer silently disagree with each
 * other, because there is exactly one plan per page load, not two.
 */
export interface WeeklyPlanView {
  draftPlan: DraftWeeklyPlan;
  roster: RosterRequirementView[];
  schedule: AgentScheduleEntry[];
}

export function computeCoverageStatus(
  requirement: StaffingRequirement,
  confirmedCount: number,
  proposedCount: number
): RequirementCoverageStatus {
  // needs_configuration requirements never reach this function — buildRosterViews
  // filters them out before computing coverage (see below); a genuine internal
  // RAM configuration gap is surfaced only as an administrative PlanIssue.
  const total = confirmedCount + proposedCount;
  // Fully staffed by the draft plan — whether via a real, confirmed
  // Assignment row or the engine's own draft-plan duty no longer matters
  // for this status: both ARE the plan's assignment, not a pending
  // recommendation. "Proposed"/recommendation language is reserved for
  // exceptional cases (renfort, a live-operational reassignment) — see
  // lib/types.ts's RequirementCoverageStatus doc comment.
  if (total >= requirement.total_requirement) return "assigned";
  return "gap";
  // "conflict" is computed at the Live Operations layer (see
  // /api/simulate-delay) once an operational event actually creates one —
  // it never applies to a static, undisturbed weekly plan.
}

function buildRosterViews(
  requirements: StaffingRequirement[],
  flights: Flight[],
  employees: Employee[],
  assignments: Assignment[],
  allDuties: GeneratedDuty[]
): RosterRequirementView[] {
  const flightsById = new Map<string, Flight>(flights.map((f) => [f.id, f]));
  const employeesById = new Map<string, Employee>(employees.map((e) => [e.id, e]));

  // A needs_configuration requirement (a genuine internal RAM gap — no
  // classified destination, or no matrix rule for this aircraft/category)
  // never becomes a Flight Coverage row at all — it's surfaced only as an
  // administrative PlanIssue (see validation.ts), never a routine
  // operational staffing state. An unmanaged foreign carrier never even
  // reaches this point: classifyFlightRequirements produces zero
  // requirement rows for it in the first place (see weekly-requirements.ts).
  const routineRequirements = requirements.filter((r) => !r.needs_configuration);

  const views: RosterRequirementView[] = routineRequirements.map((req) => {
    const flight = flightsById.get(req.flight_id)!;

    const confirmedIds = assignments
      .filter((a) => a.staffing_requirement_id === req.id)
      .map((a) => a.employee_id);
    const assignedEmployees = confirmedIds
      .map((id) => employeesById.get(id))
      .filter((e): e is Employee => Boolean(e));

    const proposedIds = allDuties
      .filter((d) => d.requirementId === req.id && !confirmedIds.includes(d.employeeId))
      .map((d) => d.employeeId);
    const proposedEmployees = Array.from(new Set(proposedIds))
      .map((id) => employeesById.get(id))
      .filter((e): e is Employee => Boolean(e));

    const gap = Math.max(0, req.total_requirement - assignedEmployees.length - proposedEmployees.length);

    // Company-config (foreign-carrier) requirements display as "{Airline}
    // Team" — never the generic internal skill tag "Ramp Team", which
    // reads like a RAM/airport ramp-handling function these ACE/passenger-
    // service employees don't actually perform. requirement.role itself is
    // untouched (it still has to equal the Employee.skills entry scoring
    // matches against) — this is a display-only label.
    const coverageLabel = req.source === "company_config" ? `${flight.airline} Team` : req.role;

    return {
      requirement: req,
      flight,
      assignedEmployees,
      proposedEmployees,
      gap,
      coverageStatus: computeCoverageStatus(req, assignedEmployees.length, proposedEmployees.length),
      coverageLabel,
    };
  });

  // Sort by day then departure time so Flight Coverage reads as a real schedule.
  views.sort((a, b) => {
    if (a.flight.day_of_week !== b.flight.day_of_week) {
      return a.flight.day_of_week.localeCompare(b.flight.day_of_week);
    }
    return a.flight.scheduled_departure.localeCompare(b.flight.scheduled_departure);
  });

  return views;
}

function buildAgentScheduleEntries(
  employees: Employee[],
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[],
  allDuties: GeneratedDuty[],
  daysOrder: string[],
  planIssues: PlanIssue[],
  generatedShiftsByDay: Record<string, GeneratedShiftAssignment[]>
): AgentScheduleEntry[] {
  const requirementsById = new Map<string, StaffingRequirement>(requirements.map((r) => [r.id, r]));
  const flightsById = new Map<string, Flight>(flights.map((f) => [f.id, f]));

  // Issues are per-employee, and are either day-specific (rest_violation
  // carries dayOfWeek — the day rest was violated INTO) or week-level
  // (weekly_hours_violation has no single day it belongs to). Indexed once
  // here rather than re-filtering planIssues per employee x day.
  const issuesByEmployeeDay = new Map<string, PlanIssue[]>();
  const weeklyIssuesByEmployee = new Map<string, PlanIssue[]>();
  for (const issue of planIssues) {
    if (!issue.employeeId) continue; // needs_configuration/unfilled_duty belong to Flight Coverage, not an employee
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
      const confirmedAssignments = assignments.filter((a) => a.employee_id === employee.id);
      const confirmedRequirementIds = new Set(confirmedAssignments.map((a) => a.staffing_requirement_id));

      const duties = confirmedAssignments
        .map((a) => {
          const requirement = requirementsById.get(a.staffing_requirement_id);
          const flight = requirement ? flightsById.get(requirement.flight_id) : undefined;
          if (!requirement || !flight) return null;
          return {
            flightNumber: flight.flight_number,
            role: requirement.role,
            dayOfWeek: flight.day_of_week,
          };
        })
        .filter((d): d is { flightNumber: string; role: string; dayOfWeek: string } => Boolean(d));

      // Only the engine's proposals not already backed by a real,
      // confirmed Assignment row for this employee+requirement — same
      // dedupe rule the roster view applies per requirement.
      const proposedDuties = allDuties
        .filter((d) => d.employeeId === employee.id && !confirmedRequirementIds.has(d.requirementId))
        .map((d) => {
          const requirement = requirementsById.get(d.requirementId);
          const flight = requirement ? flightsById.get(requirement.flight_id) : undefined;
          if (!requirement || !flight) return null;
          return {
            flightNumber: flight.flight_number,
            role: d.role,
            dayOfWeek: flight.day_of_week,
          };
        })
        .filter((d): d is { flightNumber: string; role: string; dayOfWeek: string } => Boolean(d));

      // The actual day-by-day source of truth this employee's week is
      // built from — weekly_shifts (never the static shift_start/shift_end
      // fields, which only describe the employee's own baseline/most-recent
      // placement, not what any given day of THIS generated week holds).
      // One entry per day in daysOrder; a day composes several independent,
      // non-exclusive facts (shift, foreign commitment, RAM duties, issues)
      // rather than collapsing to one "day type".
      const foreignCommitmentsAll = getEmployeeForeignCommitments(employee.id, assignments, requirements, flights);

      const days: AgentDayEntry[] = daysOrder.map((day) => {
        const weeklyShift = employee.weekly_shifts.find((s) => s.day_of_week === day) ?? null;
        const isOff = !weeklyShift || weeklyShift.status === "off";

        // The REAL effective shift for this day — for a flexible General T1
        // Pool employee this is the freshly generated demand-driven shift
        // (Stage 6), not the static/uniform weekly_shifts baseline; for
        // everyone else (foreign-committed, fixed/specialized, Transit) it's
        // their real weekly_shifts entry, unchanged. This is exactly what
        // duty-generation.ts itself uses to decide who's even a candidate
        // that day, so the grid can never show a shift the plan didn't
        // actually use.
        const shiftCode = isOff ? null : effectiveShiftCodeForDay(employee, day, generatedShiftsByDay[day] ?? []);
        const shiftTimes = shiftCode ? getShiftTimesAs(shiftCode) : null;

        const dayDuties: AgentScheduleDuty[] = [];

        for (const a of confirmedAssignments) {
          const requirement = requirementsById.get(a.staffing_requirement_id);
          const flight = requirement ? flightsById.get(requirement.flight_id) : undefined;
          if (!requirement || !flight || flight.day_of_week !== day) continue;
          dayDuties.push({
            flightId: flight.id,
            flightNumber: flight.flight_number,
            role: requirement.role,
            window: getRequirementWindow(requirement, flight),
            status: "confirmed",
          });
        }

        for (const d of allDuties) {
          if (d.employeeId !== employee.id || confirmedRequirementIds.has(d.requirementId)) continue;
          const flight = flightsById.get(d.flightId);
          if (!flight || flight.day_of_week !== day) continue;
          dayDuties.push({
            flightId: flight.id,
            flightNumber: flight.flight_number,
            role: d.role,
            window: d.window,
            status: "assigned",
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

export function buildWeeklyPlanView(
  flights: Flight[],
  employees: Employee[],
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  config: Config,
  daysOrder: string[],
  weekLabel: string
): WeeklyPlanView {
  const draftPlan = generateDraftWeeklyPlan(flights, employees, assignments, config, daysOrder, weekLabel);
  const allDuties = Object.values(draftPlan.dutiesByDay).flat();

  const roster = buildRosterViews(requirements, flights, employees, assignments, allDuties);
  const schedule = buildAgentScheduleEntries(
    employees,
    assignments,
    requirements,
    flights,
    allDuties,
    daysOrder,
    draftPlan.issues,
    draftPlan.generatedShiftsByDay
  );

  return { draftPlan, roster, schedule };
}
