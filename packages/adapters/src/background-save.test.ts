import { describe, expect, it, vi } from "vitest";
import {
  FEEDBACK_SAVING,
  ownRoleRevisions,
  preferenceAtCurrentRevision,
  revisionConflict,
  saveInBackground,
  savesFeedbackInBackground,
  savesRoleInBackground,
  transientSaveError,
} from "./background-save.js";

const failed = (result: unknown) => Boolean((result as { error?: unknown } | null)?.error);
const inputError = (result: unknown) => (result as { code?: unknown } | null)?.code === "INPUT";
const instant = () => Promise.resolve();

describe("savesFeedbackInBackground", () => {
  it.each([
    [{ target: "candidate", operation: "review", fit: "not_fit" }, true],
    [{ target: "round", operation: "scope" }, true],
    [{ target: "round", operation: "approve" }, false],
    [{ target: "candidate", operation: "pass" }, false],
    [{ target: "preference", operation: "add" }, true],
    [{ target: "preference", operation: "revoke" }, true],
  ])("%o → %s", (args, expected) => {
    expect(savesFeedbackInBackground("recruiting_feedback", args)).toBe(expected);
  });

  it("leaves other tools alone", () => {
    expect(savesFeedbackInBackground("recruiting_role", { target: "round" })).toBe(false);
  });
});

describe("saveInBackground", () => {
  it("returns the saved result when the save is quick", async () => {
    const save = saveInBackground({
      first: Promise.resolve({ status: "recorded" }),
      retry: vi.fn(),
      failed,
      inputError,
      onGiveUp: vi.fn(),
      sleep: instant,
      waitMs: 1_000,
    });
    await expect(save.reply).resolves.toEqual({ status: "recorded" });
    await expect(save.settled).resolves.toEqual({ status: "recorded" });
  });

  it("never hands the agent a refused save: it carries on while the save retries", async () => {
    const retry = vi.fn(async () => ({ status: "recorded" }));
    const onGiveUp = vi.fn();
    const save = saveInBackground({
      first: Promise.resolve({ error: "Not recorded: nothing was saved" }),
      retry,
      failed,
      inputError,
      onGiveUp,
      sleep: instant,
    });
    await expect(save.reply).resolves.toBe(FEEDBACK_SAVING);
    await expect(save.settled).resolves.toEqual({ status: "recorded" });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it("does not wait for a slow save", async () => {
    let finish!: (value: unknown) => void;
    const save = saveInBackground({
      first: new Promise((resolve) => {
        finish = resolve;
      }),
      retry: vi.fn(),
      failed,
      inputError,
      onGiveUp: vi.fn(),
      sleep: instant,
    });
    await expect(save.reply).resolves.toBe(FEEDBACK_SAVING);
    finish({ status: "recorded" });
    await expect(save.settled).resolves.toEqual({ status: "recorded" });
  });

  it("logs a save that still fails after its retries, without telling the agent", async () => {
    const onGiveUp = vi.fn();
    const retry = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const save = saveInBackground({
      first: Promise.resolve({ error: "refused" }),
      retry,
      failed,
      inputError,
      onGiveUp,
      sleep: instant,
      retryDelaysMs: [1, 1],
    });
    await expect(save.reply).resolves.toBe(FEEDBACK_SAVING);
    await save.settled;
    expect(retry).toHaveBeenCalledTimes(2);
    expect(onGiveUp).toHaveBeenCalledWith({ error: "database unavailable" });
  });

  it("passes on people the agent named wrongly, so it can fix them", async () => {
    const wrong = { error: "No saved person on this role matches", code: "INPUT" };
    const retry = vi.fn();
    const save = saveInBackground({
      first: Promise.resolve(wrong),
      retry,
      failed,
      inputError,
      onGiveUp: vi.fn(),
      sleep: instant,
    });
    await expect(save.reply).resolves.toBe(wrong);
    await save.settled;
    expect(retry).not.toHaveBeenCalled();
  });
});

// 11-11: a must-have typed into an intake card was saved only once the first ten came out, so a
// stopped search lost it. Role saves now run in the background like feedback.
describe("role saves in the background", () => {
  it("runs role updates in the background, never creation or reads", () => {
    expect(savesRoleInBackground("recruiting_role", { operation: "update" })).toBe(true);
    expect(savesRoleInBackground("recruiting_role", { operation: "create" })).toBe(false);
    expect(savesRoleInBackground("recruiting_role", { operation: "read" })).toBe(false);
    expect(savesRoleInBackground("recruiting_feedback", { operation: "update" })).toBe(false);
  });

  it("retries a revision race or an outage, and hands bad input back to the agent", () => {
    expect(transientSaveError("Role revision conflict")).toBe(true);
    expect(transientSaveError("connection terminated unexpectedly")).toBe(true);
    expect(transientSaveError("brief.fields[0].key: Required")).toBe(false);
  });

  it("moves a revision this run saved on to the newest, and leaves others' revisions alone", () => {
    const revisions = ownRoleRevisions();
    revisions.saved("role-1", 3);
    revisions.saved("role-1", 4);
    // The agent still names the revision it started from while its saves ran in the background.
    expect(revisions.current("role-1", 2)).toBe(4);
    expect(revisions.current("role-1", 3)).toBe(4);
    expect(revisions.current("role-1", 4)).toBe(4);
    // A revision this run never saw, or another role, conflicts as before.
    expect(revisions.current("role-1", 1)).toBe(1);
    expect(revisions.current("role-2", 2)).toBe(2);
    expect(revisions.current(undefined, 2)).toBe(2);
  });
});

describe("preference retries", () => {
  const conflict = {
    error: "Memory changed since it was read. Read the latest version and save again.",
    code: "CONFLICT",
    currentRevision: 7,
  };

  it("retries a preference at the revision the conflict reported", async () => {
    const args = { target: "preference", operation: "add", expectedRevision: 5, content: "x" };
    const retry = vi.fn(async (_attempt: number, previous: unknown) =>
      preferenceAtCurrentRevision(args, previous).expectedRevision === 7
        ? { status: "saved" }
        : conflict,
    );
    const save = saveInBackground({
      first: Promise.resolve(conflict),
      retry,
      failed,
      inputError: (result) => !revisionConflict(result) && failed(result),
      onGiveUp: vi.fn(),
      sleep: instant,
    });
    await expect(save.reply).resolves.toBe(FEEDBACK_SAVING);
    await expect(save.settled).resolves.toEqual({ status: "saved" });
    expect(retry).toHaveBeenCalledWith(1, conflict);
  });

  it("reads a conflict wrapped in details", () => {
    expect(revisionConflict({ details: conflict })).toBe(true);
    expect(
      preferenceAtCurrentRevision(
        { target: "preference", expectedRevision: 1 },
        { details: conflict },
      ).expectedRevision,
    ).toBe(7);
  });

  it("leaves other feedback and other failures as they are", () => {
    const round = { target: "round", operation: "scope" };
    expect(preferenceAtCurrentRevision(round, conflict)).toBe(round);
    expect(
      revisionConflict({ error: "This is a role requirement, not a shared preference." }),
    ).toBe(false);
  });
});
