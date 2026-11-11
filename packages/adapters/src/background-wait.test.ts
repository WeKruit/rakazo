import { describe, expect, it, vi } from "vitest";
import { waitForBackgroundWork } from "./background-wait.js";

const research = { id: "research-1", kind: "research", status: "running" };
const search = { id: "effect-1", kind: "agent_run", status: "running" };
const self = { id: "run-self", kind: "run", status: "running" };

function prisma(...lists: unknown[][]) {
  const $queryRaw = vi.fn();
  for (const list of lists) $queryRaw.mockResolvedValueOnce(list);
  $queryRaw.mockResolvedValue(lists.at(-1));
  return { $queryRaw } as never;
}

const base = { threadId: "thread-1", selfRunId: "run-self", pollMs: 1 };

describe("waitForBackgroundWork", () => {
  // 11-11 staging: a role's coordinator waited 40 min on Outreach paused at a Send card, and a
  // new request handed to it sat queued the whole time.
  it("never waits on a teammate's turn paused on a person's card", async () => {
    const db = prisma([]);
    await waitForBackgroundWork(db, { ...base, signal: new AbortController().signal });
    const query = JSON.stringify(
      (db as { $queryRaw: { mock: { calls: unknown[] } } }).$queryRaw.mock.calls[0],
    );
    expect(query).toContain('"running"');
    expect(query).not.toContain("waiting_input");
  });

  it("returns when all background work is done, never waiting on its own run", async () => {
    const result = await waitForBackgroundWork(
      prisma([research, search, self], [search, self], [self]),
      { ...base, signal: new AbortController().signal },
    );
    expect(result).toMatchObject({
      done: [
        { id: "research-1", kind: "research" },
        { id: "effect-1", kind: "agent_run" },
      ],
      running: [],
      timedOut: false,
    });
  });

  it("returns at the first finish in any mode", async () => {
    const result = await waitForBackgroundWork(prisma([research, search], [search]), {
      ...base,
      mode: "any",
      signal: new AbortController().signal,
    });
    expect(result.done).toEqual([{ id: "research-1", kind: "research" }]);
    expect(result.running).toEqual([{ id: "effect-1", kind: "agent_run" }]);
  });

  it("reports what is still running at the timeout", async () => {
    const result = await waitForBackgroundWork(prisma([research]), {
      ...base,
      timeoutSeconds: 1,
      pollMs: 200,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ done: [], running: [{ id: "research-1" }], timedOut: true });
  });

  it("waits only for the named ids and says when nothing is running", async () => {
    const named = await waitForBackgroundWork(prisma([research, search], [research]), {
      ...base,
      ids: ["effect-1"],
      signal: new AbortController().signal,
    });
    expect(named.done).toEqual([{ id: "effect-1", kind: "agent_run" }]);
    const idle = await waitForBackgroundWork(prisma([self]), {
      ...base,
      signal: new AbortController().signal,
    });
    expect(idle.note).toMatch(/Nothing is running/);
  });

  it("ends the wait when the user writes, so the reply does not wait behind the work", async () => {
    const userMessageWaiting = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const result = await waitForBackgroundWork(prisma([research]), {
      ...base,
      timeoutSeconds: 1800,
      userMessageWaiting,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      done: [],
      running: [{ id: "research-1" }],
      timedOut: false,
      userMessage: true,
    });
    expect(result.note).toMatch(/new message/);
    expect(userMessageWaiting).toHaveBeenCalledTimes(2);
  });

  it("stops at once when the turn is stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await waitForBackgroundWork(prisma([research]), {
      ...base,
      signal: controller.signal,
    });
    expect(result.running).toEqual([{ id: "research-1", kind: "research" }]);
    expect(result.timedOut).toBe(false);
  });
});
