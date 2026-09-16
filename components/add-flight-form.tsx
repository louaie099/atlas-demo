"use client";

import { useState } from "react";
import { Button, Card } from "./ui";

/**
 * Add Flight -- collects only what the planning engine actually needs
 * (identity, route, timing, aircraft). destination_category and
 * operator_type are ALWAYS derived server-side from what's submitted
 * here (see app/api/flights/route.ts) -- this form never asks for a
 * staffing number, a role, or a classification the person would
 * otherwise have to guess.
 */
export function AddFlightForm({ weekStart, onAdded }: { weekStart: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [flightNumber, setFlightNumber] = useState("");
  const [airline, setAirline] = useState("Royal Air Maroc");
  const [flightDate, setFlightDate] = useState(weekStart);
  const [origin, setOrigin] = useState("CMN");
  const [destination, setDestination] = useState("");
  const [aircraft, setAircraft] = useState("Boeing 737-800");
  const [departure, setDeparture] = useState("10:00");
  const [bookingPressure, setBookingPressure] = useState<"normal" | "elevated">("normal");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    if (!flightNumber.trim() || !destination.trim()) {
      setError("Flight number and destination are required.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/flights", {
        method: "POST",
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
        setError(data.error ?? "Failed to add flight.");
        return;
      }
      setFlightNumber("");
      setDestination("");
      onAdded();
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} className="self-start">
        + Add Flight
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <h3 className="font-semibold text-ink">Add Flight</h3>

      {error && <p className="text-sm text-bad-700 bg-bad-50 rounded-lg px-3 py-2">{error}</p>}

      <div className="grid sm:grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Flight number</span>
          <input
            className="border border-border rounded-lg px-3 py-2"
            value={flightNumber}
            onChange={(e) => setFlightNumber(e.target.value)}
            placeholder="e.g. AT650"
          />
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
          <input
            className="border border-border rounded-lg px-3 py-2 uppercase"
            value={origin}
            onChange={(e) => setOrigin(e.target.value.toUpperCase())}
            maxLength={3}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Destination (IATA)</span>
          <input
            className="border border-border rounded-lg px-3 py-2 uppercase"
            value={destination}
            onChange={(e) => setDestination(e.target.value.toUpperCase())}
            placeholder="e.g. MAD"
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

      <p className="text-xs text-muted">
        Staffing requirements are calculated automatically by ATLAS from this flight's route, aircraft, and rules the
        next time Make Planning runs — nothing here is a staffing number.
      </p>

      <div className="flex gap-2">
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? "Adding…" : "Add Flight"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
