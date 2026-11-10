import type { AgentRunModel, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { isChineseText } from "@rakazo/core";

const TIMEOUT_MS = 4_000;
const MAX_USER_CHARS = 1_200;
const MAX_REPLY_CHARS = 2_400;
const MAX_SUGGESTION_CHARS = 120;
const EARLIER_TURNS = 10;
const MAX_EARLIER_CHARS = 500;

// Fixed text first, so providers that cache prompt prefixes can reuse it.
const INSTRUCTIONS = [
  "The user is a headhunter or recruiter filling roles for clients. You suggest the next message they are most likely to send in this chat with their recruiting assistant.",
  "Reply with only that message, written in the recruiter's own voice to the assistant (never the assistant's words, never a question addressed to the recruiter), at most 12 words, in the language the user writes in.",
  "Make it the natural next step in the task the conversation is working on, in everyday recruiting words about the role, candidates, interviews or outreach: usually answering the assistant's question or asking for the next piece of work, such as finding more people like the good ones or checking who replied. Never internal terms like intake or calibration, a generic greeting or a change of topic. If the assistant just handed the work to a role's own conversation, reply with nothing.",
  "Respect what the user already decided or asked to hold off on (for example not searching yet): never suggest it again.",
  "Never suggest approving, sending or confirming emails, outreach or interview invitations.",
  "No quotes, no explanation, no markdown. If there is no clear next step, reply with nothing.",
].join(" ");

/** The plain text of a message. */
export function blocksText(blocks: readonly MessageBlock[]): string {
  return blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n");
}

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
  if (/^(?:I hit a problem:|Unknown model |No response\. Try again\.)/i.test(line)) return null;
  return line;
}

/**
 * A short guess at the user's next message after a finished reply, shown as gray text in the
 * composer that Tab accepts. One small model call per reply; failures just mean no suggestion.
 */
export async function suggestNextMessage(input: {
  runtime: AgentRuntime;
  model: AgentRunModel;
  /** Messages before this turn, oldest first; only the last few are used. */
  earlier?: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  userText: string;
  replyText: string;
  runId: string;
  spaceId: string;
  userId: string;
  botId: string;
  threadId: string;
  onUsage?: (event: Extract<AgentRuntimeEvent, { type: "usage" }>) => Promise<unknown>;
}): Promise<string | null> {
  const earlier = (input.earlier ?? [])
    .filter((turn) => turn.text.trim())
    .slice(-EARLIER_TURNS)
    .map(
      (turn) =>
        `${turn.role === "user" ? "User" : "Assistant"}: ${clip(turn.text, MAX_EARLIER_CHARS)}`,
    );
  const prompt = [
    ...(earlier.length ? ["Earlier in the conversation:", ...earlier, "", "Latest turn:"] : []),
    "User:",
    clip(input.userText, MAX_USER_CHARS),
    "",
    "Assistant:",
    clip(input.replyText, MAX_REPLY_CHARS),
    "",
    isChineseText(input.userText)
      ? "Write it in Chinese."
      : "Write it in the language of the user's latest message, not Chinese, even if earlier messages were.",
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
      // "Reply with nothing" is a valid answer: no runtime filler text in the composer.
      allowSilentEmpty: true,
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
