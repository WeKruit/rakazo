import type { ProductEvent } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  applyBotStatus,
  applyGroupRunStatus,
  botStatusFromRunEvent,
  groupIsWorking,
  openBotStatusChannel,
} from "./bot-run-status";

const event = (type: string, payload: Record<string, unknown> = {}) =>
  ({ type, payload }) as Pick<ProductEvent, "type" | "payload">;

describe("bot status from run events", () => {
  it("reads the sidebar status straight from the event", () => {
    expect(botStatusFromRunEvent(event("run.started", { trigger: "user" }))).toBe("running");
    expect(botStatusFromRunEvent(event("run.started", { trigger: "tickets" }))).toBeNull();
    expect(botStatusFromRunEvent(event("run.waiting_input"))).toBe("waiting_input");
    expect(botStatusFromRunEvent(event("computer.takeover.requested"))).toBe("waiting_takeover");
    expect(botStatusFromRunEvent(event("run.completed"))).toBe("idle");
    expect(botStatusFromRunEvent(event("thread.progress"))).toBeNull();
  });

  it("keeps the same list when nothing changes", () => {
    const bots = [{ id: "a", status: "idle" }];
    expect(applyBotStatus(bots, "a", "idle")).toBe(bots);
    expect(applyBotStatus(bots, "missing", "running")).toBe(bots);
    expect(applyBotStatus(bots, "a", "running")).toEqual([{ id: "a", status: "running" }]);
  });
});

describe("role status", () => {
  it("is working only from its own conversation's runs", () => {
    expect(groupIsWorking({ working: true })).toBe(true);
    expect(groupIsWorking({ working: false })).toBe(false);
    expect(groupIsWorking({})).toBe(false);
  });

  it("follows run events of that conversation and keeps the list otherwise", () => {
    const groups = [{ threadId: "t1", working: false }, { threadId: "t2" }];
    expect(applyGroupRunStatus(groups, "t1", "idle")).toBe(groups);
    expect(applyGroupRunStatus(groups, "other", "running")).toBe(groups);
    expect(applyGroupRunStatus(groups, "t1", "running")).toEqual([
      { threadId: "t1", working: true },
      { threadId: "t2" },
    ]);
    expect(applyGroupRunStatus(groups, "t2", "waiting_input")).toBe(groups);
  });
});

describe("bot status across tabs", () => {
  it("reaches another tab of the same user and space, and no one else", async () => {
    const scope = { userId: "user", spaceId: "space" };
    const sameUser = vi.fn();
    const otherUser = vi.fn();
    const sender = openBotStatusChannel(scope, () => {});
    const receiver = openBotStatusChannel(scope, sameUser);
    const stranger = openBotStatusChannel({ userId: "other", spaceId: "space" }, otherUser);
    sender.post({ botId: "bot", status: "running" });
    await vi.waitFor(() =>
      expect(sameUser).toHaveBeenCalledWith({ botId: "bot", status: "running" }),
    );
    expect(otherUser).not.toHaveBeenCalled();
    for (const channel of [sender, receiver, stranger]) channel.close();
  });
});
