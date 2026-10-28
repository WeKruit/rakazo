/**
 * Only skip the parser when a link is impossible. The existing parser enables
 * explicit schemes and email addresses (ASCII ':' or '@'). Fullwidth variants
 * also take the conservative parser path. Bare domains are literal under the
 * existing fuzzyLink:false rule; they cannot create links without these markers.
 * This is a loading guard, never a substitute link parser or URL sanitizer.
 */
export function mayContainExplicitLink(text: string): boolean {
  return /[:@\uFF1A\uFF20]/u.test(text);
}
