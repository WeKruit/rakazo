import { describe, expect, it, vi } from "vitest";
import {
  COMPLETION_EMAIL_KIND,
  recordCompletionEmailChoice,
  sendCompletionEmailIfDone,
} from "./completion-email.js";
import { recruitingResearchInFlight } from "./recruiting-research-poll.js";

vi.mock("./recruiting-research-poll.js", () => ({
  recruitingResearchInFlight: vi.fn(async () => false),
}));

const turn = {
  id: "run-final",
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "main",
  userId: "user-1",
};

function harness(
  options: { armed?: { id: string; runId: string } | null; busy?: number; replies?: string[] } = {},
) {
  const send = vi.fn(async () => undefined);
  const update = vi.fn(async () => ({}));
  const claim = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    externalEffect: {
      findFirst: vi.fn(async () =>
        options.armed === null ? null : (options.armed ?? { id: "effect-1", runId: "run-ask" }),
      ),
      updateMany: claim,
      update,
      upsert: vi.fn(async () => ({})),
    },
    run: { count: vi.fn(async () => options.busy ?? 0) },
    thread: {
      findUnique: vi.fn(async () => ({
        activeRecruitingRole: { id: "role-1", title: "Senior Sales Engineer" },
      })),
    },
    user: { findUnique: vi.fn(async () => ({ email: "recruiter@example.com" })) },
    message: {
      findMany: vi.fn(async () =>
        (options.replies ?? []).map((text) => ({ blocks: text ? [{ kind: "text", text }] : [] })),
      ),
    },
  };
  return {
    deps: { prisma: prisma as never, email: { send } as never, webOrigin: "https://app.test" },
    prisma,
    send,
    update,
    claim,
  };
}

const ended = {
  text: "Found **150** people; all saved in Results.",
  groupId: "group-1",
  continuing: false,
};

describe("completion email", () => {
  it("emails the recruiter once the work they asked about has finished", async () => {
    const { deps, send, update } = harness();
    await sendCompletionEmailIfDone(deps, turn, ended);
    expect(send).toHaveBeenCalledWith({
      to: "recruiter@example.com",
      subject: "Senior Sales Engineer is done",
      text: "Found 150 people; all saved in Results.\n\nOpen it: https://app.test/app/g/group-1",
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "sent" }) }),
    );
  });

  it("waits while a teammate or research is still running, or the turn carries on", async () => {
    const busy = harness({ busy: 1 });
    await sendCompletionEmailIfDone(busy.deps, turn, ended);
    const continuing = harness();
    await sendCompletionEmailIfDone(continuing.deps, turn, { ...ended, continuing: true });
    vi.mocked(recruitingResearchInFlight).mockResolvedValueOnce(true);
    const researching = harness();
    await sendCompletionEmailIfDone(researching.deps, turn, ended);
    const sameTurn = harness({ armed: { id: "effect-1", runId: turn.id } });
    await sendCompletionEmailIfDone(sameTurn.deps, turn, ended);
    const unasked = harness({ armed: null });
    await sendCompletionEmailIfDone(unasked.deps, turn, ended);
    for (const { send, claim } of [busy, continuing, researching, sameTurn, unasked]) {
      expect(send).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
    }
  });

  it("uses the latest reply when the final turn only checked a teammate's result", async () => {
    const { deps, send } = harness({ replies: ["", "Done: 152 people found."] });
    await sendCompletionEmailIfDone(deps, turn, { ...ended, text: "" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Done: 152 people found.") }),
    );
  });

  it("says an answer is needed when the work stops on a question", async () => {
    const { deps, send } = harness();
    await sendCompletionEmailIfDone(deps, turn, {
      ...ended,
      text: "Only 40 meet everything. Widen the area?",
      question: true,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Senior Sales Engineer: your answer is needed" }),
    );
  });

  it("records a failed send without throwing, and sends nothing without email set up", async () => {
    const failing = harness();
    failing.send.mockRejectedValueOnce(new Error("smtp down"));
    await expect(sendCompletionEmailIfDone(failing.deps, turn, ended)).resolves.toBeUndefined();
    expect(failing.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) }),
    );
    const none = harness();
    await sendCompletionEmailIfDone({ ...none.deps, email: undefined }, turn, ended);
    expect(none.prisma.externalEffect.findFirst).not.toHaveBeenCalled();
  });

  it("keeps one waiting yes per conversation and records a no", async () => {
    const { prisma } = harness();
    await expect(
      recordCompletionEmailChoice(prisma as never, turn, { email: false }),
    ).resolves.toEqual({ ok: true, email: false });
    expect(prisma.externalEffect.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ kind: COMPLETION_EMAIL_KIND, status: "armed" }),
        data: { status: "replaced" },
      }),
    );
    expect(prisma.externalEffect.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "declined", runId: turn.id }),
      }),
    );
    await expect(
      recordCompletionEmailChoice(prisma as never, turn, { email: "yes" }),
    ).resolves.toEqual({ error: "email must be true or false." });
  });
});
