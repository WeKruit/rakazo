import type { AgentRunModel, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";

const TIMEOUT_MS = 4_000;
const MAX_USER_CHARS = 1_500;
const MAX_EARLIER_CHARS = 400;
const EARLIER_TURNS = 4;
const MAX_REPLY_CHARS = 100;

// Fixed text first, so providers that cache prompt prefixes can reuse it.
const INSTRUCTIONS = [
  "You are the assistant in this chat. The person just sent the latest message. Your full answer takes a little while, so first send one short sentence right away that shows you understood what they asked and says what you are working on now.",
  "At most 20 words, in the language of the person's latest message, in the assistant's own voice.",
  "Never answer the request itself, state facts, names, numbers or results, say anything is done, saved or sent, promise a time or an outcome, ask a question, or mention tools, systems or internal steps.",
  "No quotes, no markdown, no greeting unless they greeted you.",
].join(" ");

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** One sentence the chat can show as-is, or null when the model gave nothing usable. */
export function cleanQuickReply(raw: string): string | null {
  const line = raw
    .trim()
    .split("\n")[0]!
    .trim()
    .replace(/^["'“”「」]+|["'“”「」]+$/g, "")
    .trim();
  if (!line || line.length > MAX_REPLY_CHARS) return null;
  if (/[?？]$/.test(line)) return null;
  if (/^(?:I hit a problem:|Unknown model |No response\. Try again\.)/i.test(line)) return null;
  return line;
}

/**
 * The short first reply the person sees while the full answer is still being worked out. One
 * small model call without reasoning per turn; failures just mean no quick reply.
 */
export async function quickReply(input: {
  runtime: AgentRuntime;
  model: AgentRunModel;
  /** Messages before this turn, oldest first; only the last few are used. */
  earlier?: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  userText: string;
  runId: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  onUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => Promise<unknown>;
}): Promise<string | null> {
  if (!input.userText.trim()) return null;
  const earlier = (input.earlier ?? [])
    .filter((turn) => turn.text.trim())
    .slice(-EARLIER_TURNS)
    .map(
      (turn) =>
        `${turn.role === "user" ? "Person" : "Assistant"}: ${clip(turn.text, MAX_EARLIER_CHARS)}`,
    );
  const prompt = [
    ...(earlier.length ? ["Earlier in the conversation:", ...earlier, ""] : []),
    "Latest message from the person:",
    clip(input.userText, MAX_USER_CHARS),
  ].join("\n");
  let text = "";
  for await (const event of input.runtime.run(
    {
      botId: input.botId,
      threadId: input.threadId,
      runId: `${input.runId}:quick-reply`,
      usageOperationKind: "setup",
      prompt,
      instructions: INSTRUCTIONS,
      history: [],
      tools: [],
      allowSilentEmpty: true,
      model: { ...input.model, thinkingLevel: "off", firstStepThinkingLevel: undefined },
    },
    {
      operationId: `quick-reply:${input.runId}`,
      traceId: `quick-reply:${input.runId}`,
      spaceId: input.spaceId,
      userId: input.userId,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  )) {
    if (event.type === "usage" && !event.accounted) await input.onUsage?.(event);
    if (event.type === "done" && event.text) text = event.text;
  }
  return cleanQuickReply(text);
}
