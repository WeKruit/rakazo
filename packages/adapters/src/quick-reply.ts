import type { ReplyLanguage } from "@rakazo/core";
import { inOtherLanguage } from "@rakazo/core";

const MAX_REPLY_CHARS = 160;

const ON_IT: Record<ReplyLanguage, string> = {
  zh: "收到，马上处理。",
  ko: "네, 바로 처리할게요.",
  ja: "承知しました。すぐ対応します。",
  en: "Got it, on it.",
};

/**
 * The fixed first line for a message sent while a run works, or for a card answer: sent at once,
 * with no model call, in the language of the person's message. The run's own answer follows.
 */
export function fixedAck(language: ReplyLanguage): string {
  return ON_IT[language];
}

/** Whether the text is one of the fixed lines, in any language. */
export function isFixedAck(text: string): boolean {
  return [...Object.values(ON_IT), ...Object.values(GOING_AHEAD)].includes(text.trim());
}

const LEADING_ACK =
  /^\s*(?:(?:收到|好的|明白|了解|没问题|네|알겠습니다|承知しました)(?:了)?[，,：:。！!、\s]*|(?:got it|okay|ok|sure|understood|noted|will do)\b[,.:;!—–\-\s]*)/i;

/**
 * The run's own line without an opening acknowledgement, once the fixed line already said it.
 * A line that is only an acknowledgement stays as it is.
 */
export function withoutLeadingAck(text: string): string {
  const rest = text.replace(LEADING_ACK, "");
  if (!rest.trim() || rest === text) return text;
  return /^[a-z]/.test(rest) ? rest[0]!.toUpperCase() + rest.slice(1) : rest;
}

/**
 * A one-line progress note in another language than the person's message: simulated 11-14, a
 * Chinese edit request got "I'll revise the template to show…". It is dropped; the answer follows.
 */
export function progressInOtherLanguage(line: string, language: ReplyLanguage): boolean {
  return oneLineNote(line) && inOtherLanguage(line.trim(), language);
}

/** One short line, as a note about the next step is: not an answer, a list or a draft. */
export function oneLineNote(line: string): boolean {
  const text = line.trim();
  return !text.includes("\n") && text.length <= 2 * MAX_REPLY_CHARS;
}

const GOING_AHEAD: Record<ReplyLanguage, string> = {
  zh: "好，这就处理。",
  ko: "네, 진행할게요.",
  ja: "はい、進めます。",
  en: "On it.",
};
