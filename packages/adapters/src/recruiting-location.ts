import { US_PLACES } from "./us-places.js";

const US_STATES =
  "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming";
const COUNTRY = "united states(?: of america)?|usa|u\\.s\\.a?\\.?|us";
const REGION_ONLY = new RegExp(
  `^\\s*(?:(?:${US_STATES})(?:\\s*,\\s*(?:${COUNTRY}))?|${COUNTRY})\\s*$`,
  "i",
);

/**
 * A profile location that names only a country or a state, or nothing at all, which never shows
 * the person inside a city or metro scope.
 */
export function isRegionOnlyLocation(location: string | null | undefined): boolean {
  return !location?.trim() || REGION_ONLY.test(location);
}

const STATE_CODES: Record<string, string> = Object.fromEntries(
  US_STATES.split("|").map((name, index) => [
    name,
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
      " ",
    )[index] as string,
  ]),
);
const CODES = new Set(Object.values(STATE_CODES));

let placeIndex: Map<string, string> | undefined;
/** Coordinates of a place, in the named state when one is given, else the largest of that name. */
function coordinates(place: string, state: string | undefined): [number, number] | undefined {
  placeIndex ??= new Map(
    US_PLACES.split("\n").map((line) => line.split("|", 2) as [string, string]),
  );
  const entries = placeIndex.get(place)?.split(";");
  if (!entries) return undefined;
  const entry = (state && entries.find((item) => item.startsWith(`${state},`))) || entries[0];
  const [, lat, lon] = (entry as string).split(",");
  return [Number(lat), Number(lon)];
}

/** Where a profile location points: the first city or metro it names that is a known US place. */
export function locate(location: string): [number, number] | undefined {
  const parts = location
    .split(/,|--|\//)
    .map((part) =>
      part
        .replace(/\b(?:greater|metropolitan|metro|area|region|city of)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const state = parts
    .map((part) => STATE_CODES[part.toLowerCase()] ?? (CODES.has(part) ? part : undefined))
    .find(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (STATE_CODES[lower] || CODES.has(part.toUpperCase()) || COUNTRY_ONLY.test(lower)) continue;
    const point = coordinates(lower.replace(/^st\.? /, "st. "), state);
    if (point) return point;
  }
  return undefined;
}

const COUNTRY_ONLY = new RegExp(`^(?:${COUNTRY})$`, "i");

function miles([lat1, lon1]: [number, number], [lat2, lon2]: [number, number]): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 7918 * Math.asin(Math.sqrt(a));
}

/** Farther than this from where the group is centred is beyond an ordinary daily commute. */
export const COMMUTE_MILES = 50;

/**
 * People in a picked group who live beyond commuting distance of where the group is centred
 * (the pick closest to all the others), such as one LaGrange or Greensboro profile among ten
 * around Atlanta. Suburbs stay inside. It only points at a likely slip; the model decides.
 */
export function locationOutliers(locations: ReadonlyMap<string, string>): string[] {
  const points = [...locations]
    .map(([key, location]) => [key, locate(location)] as const)
    .filter((entry): entry is readonly [string, [number, number]] => Boolean(entry[1]));
  if (points.length < 3) return [];
  const spread = (point: [number, number]) =>
    points.reduce((sum, [, other]) => sum + miles(point, other), 0);
  const centre = points.reduce((best, entry) =>
    spread(entry[1]) < spread(best[1]) ? entry : best,
  )[1];
  return points.filter(([, point]) => miles(point, centre) > COMMUTE_MILES).map(([key]) => key);
}
