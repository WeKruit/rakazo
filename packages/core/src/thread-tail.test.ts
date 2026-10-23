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
      "working",
    );
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
