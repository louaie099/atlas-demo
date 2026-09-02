"use client";

import { useState } from "react";
import { Button, Card } from "./ui";

export function AddFlightForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [flightNumber, setFlightNumber] = useState("");
  const [airline, setAirline] = useState("Royal Air Maroc");
  const [route, setRoute] = useState("");
  const [aircraft, setAircraft] = useState("Boeing 737-800");
  const [departure, setDeparture] = useState("10:00");
  const [role, setRole] = useState<"Boarding" | "Check-in/ACE">("Boarding");
  const [boardingBaseline, setBoardingBaseline] = useState(3);
  const [bookingPressure, setBookingPressure] = useState<"normal" | "elevated">("normal");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    if (!flightNumber.trim() || !route.trim()) {
      setError("Flight number and route are required.");
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
          route,
          aircraft,
          scheduled_departure: departure,
          role,
          boarding_baseline: boardingBaseline,
          booking_pressure: bookingPressure,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to add flight.");
        return;
      }
      setFlightNumber("");
      setRoute("");
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
          <span className="text-muted">Route</span>
          <input
            className="border border-border rounded-lg px-3 py-2"
            value={route}
            onChange={(e) => setRoute(e.target.value)}
            placeholder="e.g. CMN → MAD"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Airline</span>
          <input
            className="border border-border rounded-lg px-3 py-2"
            value={airline}
            onChange={(e) => setAirline(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Aircraft</span>
          <input
            className="border border-border rounded-lg px-3 py-2"
            value={aircraft}
            onChange={(e) => setAircraft(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Scheduled departure</span>
          <input
            type="time"
            className="border border-border rounded-lg px-3 py-2"
            value={departure}
            onChange={(e) => setDeparture(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted">Staffing role for this flight</span>
          <select
            className="border border-border rounded-lg px-3 py-2"
            value={role}
            onChange={(e) => setRole(e.target.value as "Boarding" | "Check-in/ACE")}
          >
            <option value="Boarding">Boarding (fixed rule)</option>
            <option value="Check-in/ACE">Check-in/ACE (demand forecast)</option>
          </select>
        </label>

        {role === "Boarding" ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Boarding agents required (fixed rule)</span>
            <input
              type="number"
              className="border border-border rounded-lg px-3 py-2"
              value={boardingBaseline}
              onChange={(e) => setBoardingBaseline(Number(e.target.value))}
            />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted">Booking pressure</span>
            <select
              className="border border-border rounded-lg px-3 py-2"
              value={bookingPressure}
              onChange={(e) => setBookingPressure(e.target.value as "normal" | "elevated")}
            >
              <option value="normal">Normal — baseline requirement only</option>
              <option value="elevated">Elevated — Planning Engine adds overbooking reinforcement</option>
            </select>
          </label>
        )}
      </div>

      <p className="text-xs text-muted">
        The staffing requirement is calculated automatically using the same Planning Engine logic
        as the rest of the demo — Boarding is always a fixed rule, Check-in/ACE responds to booking
        pressure. Nothing here is hand-entered as a final number.
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
