import { SHIFT_CODES } from "./shift-templates";

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export function shiftDurationHours(code: string): number {
  const times = SHIFT_CODES[code];
  if (!times) {
    throw new Error(`Unknown shift code "${code}" -- not in the authoritative shift catalog.`);
  }
  let minutes = timeToMinutes(times.sortie) - timeToMinutes(times.entree);
  if (minutes < 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 100) / 100;
}

export function maxWorkingDaysForShift(shiftCode: string, ceilingHours: number): number {
  const duration = shiftDurationHours(shiftCode);
  const byCeiling = Math.floor(ceilingHours / duration);
  return Math.max(1, Math.min(6, byCeiling));
}

export function buildStaggeredOffDays(
  employeeIndexInGroup: number,
  offDaysCount: number,
  candidatePool: string[],
  preferredOffDays?: string[]
): string[] {
  if (candidatePool.length === 0 || offDaysCount <= 0) return [];

  const preferred = (preferredOffDays ?? []).filter((d) => candidatePool.includes(d));
  const rest = candidatePool.filter((d) => !preferred.includes(d));
  const ordered = [...preferred, ...rest];

  const rotated = ordered.map((_, i) => ordered[(i + employeeIndexInGroup) % ordered.length]);

  const chosen: string[] = [];
  for (const day of rotated) {
    if (chosen.length >= offDaysCount) break;
    if (!chosen.includes(day)) chosen.push(day);
  }
  return chosen;
}

export function offDaysCountForShift(shiftCode: string, ceilingHours: number): number {
  return 7 - maxWorkingDaysForShift(shiftCode, ceilingHours);
}
