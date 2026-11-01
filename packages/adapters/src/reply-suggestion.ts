import type { AgentRunModel, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";

const TIMEOUT_MS = 4_000;
const MAX_USER_CHARS = 1_200;
const MAX_REPLY_CHARS = 2_400;
const MAX_SUGGESTION_CHARS = 120;

// Fixed text first, so providers that cache prompt prefixes can reuse it.
const INSTRUCTIONS = [
  "You suggest the next message the user is most likely to send in this chat with their recruiting assistant.",
  "Reply with only that message, written as the user, at most 12 words, in the language the user writes in.",
  "Make it a natural next step that follows from the assistant's reply, such as answering its question or asking for the next piece of work.",
  "Never suggest approving, sending or confirming emails, outreach or interview invitations.",
  "No quotes, no explanation, no markdown. If there is no clear next step, reply with nothing.",
].join(" ");

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** One line the composer can show as-is, or null when the model gave nothing usable. */
export function cleanSuggestion(raw: string): string | null {
  const line = raw
    .trim()
    .split("\n")[0]!
    .trim()
    .replace(/^["'“”「」]+|["'“”「」]+$/g, "")
    .trim();
  if (!line || line.length > MAX_SUGGESTION_CHARS) return null;
  if (/^(?:I hit a problem:|Unknown model )/i.test(line)) return null;
  return line;
}

/**
 * A short guess at the user's next message after a finished reply, shown as gray text in the
 * composer that Tab accepts. One small model call per reply; failures just mean no suggestion.
 */
export async function suggestNextMessage(input: {
  runtime: AgentRuntime;
  model: AgentRunModel;
  userText: string;
  replyText: string;
  runId: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  onUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => Promise<unknown>;
}): Promise<string | null> {
  const prompt = [
    "User:",
    clip(input.userText, MAX_USER_CHARS),
    "",
    "Assistant:",
    clip(input.replyText, MAX_REPLY_CHARS),
  ].join("\n");
  let text = "";
  for await (const event of input.runtime.run(
    {
      botId: input.botId,
      threadId: input.threadId,
      runId: `${input.runId}:suggestion`,
      usageOperationKind: "setup",
      prompt,
      instructions: INSTRUCTIONS,
      history: [],
      tools: [],
      model: { ...input.model, thinkingLevel: "off", firstStepThinkingLevel: undefined },
    },
    {
      operationId: `suggestion:${input.runId}`,
      traceId: `suggestion:${input.runId}`,
      spaceId: input.spaceId,
      userId: input.userId,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  )) {
    if (event.type === "usage" && !event.accounted) await input.onUsage?.(event);
    if (event.type === "done" && event.text) text = event.text;
  }
  return cleanSuggestion(text);
}
