import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { LiveThread } from "./thread-reducer.js";
import { threadTailPhase } from "./thread-tail.js";

function thread(
  runs: Array<{ id: string; status: string }>,
  messages: Array<{ id: string; runId?: string; blocks: MessageBlock[] }> = [],
): Pick<LiveThread, "run" | "activeRuns" | "messages"> {
  return {
    run: runs[0] ?? null,
    activeRuns: runs,
    messages: messages.map((message) => ({ role: "bot", ...message })),
  };
}

describe("thread tail phase", () => {
  it("says the context is being compacted ahead of plain work", () => {
    expect(
      threadTailPhase(
        thread(
          [{ id: "run", status: "running" }],
          [
            {
              id: "progress:run",
              runId: "run",
              blocks: [{ kind: "progress", text: "", activity: true, phase: "compacting" }],
            },
          ],
        ),
      ),
    ).toBe("compacting");
  });

  it("says the reply is reconnecting while a silent model call is retried", () => {
    expect(
      threadTailPhase(
        thread(
          [{ id: "run", status: "running" }],
          [
            {
              id: "progress:run",
              runId: "run",
              blocks: [{ kind: "progress", text: "", activity: true, phase: "retrying" }],
            },
          ],
        ),
      ),
    ).toBe("retrying");
  });

  it("asks for an answer only when no open ask card already does", () => {
    const waiting = [{ id: "run", status: "waiting_input" }];
    expect(threadTailPhase(thread(waiting))).toBe("needs_input");
    expect(
      threadTailPhase(
        thread(waiting, [
          { id: "ask", runId: "run", blocks: [{ kind: "ask", text: "Which city?" }] },
        ]),
      ),
    ).toBeNull();
  });

  it("shows starting the moment the user sends, ahead of an earlier pause", () => {
    expect(
      threadTailPhase(thread([{ id: "run", status: "waiting_input" }]), { sending: true }),
    ).toBe("starting");
    expect(threadTailPhase(thread([{ id: "run", status: "running" }]), { sending: true })).toBe(
      "starting",
    );
  });

  it("keeps received queued messages visible through a reconnect or an earlier card wait", () => {
    for (const status of ["waiting_input", "waiting_takeover", "queued", "leased"]) {
      const snapshot = {
        ...thread([{ id: "previous", status }]),
        queuedMessageIds: ["received"],
      };
      expect(threadTailPhase(snapshot)).toBe("queued");
    }
    expect(threadTailPhase({ ...thread([]), queuedMessageIds: ["received"] })).toBe("queued");
  });

  it("acknowledges a new send before an older run's reconnect or compaction status", () => {
    for (const phase of ["retrying", "compacting"] as const) {
      const snapshot = thread(
        [{ id: "old", status: "running" }],
        [
          {
            id: "progress:old",
            runId: "old",
            blocks: [{ kind: "progress", text: "", activity: true, phase }],
          },
        ],
      );
      expect(threadTailPhase(snapshot, { sending: true })).toBe("starting");
    }
  });

  it("keeps a group visibly busy while one member works and another waits", () => {
    expect(
      threadTailPhase(
        thread([
          { id: "a", status: "running" },
          { id: "b", status: "waiting_input" },
        ]),
      ),
    ).toBe("working");
  });

  it("maps run states in order", () => {
    expect(threadTailPhase(thread([{ id: "run", status: "waiting_takeover" }]))).toBe(
      "needs_takeover",
    );
    expect(threadTailPhase(thread([{ id: "run", status: "running" }]))).toBe("working");
    expect(threadTailPhase(thread([{ id: "run", status: "leased" }]))).toBe("starting");
    expect(threadTailPhase(thread([{ id: "run", status: "queued" }]))).toBe("queued");
    expect(threadTailPhase(thread([]))).toBeNull();
  });

  it("notes background work after the run ends when its card is out of sight", () => {
    const card: MessageBlock = {
      kind: "cloud_agent",
      agentId: "agent",
      title: "Research",
      status: "running",
      url: "https://example.test/agent",
    };
    expect(
      threadTailPhase(
        thread(
          [],
          [
            { id: "card", blocks: [card] },
            { id: "reply", blocks: [{ kind: "text", text: "Started research." }] },
          ],
        ),
      ),
    ).toBe("background");
    expect(threadTailPhase(thread([], [{ id: "card", blocks: [card] }]))).toBeNull();
  });
});
