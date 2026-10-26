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
