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
/** Coordinates of a place in the named state, or the largest of that name when no state is named. */
function coordinates(place: string, state: string | undefined): [number, number] | undefined {
  placeIndex ??= new Map(
    US_PLACES.split("\n").map((line) => line.split("|", 2) as [string, string]),
  );
  const entries = placeIndex.get(place)?.split(";");
  if (!entries) return undefined;
  // A place the named state lacks (an unincorporated community) stays unknown, never another state's.
  const entry = state ? entries.find((item) => item.startsWith(`${state},`)) : entries[0];
  if (!entry) return undefined;
  const [, lat, lon] = entry.split(",");
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

/**
 * People from a local search who are not in its area: when most rows centre on one metro, the
 * rows beyond commuting distance of it or showing only a country or a state. A search whose rows
 * spread out (a remote or nationwide role) leaves everyone in.
 */
export function outsideSearchArea(
  locations: ReadonlyMap<string, string | null | undefined>,
  place?: NamedPlace,
): Set<string> {
  const points = [...locations]
    .map(([key, location]) => [key, location ? locate(location) : undefined] as const)
    .filter((entry): entry is readonly [string, [number, number]] => Boolean(entry[1]));
  if (!place && points.length < 5) return new Set();
  const spread = (point: [number, number]) =>
    points.reduce((sum, [, other]) => sum + miles(point, other), 0);
  const centre =
    place?.point ??
    points.reduce((best, entry) => (spread(entry[1]) < spread(best[1]) ? entry : best))[1];
  const far = points.filter(([, point]) => miles(point, centre) > COMMUTE_MILES);
  // Without a named place, rows spread across the country mean a remote or nationwide search.
  if (!place && far.length > points.length * 0.4) return new Set();
  return new Set([
    ...far.map(([key]) => key),
    ...[...locations]
      .filter(
        ([, location]) =>
          isRegionOnlyLocation(location) || Boolean(place && location && isAbroad(location)),
      )
      .map(([key]) => key),
  ]);
}

export type NamedPlace = { label: string; point: [number, number] };

const STATE_NAMES = Object.keys(STATE_CODES)
  .map((name) => name.replace(/\b\w/g, (letter) => letter.toUpperCase()))
  .join("|");
const PLACE_MENTION = new RegExp(
  `((?:[A-Z][\\w.'-]*\\s+){0,2}[A-Z][\\w.'-]*),?\\s+(${[...CODES].join("|")}|${STATE_NAMES})\\b`,
  "g",
);

/**
 * The US city a role's searches or words name most often, such as "Linden, NJ" in "within 30
 * miles of Linden, NJ 07036". A required language narrows a search to profiles across the
 * country, so the area is held to this place instead of to where most rows happen to be.
 */
export function namedPlace(texts: readonly string[]): NamedPlace | undefined {
  const counts = new Map<string, NamedPlace & { count: number }>();
  for (const text of texts)
    for (const [, city = "", state = ""] of text.matchAll(PLACE_MENTION)) {
      const words = city.split(/\s+/);
      // The longest run of capitalised words before the state that is a known place.
      for (let take = words.length; take > 0; take--) {
        const label = `${words.slice(-take).join(" ")}, ${state}`;
        const code = STATE_CODES[state.toLowerCase()] ?? state;
        const point = coordinates(words.slice(-take).join(" ").toLowerCase(), code);
        if (!point) continue;
        const key = point.join(",");
        const entry = counts.get(key) ?? { label, point, count: 0 };
        entry.count++;
        counts.set(key, entry);
        break;
      }
    }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return best ? { label: best.label, point: best.point } : undefined;
}

/** Whether a profile location is beyond commuting distance of the named place. */
export function beyondCommute(location: string, place: NamedPlace): boolean {
  const point = locate(location);
  return point ? miles(point, place.point) > COMMUTE_MILES : isAbroad(location);
}

/** Profile locations outside the US, which the US place list cannot place. */
const ABROAD =
  /\b(canada|british columbia|ontario|quebec|alberta|toronto|vancouver|burnaby|montreal|ottawa|calgary|edmonton|mississauga|waterloo|kitchener|mexico|singapore|china|hong kong|taiwan|japan|korea|india|vietnam|malaysia|philippines|thailand|australia|united kingdom|england|ireland|germany|france|netherlands|spain|italy|brazil|united arab emirates|dubai)\b/i;

/** Whether a profile location is outside the US. */
export function isAbroad(location: string): boolean {
  return ABROAD.test(location) && !/\bunited states\b/i.test(location);
}

const LOCAL_ROLE =
  /\b(within \d+|miles? (?:of|from)|commut\w*|on-?site|hybrid|near|area|metro)\b|通勤|现场|驻场|附近|英里|公里/i;
const OPEN_LOCATION =
  /(?<!\b(?:no|not|non)[\s-]?)\b(remote|relocat\w*|anywhere|nationwide|across the (?:us|country)|any location)\b|远程|搬迁|全国|不限地点/i;

/**
 * The place a local role is held to: the city its searches or the recruiter's words name, when
 * they describe an on-site, hybrid or commuting role and never a remote, relocation or nationwide
 * one.
 */
export function localRolePlace(texts: readonly string[]): NamedPlace | undefined {
  if (!texts.some((text) => LOCAL_ROLE.test(text))) return undefined;
  if (texts.some((text) => OPEN_LOCATION.test(text))) return undefined;
  return namedPlace(texts);
}
