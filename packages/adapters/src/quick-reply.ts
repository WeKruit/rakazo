import type { AgentRunModel, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { isChineseText } from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { withoutNudge } from "./silent-reply.js";

// A busy model can take several seconds to start; a late first line still beats silence.
const TIMEOUT_MS = 8_000;
const MAX_USER_CHARS = 1_500;
const MAX_EARLIER_CHARS = 400;
const EARLIER_TURNS = 4;
const MAX_REPLY_CHARS = 160;
const MAX_OUTPUT_TOKENS = 80;

// Fixed text first, so providers that cache prompt prefixes can reuse it.
const INSTRUCTIONS = [
  'You are the assistant in this chat. The person just sent the latest message. Your full answer takes a little while, so first send one short sentence right away that names the concrete thing you will check or do first ("I\'ll check this role\'s email queue", "我先看这个岗位的发信队列").',
  'When the latest message confirms or approves something already shown (Send, Confirm, Allow, 发送, 确认, 同意), say you are going ahead with it ("好，现在发出。"), never that you will check it. An instruction for later ("once there are candidates, send them this") gets only that you are noting it ("好，我记下来。"), never how or when it will be done.',
  'Never paraphrase or restate their message ("I\'m looking into your question about…", "我正在梳理你问的…"), and never use the word 梳理.',
  "One sentence of at most 20 words (at most 30 characters in Chinese), in the language of the person's latest message, in the assistant's own voice.",
  "You cannot see their data yet: never say what you can or cannot see or find. Never answer the request itself, state facts, names, numbers or results, say anything is done, saved or sent, promise a time or an outcome, ask a question, or mention tools, systems or internal steps.",
  "No quotes, no markdown, no greeting unless they greeted you.",
  "The sentence is about the latest message alone: earlier messages and saved preferences are background, never the task.",
].join(" ");

// For a recruiter: a pasted job description is a role they hire for, not a job to apply to or an
// email to write because an earlier message mentioned emails.
const RECRUITING_INSTRUCTIONS = `${INSTRUCTIONS} The person is a recruiter. A job description they send is a role they are hiring for: say you are reading its requirements, never that you are applying to it or writing an email or anything else an earlier message asked for.`;

/** Earlier turns in another language must not pull the sentence away from the latest message's. */
export function replyLanguage(userText: string): string {
  return isChineseText(userText)
    ? "Write the sentence in Chinese."
    : "Write the sentence in the language of the latest message, not Chinese, even if earlier messages were.";
}

/**
 * The fixed first line for a message sent while a run works, or for a card answer: sent at once,
 * with no model call, in the language of the person's message. The run's own answer follows.
 */
export function fixedAck(userText: string): string {
  return isChineseText(userText) ? "收到，马上处理。" : "Got it, on it.";
}

const LEADING_ACK =
  /^\s*(?:(?:收到|好的|明白|了解|没问题)(?:了)?[，,：:。！!、\s]*|(?:got it|okay|ok|sure|understood|noted|will do)\b[,.:;!—–\-\s]*)/i;

/**
 * The run's own line without an opening acknowledgement, once the fixed line already said it.
 * A line that is only an acknowledgement stays as it is.
 */
export function withoutLeadingAck(text: string): string {
  const rest = text.replace(LEADING_ACK, "");
  if (!rest.trim() || rest === text) return text;
  return /^[a-z]/.test(rest) ? rest[0]!.toUpperCase() + rest.slice(1) : rest;
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
  if (/[?？]$/.test(line) || withoutNudge(line) !== line) return null;
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
  /** The person is a recruiter in a recruiting chat. */
  recruiting?: boolean;
  /** Tells apart several quick replies in one run, such as one per message sent while it works. */
  key?: string;
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
          runId: `${input.runId}:quick-reply${input.key ? `:${input.key}` : ""}`,
          usageOperationKind: "setup",
          prompt,
          instructions: input.recruiting ? RECRUITING_INSTRUCTIONS : INSTRUCTIONS,
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
          operationId: `quick-reply:${input.runId}${input.key ? `:${input.key}` : ""}`,
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
