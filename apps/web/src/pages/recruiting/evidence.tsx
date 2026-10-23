/** Literal token ranges only; a keyword mention never changes an assessment. */
export function keywordRanges(text: string, terms: readonly string[]) {
  const ranges: { start: number; end: number }[] = [];
  for (const term of new Set(terms.map((value) => value.trim()).filter(Boolean))) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Han text has no word separators. Other names must not match inside another token
    // (for example Go in Google, or C in C++).
    const boundary = /\p{Script=Han}/u.test(term) ? "" : "[\\p{L}\\p{N}_+#]";
    const pattern = new RegExp(
      `${boundary ? `(?<!${boundary})` : ""}${escaped}${boundary ? `(?!${boundary})` : ""}`,
      "giu",
    );
    for (const match of text.matchAll(pattern))
      ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  const merged: typeof ranges = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}

export function mentionsKeyword(text: string, keyword: string) {
  return keywordRanges(text, [keyword]).length > 0;
}

export function HighlightText({ text, terms }: { text: string; terms: readonly string[] }) {
  const ranges = keywordRanges(text, terms);
  let start = 0;
  return (
    <>
      {ranges.map((range) => {
        const before = text.slice(start, range.start);
        start = range.end;
        return (
          <span key={range.start}>
            {before}
            <mark className="rounded-sm bg-muted px-0.5 font-semibold text-foreground">
              {text.slice(range.start, range.end)}
            </mark>
          </span>
        );
      })}
      {text.slice(start)}
    </>
  );
}
