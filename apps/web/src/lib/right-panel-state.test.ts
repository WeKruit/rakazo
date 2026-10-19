import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readRecruitingPanelState,
  readRightPanelState,
  rightPanelStorageKey,
  writeRecruitingPanelState,
  writeRightPanelState,
} from "./right-panel-state";

afterEach(() => vi.unstubAllGlobals());
describe("right panel preferences", () => {
  it("round trips closed state and only the selected routine reference", () => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });
    writeRightPanelState("user-a:space-a:bot-a", "routine", "routine-a");
    expect(readRightPanelState("user-a:space-a:bot-a")).toEqual({
      panel: "routine",
      routineId: "routine-a",
    });
    expect(readRightPanelState("user-b:space-a:bot-a")).toEqual({ panel: null });
    writeRightPanelState("user-a:space-a:bot-a", null, "routine-a");
    expect(readRightPanelState("user-a:space-a:bot-a")).toEqual({ panel: null });
  });
  it.each(["not json", "null", "[]", '{"panel":"unknown"}', '{"panel":{}}', '{"panel":"create"}'])(
    "ignores malformed preference %s",
    (value) => {
      vi.stubGlobal("localStorage", { getItem: () => value });
      expect(readRightPanelState("state")).toEqual({ panel: null });
    },
  );
  it("keeps working when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readRightPanelState("state")).toEqual({ panel: null });
    expect(() => writeRightPanelState("state", "computer")).not.toThrow();
  });
  it("skips ephemeral create panels and builds scoped keys", () => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });
    const key = rightPanelStorageKey("user-a", "space-a", "bot", "bot-a");
    expect(key).toBe("rakazo:right-panel-state:user-a:space-a:bot:bot-a");
    writeRightPanelState(key, "computer");
    writeRightPanelState(key, "create");
    expect(readRightPanelState(key)).toEqual({ panel: "computer" });
    writeRightPanelState(key, "create-group");
    expect(readRightPanelState(key)).toEqual({ panel: "computer" });
  });
  it("restores recruiting only for its target and discards unrelated stored data", () => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });
    const botKey = rightPanelStorageKey("user", "space", "bot", "bot");
    const groupKey = rightPanelStorageKey("user", "space", "group", "group");
    writeRightPanelState(botKey, "recruiting", "unrelated-routine");
    expect(readRightPanelState(botKey)).toEqual({ panel: "recruiting" });
    expect(readRightPanelState(groupKey)).toEqual({ panel: null });
    expect(entries.get(botKey)).toBe('{"panel":"recruiting"}');
    entries.set(
      botKey,
      JSON.stringify({ panel: "recruiting", candidate: "private", authorized: true }),
    );
    expect(readRightPanelState(botKey)).toEqual({ panel: "recruiting" });
  });
});

it("round trips only recruiting list settings and ignores malformed browser state", () => {
  const entries = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
  });
  const state = {
    ...readRecruitingPanelState(null),
    tab: "evidence" as const,
    candidateView: "table" as const,
    filters: { sort: "recent" as const, sourceEffectId: "source-a", query: "Search" },
    pageCount: 2,
    selectedCandidateKey: "candidate-a",
    detailOpen: true,
  };
  writeRecruitingPanelState("list", state);
  expect(readRecruitingPanelState("list")).toEqual(state);
  entries.set("list", JSON.stringify({ ...state, candidate: { name: "private" } }));
  expect(readRecruitingPanelState("list")).toEqual(state);
  expect(readRecruitingPanelState("other")).toEqual(readRecruitingPanelState(null));
  for (const value of [
    "not json",
    "null",
    JSON.stringify({ ...state, filters: { roleId: "untrusted-role" } }),
    JSON.stringify({ ...state, filters: { sort: "unknown" } }),
    JSON.stringify({ ...state, pageCount: 0 }),
    JSON.stringify({ ...state, pageCount: 1.5 }),
    JSON.stringify({ ...state, candidateView: "unknown" }),
    JSON.stringify({ ...state, selectedCandidateKey: {} }),
  ]) {
    entries.set("list", value);
    expect(readRecruitingPanelState("list")).toEqual(readRecruitingPanelState(null));
  }
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  });
  expect(readRecruitingPanelState("list")).toEqual(readRecruitingPanelState(null));
  expect(() => writeRecruitingPanelState("list", state)).not.toThrow();
});

it.each(["rank", "tier", "score"] as const)(
  "restores the explicit provider %s ordering",
  (sort) => {
    const state = { ...readRecruitingPanelState(null), filters: { sort } };
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(state) });
    expect(readRecruitingPanelState("list")).toEqual(state);
  },
);
