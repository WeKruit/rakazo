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

const NOT_A_CITY = new RegExp(`^(?:${COUNTRY}|${US_STATES}|[a-z]{2})$`, "i");

/** The cities or metros a profile location names, without its state or country. */
function places(location: string): string[] {
  return location
    .split(/,|--|\//)
    .map((part) =>
      part
        .replace(/\b(?:greater|metropolitan|metro|area|region|city of)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase(),
    )
    .filter((part) => part && !NOT_A_CITY.test(part));
}

/**
 * People in a picked group whose location names none of the cities a third or more of the group
 * names. A shared state never counts, so one LaGrange or Greensboro profile among ten around
 * Atlanta is pointed out; so is a suburb, once. The model decides who is within the role's commute.
 */
export function locationOutliers(locations: ReadonlyMap<string, string>): string[] {
  const named = [...locations].map(([key, location]) => [key, new Set(places(location))] as const);
  const counts = new Map<string, number>();
  for (const [, set] of named)
    for (const place of set) counts.set(place, (counts.get(place) ?? 0) + 1);
  const least = Math.max(2, Math.ceil(named.length / 3));
  const shared = new Set([...counts].filter(([, count]) => count >= least).map(([place]) => place));
  if (!shared.size) return [];
  return named
    .filter(([, set]) => set.size && ![...set].some((place) => shared.has(place)))
    .map(([key]) => key);
}
