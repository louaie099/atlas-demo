"use client";

import { useState } from "react";
import { Flight } from "@/lib/types";
import { TeamBadge } from "./team-badge";
import { Badge, Button } from "./ui";

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

function EditFlightForm({ flight, onSaved, onCancel }: { flight: Flight; onSaved: () => void; onCancel: () => void }) {
  const [flightNumber, setFlightNumber] = useState(flight.flight_number);
  const [airline, setAirline] = useState(flight.airline);
  const [flightDate, setFlightDate] = useState(flight.flight_date);
  const [origin, setOrigin] = useState(flight.origin ?? "CMN");
  const [destination, setDestination] = useState(flight.destination ?? "");
  const [aircraft, setAircraft] = useState(flight.aircraft);
  const [departure, setDeparture] = useState(flight.scheduled_departure);
  const [bookingPressure, setBookingPressure] = useState<"normal" | "elevated">(flight.booking_pressure);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSave() {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/flights/${flight.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flight_number: flightNumber,
          airline,
          flight_date: flightDate,
          origin,
          destination,
          aircraft,
          scheduled_departure: departure,
          booking_pressure: bookingPressure,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save changes.");
        return;
      }
      onSaved();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-sm text-bad-700 bg-bad-50 rounded-lg px-3 py-2">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Flight number</span>
          <input className="border border-border rounded-lg px-3 py-2" value={flightNumber} onChange={(e) => setFlightNumber(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Airline</span>
          <input className="border border-border rounded-lg px-3 py-2" value={airline} onChange={(e) => setAirline(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Date</span>
          <input type="date" className="border border-border rounded-lg px-3 py-2" value={flightDate} onChange={(e) => setFlightDate(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Scheduled departure</span>
          <input type="time" className="border border-border rounded-lg px-3 py-2" value={departure} onChange={(e) => setDeparture(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Origin (IATA)</span>
          <input className="border border-border rounded-lg px-3 py-2 uppercase" value={origin} onChange={(e) => setOrigin(e.target.value.toUpperCase())} maxLength={3} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Destination (IATA)</span>
          <input
            className="border border-border rounded-lg px-3 py-2 uppercase"
            value={destination}
            onChange={(e) => setDestination(e.target.value.toUpperCase())}
            maxLength={3}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Aircraft</span>
          <input className="border border-border rounded-lg px-3 py-2" value={aircraft} onChange={(e) => setAircraft(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Booking pressure</span>
          <select
            className="border border-border rounded-lg px-3 py-2"
            value={bookingPressure}
            onChange={(e) => setBookingPressure(e.target.value as "normal" | "elevated")}
          >
            <option value="normal">Normal</option>
            <option value="elevated">Elevated</option>
          </select>
        </label>
      </div>
      <div className="flex gap-2">
        <Button onClick={handleSave} disabled={submitting}>
          {submitting ? "Saving…" : "Save changes"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Every field the flight record currently supports, planning-relevant
 * metadata included -- this is the source input for planning, so nothing
 * here is invented; a field with no data (e.g. gate, equipment code) is
 * simply omitted rather than shown as a placeholder.
 */
function FlightDetailPanel({ flight, onClose, onChanged }: { flight: Flight; onClose: () => void; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function handleRemove() {
    setRemoving(true);
    try {
      const res = await fetch(`/api/flights/${flight.id}`, { method: "DELETE" });
      if (res.ok) {
        onChanged();
        onClose();
      }
    } finally {
      setRemoving(false);
    }
  }

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
              <Badge tone="neutral">{flight.flight_date}</Badge>
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

        {editing ? (
          <EditFlightForm
            flight={flight}
            onSaved={() => {
              setEditing(false);
              onChanged();
              onClose();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
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
              Editing or removing it will mark the current Draft Weekly Plan out of date — click Make Planning to
              regenerate from the updated schedule.
            </p>

            <div className="flex gap-2 pt-2 border-t border-border">
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit Flight
              </Button>
              {confirmRemove ? (
                <>
                  <Button variant="danger" onClick={handleRemove} disabled={removing}>
                    {removing ? "Removing…" : "Confirm Remove"}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmRemove(false)} disabled={removing}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="danger" onClick={() => setConfirmRemove(true)}>
                  Remove Flight
                </Button>
              )}
            </div>
          </>
        )}
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
export function FlightScheduleView({ flights, onChanged }: { flights: Flight[]; onChanged: () => void }) {
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

      {selected && <FlightDetailPanel flight={selected} onClose={() => setSelected(null)} onChanged={onChanged} />}
    </div>
  );
}
