/**
 * A model run with thinking off sometimes writes its planning into the reply itself, after the
 * answer: 「目前没有在招职位。 a role 不会…… Need Chinese only. … Answer.」. A recruiter must never
 * see that. When a Chinese reply turns into mostly-English planning, the reply ends at the last
 * Chinese sentence before it.
 */
const PLANNING =
  /\b(?:need (?:chinese|english)(?: only)?\b|maybe next step|as rule:|answer\.\s*$|final answer\b|let me (?:answer|check|think)\b|i (?:should|will|need to) (?:answer|reply|respond)\b|the (?:user|recruiter) (?:asks|wants|is asking)\b)/i;
const CJK = /[㐀-鿿]/g;
const LATIN = /[A-Za-z]/g;
/** The end of a Chinese sentence or line, where the answer can stop. */
const SENTENCE_END = /[。！？!?\n]/g;

export function dropScratchReasoning(text: string): string {
  const marker = PLANNING.exec(text);
  if (!marker) return text;
  let cut = -1;
  for (const end of text.slice(0, marker.index).matchAll(SENTENCE_END)) cut = end.index;
  if (cut < 0) return text;
  const head = text.slice(0, cut + 1).trimEnd();
  const tail = text.slice(cut + 1);
  const cjk = (value: string) => value.match(CJK)?.length ?? 0;
  // Only a Chinese answer followed by planning that is mostly English; an English email inside a
  // Chinese reply carries no planning words and stays.
  if (!cjk(head) || (tail.match(LATIN)?.length ?? 0) < 2 * cjk(tail)) return text;
  return head;
}
