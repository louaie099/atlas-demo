export type RamDestinationCategory = "Africa" | "Europe/Schengen" | "UK/USA";

export interface RamRoleCounts {
  gate: number;
  boarding: number;
  profiling: number | null;
  mesureApplicable: boolean;
}

const RAM_STAFFING_MATRIX: Record<RamDestinationCategory, { standard: RamRoleCounts; dreamliner: RamRoleCounts }> = {
  Africa: {
    standard: { gate: 1, boarding: 1, profiling: null, mesureApplicable: false },
    dreamliner: { gate: 2, boarding: 2, profiling: null, mesureApplicable: false },
  },
  "Europe/Schengen": {
    standard: { gate: 1, boarding: 1, profiling: 1, mesureApplicable: false },
    dreamliner: { gate: 2, boarding: 2, profiling: 2, mesureApplicable: false },
  },
  "UK/USA": {
    standard: { gate: 1, boarding: 1, profiling: 1, mesureApplicable: true },
    dreamliner: { gate: 2, boarding: 2, profiling: 2, mesureApplicable: true },
  },
};

export function isDreamlinerAircraft(aircraft: string): boolean {
  return aircraft.includes("787");
}

export function getRamRoleCounts(destinationCategory: string | null, aircraft: string): RamRoleCounts | null {
  if (!destinationCategory) return null;
  const bucket = RAM_STAFFING_MATRIX[destinationCategory as RamDestinationCategory];
  if (!bucket) return null;
  return isDreamlinerAircraft(aircraft) ? bucket.dreamliner : bucket.standard;
}
