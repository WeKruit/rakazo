import type { AgentRunModel, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { isChineseText } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";

const TIMEOUT_MS = 4_000;
const MAX_USER_CHARS = 1_500;
const MAX_EARLIER_CHARS = 400;
const EARLIER_TURNS = 4;
const MAX_REPLY_CHARS = 160;
const MAX_OUTPUT_TOKENS = 80;

// Fixed text first, so providers that cache prompt prefixes can reuse it.
const INSTRUCTIONS = [
  "You are the assistant in this chat. The person just sent the latest message. Your full answer takes a little while, so first send one short sentence right away that shows you understood what they asked and says what you are working on now.",
  "One sentence of at most 20 words (at most 30 characters in Chinese), in the language of the person's latest message, in the assistant's own voice.",
  "You cannot see their data yet: never say what you can or cannot see or find. Never answer the request itself, state facts, names, numbers or results, say anything is done, saved or sent, promise a time or an outcome, ask a question, or mention tools, systems or internal steps.",
  "No quotes, no markdown, no greeting unless they greeted you.",
].join(" ");

/** Earlier turns in another language must not pull the sentence away from the latest message's. */
export function replyLanguage(userText: string): string {
  return isChineseText(userText)
    ? "Write the sentence in Chinese."
    : "Write the sentence in the language of the latest message, not Chinese, even if earlier messages were.";
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** The first sentence of the text, with its end mark, or undefined while it is still being written. */
export function firstSentence(text: string): string | undefined {
  // A period right before a capitalised word also ends one: "…candidates.I can help…".
  const match = /^[\s\S]*?(?:[。！？!?]|\.(?=\s|[A-Z][a-z'’]*\s)|\n)/.exec(text.trimStart());
  return match?.[0];
}

/** One sentence the chat can show as-is, or null when the model gave nothing usable. */
export function cleanQuickReply(raw: string): string | null {
  if (/^(?:I hit a problem:|Unknown model |No response\. Try again\.)/i.test(raw.trim()))
    return null;
  const line = (firstSentence(raw) ?? raw)
    .trim()
    .replace(/^["'“”「」]+|["'“”「」]+$/g, "")
    .trim();
  if (!line || line.length > MAX_REPLY_CHARS) return null;
  if (/[?？]$/.test(line)) return null;
  return line;
}

/**
 * The short first reply the person sees while the full answer is still being worked out. One
 * small model call without reasoning per turn; failures just mean no quick reply. It resolves as
 * soon as the first sentence is written; the call still finishes so its usage is recorded.
 */
export function quickReply(input: {
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
  if (!input.userText.trim()) return Promise.resolve(null);
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
    "",
    replyLanguage(input.userText),
  ].join("\n");
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (text: string) => {
      if (settled) return;
      settled = true;
      const line = cleanQuickReply(text);
      if (!line)
        getLogger().info("quick_reply.dropped", {
          runId: input.runId,
          chars: text.trim().length,
          question: /[?？]\s*$/.test((firstSentence(text) ?? text).trim()),
        });
      resolve(line);
    };
    void (async () => {
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
          model: {
            ...input.model,
            thinkingLevel: "off",
            firstStepThinkingLevel: undefined,
            maxTokens: MAX_OUTPUT_TOKENS,
          },
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
        if (event.type === "text") {
          text += event.text;
          if (firstSentence(text)) settle(text);
        }
        if (event.type === "done" && event.text) text = event.text;
      }
      settle(text);
    })().catch((error) => {
      if (!settled) {
        settled = true;
        reject(error);
      } else getLogger().warn("quick reply finish failed", { runId: input.runId, error });
    });
  });
}
