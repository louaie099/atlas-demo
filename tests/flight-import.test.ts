import { describe, it, expect } from "vitest";
import { validateImportFile } from "../lib/flight-import";
import { CURRENT_WEEK_START } from "../lib/seed-data";
import { shiftWeek } from "../lib/flight-date";

/**
 * REGRESSION: the live bug this covers -- Import Flights reported success
 * ("Confirm Import (49)") and the commit itself succeeded, but the
 * imported flights never appeared in Flight Schedule. Root cause:
 * validateRow derived each row's week_start independently from its own
 * flight_date, completely ignoring which week the person had selected and
 * was importing INTO -- a row for a different real calendar week silently
 * committed into that OTHER week's bucket, invisible from the view the
 * person was actually looking at. The fix rejects such a row outright,
 * with the exact mismatch named, rather than silently relocating it.
 */
describe("Import Flights — rows are scoped to the currently selected week", () => {
  const monday = CURRENT_WEEK_START; // a real Monday, guaranteed by tests/flight-date.test.ts
  const nextMonday = shiftWeek(CURRENT_WEEK_START, 1);

  function csvRow(flightDate: string, flightNumber = "AT900") {
    const header = "flight_number,airline,origin,destination,flight_date,scheduled_departure,aircraft";
    return `${header}\n${flightNumber},Royal Air Maroc,CMN,MAD,${flightDate},10:00,Boeing 737-800`;
  }

  it("a row whose flight_date falls in the selected week is accepted (ready)", () => {
    const csv = csvRow(monday);
    const rows = validateImportFile(csv, new Set(), monday);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ready");
    expect(rows[0].flight?.week_start).toBe(monday);
  });

  it("a row whose flight_date falls in a DIFFERENT week is REJECTED, not silently imported into that other week", () => {
    const csv = csvRow(nextMonday); // a real date, just not in the week being viewed
    const rows = validateImportFile(csv, new Set(), monday);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].flight).toBeNull();
    expect(rows[0].problems[0]).toMatch(/falls in the week of/);
    expect(rows[0].problems[0]).toContain(nextMonday);
  });

  it("a mixed file: only the rows matching the selected week are ready/warning; cross-week rows are rejected alongside genuinely invalid ones", () => {
    const header = "flight_number,airline,origin,destination,flight_date,scheduled_departure,aircraft";
    const csv = [
      header,
      `AT901,Royal Air Maroc,CMN,MAD,${monday},10:00,Boeing 737-800`, // correct week -> ready
      `AT902,Royal Air Maroc,CMN,MAD,${nextMonday},10:00,Boeing 737-800`, // wrong week -> rejected
      `AT903,Royal Air Maroc,CMN,MAD,not-a-date,10:00,Boeing 737-800`, // genuinely invalid -> rejected
    ].join("\n");

    const rows = validateImportFile(csv, new Set(), monday);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.status === "ready")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "rejected")).toHaveLength(2);
    expect(rows.find((r) => r.raw.flight_number === "AT901")?.flight?.week_start).toBe(monday);
  });

  it("end-to-end simulation: preview -> commit -> a fake GET for the SAME selected week returns the imported flight, a GET for a different week does not", () => {
    const csv = csvRow(monday, "AT905");

    // PREVIEW (no write)
    const previewRows = validateImportFile(csv, new Set(), monday);
    expect(previewRows[0].status).toBe("ready");

    // COMMIT: re-validate (as the real route does) and "insert" into a fake table.
    const commitRows = validateImportFile(csv, new Set(), monday);
    const fakeFlightsTable = commitRows.filter((r) => r.flight !== null).map((r) => r.flight!);
    expect(fakeFlightsTable).toHaveLength(1);

    // READ back, scoped exactly like GET /api/flights?week_start=...
    const sameWeekRead = fakeFlightsTable.filter((f) => f.week_start === monday);
    const otherWeekRead = fakeFlightsTable.filter((f) => f.week_start === nextMonday);
    expect(sameWeekRead).toHaveLength(1);
    expect(sameWeekRead[0].flight_number).toBe("AT905");
    expect(otherWeekRead).toHaveLength(0);
  });
});
