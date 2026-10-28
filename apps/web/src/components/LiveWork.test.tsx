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

import { LiveWork } from "./LiveWork";

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
