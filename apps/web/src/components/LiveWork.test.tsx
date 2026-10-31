// @vitest-environment jsdom

import type { MessageBlock } from "@rakazo/contracts";
import type { WorkSession } from "@rakazo/core";
import { observeWorkSession } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

import { BackgroundWork, LiveWork } from "./LiveWork";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

// A live row as the reducer leaves it: two finished calls and one in flight.
const liveRow = {
  id: "progress:r1",
  runId: "r1",
  seq: 4,
  role: "bot",
  blocks: [
    { kind: "steps", steps: [{ label: "Recruiting role", count: 1 }] },
    { kind: "steps", steps: [{ label: "Mcp  autumn  research", count: 1 }] },
    {
      kind: "progress",
      activity: true,
      text: "Reading /private/path",
      pendingToolNames: ["mcp__autumn__get_rows"],
    },
  ] as MessageBlock[],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 42_000);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(session: WorkSession | null, live: boolean) {
  act(() => root.render(<LiveWork session={session} live={live} label="Working…" />));
}

it("shows plain-language steps, the step in flight and a clock from the run's start", () => {
  const session = observeWorkSession(
    null,
    { runs: [{ id: "r1", status: "running", startedAt: at(0) }], messages: [liveRow] },
    at(42),
  );
  render(session, true);
  const text = container.textContent ?? "";
  expect(text).toContain("Reviewing the role");
  expect(text).toContain("Searching candidates");
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "Searching candidates…",
  );
  expect(text).toContain("0:42");
  act(() => vi.advanceTimersByTime(30_000));
  expect(container.textContent).toContain("1:12");
  // Ordinary users never see tool names, connection names or progress free text.
  expect(text).not.toMatch(/mcp|autumn|recruiting_role|get_rows|private/i);
});

it("folds into a 'Worked for' line that expands to the steps", () => {
  const running = observeWorkSession(
    null,
    { runs: [{ id: "r1", status: "running", startedAt: at(0) }], messages: [liveRow] },
    at(42),
  );
  const ended = observeWorkSession(
    running,
    {
      runs: [],
      messages: [{ id: "m1", runId: "r1", role: "bot", blocks: [], createdAt: at(72) }],
    },
    at(80),
  );
  render(ended, false);
  const details = container.querySelector("details");
  expect(details?.open).toBe(false);
  expect(container.querySelector("summary")?.textContent).toBe("Worked for 1m 12s");
  act(() => container.querySelector("summary")?.click());
  expect(details?.open).toBe(true);
  expect(details?.textContent).toContain("Reviewing the role");
  expect(details?.textContent).toContain("Searching candidates ×2");
  expect(details?.textContent).not.toMatch(/mcp|autumn/i);
});

it("shows the phase without a clock before any run executes", () => {
  render(null, true);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Working…");
  expect(container.textContent).not.toMatch(/\d:\d\d/);
  render(null, false);
  expect(container.textContent).toBe("");
});

it("shows business progress beside the step in flight", () => {
  const session = observeWorkSession(
    null,
    { runs: [{ id: "r1", status: "running", startedAt: at(0) }], messages: [liveRow] },
    at(42),
  );
  act(() =>
    root.render(<LiveWork session={session} live label="Working…" detail="12 people added" />),
  );
  expect(container.querySelector('[data-testid="live-work-detail"]')?.textContent).toBe(
    "12 people added",
  );
  expect(container.textContent).toContain("Searching candidates…");
});

it("opens and cancels only the selected handed-off stage, keeping its transcript after completion", async () => {
  const onOpenStage = vi.fn();
  const onCancelStage = vi.fn(async () => {});
  const sourcerRow = {
    id: "progress:r2",
    runId: "r2",
    seq: 6,
    role: "bot",
    blocks: [
      { kind: "steps", steps: [{ label: "Recruiting research", count: 2 }] },
    ] as MessageBlock[],
  };
  let session = observeWorkSession(
    null,
    {
      runs: [{ id: "r1", botId: "main", status: "running", startedAt: at(0) }],
      messages: [liveRow],
    },
    at(10),
  );
  session = observeWorkSession(
    session,
    {
      runs: [{ id: "r2", botId: "bot-7", status: "running", startedAt: at(11) }],
      messages: [liveRow, sourcerRow],
    },
    at(12),
  );
  act(() =>
    root.render(
      <LiveWork
        session={session}
        live
        label="Working…"
        stageKind={(botId) => (botId === "bot-7" ? "sourcing" : "other")}
        onOpenStage={onOpenStage}
        onCancelStage={onCancelStage}
      />,
    ),
  );
  const stage = container.querySelector<HTMLDetailsElement>('[data-testid="work-stage"]');
  expect(stage?.open).toBe(true);
  expect(stage?.dataset.running).toBe("true");
  expect(stage?.querySelector("summary")?.textContent).toContain("Finding candidates");
  expect(stage?.textContent).toContain("Searching candidates ×2");
  expect(container.textContent).not.toContain("bot-7");
  const action = (text: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === text)!;
  act(() => action("View").click());
  expect(onOpenStage).toHaveBeenCalledExactlyOnceWith("bot-7");
  await act(async () => action("Cancel task").click());
  expect(onCancelStage).toHaveBeenCalledExactlyOnceWith("bot-7");

  session = observeWorkSession(session, { runs: [], messages: [liveRow, sourcerRow] }, at(40));
  act(() =>
    root.render(
      <LiveWork
        session={session}
        live={false}
        label=""
        stageKind={() => "sourcing"}
        onOpenStage={onOpenStage}
        onCancelStage={onCancelStage}
      />,
    ),
  );
  const done = container.querySelector<HTMLDetailsElement>('[data-testid="work-stage"]');
  expect(done?.open).toBe(false);
  expect(done?.dataset.running).toBeUndefined();
  expect(action("View")).toBeDefined();
  expect(action("Cancel task")).toBeUndefined();
  expect(container.querySelector('[data-testid="work-summary"]')?.textContent).toContain(
    "Finding candidates",
  );
});

it("counts a big background search down and starts over if it runs past", () => {
  const estimate = {
    kind: "search" as const,
    people: 500,
    startedAt: new Date(T0).toISOString(),
    estimateMs: 17 * 60_000,
  };
  act(() => root.render(<BackgroundWork estimate={estimate} />));
  const clock = container.querySelector('[data-testid="work-countdown"]');
  expect(clock?.getAttribute("data-counting")).toBe("down");
  // 42 s in: 16:18 of 17:00 left.
  expect(clock?.textContent).toBe("16:18 left");
  expect(container.textContent).toContain("Finding about 500 people");
  expect(container.querySelector('[data-testid="work-countdown-note"]')?.textContent).toContain(
    "about 17 minutes",
  );
  act(() => vi.advanceTimersByTime(17 * 60_000));
  expect(container.querySelector('[data-testid="work-countdown"]')?.textContent).toBe("16:18 left");
});

it("counts a small background search up without a note", () => {
  const estimate = {
    kind: "search" as const,
    people: 30,
    startedAt: new Date(T0).toISOString(),
    estimateMs: null,
  };
  act(() => root.render(<BackgroundWork estimate={estimate} />));
  const clock = container.querySelector('[data-testid="work-countdown"]');
  expect(clock?.getAttribute("data-counting")).toBe("up");
  expect(clock?.textContent).toBe("0:42");
  expect(container.textContent).toContain("Finding people");
  expect(container.querySelector('[data-testid="work-countdown-note"]')).toBeNull();
});
