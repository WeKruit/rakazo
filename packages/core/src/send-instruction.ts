/**
 * Email sends the recruiter explicitly told the agent to make need no second confirmation when
 * the recruiter wrote or was shown the exact text, or chose "send when I say send" on an earlier
 * card. Everything else keeps its one-time card.
 */
export const RECRUITER_INSTRUCTED_SEND_TOOLS = new Set([
  "reply_to_email",
  "native_instantly_reply_to_email",
  "GMAIL_SEND_EMAIL",
  "GMAIL_REPLY_TO_THREAD",
]);

const SEND_INSTRUCTION =
  /(发送|发出|发吧|发掉|发了吧|直接发|可以发|帮我发|发给|发过去|发邮件|发信|回复(他|她|候选人|一下)|回(他|她)|回一下|\bsend\b|\breply\b)/i;

const NEGATED = /(不要|别|先不|不用|暂时不|don'?t|do not|not yet|hold off)\s*(发|回|send|reply)/i;

function normalize(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join("\n")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The outgoing text of a send tool's arguments, or null when it has none. */
export function sendBodyText(args: Record<string, unknown>): string | null {
  if (typeof args.body_text === "string") return args.body_text;
  const body = args.body;
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const text = (body as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return null;
}

/**
 * True only when the recruiter's own message asks to send and the exact body is text the
 * recruiter wrote in that message or was shown in the assistant's message right before it.
 */
/** The recruiter's own words ask to send now, without a negation. */
export function recruiterAskedToSend(instruction: string): boolean {
  const text = instruction.trim();
  return Boolean(text) && SEND_INSTRUCTION.test(text) && !NEGATED.test(text);
}

export function recruiterInstructedSend(input: {
  instruction: string;
  shownBefore: string | null;
  body: string | null;
}): boolean {
  const instruction = input.instruction.trim();
  if (!recruiterAskedToSend(instruction)) return false;
  const body = input.body ? normalize(input.body) : "";
  if (body.length < 2) return false;
  return (
    normalize(instruction).includes(body) ||
    (input.shownBefore !== null && normalize(input.shownBefore).includes(body))
  );
}
