import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { cleanQuickReply, firstSentence, quickReply, replyLanguage } from "./quick-reply.js";

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
    expect(seen[0]?.prompt).toContain("Write the sentence in Chinese.");
  });

  it("reads a JD after a saved email preference as a role to hire for", async () => {
    const seen: AgentRunRequest[] = [];
    await quickReply({
      ...base,
      recruiting: true,
      earlier: [
        { role: "user", text: "记住：以后所有候选人邮件都用英文写，署名 Jules Hou" },
        { role: "assistant", text: "已记住：以后所有候选人邮件都用英文写，并署名 Jules Hou。" },
      ],
      userText: "Senior Data Engineer — Seattle, WA. Requirements: 6+ years of data engineering.",
      runtime: runtimeReplying("I'm reading the role's requirements.", seen),
    });
    expect(seen[0]?.instructions).toContain(
      "earlier messages and saved preferences are background",
    );
    expect(seen[0]?.instructions).toContain(
      "A job description they send is a role they are hiring for",
    );
    // Outside recruiting chats the recruiter sentence stays out.
    await quickReply({ ...base, runtime: runtimeReplying("On it.", seen) });
    expect(seen[1]?.instructions).not.toContain("recruiter");
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

  it("keeps only the first sentence", () => {
    expect(cleanQuickReply("我来看看你的职位。目前看不到任何职位。")).toBe("我来看看你的职位。");
    expect(cleanQuickReply("On it. Checking now.")).toBe("On it.");
    expect(
      cleanQuickReply("I'm on it for the U.S.I'll focus on remote people.I can help you."),
    ).toBe("I'm on it for the U.S.");
    expect(cleanQuickReply("Finding engineers.I can help you find them.")).toBe(
      "Finding engineers.",
    );
    expect(firstSentence("我来看看")).toBeUndefined();
    expect(firstSentence("Version 2.5 is out")).toBeUndefined();
  });

  it("resolves at the first sentence and still reads the call to its usage", async () => {
    const usage: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = {
      describe: () => ({}) as ReturnType<AgentRuntime["describe"]>,
      async *run() {
        yield { type: "text", text: "好的，我来" } satisfies AgentRuntimeEvent;
        yield { type: "text", text: "写这封邮件。然后" } satisfies AgentRuntimeEvent;
        await gate;
        yield { type: "usage", accounted: false } as unknown as AgentRuntimeEvent;
        yield {
          type: "done",
          text: "好的，我来写这封邮件。然后再说。",
        } satisfies AgentRuntimeEvent;
      },
    } as unknown as AgentRuntime;
    const line = await quickReply({
      ...base,
      runtime,
      onUsage: async (event) => usage.push(event),
    });
    expect(line).toBe("好的，我来写这封邮件。");
    expect(usage).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(usage).toHaveLength(1));
  });
});

describe("replyLanguage", () => {
  it("follows the latest message, not a Chinese history", () => {
    expect(
      replyLanguage("New role from our client Northwind Pay. Please start sourcing"),
    ).toContain("not Chinese");
    expect(replyLanguage("帮我找 USC 的 AI engineer")).toBe("Write the sentence in Chinese.");
  });
});
