import type { AgentRunModel, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import type { ReplyLanguage } from "@rakazo/core";
import {
  inOtherLanguage,
  REPLY_LANGUAGE_NAME,
  recruiterLanguage,
  textLanguage,
} from "@rakazo/core";
import { getLogger } from "@rakazo/logging";
import { withoutNudge } from "./silent-reply.js";

// A busy model can take several seconds to start; a late first line still beats silence.
const TIMEOUT_MS = 8_000;
const MAX_USER_CHARS = 1_500;
const MAX_EARLIER_CHARS = 400;
const EARLIER_TURNS = 4;
const MAX_REPLY_CHARS = 160;
const MAX_RECORDS_CHARS = 3_000;
const MAX_OUTPUT_TOKENS = 80;

// Fixed text first, so providers that cache prompt prefixes can reuse it.
const INSTRUCTIONS = [
  'You are the assistant in this chat. The person just sent the latest message. Your full answer takes a little while, so first send one short sentence right away that already gives them something: when the saved records below answer the latest message, that answer in your own words for this ask (say how many roles there are when they ask how many, never a sentence copied from an earlier reply); otherwise the concrete thing you are doing for this ask, never a bare "let me check" ("I\'ll draft the English template for this role", "我按这个岗位写一版英文模板").',
  'When the latest message confirms or approves something already shown (Send, Confirm, Allow, 发送, 发吧, 确认, 同意), say you are going ahead with it ("好，这就处理。"), never that it is being sent (a send can still need a connection or a card) and never that you will check it. An instruction for later ("once there are candidates, send them this") gets only that you are noting it ("好，我记下来。"), never how or when it will be done; when it also asks something ("…会怎么发？"), name what you will check instead.',
  'Never paraphrase or restate their message ("I\'m looking into your question about…", "我正在梳理你问的…"), and never use the word 梳理.',
  "One sentence of at most 20 words (at most 30 characters in Chinese), in the language of the person's latest message, in the assistant's own voice.",
  "State only facts the saved records below show, in their words; with no records, or none that answer it, state no facts, names, numbers or results and never say what you can or cannot see or find. Never say anything is done, saved or sent that the records do not show, promise a time or an outcome, ask a question, or mention tools, systems or internal steps.",
  "No quotes, no markdown, no greeting unless they greeted you.",
  "The sentence is about the latest message alone: earlier messages and saved preferences are background, never the task.",
].join(" ");

// For a recruiter: a pasted job description is a role they hire for, not a job to apply to or an
// email to write because an earlier message mentioned emails.
const RECRUITING_INSTRUCTIONS = `${INSTRUCTIONS} The person is a recruiter. A job description they send is a role they are hiring for: say you are reading its requirements, never that you are applying to it or writing an email or anything else an earlier message asked for.`;

/** Earlier turns in another language must not pull the sentence away from the latest message's. */
export function replyLanguage(language: ReplyLanguage): string {
  return `Write the sentence in ${REPLY_LANGUAGE_NAME[language]}, even if earlier messages were in another language.`;
}

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

// A claim that something goes out now, not any mention of sending: simulated 11-14, "发出的邮件
// 和回复去哪看" and "把职位描述发给我" were turned into 「好，这就处理。」.
const SAYS_SENDING =
  /(?:现在|马上|正在|这就|立即|立刻|即将|已经?)\s*(?:发|寄)|\b(?:sending|sent|send(?:s)? (?:it|this|them|now|out))\b/i;

/**
 * The line in the person's language: staging 11-13, a Chinese request got "I'll draft a first
 * outreach email template for this role." A line in another language becomes the fixed one.
 */
export function inPersonLanguage(line: string | null, language: ReplyLanguage): string | null {
  if (!line || !inOtherLanguage(line, language)) return line;
  return fixedAck(language);
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
  // Staging 11-13: "发吧" got 「好，现在发出。」 and then no mailbox was connected. A send can
  // still need a connection or a card, so the first line never says it is going out.
  if (SAYS_SENDING.test(line)) return GOING_AHEAD[textLanguage(line, 1) ?? "en"];
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
  /** The working-state card, read from saved records this turn, when it was ready in time. */
  records?: string | undefined;
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
  // A short message with no clear language ("200-250k base 加上") keeps the person's earlier one.
  const language = recruiterLanguage([
    input.userText,
    ...(input.earlier ?? [])
      .filter((turn) => turn.role === "user")
      .map((turn) => turn.text)
      .reverse(),
  ]);
  const prompt = [
    ...(input.records?.trim()
      ? ["Saved records now:", clip(input.records, MAX_RECORDS_CHARS), ""]
      : []),
    ...(earlier.length ? ["Earlier in the conversation:", ...earlier, ""] : []),
    "Latest message from the person:",
    clip(input.userText, MAX_USER_CHARS),
    "",
    replyLanguage(language),
  ].join("\n");
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (text: string) => {
      if (settled) return;
      settled = true;
      const line = inPersonLanguage(cleanQuickReply(text), language);
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
