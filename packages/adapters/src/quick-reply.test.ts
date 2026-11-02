import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { cleanQuickReply, quickReply } from "./quick-reply.js";

function runtimeReplying(text: string, seen: AgentRunRequest[] = []): AgentRuntime {
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
  userText: "帮我写一封面试后的跟进邮件",
  runId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
};

describe("quick reply", () => {
  it("returns one clean line from a thinking-off call without tools or history", async () => {
    const seen: AgentRunRequest[] = [];
    const text = await quickReply({
      ...base,
      earlier: [
        { role: "user", text: "too old" },
        ...Array.from({ length: 4 }, (_, index) => ({
          role: index % 2 ? ("assistant" as const) : ("user" as const),
          text: `turn ${index}`,
        })),
      ],
      runtime: runtimeReplying("「好的，我来写一封简短的跟进邮件。」\n", seen),
    });
    expect(text).toBe("好的，我来写一封简短的跟进邮件。");
    expect(seen[0]?.tools).toEqual([]);
    expect(seen[0]?.history).toEqual([]);
    expect(seen[0]?.model.thinkingLevel).toBe("off");
    expect(seen[0]?.prompt).toContain("帮我写一封面试后的跟进邮件");
    expect(seen[0]?.prompt).toContain("turn 3");
    expect(seen[0]?.prompt).not.toContain("too old");
  });

  it("skips empty turns without a model call", async () => {
    const seen: AgentRunRequest[] = [];
    expect(await quickReply({ ...base, userText: "  ", runtime: runtimeReplying("x", seen) })).toBe(
      null,
    );
    expect(seen).toHaveLength(0);
  });

  it("drops questions, long text and runtime filler", () => {
    expect(cleanQuickReply("你想招哪个职位？")).toBeNull();
    expect(cleanQuickReply("x".repeat(200))).toBeNull();
    expect(cleanQuickReply("No response. Try again.")).toBeNull();
    expect(cleanQuickReply("")).toBeNull();
    expect(cleanQuickReply("On it, checking your roles now.")).toBe(
      "On it, checking your roles now.",
    );
  });
});
