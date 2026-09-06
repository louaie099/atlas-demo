import { AgentDayEntry, AgentScheduleDuty } from "@/lib/types";
import { Badge } from "./ui";
import { TeamBadge } from "./team-badge";

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(mins: number): string {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

type Segment = { start: string; end: string; label: string; tone: "foreign" | "confirmed" | "proposed" | "available" };

const SEGMENT_STYLE: Record<Segment["tone"], string> = {
  foreign: "bg-warn-500/70",
  confirmed: "bg-good-500/80",
  proposed: "bg-brand-500/70",
  // "Available" is a real, positive fact -- capacity RAM/General T1 can
  // still draw on -- never rendered as an empty/idle-looking gap (see
  // lib/planning/validation.ts's PlanIssue types: unassigned time is not a
  // problem to flag, since full General T1 Check-in/Weight-Control demand
  // isn't modeled yet).
  available: "bg-gray-200",
};

/**
 * Builds the chronological, composable picture of one working day: the
 * employee's foreign-company protected window (if any) and every RAM duty
 * (confirmed or proposed), in real time order, with the remaining shift
 * time between/around them labeled as available capacity -- never "idle".
 * Pure derivation from the same AgentDayEntry the grid cell already shows;
 * no new data, no invented duties or windows.
 */
function buildTimeline(day: AgentDayEntry): Segment[] {
  if (!day.shiftStart || !day.shiftEnd) return [];

  const shiftStartMin = timeToMinutes(day.shiftStart);
  let shiftEndMin = timeToMinutes(day.shiftEnd);
  if (shiftEndMin <= shiftStartMin) shiftEndMin += 1440; // overnight shift

  type Event = { startMin: number; endMin: number; label: string; tone: Segment["tone"] };
  const events: Event[] = [];

  for (const c of day.foreignCommitments) {
    let s = timeToMinutes(c.window.start);
    let e = timeToMinutes(c.window.end);
    if (s < shiftStartMin) s += 1440;
    if (e <= s) e += 1440;
    events.push({ startMin: s, endMin: e, label: `${c.airline} protected`, tone: "foreign" });
  }
  for (const d of day.duties) {
    let s = timeToMinutes(d.window.start);
    let e = timeToMinutes(d.window.end);
    if (s < shiftStartMin) s += 1440;
    if (e <= s) e += 1440;
    events.push({
      startMin: s,
      endMin: e,
      label: `${d.flightNumber} ${d.role}${d.status === "proposed" ? " (proposed)" : ""}`,
      tone: d.status,
    });
  }

  events.sort((a, b) => a.startMin - b.startMin);

  const segments: Segment[] = [];
  let cursor = shiftStartMin;
  for (const e of events) {
    const start = Math.max(e.startMin, cursor);
    if (start > cursor) {
      segments.push({ start: minutesToTime(cursor), end: minutesToTime(start), label: "Available to RAM / General T1", tone: "available" });
    }
    segments.push({ start: minutesToTime(e.startMin), end: minutesToTime(e.endMin), label: e.label, tone: e.tone });
    cursor = Math.max(cursor, e.endMin);
  }
  if (cursor < shiftEndMin) {
    segments.push({ start: minutesToTime(cursor), end: minutesToTime(shiftEndMin), label: "Available to RAM / General T1", tone: "available" });
  }

  return segments;
}

function DutyRow({ duty }: { duty: AgentScheduleDuty }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm bg-surface rounded-lg px-3 py-2">
      <div>
        <span className="font-medium text-ink">{duty.flightNumber}</span>{" "}
        <span className="text-muted">· {duty.role}</span>{" "}
        <span className="text-xs text-muted">
          ({duty.window.start}–{duty.window.end})
        </span>
      </div>
      <Badge tone={duty.status === "proposed" ? "brand" : "good"}>
        {duty.status === "proposed" ? "Proposed" : "Confirmed"}
      </Badge>
    </div>
  );
}

export function AgentDayDetail({ day }: { day: AgentDayEntry }) {
  const timeline = buildTimeline(day);
  const totalSpanMin =
    timeline.length > 0
      ? Math.max(1, timeToMinutes(timeline[timeline.length - 1].end) - timeToMinutes(timeline[0].start) || 1440)
      : 0;

  if (day.status === "off") {
    return (
      <div className="flex flex-col gap-2">
        <Badge tone="neutral">OFF</Badge>
        <p className="text-sm text-muted">Not rostered this day.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge tone="neutral">{day.shiftCode ?? "Shift"}</Badge>
        {day.shiftStart && day.shiftEnd && (
          <span className="text-sm text-muted">
            {day.shiftStart}–{day.shiftEnd}
          </span>
        )}
      </div>

      {timeline.length > 0 && (
        <div>
          <div className="flex h-7 rounded-lg overflow-hidden border border-border">
            {timeline.map((seg, i) => {
              const span = (timeToMinutes(seg.end) - timeToMinutes(seg.start) + 1440) % 1440 || 1440;
              const width = totalSpanMin > 0 ? (span / totalSpanMin) * 100 : 100 / timeline.length;
              return (
                <div
                  key={i}
                  className={SEGMENT_STYLE[seg.tone]}
                  style={{ width: `${width}%` }}
                  title={`${seg.label} (${seg.start}–${seg.end})`}
                />
              );
            })}
          </div>
          <div className="flex flex-col gap-1 mt-2">
            {timeline.map((seg, i) => (
              <p key={i} className="text-xs text-muted">
                <span className="font-medium text-ink">
                  {seg.start}–{seg.end}
                </span>{" "}
                {seg.label}
              </p>
            ))}
          </div>
        </div>
      )}

      {day.foreignCommitments.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold text-muted uppercase tracking-wide">Foreign-company commitment</h4>
          {day.foreignCommitments.map((c) => (
            <div key={c.flightId} className="flex items-center gap-2 text-sm">
              <TeamBadge name={c.airline} />
              <span className="text-muted">
                {c.flightNumber} · protected {c.window.start}–{c.window.end}
              </span>
            </div>
          ))}
        </div>
      )}

      {day.duties.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold text-muted uppercase tracking-wide">RAM duties</h4>
          <div className="flex flex-col gap-1.5">
            {day.duties.map((d, i) => (
              <DutyRow key={i} duty={d} />
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">
          No flight duty generated for this day yet — available to RAM / General T1.
        </p>
      )}

      {day.issues.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold text-muted uppercase tracking-wide">Plan warnings</h4>
          {day.issues.map((issue, i) => (
            <p key={i} className="text-xs text-bad-700 bg-bad-50 rounded-lg px-3 py-2">
              {issue.description}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
