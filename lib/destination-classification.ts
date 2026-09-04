import { RamDestinationCategory } from "./ram-staffing-matrix";

export const DESTINATIONS: Record<string, { code: string; city: string; country: string }> = {
  MAD: { code: "MAD", city: "Madrid", country: "Spain" },
  LHR: { code: "LHR", city: "London", country: "United Kingdom" },
  RAK: { code: "RAK", city: "Marrakech", country: "Morocco" },
  FEZ: { code: "FEZ", city: "Fez", country: "Morocco" },
  IST: { code: "IST", city: "Istanbul", country: "Turkey" },
  DKR: { code: "DKR", city: "Dakar", country: "Senegal" },
  YUL: { code: "YUL", city: "Montreal", country: "Canada" },
  DOH: { code: "DOH", city: "Doha", country: "Qatar" },
  DXB: { code: "DXB", city: "Dubai", country: "United Arab Emirates" },
  AUH: { code: "AUH", city: "Abu Dhabi", country: "United Arab Emirates" },
  CDG: { code: "CDG", city: "Paris", country: "France" },
  ORY: { code: "ORY", city: "Paris", country: "France" },
  BAH: { code: "BAH", city: "Manama", country: "Bahrain" },
};

const COUNTRY_TO_RAM_CATEGORY: Partial<Record<string, RamDestinationCategory>> = {
  Spain: "Europe/Schengen",
  France: "Europe/Schengen",
  "United Kingdom": "UK/USA",
  "United States": "UK/USA",
  Senegal: "Africa",
};

export function classifyDestinationOperationally(
  destinationCode: string | null
): "Domestic" | RamDestinationCategory | null {
  if (!destinationCode) return null;
  const dest = DESTINATIONS[destinationCode];
  if (!dest) return null;
  if (dest.country === "Morocco") return "Domestic";
  return COUNTRY_TO_RAM_CATEGORY[dest.country] ?? null;
}
