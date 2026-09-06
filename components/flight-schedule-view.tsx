"use client";

import { useState } from "react";
import { Flight } from "@/lib/types";
import { TeamBadge } from "./team-badge";
import { Badge } from "./ui";

const DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function groupByDay(flights: Flight[]): { day: string; flights: Flight[] }[] {
  const byDay = new Map<string, Flight[]>();
  for (const f of flights) {
    byDay.set(f.day_of_week, [...(byDay.get(f.day_of_week) ?? []), f]);
  }
  return DAY_ORDER.filter((d) => byDay.has(d)).map((day) => ({
    day,
    flights: [...byDay.get(day)!].sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure)),
  }));
}

/**
 * One compact row -- the raw operational program, answering "what flights
 * are scheduled?", not "who's staffed on them" (that's Flight Coverage).
 * Deliberately no staffing badges here at all, managed or not -- this view
 * shows every scheduled flight identically regardless of whether ATLAS
 * generates workforce coverage for it.
 */
function FlightScheduleRow({ flight, onClick }: { flight: Flight; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 flex-wrap px-4 py-2.5 text-left hover:bg-surface rounded-xl2 bg-card border border-border shadow-soft"
    >
      <span className="text-xs font-medium text-muted w-12 shrink-0">{flight.scheduled_departure}</span>
      <span className="font-semibold text-ink">{flight.flight_number}</span>
      <span className="text-sm text-ink">{flight.route}</span>
      <span className="text-sm text-muted">{flight.aircraft}</span>
      <TeamBadge name={flight.airline} />
      <span className="ml-auto text-xs text-muted">Detail →</span>
    </button>
  );
}

/**
 * Passenger load display. Deliberately defensive: passenger data is
 * currently synthetic demo data (see lib/flight-generator.ts) but this
 * field is also the intended landing spot for real imported/API figures
 * later, so this must never render "undefined", "NaN", or "0/0" no matter
 * where the numbers came from — genuinely missing or malformed data always
 * reads as the neutral "Not available" instead of a broken calculation.
 */
function loadFactorLabel(flight: Flight): string {
  const { booked_passengers, seat_capacity } = flight;
  if (
    booked_passengers === null ||
    booked_passengers === undefined ||
    seat_capacity === null ||
    seat_capacity === undefined ||
    !Number.isFinite(booked_passengers) ||
    !Number.isFinite(seat_capacity) ||
    seat_capacity <= 0 ||
    booked_passengers < 0
  ) {
    return "Not available";
  }
  const pct = Math.round((booked_passengers / seat_capacity) * 100);
  return `${booked_passengers} / ${seat_capacity} passengers · ${pct}%`;
}

function FlightDetailField({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-semibold text-muted uppercase tracking-wide">{label}</span>
      <span className="text-sm text-ink">{value}</span>
    </div>
  );
}

/**
 * Every field the flight record currently supports, planning-relevant
 * metadata included -- this is the source input for planning, so nothing
 * here is invented; a field with no data (e.g. gate, equipment code) is
 * simply omitted rather than shown as a placeholder.
 */
function FlightDetailPanel({ flight, onClose }: { flight: Flight; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={onClose}>
      <div
        className="w-full max-w-md h-full bg-card shadow-soft overflow-y-auto p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold text-ink text-lg">{flight.flight_number}</h3>
            <div className="flex items-center gap-2 mt-1">
              <TeamBadge name={flight.airline} />
              <Badge tone="neutral">{flight.day_of_week}</Badge>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-ink text-sm px-2 py-1 rounded-lg hover:bg-surface"
          >
            Close
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FlightDetailField label="Route" value={flight.route} />
          <FlightDetailField label="Aircraft" value={flight.aircraft} />
          <FlightDetailField label="Scheduled departure" value={flight.scheduled_departure} />
          <FlightDetailField label="Scheduled arrival" value={flight.scheduled_arrival} />
          <FlightDetailField label="Terminal" value={flight.terminal} />
          <FlightDetailField label="Gate" value={flight.gate} />
          <FlightDetailField label="Equipment code" value={flight.equipment_code} />
          <FlightDetailField label="Registration" value={flight.registration} />
          <FlightDetailField
            label="Operator"
            value={flight.operator_type === "atlas_managed" ? "ATLAS-managed (RAM Handling)" : "Self-managed (airline handles internal task distribution)"}
          />
          <FlightDetailField label="Destination category" value={flight.destination_category} />
          <FlightDetailField label="Booking pressure" value={flight.booking_pressure} />
          <FlightDetailField label="Passenger load" value={loadFactorLabel(flight)} />
          <FlightDetailField label="Boarding window" value={flight.boarding_window_start && flight.boarding_window_end ? `${flight.boarding_window_start}–${flight.boarding_window_end}` : null} />
        </div>

        <p className="text-xs text-muted">
          This is the raw scheduled flight. See Flight Coverage for ATLAS's generated staffing for it, if any.
        </p>
      </div>
    </div>
  );
}

/**
 * The raw operational program for the selected week -- "what flights are
 * scheduled?", never staffing coverage. Every scheduled flight appears
 * here regardless of whether it's ATLAS-managed or a foreign carrier, and
 * regardless of whether ATLAS generates any workforce coverage for it —
 * that distinction belongs to Flight Coverage, not this view.
 */
export function FlightScheduleView({ flights }: { flights: Flight[] }) {
  const [selected, setSelected] = useState<Flight | null>(null);
  const groups = groupByDay(flights);

  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <div key={g.day} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">{g.day}</h2>
          <div className="flex flex-col gap-2">
            {g.flights.map((f) => (
              <FlightScheduleRow key={f.id} flight={f} onClick={() => setSelected(f)} />
            ))}
          </div>
        </div>
      ))}

      {selected && <FlightDetailPanel flight={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
