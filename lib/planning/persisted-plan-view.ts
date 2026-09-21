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
  AgentZoneDuty,
  ZoneCheckinRequirement,
  ZoneCheckinAssignment,
} from "../types";
import { buildRosterViewsFromItems, CoverageItem } from "./weekly-plan-view";
import { getRequirementWindow } from "./requirement-window";
import { getEmployeeForeignCommitments } from "../foreign-company-window";
import { getShiftTimesAs } from "../shift-templates";
import { PlanIssue } from "./validation";
import { CHECKIN_ZONES } from "../checkin-zones";

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
/**
 * ONE T1 Check-in zone requirement's coverage -- the zone-model analogue
 * of RosterRequirementView, kept as a genuinely separate type (never
 * merged into RosterRequirementView, whose `flight` field a zone
 * requirement has no single equivalent for -- see `contributingFlights`
 * below instead). `assignedEmployees`/`proposedEmployees` follow the exact
 * same human_modified/atlas_generated display-bucket convention as
 * RosterRequirementView.
 */
export interface ZoneCoverageView {
  requirement: ZoneCheckinRequirement;
  assignedEmployees: Employee[];
  proposedEmployees: Employee[];
  gap: number;
  contributingFlights: Flight[];
}

export interface PersistedWeeklyPlanView {
  plan: WeeklyPlan;
  flights: Flight[];
  roster: RosterRequirementView[];
  schedule: AgentScheduleEntry[];
  zoneCoverage: ZoneCoverageView[];
}

function buildZoneCoverageViews(
  zoneRequirements: ZoneCheckinRequirement[],
  zoneAssignments: ZoneCheckinAssignment[],
  employees: Employee[],
  flights: Flight[]
): ZoneCoverageView[] {
  const employeesById = new Map(employees.map((e) => [e.id, e]));
  const flightsById = new Map(flights.map((f) => [f.id, f]));

  const views: ZoneCoverageView[] = zoneRequirements.map((requirement) => {
    const forRequirement = zoneAssignments.filter((a) => a.zone_requirement_id === requirement.id);
    const assignedIds = Array.from(new Set(forRequirement.filter((a) => a.source === "human_modified").map((a) => a.employee_id)));
    const proposedIds = Array.from(
      new Set(forRequirement.filter((a) => a.source === "atlas_generated" && !assignedIds.includes(a.employee_id)).map((a) => a.employee_id))
    );
    const assignedEmployees = assignedIds.map((id) => employeesById.get(id)).filter((e): e is Employee => Boolean(e));
    const proposedEmployees = proposedIds.map((id) => employeesById.get(id)).filter((e): e is Employee => Boolean(e));
    const contributingFlights = requirement.contributingFlightIds.map((id) => flightsById.get(id)).filter((f): f is Flight => Boolean(f));

    return {
      requirement,
      assignedEmployees,
      proposedEmployees,
      gap: Math.max(0, requirement.required_headcount - assignedEmployees.length - proposedEmployees.length),
      contributingFlights,
    };
  });

  // Same display ordering convention as buildRosterViewsFromItems: day,
  // then window start, then a stable zone tie-break.
  views.sort((a, b) => {
    if (a.requirement.day_of_week !== b.requirement.day_of_week) return a.requirement.day_of_week.localeCompare(b.requirement.day_of_week);
    if (a.requirement.window_start !== b.requirement.window_start) return a.requirement.window_start.localeCompare(b.requirement.window_start);
    return a.requirement.zone.localeCompare(b.requirement.zone);
  });

  return views;
}

export function buildPersistedWeeklyPlanView(
  plan: WeeklyPlan,
  rosterEntries: WeeklyPlanRosterEntry[],
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[],
  employees: Employee[],
  daysOrder: string[],
  zoneRequirements: ZoneCheckinRequirement[] = [],
  zoneAssignments: ZoneCheckinAssignment[] = []
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
  const schedule = buildPersistedAgentScheduleEntries(
    employees,
    assignments,
    requirements,
    flights,
    daysOrder,
    plan.issues,
    rosterEntries,
    plan.config_snapshot.checkin_demand_policy,
    zoneAssignments,
    zoneRequirements
  );
  const zoneCoverage = buildZoneCoverageViews(zoneRequirements, zoneAssignments, employees, flights);

  return { plan, flights, roster, schedule, zoneCoverage };
}

function buildPersistedAgentScheduleEntries(
  employees: Employee[],
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[],
  daysOrder: string[],
  planIssues: PlanIssue[],
  rosterEntries: WeeklyPlanRosterEntry[],
  checkinPolicy: import("./checkin-demand").CheckinDemandPolicy,
  zoneAssignments: ZoneCheckinAssignment[] = [],
  zoneRequirements: ZoneCheckinRequirement[] = []
): AgentScheduleEntry[] {
  const requirementsById = new Map<string, StaffingRequirement>(requirements.map((r) => [r.id, r]));
  const flightsById = new Map<string, Flight>(flights.map((f) => [f.id, f]));
  const rosterByEmployeeDay = new Map<string, WeeklyPlanRosterEntry>(
    rosterEntries.map((r) => [`${r.employee_id}|${r.day_of_week}`, r])
  );
  const zoneRequirementsById = new Map<string, ZoneCheckinRequirement>(zoneRequirements.map((r) => [r.id, r]));
  const zoneAssignmentsByEmployee = new Map<string, ZoneCheckinAssignment[]>();
  for (const za of zoneAssignments) {
    zoneAssignmentsByEmployee.set(za.employee_id, [...(zoneAssignmentsByEmployee.get(za.employee_id) ?? []), za]);
  }

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
            window: getRequirementWindow(requirement, flight, checkinPolicy),
            status: a.source === "human_modified" ? "confirmed" : "assigned",
          });
        }
        dayDuties.sort((a, b) => a.window.start.localeCompare(b.window.start));

        const zoneDuties: AgentZoneDuty[] = (zoneAssignmentsByEmployee.get(employee.id) ?? [])
          .map((za) => {
            const requirement = zoneRequirementsById.get(za.zone_requirement_id);
            if (!requirement || requirement.day_of_week !== day) return null;
            return {
              zone: requirement.zone,
              window: { start: za.window_start, end: za.window_end },
              status: (za.source === "human_modified" ? "confirmed" : "assigned") as "confirmed" | "assigned",
            };
          })
          .filter((d): d is AgentZoneDuty => d !== null)
          .sort((a, b) => a.window.start.localeCompare(b.window.start));

        return {
          dayOfWeek: day,
          status: isOff ? "off" : "working",
          shiftCode,
          shiftStart: shiftTimes?.shift_start ?? null,
          shiftEnd: shiftTimes?.shift_end ?? null,
          foreignCommitments: foreignCommitmentsAll.filter((c) => c.dayOfWeek === day),
          duties: dayDuties,
          zoneDuties,
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
