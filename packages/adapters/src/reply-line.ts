const MAX_REPLY_CHARS = 160;

/** One short line, as a note about the next step is: not an answer, a list or a draft. */
export function oneLineNote(line: string): boolean {
  const text = line.trim();
  return !text.includes("\n") && text.length <= 2 * MAX_REPLY_CHARS;
}
