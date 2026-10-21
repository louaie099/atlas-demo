import { CheckinZoneId } from "../checkin-zones";
import { ZoneCheckinDemandPolicy, DEFAULT_ZONE_CHECKIN_DEMAND_POLICY } from "./checkin-zone-demand";

/**
 * Editable T1 Check-in BASELINE per automatic zone: the number of agents a
 * zone needs whenever ANY flight is Check-in-open there (see
 * checkin-zone-demand.ts's base_agents -- applied once per zone per slot).
 *
 * Kept separate from DEFAULT_ZONE_CHECKIN_DEMAND_POLICY on purpose: that
 * static default (base 2 everywhere) is the engine prototype that the PoC /
 * small demos and the regression tests pin. This is the live, persisted
 * planner setting (planning_zone_demand_config) layered on top of it by
 * resolveEffectiveConfig, so the real app can run Main at 5 without
 * changing those fixtures.
 */
export type ZoneBaseSetting = Partial<Record<CheckinZoneId, number>> & {
  t1_main_checkin: number;
  t1_italy_spain: number;
  t1_domestic: number;
};

export const DEFAULT_ZONE_BASE_SETTING: ZoneBaseSetting = {
  t1_main_checkin: 5,
  t1_italy_spain: 2,
  t1_domestic: 2,
};

export const ZONE_BASE_LIMITS = { min: 1, max: 20 } as const;

/** Clamps/normalizes anything read from the DB or a request body into a valid setting. */
export function sanitizeZoneBase(input: unknown): ZoneBaseSetting {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const pick = (zone: keyof ZoneBaseSetting): number => {
    const v = Number(src[zone]);
    if (!Number.isFinite(v)) return DEFAULT_ZONE_BASE_SETTING[zone] as number;
    return Math.min(ZONE_BASE_LIMITS.max, Math.max(ZONE_BASE_LIMITS.min, Math.round(v)));
  };
  return { t1_main_checkin: pick("t1_main_checkin"), t1_italy_spain: pick("t1_italy_spain"), t1_domestic: pick("t1_domestic") };
}

/** Returns a copy of the policy with each zone's base_agents replaced by the setting; every other coefficient is untouched. */
export function applyZoneBase(setting: ZoneBaseSetting, policy: ZoneCheckinDemandPolicy = DEFAULT_ZONE_CHECKIN_DEMAND_POLICY): ZoneCheckinDemandPolicy {
  const zone_coefficients = { ...policy.zone_coefficients };
  for (const zone of ["t1_main_checkin", "t1_italy_spain", "t1_domestic"] as const) {
    const c = zone_coefficients[zone];
    if (c) zone_coefficients[zone] = { ...c, base_agents: setting[zone] };
  }
  return { ...policy, zone_coefficients };
}
