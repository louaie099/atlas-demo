import {
  Employee,
  Flight,
  StaffingRequirement,
  Assignment,
  Config,
  RosterRequirementView,
  RequirementCoverageStatus,
  AgentScheduleEntry,
} from "../types";
import { generateDraftWeeklyPlan, DraftWeeklyPlan } from "./generate-draft-plan";
import { GeneratedDuty } from "./duty-generation";

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
  if (requirement.needs_configuration) return "needs_configuration";
  const total = confirmedCount + proposedCount;
  if (total >= requirement.total_requirement) {
    // Fully covered by real, confirmed assignments alone → covered.
    // Covered only with the help of the engine's proposals → proposed,
    // an honestly distinct state — it's what the draft plan suggests,
    // not yet a human-confirmed assignment.
    return confirmedCount >= requirement.total_requirement ? "covered" : "proposed";
  }
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

  const views: RosterRequirementView[] = requirements.map((req) => {
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

    const gap = req.needs_configuration
      ? 0
      : Math.max(0, req.total_requirement - assignedEmployees.length - proposedEmployees.length);

    return {
      requirement: req,
      flight,
      assignedEmployees,
      proposedEmployees,
      gap,
      coverageStatus: computeCoverageStatus(req, assignedEmployees.length, proposedEmployees.length),
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
  allDuties: GeneratedDuty[]
): AgentScheduleEntry[] {
  const requirementsById = new Map<string, StaffingRequirement>(requirements.map((r) => [r.id, r]));
  const flightsById = new Map<string, Flight>(flights.map((f) => [f.id, f]));

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

      return {
        employee,
        dayOff: employee.off_days.length > 0,
        duties,
        proposedDuties,
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
  const schedule = buildAgentScheduleEntries(employees, assignments, requirements, flights, allDuties);

  return { draftPlan, roster, schedule };
}
