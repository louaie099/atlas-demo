import { describe, it, expect } from "vitest";
import { hashPlanInputs } from "../lib/planning/weekly-plan-service";
import { EMPLOYEES, FLIGHTS, CONFIG } from "../lib/seed-data";
import { Employee, Flight } from "../lib/types";

/**
 * Regression coverage for the traced `isStale` false-positive: `flights`
 * and `employees` are both fetched with a plain `.select("*")` and no
 * `.order(...)` at every call site feeding hashPlanInputs (the generation
 * path in weekly-plan-service.ts, and the isStale check in
 * app/api/planning/weekly-view/route.ts) -- Postgres makes no row-order
 * guarantee without an explicit ORDER BY, so the exact same logical rows
 * can legitimately come back in a different physical order on two
 * separate calls. Before this fix, hashPlanInputs hashed the raw
 * JSON.stringify of those arrays as given, so a reordered-but-identical
 * re-fetch could hash differently and flip a freshly generated plan's
 * `isStale` to true with nothing having actually changed -- confirmed
 * live immediately after a Make Planning run against the heavy-week
 * stress-test dataset. The fix makes hashPlanInputs canonical: flights
 * and employees (both logically unordered sets keyed by `id`) are sorted
 * by `id` before hashing, and each object's own keys are sorted
 * recursively, so the hash never depends on whatever order Postgres (or
 * anything else) happens to hand rows/keys back in.
 */
describe("hashPlanInputs — canonical, order-independent over logically unordered collections", () => {
  it("identical flights/employees in a different row order hash identically", () => {
    const shuffledFlights: Flight[] = [...FLIGHTS].reverse();
    const shuffledEmployees: Employee[] = [...EMPLOYEES].slice(1).concat(EMPLOYEES.slice(0, 1)); // rotate, not just reverse -- a different shuffle shape than flights'

    const original = hashPlanInputs(FLIGHTS, EMPLOYEES, CONFIG);
    const reordered = hashPlanInputs(shuffledFlights, shuffledEmployees, CONFIG);

    expect(reordered).toBe(original);
  });

  it("a real world example: employees array as Postgres might return it on one call vs. another (arbitrary reordering, not sorted either way) still hashes identically", () => {
    // Neither order below is alphabetical-by-id or anything else
    // meaningful -- exactly what "whatever row order Postgres happens to
    // return" looks like: two unpredictable, mutually different orders of
    // the SAME rows.
    const order1 = [...EMPLOYEES].sort(() => 0.37 - 0.5 * 0.74);
    const order2 = [...order1].sort(() => 0.61 - 0.5 * 0.29);
    expect(order1.map((e) => e.id).sort()).toEqual(order2.map((e) => e.id).sort()); // sanity: same set

    const hash1 = hashPlanInputs(FLIGHTS, order1, CONFIG);
    const hash2 = hashPlanInputs(FLIGHTS, order2, CONFIG);
    expect(hash1).toBe(hash2);
  });

  it("an object with the same data but keys inserted in a different order still hashes identically", () => {
    const flight = FLIGHTS[0];
    const reorderedFlight = Object.fromEntries(Object.entries(flight).reverse()) as unknown as Flight;

    const hash1 = hashPlanInputs([flight], EMPLOYEES, CONFIG);
    const hash2 = hashPlanInputs([reorderedFlight], EMPLOYEES, CONFIG);
    expect(hash1).toBe(hash2);
  });

  it("an actual flight change (not just reordering) produces a different hash", () => {
    const changedFlights: Flight[] = FLIGHTS.map((f, i) => (i === 0 ? { ...f, scheduled_departure: "23:59" } : f));

    const before = hashPlanInputs(FLIGHTS, EMPLOYEES, CONFIG);
    const after = hashPlanInputs(changedFlights, EMPLOYEES, CONFIG);

    expect(after).not.toBe(before);
  });

  it("an actual employee change (not just reordering) produces a different hash", () => {
    const changedEmployees: Employee[] = EMPLOYEES.map((e, i) => (i === 0 ? { ...e, weekly_hours: (e.weekly_hours ?? 0) + 1 } : e));

    const before = hashPlanInputs(FLIGHTS, EMPLOYEES, CONFIG);
    const after = hashPlanInputs(FLIGHTS, changedEmployees, CONFIG);

    expect(after).not.toBe(before);
  });

  it("an actual config change produces a different hash", () => {
    const changedConfig = { ...CONFIG, minimum_rest_hours: CONFIG.minimum_rest_hours + 1 };

    const before = hashPlanInputs(FLIGHTS, EMPLOYEES, CONFIG);
    const after = hashPlanInputs(FLIGHTS, EMPLOYEES, changedConfig);

    expect(after).not.toBe(before);
  });

  it("adding or removing a flight/employee (not just reordering the rest) produces a different hash", () => {
    const withoutOneFlight = FLIGHTS.slice(1);
    const withoutOneEmployee = EMPLOYEES.slice(1);

    expect(hashPlanInputs(withoutOneFlight, EMPLOYEES, CONFIG)).not.toBe(hashPlanInputs(FLIGHTS, EMPLOYEES, CONFIG));
    expect(hashPlanInputs(FLIGHTS, withoutOneEmployee, CONFIG)).not.toBe(hashPlanInputs(FLIGHTS, EMPLOYEES, CONFIG));
  });
});
