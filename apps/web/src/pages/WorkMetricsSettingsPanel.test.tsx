// @vitest-environment jsdom
import type { WorkMetrics } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));
const mocks = vi.hoisted(() => ({ workMetrics: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { usage: { workMetrics: mocks.workMetrics } } }));

import { WorkMetricsSettingsPanel } from "./WorkMetricsSettingsPanel";

const data: WorkMetrics = {
  windowDays: 28,
  since: "2026-02-01T00:00:00.000Z",
  unrescuedWeeks: [{ week: "2026-02-23", unrescued: 3, tasks: 4 }],
  completion: {
    completed: 8,
    failed: 1,
    cancelled: 1,
    stoppedByPerson: 1,
    reasons: [{ status: "failed", reason: "Model timed out after N s", count: 1 }],
  },
  longTasks: {
    runDuration: { count: 8, p50Ms: 12_000, p95Ms: 300_000 },
    taskDuration: { count: 4, p50Ms: 20_000, p95Ms: null },
    compactions: 2,
    runsCompacted: 1,
    resumed: { count: 1, of: 2 },
  },
  experience: {
    firstReply: { count: 5, p50Ms: 900, p95Ms: 4_000 },
    interject: { count: 2, p50Ms: 1_500, p95Ms: 2_000 },
    unansweredInputs: 1,
    inputs: 6,
  },
  memory: { correctedAfterCompaction: { count: 1, of: 2 } },
  collaboration: { handoffs: 3, teammateTurns: 4, replied: 3, silent: 1 },
  automation: { fired: 10, skipped: 2, completed: 7, failed: 1 },
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

it("shows every Workloop metric from the operator summary", async () => {
  mocks.workMetrics.mockResolvedValue(data);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<WorkMetricsSettingsPanel />));
  const text = container.textContent ?? "";
  expect(text).toContain("All accounts, last 28 days");
  expect(text).toContain("2026-02-233 75%4");
  expect(text).toContain("Completed80%");
  expect(text).toContain("Model timed out after N s");
  expect(text).toContain("Run time p50 · p9512.0 s · 5.0 min");
  expect(text).toContain("Resumed after restart50%");
  expect(text).toContain("First reply p50 · p95900 ms · 4.0 s");
  expect(text).toContain("Unanswered messages1 / 6");
  expect(text).toContain("Corrected after compaction50% (1 / 2)");
  expect(text).toContain("Nothing to add25%");
  expect(text).toContain("Skipped20%");
  expect(text).toContain("Succeeded88%");
  act(() => root.unmount());
});

it("offers a retry when the summary fails", async () => {
  mocks.workMetrics.mockRejectedValueOnce(new Error("forbidden")).mockResolvedValue(data);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<WorkMetricsSettingsPanel />));
  expect(container.querySelector("[role=alert]")?.textContent).toContain(
    "Could not load work metrics",
  );
  await act(async () => container.querySelector("button")?.click());
  expect(container.querySelector("[data-testid=work-metrics-settings]")).not.toBeNull();
  act(() => root.unmount());
});
