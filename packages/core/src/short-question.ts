/** Keeps a question within the card limit by dropping leading sentences, so its ask survives. */
export function shortQuestion(question: string, max = 240): string {
  let text = question.trim();
  while (text.length > max) {
    const cut = text.search(/[。！？.!?；;]\s*(?=\S)/);
    if (cut < 0 || cut + 1 >= text.length) return `${text.slice(0, max - 1)}…`;
    text = text.slice(cut + 1).trim();
  }
  return text;
}
