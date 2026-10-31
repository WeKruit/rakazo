import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { backgroundTaskTime } from "./background-task-time";

describe("backgroundTaskTime", () => {
  beforeAll(() => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
  });
  const start = Date.parse("2026-10-31T04:00:00.000Z");
  const startedAt = new Date(start).toISOString();

  it("shows time left on work with a countdown", () => {
    expect(backgroundTaskTime({ startedAt, estimateMs: 10 * 60_000 }, start + 4 * 60_000)).toBe(
      "About 6 min left",
    );
  });

  it("shows how long other work has been running", () => {
    expect(backgroundTaskTime({ startedAt, estimateMs: null }, start + 30_000)).toBe(
      "Just started",
    );
    expect(backgroundTaskTime({ startedAt, estimateMs: null }, start + 12 * 60_000)).toBe(
      "Running 12 min",
    );
  });

  it("shows nothing without a start time", () => {
    expect(backgroundTaskTime({}, start)).toBeNull();
  });
});
