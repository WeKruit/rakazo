import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { cleanSuggestion, suggestNextMessage } from "./reply-suggestion.js";

function runtimeReplying(text: string, seen: unknown[] = []): AgentRuntime {
  return {
    describe: () => ({}) as ReturnType<AgentRuntime["describe"]>,
    async *run(request: AgentRunRequest) {
      seen.push(request);
      yield { type: "done", text } satisfies AgentRuntimeEvent;
    },
  } as unknown as AgentRuntime;
}

const base = {
  model: { provider: "openai", id: "fast", thinkingLevel: "high" as const },
  userText: "Find backend engineers in Austin",
  replyText: "Here are ten people. Want me to keep going?",
  runId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
};

describe("reply suggestion", () => {
  it("returns one clean line from a thinking-off call without tools or history", async () => {
    const seen: Array<{ tools: unknown[]; history: unknown[]; model: { thinkingLevel: string } }> =
      [];
    const text = await suggestNextMessage({
      ...base,
      runtime: runtimeReplying('"Yes, find 20 more"\n', seen),
    });
    expect(text).toBe("Yes, find 20 more");
    expect(seen[0]?.tools).toEqual([]);
    expect(seen[0]?.history).toEqual([]);
    expect(seen[0]?.model.thinkingLevel).toBe("off");
  });

  it("gives the model the last few earlier turns so the guess fits the current task", async () => {
    const seen: Array<{ prompt: string }> = [];
    await suggestNextMessage({
      ...base,
      earlier: [
        { role: "user", text: "too old" },
        ...Array.from({ length: 6 }, (_, index) => ({
          role: index % 2 ? ("assistant" as const) : ("user" as const),
          text: `turn ${index}`,
        })),
        { role: "user", text: "我要招一个做 Agent 的 SWE" },
      ],
      runtime: runtimeReplying("应届生也可以", seen),
    });
    expect(seen[0]?.prompt).toContain("我要招一个做 Agent 的 SWE");
    expect(seen[0]?.prompt).not.toContain("too old");
    expect(seen[0]?.prompt.indexOf("Earlier in the conversation:")).toBeLessThan(
      seen[0]?.prompt.indexOf("Latest turn:") ?? -1,
    );
  });

  it("drops empty, failed or overlong output", () => {
    expect(cleanSuggestion("")).toBeNull();
    expect(cleanSuggestion("I hit a problem: timeout")).toBeNull();
    expect(cleanSuggestion("x".repeat(200))).toBeNull();
    expect(cleanSuggestion("「看看前十个」")).toBe("看看前十个");
  });
});
