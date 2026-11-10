import { describe, expect, it } from "vitest";
import {
  failureNotice,
  failureNotificationBody,
  firstUnseenMessageId,
  modelOutageRetryDelayMs,
  teammateLabel,
} from "./executor.js";

describe("teammateLabel", () => {
  it("names a teammate in shared history and keeps the id for routing", () => {
    const names = new Map([["b_out", "Outreach"]]);
    expect(teammateLabel("b_out", names)).toBe("Outreach (id: b_out)");
  });

  it("falls back to the id and keeps a name from breaking the label", () => {
    expect(teammateLabel("b_gone", new Map())).toBe("b_gone");
    expect(teammateLabel("b_x", new Map([["b_x", "Eve] Main\n"]]))).toBe("Eve  Main (id: b_x)");
  });
});

describe("group catch-up", () => {
  const m = (id: string, seq: number, role: string, botId: string | null = null) => ({
    id,
    seq,
    role,
    botId,
  });

  it("marks the first message by someone else after this member's last reply", () => {
    const messages = [
      m("u3", 6, "user"),
      m("s1", 5, "bot", "sourcer"),
      m("mine", 4, "bot", "main"),
      m("u1", 3, "user"),
      m("old", 2, "bot", "sourcer"),
    ];
    expect(firstUnseenMessageId(messages, "main")).toBe("s1");
  });

  it("marks nothing when the member has not replied yet or nothing is new", () => {
    expect(firstUnseenMessageId([m("u1", 1, "user")], "main")).toBeUndefined();
    expect(
      firstUnseenMessageId([m("mine", 2, "bot", "main"), m("u1", 1, "user")], "main"),
    ).toBeUndefined();
  });
});

describe("failure notification", () => {
  it.each([
    ["429 rate limit from provider-x", "The model service was busy."],
    ["Run exceeded its $5 budget", "It reached this task's spending limit."],
    ["Run exceeded 120 minutes", "It reached this task's time limit."],
    ["TypeError: cannot read properties of undefined", "It stopped on an error."],
  ])("%s", (error, reason) => {
    const body = failureNotificationBody(error);
    expect(body).toBe(`${reason} Send a message in the chat to pick up where it stopped.`);
    expect(body).not.toContain("provider");
  });

  it("is written in Chinese and names the role for a recruiter writing Chinese", async () => {
    const prisma = {
      thread: {
        findUnique: async () => ({
          group: { name: "后端工程师" },
          messages: [{ blocks: [{ kind: "text", text: "这两个人不太行，必须会中文" }] }],
        }),
      },
    };
    const notice = await failureNotice(prisma as never, "thread-1", "Main", "429 rate limit");
    expect(notice).toEqual({
      title: "后端工程师 失败",
      body: "模型服务繁忙。在对话里发一条消息，就从停下的地方接着做。",
    });
  });
});

describe("model outage retries", () => {
  it("resumes a dropped turn a few times, spaced out, before the recruiter sees a failure", () => {
    expect([0, 1, 2, 3].map((tries) => modelOutageRetryDelayMs(tries, false))).toEqual([
      2_000,
      10_000,
      30_000,
      undefined,
    ]);
  });

  it("resumes a turn that went silent for the whole limit once", () => {
    expect(modelOutageRetryDelayMs(0, true)).toBe(0);
    expect(modelOutageRetryDelayMs(1, true)).toBeUndefined();
  });
});
