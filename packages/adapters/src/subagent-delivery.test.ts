import { describe, expect, it } from "vitest";
import type { SubagentSession } from "./subagent-delivery.js";
import {
  collectSubagentResults,
  deliverFinishedSubagents,
  startBackgroundTurn,
  waitForSubagents,
} from "./subagent-delivery.js";

function helper(handle: string) {
  let finish!: (result: string) => void;
  const session: SubagentSession = { handle, name: "scout", busy: true };
  startBackgroundTurn(
    session,
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
  );
  return { session, finish };
}

const toolTurn = { message: { stopReason: "toolUse" }, toolResults: [{}] };
const finalTurn = { message: { stopReason: "stop" }, toolResults: [] };

describe("background helper delivery", () => {
  it("delivers a finished result once at a tool turn without waiting for others", async () => {
    const done = helper("subagent-1");
    const working = helper("subagent-2");
    done.finish("Found Ada.");
    await done.session.background;
    const steered: string[] = [];
    const sessions = [done.session, working.session];
    await deliverFinishedSubagents((text) => steered.push(text), sessions, toolTurn, {
      paused: false,
    });
    await deliverFinishedSubagents((text) => steered.push(text), sessions, toolTurn, {
      paused: false,
    });
    expect(steered).toEqual(["Helper scout (subagent-1) finished:\nFound Ada."]);
  });

  it("holds a final turn open until the next result arrives", async () => {
    const working = helper("subagent-1");
    const steered: string[] = [];
    const delivering = deliverFinishedSubagents(
      (text) => steered.push(text),
      [working.session],
      finalTurn,
      { paused: false },
    );
    await Promise.resolve();
    expect(steered).toEqual([]);
    working.finish("Found Bob.");
    await delivering;
    expect(steered).toEqual(["Helper scout (subagent-1) finished:\nFound Bob."]);
  });

  it("delivers nothing after Stop or a failed step", async () => {
    const working = helper("subagent-1");
    const stop = new AbortController();
    const steered: string[] = [];
    const delivering = deliverFinishedSubagents(
      (text) => steered.push(text),
      [working.session],
      finalTurn,
      { paused: false, signal: stop.signal },
    );
    stop.abort();
    await delivering;
    working.finish("late");
    await working.session.background;
    await deliverFinishedSubagents(
      (text) => steered.push(text),
      [working.session],
      { message: { stopReason: "error" }, toolResults: [] },
      { paused: false },
    );
    expect(steered).toEqual([]);
  });

  it("lets helpers finish before a pause without steering", async () => {
    const working = helper("subagent-1");
    const steered: string[] = [];
    let settled = false;
    const delivering = deliverFinishedSubagents(
      (text) => steered.push(text),
      [working.session],
      finalTurn,
      { paused: true },
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    working.finish("Found Ada.");
    await delivering;
    expect(steered).toEqual([]);
  });

  it("wait returns finished results, reports the rest and honors the timeout", async () => {
    const done = helper("subagent-1");
    const working = helper("subagent-2");
    done.finish("Found Ada.");
    const sessions = new Map([
      [done.session.handle, done.session],
      [working.session.handle, working.session],
    ]);
    const text = await waitForSubagents(sessions, ["subagent-1", "subagent-2", "nope"], 0);
    expect(text).toBe(
      [
        "Helper scout (subagent-1) finished:\nFound Ada.",
        "Helper scout (subagent-2) is still working.",
        "No helper with handle nope in this turn.",
      ].join("\n\n"),
    );
    working.finish("Found Bob.");
    expect(await waitForSubagents(sessions, [], 1)).toBe(
      "Helper scout (subagent-2) finished:\nFound Bob.",
    );
    expect(await collectSubagentResults(sessions.values())).toBeUndefined();
  });
});
