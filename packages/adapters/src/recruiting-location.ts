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

const COUNTRY_ONLY = new RegExp(`^(?:${COUNTRY})$`, "i");

/** The places a profile location names: city, metro or state, without the country. */
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
    .filter((part) => part && !COUNTRY_ONLY.test(part));
}

/**
 * People in a picked group whose location shares no place with the places most of the group
 * names. It only points at a likely slip, such as one Greensboro profile among ten around Atlanta;
 * the model decides whether that person is within the role's commute.
 */
export function locationOutliers(locations: ReadonlyMap<string, string>): string[] {
  const named = [...locations].map(([key, location]) => [key, new Set(places(location))] as const);
  const counts = new Map<string, number>();
  for (const [, set] of named)
    for (const place of set) counts.set(place, (counts.get(place) ?? 0) + 1);
  const shared = new Set(
    [...counts].filter(([, count]) => count * 2 >= named.length).map(([place]) => place),
  );
  if (!shared.size) return [];
  // A city named next to a shared state ("Atlanta, Georgia") also counts as the group's place.
  for (const [, set] of named)
    if ([...set].some((place) => shared.has(place))) for (const place of set) shared.add(place);
  return named
    .filter(([, set]) => set.size && ![...set].some((place) => shared.has(place)))
    .map(([key]) => key);
}
