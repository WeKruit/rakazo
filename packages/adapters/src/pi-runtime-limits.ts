import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import { DEFAULT_MODEL_MAX_TOKENS } from "@rakazo/contracts";

/** Hung completions must fail before the typical 5-minute run lease. */
export const MODEL_STREAM_TIMEOUT_MS = 120_000;
/**
 * `timeoutMs` bounds only time-to-headers; the SSE body that follows is
 * unbounded. A Codex stream silent this long is a dead connection — reasoning
 * models emit thinking deltas continuously while generating.
 */
export const MODEL_STREAM_IDLE_TIMEOUT_MS = 120_000;
/**
 * Codex sends response headers as soon as the stream opens, so a request still without headers
 * after this long is hung: fail the attempt and let the retry or the fallback model take over
 * instead of holding the recruiter for minutes.
 */
export const CODEX_STREAM_HEADERS_TIMEOUT_MS = 30_000;
/**
 * Once a Codex response's headers land, the stream reports its first item (reasoning, text or a
 * tool call) within seconds at any reasoning level. A stream still silent this long after its
 * headers is dead: it is aborted and retried instead of waiting out the full idle bound.
 */
export const MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS = 30_000;
/**
 * The retry after a first-event timeout waits longer, so a stream that was only slow (a large
 * prompt on a busy backend) still completes on its second attempt instead of failing twice.
 */
export const MODEL_STREAM_RETRY_FIRST_EVENT_TIMEOUT_MS = 90_000;
/** A provider error body is a few hundred bytes; one still unread after this is a stalled connection. */
export const MODEL_ERROR_BODY_TIMEOUT_MS = 15_000;
/** One model response, even one that keeps streaming, ends within this; a lease is 5 minutes. */
export const MODEL_STREAM_TOTAL_TIMEOUT_MS = 240_000;
export const DEFAULT_MODEL_STREAM_MAX_RETRIES = 1;

/** More retries extend the worst-case turn; the executor heartbeat renews its leases. */
export function modelStreamMaxRetries(): number {
  const value = process.env.MODEL_STREAM_MAX_RETRIES?.trim();
  const raw = Number(value || DEFAULT_MODEL_STREAM_MAX_RETRIES);
  return Number.isInteger(raw) && raw >= 0 && raw <= 5 ? raw : DEFAULT_MODEL_STREAM_MAX_RETRIES;
}

export const TOOL_RESULT_TEXT_LIMIT = 12_000;

export function clipToolResultText(text: string, limit: number = TOOL_RESULT_TEXT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Share one remaining character budget across all text parts.
 * Later text is omitted once the aggregate limit is exhausted; non-text parts stay.
 */
export function clipToolResultContent<T>(
  content: T[],
  limit: number = TOOL_RESULT_TEXT_LIMIT,
): T[] {
  let remaining = limit;
  const clipped: T[] = [];
  for (const part of content) {
    if (
      !part ||
      typeof part !== "object" ||
      !("type" in part) ||
      (part as { type?: unknown }).type !== "text" ||
      !("text" in part)
    ) {
      clipped.push(part);
      continue;
    }
    if (remaining <= 0) continue;
    const text = String((part as { text: unknown }).text);
    if (text.length <= remaining) {
      clipped.push(part);
      remaining -= text.length;
      continue;
    }
    clipped.push({ ...part, text: clipToolResultText(text, remaining) });
    remaining = 0;
  }
  return clipped;
}

/**
 * Prompt tokens providers bill, including cache read/write rather than the uncached remainder.
 * The cache halves are reported alongside so downstream views can show what a cache hit saved.
 */
export function billedPromptTokens(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const cacheReadTokens = nonNegativeCount(usage.cacheRead);
  const cacheWriteTokens = nonNegativeCount(usage.cacheWrite);
  return {
    inputTokens: nonNegativeCount(usage.input) + cacheReadTokens + cacheWriteTokens,
    outputTokens: nonNegativeCount(usage.output),
    cacheReadTokens,
    cacheWriteTokens,
  };
}

/**
 * A reasoning model spends this same budget on its thinking, so the modest default
 * can be consumed before the reply starts. Wide enough for thinking plus an answer,
 * still far below a model card's 128k ceiling.
 */
export const REASONING_MODEL_MAX_TOKENS = 32_768;

/**
 * Completions default to a modest output cap so OpenRouter-style providers do not
 * hold credit for a model card's 128k ceiling. A configured maxTokens is the escape.
 * Reasoning models get the wider default because their thinking is billed against
 * the same ceiling: at 4k a hard question can leave no room for the reply at all.
 */
export function resolveCompletionMaxTokens(
  modelMaxTokens?: number,
  configuredMaxTokens?: number,
  optionsMaxTokens?: number,
  reasoning?: boolean,
): number {
  const userCap =
    typeof configuredMaxTokens === "number" && configuredMaxTokens >= 1
      ? configuredMaxTokens
      : reasoning
        ? REASONING_MODEL_MAX_TOKENS
        : DEFAULT_MODEL_MAX_TOKENS;
  const optionCap =
    typeof optionsMaxTokens === "number" && optionsMaxTokens >= 1
      ? Math.min(optionsMaxTokens, userCap)
      : userCap;
  if (typeof modelMaxTokens === "number" && modelMaxTokens >= 1) {
    return Math.min(modelMaxTokens, optionCap);
  }
  return optionCap;
}

function nonNegativeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export type StoredToolOutput = { artifactId: string; length: number };
export type ToolOutputStore = (text: string) => Promise<StoredToolOutput | undefined>;

/** Pointer the model sees after a clipped result; the full text stays readable on demand. */
export function fullToolOutputPointer(stored: StoredToolOutput): string {
  return `\n[Output clipped. The complete ${stored.length}-character result is saved; read it with artifact_read artifactId "${stored.artifactId}" using offset and limit.]`;
}

/**
 * Clip text for the context and, when a store is available, keep the complete text as an
 * artifact and append a pointer. Without a store this is exactly the old clip.
 */
export async function clipWithFullOutput(
  text: string,
  clip: (text: string) => string,
  store: ToolOutputStore | undefined,
  limit: number = TOOL_RESULT_TEXT_LIMIT,
): Promise<string> {
  if (text.length <= limit) return text;
  const clipped = clip(text);
  if (!store) return clipped;
  const stored = await store(text).catch(() => undefined);
  return stored ? `${clipped}${fullToolOutputPointer(stored)}` : clipped;
}

/** Content-part variant: clips text parts by one shared budget and adds a pointer part. */
export async function clipContentWithFullOutput<T>(
  content: T[],
  store: ToolOutputStore | undefined,
  limit: number = TOOL_RESULT_TEXT_LIMIT,
): Promise<T[]> {
  const texts = content.flatMap((part) =>
    part &&
    typeof part === "object" &&
    "type" in part &&
    (part as { type?: unknown }).type === "text" &&
    "text" in part
      ? [String((part as { text: unknown }).text)]
      : [],
  );
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  const clipped = clipToolResultContent(content, limit);
  if (total <= limit || !store) return clipped;
  const stored = await store(texts.join("\n")).catch(() => undefined);
  if (!stored) return clipped;
  return [...clipped, { type: "text", text: fullToolOutputPointer(stored) } as T];
}

/** Compact once the context passes about 80% of the window, so a long run never hits the provider's limit. */
export function compactionReserveTokens(window: number, output: number): number {
  return Math.min(
    Math.max(DEFAULT_COMPACTION_SETTINGS.reserveTokens, Math.floor(window * 0.2)),
    Math.max(0, window - output),
  );
}
