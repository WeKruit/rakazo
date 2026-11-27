import { describe, expect, it, vi } from "vitest";
import {
  delegatedRequestMessage,
  newestRecruiterWords,
  otherRoleWriteRefusal,
  roleRequestMessage,
} from "./global-role-writes.js";

function prisma(boundRoleId?: string) {
  return {
    externalEffect: {
      findFirst: vi.fn(async () => (boundRoleId ? { request: { roleId: boundRoleId } } : null)),
    },
    recruitingRole: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === "role-1" ? { id: "role-1", title: "Senior Data Engineer — Seattle" } : null,
      ),
    },
  };
}
const actor = { spaceId: "s", userId: "u", threadId: "global" };

describe("otherRoleWriteRefusal", () => {
  it("keeps a role's conversation to its own role's campaigns (stop-after-approve, 11-20)", async () => {
    // "全停掉" in one role's conversation also paused two other roles' campaigns.
    const error = await otherRoleWriteRefusal(prisma("role-1") as never, actor, "role-2", {
      toolName: "native_instantly_pause_campaign",
      args: { campaign_id: "c-1" },
    });
    expect(error).toContain("Senior Data Engineer — Seattle");
    expect(
      await otherRoleWriteRefusal(prisma("role-1") as never, actor, "role-1", {
        toolName: "native_instantly_pause_campaign",
        args: { campaign_id: "c-1" },
      }),
    ).toBeUndefined();
    expect(
      await otherRoleWriteRefusal(prisma() as never, actor, "role-2", {
        toolName: "native_instantly_pause_campaign",
        args: { campaign_id: "one-off" },
      }),
    ).toBeUndefined();
  });
});

describe("roleRequestMessage", () => {
  it("puts the recruiter's words first and a teammate's brief after them as a note", () => {
    // team-has-no-email 11-16: the note named Bhargav; only 「没存的话现在怎么办？」 reached the
    // team, which took "him" to be the person its own conversation last talked about.
    const message = roleRequestMessage({
      recruiterWords: "没存的话现在怎么办？",
      brief: "Candidate Bhargav P: is his email saved?",
    });
    expect(message).toContain('word for word:\n"没存的话现在怎么办？"');
    expect(message).toContain("Teammate's note (not the recruiter's words):");
    expect(message.indexOf("没存的话")).toBeLessThan(message.indexOf("Bhargav P"));
  });

  it("keeps the brief alone when no recruiter message started this turn", () => {
    expect(
      roleRequestMessage({ recruiterWords: "", brief: "Goal: use Ana's profile from the other role" }),
    ).toBe("Goal: use Ana's profile from the other role");
  });
});

describe("delegatedRequestMessage", () => {
  it("carries the recruiter's words and only the people and round they refer to", () => {
    // Staging 11-15: Kruit's brief turned "find more like the rest" into "find the next 20 people".
    const words = "3 and 10 aren't a fit, find more like the rest";
    expect(
      delegatedRequestMessage(
        words,
        [{ candidateKey: "linkedin:ada", name: "Ada Chen", linkedinUrl: "https://linkedin.com/in/ada" }],
        1,
      ),
    ).toBe(
      `The recruiter wrote, word for word:\n"${words}"\n\nPeople they refer to: Ada Chen, https://linkedin.com/in/ada.\n\nRound they refer to: round 1.`,
    );
    expect(delegatedRequestMessage("find 20 more", [])).toBe(
      'The recruiter wrote, word for word:\n"find 20 more"',
    );
  });
});

describe("newestRecruiterWords", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 10, minute));
  const thread = (rows: unknown[]) => ({ message: { findMany: vi.fn(async () => rows) } });
  it("takes a card's answer over the opening message it came after (play s165)", async () => {
    // The turn-down came as the answer to the first round's card, in the run that opened the
    // role, and the hand-off quoted the opening "找10人" as the request.
    const words = await newestRecruiterWords(
      thread([
        {
          role: "bot",
          blocks: [{ kind: "ask", status: "answered", answer: "张钰职级偏低，排除" }],
          createdAt: at(39),
          updatedAt: at(40),
        },
        {
          role: "user",
          blocks: [{ kind: "text", text: "新开岗位…找10人。" }],
          createdAt: at(38),
          updatedAt: at(38),
        },
      ]) as never,
      "t",
    );
    expect(words).toBe("张钰职级偏低，排除");
  });
  it("takes the words a request from Kruit's conversation carried, never its brief", async () => {
    const words = await newestRecruiterWords(
      thread([
        {
          role: "user",
          blocks: [
            {
              kind: "bot_message_received",
              text: "The recruiter wrote…\n\nKruit's note: next ten",
              recruiterWords: "新增里还有一堆不是Senior",
            },
          ],
          createdAt: at(55),
          updatedAt: at(55),
        },
        {
          role: "bot",
          blocks: [{ kind: "ask", status: "answered", answer: "older answer" }],
          createdAt: at(39),
          updatedAt: at(40),
        },
      ]) as never,
      "t",
    );
    expect(words).toBe("新增里还有一堆不是Senior");
  });
});
