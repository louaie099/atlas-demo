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
import { flightDateFor } from "../flight-date";
import { PlanIssue } from "./validation";
import { CheckinZoneId, CHECKIN_ZONES, ORDINARY_CHECKIN_ZONES } from "../checkin-zones";
import {
  buildEligibleEmployeeAvailabilityForDay,
  buildZoneCoverageRowsForDay,
  buildDailyCapacityTimeline,
  buildEmployeeZoneAvailabilitySegments,
} from "./checkin-capacity-timeline";

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
 * ONE T1 Check-in zone/day/time-window's coverage — the zone-model
 * analogue of RosterRequirementView. 2026-09-23 architecture refactor: this
 * used to be built by counting `checkin_zone_assignments` rows against a
 * SINGLE persisted `ZoneCheckinRequirement` row (`assignedEmployees.length
 * + proposedEmployees.length` vs `requirement.required_headcount`) — the
 * "Assigned" side of that computation was exactly the bug (see
 * lib/planning/checkin-capacity-timeline.ts's module doc comment). It is
 * now built from the DERIVED capacity timeline: `required`/`available` are
 * real, atomic-interval-correct numbers computed at read time from the
 * roster + persisted specific-duty assignments, never from a discrete
 * automatic "assignment" row. `manuallyAssigned`/`manuallyAssignedEmployees`
 * are the one thing that DOES remain a real persisted row: a genuine human
 * Find Agent commitment (`checkin_zone_assignments`, source:
 * "human_modified"). `zoneRequirementId` is the FK target a Find Agent
 * action against THIS row should post to — resolved by a real overlap
 * check against the persisted demand-cluster rows (never a "first
 * requirement for this zone/day" fallback — that exact pattern was the
 * bug), and is null when this row has no persisted demand cluster to
 * attach to (a pure-surplus row, where "Find Agent" makes no sense anyway
 * since there is no gap).
 */
export interface ZoneCoverageView {
  id: string;
  zone: CheckinZoneId;
  dayOfWeek: string;
  windowStart: string;
  windowEnd: string;
  required: number;
  available: number;
  manuallyAssigned: number;
  gap: number;
  surplus: number;
  reasoning: string;
  contributingFlights: Flight[];
  availableEmployees: Employee[];
  manuallyAssignedEmployees: Employee[];
  zoneRequirementId: string | null;
}

export interface PersistedWeeklyPlanView {
  plan: WeeklyPlan;
  flights: Flight[];
  roster: RosterRequirementView[];
  schedule: AgentScheduleEntry[];
  zoneCoverage: ZoneCoverageView[];
}

function timeToMinutesForZoneOverlap(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function zoneWindowsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return (
    timeToMinutesForZoneOverlap(aStart) < timeToMinutesForZoneOverlap(bEnd) &&
    timeToMinutesForZoneOverlap(bStart) < timeToMinutesForZoneOverlap(aEnd)
  );
}

/**
 * Builds this plan's zone coverage views for every day, combining:
 *  - ORDINARY zones (Main/Italy-Spain/Domestic): the derived
 *    Required/Available atomic-interval timeline
 *    (checkin-capacity-timeline.ts), reconstructed purely from
 *    already-persisted rosterEntries + assignments + flights — never from a
 *    checkin_zone_assignments row.
 *  - MANUAL zones (Business/Staff/Oversized Baggage): these never receive
 *    automatic demand or default-placement capacity (see
 *    lib/checkin-zones.ts's ORDINARY_CHECKIN_ZONES) — any coverage view for
 *    them comes directly from a human/config-entered `checkin_zone_requirements`
 *    row (`source: "manual"`), with `available` always 0 and
 *    `manuallyAssigned` from any human_modified assignment against it.
 */
function buildZoneCoverageViews(
  daysOrder: string[],
  weekStart: string,
  zoneRequirements: ZoneCheckinRequirement[],
  zoneAssignments: ZoneCheckinAssignment[],
  employees: Employee[],
  flights: Flight[],
  rosterEntries: WeeklyPlanRosterEntry[],
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  checkinPolicy: import("./checkin-demand").CheckinDemandPolicy,
  zonePolicy?: import("./checkin-zone-demand").ZoneCheckinDemandPolicy
): ZoneCoverageView[] {
  const employeesById = new Map(employees.map((e) => [e.id, e]));
  const flightsById = new Map(flights.map((f) => [f.id, f]));
  const humanZoneAssignments = zoneAssignments.filter((a) => a.source === "human_modified");

  const views: ZoneCoverageView[] = [];

  for (const day of daysOrder) {
    const dayRequirements = zoneRequirements.filter((r) => r.day_of_week === day);

    const findOverlappingRequirementId = (zone: CheckinZoneId, start: string, end: string): string | null => {
      const overlapping = dayRequirements.filter((r) => r.zone === zone && zoneWindowsOverlap(r.window_start, r.window_end, start, end));
      if (overlapping.length === 0) return null;
      // Real overlap check (never "first row for this zone/day" — that was
      // the bug). Several persisted clusters can overlap the same derived
      // row only at a bucket boundary; the one with the LARGEST
      // required_headcount is the most representative real demand driver.
      overlapping.sort((a, b) => b.required_headcount - a.required_headcount);
      return overlapping[0].id;
    };

    const manuallyAssignedFor = (zoneRequirementId: string | null): Employee[] => {
      if (!zoneRequirementId) return [];
      const ids = Array.from(new Set(humanZoneAssignments.filter((a) => a.zone_requirement_id === zoneRequirementId).map((a) => a.employee_id)));
      return ids.map((id) => employeesById.get(id)).filter((e): e is Employee => Boolean(e));
    };

    // ORDINARY zones — derived Required/Available timeline.
    const eligibleAvailability = buildEligibleEmployeeAvailabilityForDay(
      day,
      employees,
      rosterEntries,
      assignments,
      requirements,
      flights,
      checkinPolicy,
      flightDateFor(weekStart, day)
    );
    const rowsByZone = buildZoneCoverageRowsForDay(day, flights, eligibleAvailability, zonePolicy);

    for (const zone of ORDINARY_CHECKIN_ZONES) {
      for (const row of rowsByZone[zone] ?? []) {
        const zoneRequirementId = findOverlappingRequirementId(zone, row.start, row.end);
        const manuallyAssignedEmployees = manuallyAssignedFor(zoneRequirementId);
        const manuallyAssigned = manuallyAssignedEmployees.length;
        const availableEmployees = row.availableEmployeeIds.map((id) => employeesById.get(id)).filter((e): e is Employee => Boolean(e));
        const contributingFlights = row.contributingFlightIds.map((id) => flightsById.get(id)).filter((f): f is Flight => Boolean(f));
        const matchedRequirement = zoneRequirementId ? dayRequirements.find((r) => r.id === zoneRequirementId) : undefined;

        views.push({
          id: `zonecov-${day}-${zone}-${row.start}-${row.end}`.replace(/:/g, ""),
          zone,
          dayOfWeek: day,
          windowStart: row.start,
          windowEnd: row.end,
          required: row.required,
          available: row.available,
          manuallyAssigned,
          gap: Math.max(0, row.required - row.available - manuallyAssigned),
          surplus: Math.max(0, row.available + manuallyAssigned - row.required),
          reasoning:
            matchedRequirement?.reasoning ??
            `Derived T1 Check-in capacity for ${row.start}–${row.end}: ${row.available} eligible employee(s) have no specific flight/specialized duty during this atomic interval while rostered WORK (see lib/planning/checkin-capacity-timeline.ts).`,
          contributingFlights,
          availableEmployees,
          manuallyAssignedEmployees,
          zoneRequirementId,
        });
      }
    }

    // MANUAL zones (Business/Staff/Oversized Baggage) — never part of the
    // automatic derived timeline; any coverage view for them comes
    // straight from a persisted (human/config-entered) requirement row.
    for (const requirement of dayRequirements.filter((r) => !ORDINARY_CHECKIN_ZONES.includes(r.zone))) {
      const manuallyAssignedEmployees = manuallyAssignedFor(requirement.id);
      const manuallyAssigned = manuallyAssignedEmployees.length;
      const contributingFlights = requirement.contributingFlightIds.map((id) => flightsById.get(id)).filter((f): f is Flight => Boolean(f));

      views.push({
        id: requirement.id,
        zone: requirement.zone,
        dayOfWeek: requirement.day_of_week,
        windowStart: requirement.window_start,
        windowEnd: requirement.window_end,
        required: requirement.required_headcount,
        available: 0,
        manuallyAssigned,
        gap: Math.max(0, requirement.required_headcount - manuallyAssigned),
        surplus: Math.max(0, manuallyAssigned - requirement.required_headcount),
        reasoning: requirement.reasoning,
        contributingFlights,
        availableEmployees: [],
        manuallyAssignedEmployees,
        zoneRequirementId: requirement.id,
      });
    }
  }

  views.sort((a, b) => {
    if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek.localeCompare(b.dayOfWeek);
    if (a.windowStart !== b.windowStart) return a.windowStart.localeCompare(b.windowStart);
    return a.zone.localeCompare(b.zone);
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
    plan.week_start,
    plan.issues,
    rosterEntries,
    plan.config_snapshot.checkin_demand_policy,
    zoneAssignments,
    zoneRequirements,
    plan.config_snapshot.zone_checkin_demand_policy
  );
  const zoneCoverage = buildZoneCoverageViews(
    daysOrder,
    plan.week_start,
    zoneRequirements,
    zoneAssignments,
    employees,
    flights,
    rosterEntries,
    assignments,
    requirements,
    plan.config_snapshot.checkin_demand_policy,
    plan.config_snapshot.zone_checkin_demand_policy
  );

  return { plan, flights, roster, schedule, zoneCoverage };
}

function buildPersistedAgentScheduleEntries(
  employees: Employee[],
  assignments: Assignment[],
  requirements: StaffingRequirement[],
  flights: Flight[],
  daysOrder: string[],
  weekStart: string,
  planIssues: PlanIssue[],
  rosterEntries: WeeklyPlanRosterEntry[],
  checkinPolicy: import("./checkin-demand").CheckinDemandPolicy,
  zoneAssignments: ZoneCheckinAssignment[] = [],
  zoneRequirements: ZoneCheckinRequirement[] = [],
  zonePolicy?: import("./checkin-zone-demand").ZoneCheckinDemandPolicy
): AgentScheduleEntry[] {
  const requirementsById = new Map<string, StaffingRequirement>(requirements.map((r) => [r.id, r]));
  const flightsById = new Map<string, Flight>(flights.map((f) => [f.id, f]));
  const rosterByEmployeeDay = new Map<string, WeeklyPlanRosterEntry>(
    rosterEntries.map((r) => [`${r.employee_id}|${r.day_of_week}`, r])
  );
  const zoneRequirementsById = new Map<string, ZoneCheckinRequirement>(zoneRequirements.map((r) => [r.id, r]));
  // Only genuine human Find Agent commitments are ever persisted as
  // checkin_zone_assignments now (source: "human_modified" — see
  // weekly-plan-service.ts's buildDraftPlanBundle doc comment); any
  // pre-2026-09-23 "atlas_generated" row left over in an old, un-regenerated
  // plan is intentionally ignored here rather than displayed as a
  // "confirmed" duty it never was.
  const humanZoneAssignments = zoneAssignments.filter((za) => za.source === "human_modified");
  const zoneAssignmentsByEmployee = new Map<string, ZoneCheckinAssignment[]>();
  for (const za of humanZoneAssignments) {
    zoneAssignmentsByEmployee.set(za.employee_id, [...(zoneAssignmentsByEmployee.get(za.employee_id) ?? []), za]);
  }

  // DERIVED default T1 coverage — one shared atomic-interval timeline
  // computed ONCE per day (never per employee), reused for every
  // employee's Agent Schedule row that day. See
  // lib/planning/checkin-capacity-timeline.ts's module doc comment for why
  // this replaces the old persisted "atlas_generated" checkin_zone_assignments
  // rows entirely.
  const derivedPeriodsByDay = new Map<string, ReturnType<typeof buildDailyCapacityTimeline>>();
  for (const day of daysOrder) {
    const eligibleAvailability = buildEligibleEmployeeAvailabilityForDay(
      day,
      employees,
      rosterEntries,
      assignments,
      requirements,
      flights,
      checkinPolicy,
      flightDateFor(weekStart, day)
    );
    derivedPeriodsByDay.set(day, buildDailyCapacityTimeline(day, flights, eligibleAvailability, zonePolicy));
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
        const shiftTimes = shiftCode ? getShiftTimesAs(shiftCode, flightDateFor(weekStart, day)) : null;

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

        // CONFIRMED — real human Find Agent commitments. Looked up by
        // requirement's own day_of_week (a zone requirement doesn't carry
        // a redundant day field on the assignment itself), same as before.
        const confirmedZoneDuties: AgentZoneDuty[] = (zoneAssignmentsByEmployee.get(employee.id) ?? [])
          .map((za): AgentZoneDuty | null => {
            const requirement = zoneRequirementsById.get(za.zone_requirement_id);
            if (!requirement || requirement.day_of_week !== day) return null;
            return {
              zone: requirement.zone,
              window: { start: za.window_start, end: za.window_end },
              status: "confirmed",
            };
          })
          .filter((d): d is AgentZoneDuty => d !== null);

        // AVAILABLE — derived default T1 coverage, never a persisted duty
        // (see checkin-capacity-timeline.ts). Only rendered for a working
        // day; an OFF day has no shift to derive availability from.
        const derivedZoneDuties: AgentZoneDuty[] = isOff
          ? []
          : buildEmployeeZoneAvailabilitySegments(employee.id, derivedPeriodsByDay.get(day) ?? []).map((segment) => ({
              zone: segment.zone,
              window: { start: segment.start, end: segment.end },
              status: "available" as const,
            }));

        const zoneDuties: AgentZoneDuty[] = [...confirmedZoneDuties, ...derivedZoneDuties].sort((a, b) =>
          a.window.start.localeCompare(b.window.start)
        );

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
