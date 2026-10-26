import type { Context } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_STREAM_IDLE_TIMEOUT_MESSAGE,
  reliableModelStream,
  resolveRuntimeModel,
} from "./pi-runtime.js";
import {
  MODEL_ERROR_BODY_TIMEOUT_MS,
  MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS,
} from "./pi-runtime-limits.js";

// A ChatGPT-style token: the Codex transport only reads the account claim.
const token = [
  "e30",
  btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })),
  "sig",
].join(".");
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
const never = () =>
  new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });

/** Runs the real Codex transport against a fetch that answers with `response` every time. */
async function silentRequest(response: () => Response) {
  const resolved = resolveRuntimeModel({
    provider: "openai-codex",
    id: "gpt-6-luna",
    oauth: {
      credential: {
        type: "oauth",
        access: token,
        refresh: "refresh",
        expires: Date.now() + 3_600_000,
      },
    },
  });
  const fetch = vi.fn(async () => response());
  const stream = reliableModelStream(
    resolved.models,
    resolved.model!,
    context,
    { apiKey: token, fetch },
    undefined,
  );
  let settled = false;
  const result = stream.result().finally(() => {
    settled = true;
  });
  return { fetch, result, settled: () => settled };
}

describe("a Codex request that hangs before the model says anything", () => {
  afterEach(() => vi.useRealTimers());

  it("fails a stream whose headers arrive but whose body stays silent", async () => {
    vi.useFakeTimers();
    const run = await silentRequest(
      () =>
        new Response(never(), { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    await vi.advanceTimersByTimeAsync(MODEL_STREAM_FIRST_EVENT_TIMEOUT_MS - 1_000);
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(run.result).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining(CODEX_STREAM_IDLE_TIMEOUT_MESSAGE),
    });
  });

  it("fails an error response whose body never finishes within seconds, not minutes", async () => {
    vi.useFakeTimers();
    const run = await silentRequest(() => new Response(never(), { status: 503 }));
    // pi retries the request once; each attempt's error body is bounded.
    await vi.advanceTimersByTimeAsync(2 * MODEL_ERROR_BODY_TIMEOUT_MS + 10_000);
    expect(run.fetch).toHaveBeenCalledTimes(2);
    await expect(run.result).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining(CODEX_STREAM_IDLE_TIMEOUT_MESSAGE),
    });
  });
});
