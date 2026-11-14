import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  cleanQuickReply,
  firstSentence,
  inPersonLanguage,
  progressInOtherLanguage,
  quickReply,
  replyLanguage,
  withoutLeadingAck,
} from "./quick-reply.js";

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
    expect(seen[0]?.prompt).toContain("Write the sentence in Chinese,");
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
    // Staging 11-13: "好，现在发出。" read as sent while the email still needed Gmail connected.
    expect(seen[0]?.instructions).toContain("never that it is being sent");
    expect(seen[0]?.instructions).not.toContain("现在发出");
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

  it("answers in the person's language", () => {
    // Staging 11-13: a Chinese template request got an English first line.
    expect(
      inPersonLanguage("I'll draft a first-outreach email template for this role.", "zh"),
    ).toBe("收到，马上处理。");
    expect(inPersonLanguage("我先拟一封外联模板。", "zh")).toBe("我先拟一封外联模板。");
    expect(inPersonLanguage("I'll draft it.", "en")).toBe("I'll draft it.");
    // A Korean recruiter's first line came back in Chinese or English (simulated 2026-11-14).
    expect(inPersonLanguage("我先看看模板。", "ko")).toBe("네, 바로 처리할게요.");
    expect(inPersonLanguage(null, "zh")).toBeNull();
  });

  it("never says an email is going out", () => {
    // Staging 11-13: "发吧" got 「好，现在发出。」, then Gmail turned out not to be connected.
    expect(cleanQuickReply("好，现在发出。")).toBe("好，这就处理。");
    expect(cleanQuickReply("Sending it now.")).toBe("On it.");
    expect(cleanQuickReply("我先看这个岗位的发信队列。")).toBe("我先看这个岗位的发信队列。");
    // Simulated 11-14: a mention of sending is not a claim that something goes out.
    expect(cleanQuickReply("发出的邮件和回复在「收件箱」里看。")).toBe(
      "发出的邮件和回复在「收件箱」里看。",
    );
    expect(cleanQuickReply("把职位描述发给我就行。")).toBe("把职位描述发给我就行。");
    expect(cleanQuickReply("已发出两封。")).toBe("好，这就处理。");
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
  it("follows the turn's language, not a Chinese history", () => {
    expect(replyLanguage("en")).toContain("in English");
    expect(replyLanguage("ko")).toContain("in Korean");
  });
});

describe("progressInOtherLanguage", () => {
  it("drops a one-line progress note that left the person's language (simulated 2026-11-14)", () => {
    expect(
      progressInOtherLanguage(
        "I’ll revise the template to show a RMB 700,000–900,000 base and that Fridays are remote.",
        "zh",
      ),
    ).toBe(true);
    expect(progressInOtherLanguage("我先改模板里的薪资和远程安排。", "zh")).toBe(false);
    expect(progressInOtherLanguage("Hi {{firstName}},\n\nI'm reaching out…", "zh")).toBe(false);
  });
});

describe("withoutLeadingAck", () => {
  it("drops the run's own opening acknowledgement after the fixed line", () => {
    expect(withoutLeadingAck("收到：地点范围改为西雅图优先，同时接受美国境内远程。")).toBe(
      "地点范围改为西雅图优先，同时接受美国境内远程。",
    );
    expect(withoutLeadingAck("Got it — remote in the US works too.")).toBe(
      "Remote in the US works too.",
    );
    expect(withoutLeadingAck("好的，我会更新搜寻范围。")).toBe("我会更新搜寻范围。");
    expect(withoutLeadingAck("네, 영어 버전으로 작성했어요.")).toBe("영어 버전으로 작성했어요.");
  });

  it("keeps a line that is only an acknowledgement, or opens otherwise", () => {
    expect(withoutLeadingAck("收到。")).toBe("收到。");
    expect(withoutLeadingAck("Okayama is in scope.")).toBe("Okayama is in scope.");
    expect(withoutLeadingAck("地点已更新。")).toBe("地点已更新。");
  });
});
