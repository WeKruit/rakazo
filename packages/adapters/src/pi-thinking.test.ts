import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { messageThinking, replayableThinking } from "./pi-runtime.js";

const model = {
  provider: "openai-codex",
  id: "gpt-6-luna",
  api: "openai-codex-responses",
} as Model<Api>;

describe("reply reasoning", () => {
  it("keeps an assistant message's thinking blocks with the model that wrote them", () => {
    expect(
      messageThinking({
        provider: "openai-codex",
        model: "gpt-6-luna",
        api: "openai-codex-responses",
        content: [
          { type: "thinking", thinking: "Compare the two roles", thinkingSignature: "sig-1" },
          { type: "thinking", thinking: "", thinkingSignature: "enc", redacted: true },
          { type: "thinking", thinking: "" },
          { type: "text", text: "Done." },
        ],
      }),
    ).toEqual({
      provider: "openai-codex",
      model: "gpt-6-luna",
      api: "openai-codex-responses",
      blocks: [
        { thinking: "Compare the two roles", thinkingSignature: "sig-1" },
        { thinking: "", thinkingSignature: "enc", redacted: true },
      ],
    });
    expect(
      messageThinking({
        provider: "p",
        model: "m",
        api: "a",
        content: [{ type: "text", text: "x" }],
      }),
    ).toBeNull();
  });

  it("replays reasoning only to the same provider, model and API", () => {
    const thinking = {
      provider: "openai-codex",
      model: "gpt-6-luna",
      api: "openai-codex-responses",
      blocks: [{ thinking: "plan", thinkingSignature: "sig" }],
    };
    expect(replayableThinking(thinking, model)).toEqual([
      { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
    ]);
    expect(replayableThinking({ ...thinking, model: "gpt-6.1-sol" }, model)).toEqual([]);
    expect(replayableThinking({ ...thinking, provider: "openrouter" }, model)).toEqual([]);
    expect(replayableThinking(undefined, model)).toEqual([]);
  });
});
