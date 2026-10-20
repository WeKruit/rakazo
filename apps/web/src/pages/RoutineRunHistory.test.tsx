// @vitest-environment jsdom
import type { RoutineDelegation, RoutineRun } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { routines: api } }));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ i18n: { locale: "en" } }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props} />,
}));

import { RoutineRunHistory } from "./RoutineRunHistory";

const run: RoutineRun = {
  id: "run-1",
  botId: "bot-1",
  groupId: null,
  status: "completed",
  createdAt: "2026-01-02T12:00:00Z",
  startedAt: "2026-01-02T12:00:00Z",
  completedAt: "2026-01-02T12:01:22Z",
  messageId: "reply-1",
  delegations: [],
};
const delegation: RoutineDelegation = {
  id: "delegated-run",
  parentRunId: run.id,
  botId: "research-bot",
  botName: "Researcher",
  groupId: null,
  status: "failed",
  createdAt: "2026-01-02T12:00:08Z",
  startedAt: "2026-01-02T12:00:10Z",
  completedAt: "2026-01-02T12:00:30Z",
  messageId: null,
};
const page = (runs: RoutineRun[]) => ({ runs, nextCursor: null });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  api.history.mockReset();
});
async function mounted(routineId = "routine-1") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (id: string) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <RoutineRunHistory key={id} routineId={id} />
        </MemoryRouter>,
      ),
    );
  await render(routineId);
  return {
    container,
    render,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
it("shows loading, then the real run and its exact message link", async () => {
  let finish!: (rows: RoutineRun[]) => void;
  api.history.mockReturnValue(
    new Promise<RoutineRun[]>((resolve) => {
      finish = resolve;
    }).then(page),
  );
  const view = await mounted();
  try {
    expect(view.container.textContent).toContain("Loading");
    expect(view.container.textContent).not.toContain("No runs yet");
    await act(async () => finish([run]));
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    expect(view.container.textContent).toContain("1m 22s");
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe("/app/bot-1?m=reply-1");
  } finally {
    await view.close();
  }
});
it("shows each delegated bot's own status, time and message under its actual parent", async () => {
  const nested: RoutineDelegation = {
    ...delegation,
    id: "nested-run",
    parentRunId: delegation.id,
    botId: "analysis-bot",
    botName: "Analyst",
    status: "running",
    startedAt: null,
    completedAt: null,
    createdAt: "2026-01-02T12:00:15Z",
    groupId: "analysis group",
    messageId: "actual source anchor",
  };
  api.history.mockResolvedValue(page([{ ...run, delegations: [nested, delegation] }]));
  const view = await mounted();
  try {
    const rows = view.container.querySelectorAll('li[data-testid="routine-run-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector(":scope > div > span")?.textContent).toBe("Done");
    expect(rows[1]!.querySelector(":scope > div > span")?.textContent).toBe("Failed");
    expect(rows[2]!.querySelector(":scope > div > span")?.textContent).toBe("Running");
    expect(rows[1]!.querySelector(":scope > div:nth-child(2) > span")?.textContent).toBe(
      "Researcher · 20s",
    );
    expect(rows[2]!.querySelector(":scope > div:nth-child(2) > span")?.textContent).toBe("Analyst");
    expect(rows[1]!.querySelector(":scope > div > time")?.getAttribute("dateTime")).toBe(
      delegation.startedAt,
    );
    expect(rows[2]!.querySelector(":scope > div > time")?.getAttribute("dateTime")).toBe(
      nested.createdAt,
    );
    expect(rows[1]!.querySelector(":scope > div > a")).toBeNull();
    expect(rows[2]!.querySelector(":scope > div > a")?.getAttribute("href")).toBe(
      "/app/g/analysis%20group?m=actual%20source%20anchor",
    );
    expect(rows[2]!.parentElement?.parentElement).toBe(rows[1]);
    expect(rows[1]!.parentElement?.parentElement).toBe(rows[0]);
  } finally {
    await view.close();
  }
});

it("polls child state independently after the routine root has completed", async () => {
  vi.useFakeTimers();
  api.history
    .mockResolvedValueOnce(
      page([
        { ...run, delegations: [{ ...delegation, status: "waiting_input", completedAt: null }] },
      ]),
    )
    .mockResolvedValueOnce(
      page([
        { ...run, delegations: [{ ...delegation, status: "completed", messageId: "child-reply" }] },
      ]),
    );
  const view = await mounted();
  try {
    expect(view.container.textContent).toContain("Needs input");
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    const child = view.container.querySelectorAll('li[data-testid="routine-run-row"]')[1]!;
    expect(child.querySelector(":scope > div > span")?.textContent).toBe("Done");
    expect(child.querySelector("a")?.getAttribute("href")).toBe("/app/research-bot?m=child-reply");
    expect(view.container.textContent).not.toContain("Needs input");
  } finally {
    await view.close();
  }
});
it("keeps each delegation chain with its root across expansion, older pages and collapse", async () => {
  const latest = { ...run, delegations: [delegation] };
  const older = {
    ...run,
    id: "older-root",
    delegations: [
      { ...delegation, id: "older-child", parentRunId: "older-root", botName: "Older researcher" },
    ],
  };
  const cursor = { id: run.id, createdAt: run.createdAt };
  api.history.mockImplementation(async ({ before }: { before?: unknown }) =>
    before ? page([older]) : { runs: [latest], nextCursor: cursor },
  );
  const view = await mounted();
  const button = (name: string) =>
    [...view.container.querySelectorAll("button")].find((item) => item.textContent === name)!;
  try {
    expect(view.container.querySelectorAll("li")).toHaveLength(2);
    await act(async () => button("Run history").click());
    await act(async () => button("Load older runs").click());
    expect(view.container.querySelectorAll("li")).toHaveLength(4);
    const roots = view.container.querySelectorAll("section > ul > li");
    expect(roots).toHaveLength(2);
    expect(roots[0]!.querySelector("ul")?.textContent).toContain("Researcher");
    expect(roots[0]!.querySelector("ul")?.textContent).not.toContain("Older researcher");
    expect(roots[1]!.querySelector("ul")?.textContent).toContain("Older researcher");
    expect(api.history).toHaveBeenLastCalledWith({ routineId: "routine-1", before: cursor });
    await act(async () => button("Run history").click());
    expect(view.container.querySelectorAll("li")).toHaveLength(2);
    expect(view.container.textContent).not.toContain("Older researcher");
  } finally {
    await view.close();
  }
});
it("renders overlapping root references once within each root's own chain", async () => {
  const second = { ...delegation, id: "second-root" };
  const sharedChild = {
    ...delegation,
    id: "shared-child",
    parentRunId: second.id,
    botName: "Shared analyst",
  };
  const { parentRunId: _parent, botName: _name, ...secondRun } = second;
  api.history.mockResolvedValue(
    page([
      { ...run, delegations: [second, sharedChild] },
      { ...secondRun, delegations: [sharedChild] },
    ]),
  );
  const view = await mounted();
  try {
    const expand = [...view.container.querySelectorAll("button")].find(
      (item) => item.textContent === "Run history",
    )!;
    await act(async () => expand.click());
    const roots = view.container.querySelectorAll("section > ul > li");
    expect(roots).toHaveLength(2);
    expect(roots[0]!.querySelectorAll("li")).toHaveLength(2);
    expect(roots[1]!.querySelectorAll("li")).toHaveLength(1);
    expect(roots[0]!.textContent?.match(/Shared analyst/g)).toHaveLength(1);
    expect(roots[1]!.textContent?.match(/Shared analyst/g)).toHaveLength(1);
  } finally {
    await view.close();
  }
});
it("shows a genuine empty state and refreshes while the panel is open", async () => {
  vi.useFakeTimers();
  api.history
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce(page([{ ...run, messageId: null }]));
  const view = await mounted();
  try {
    expect(view.container.textContent).toContain("No runs yet");
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    expect(view.container.querySelector("a")).toBeNull();
    await view.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.history).toHaveBeenCalledTimes(2);
  } catch (error) {
    await view.close();
    throw error;
  }
});
it("shows failures honestly, preserves previous results and recovers on the next refresh", async () => {
  vi.useFakeTimers();
  api.history
    .mockResolvedValueOnce(page([run]))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(page([]));
  const view = await mounted();
  try {
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    expect(view.container.textContent).not.toContain("No runs yet");
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.textContent).toContain("No runs yet");
  } finally {
    await view.close();
  }
});
it("discards a response from the previous routine", async () => {
  let finish!: (rows: RoutineRun[]) => void;
  api.history
    .mockReturnValueOnce(
      new Promise<RoutineRun[]>((resolve) => {
        finish = resolve;
      }).then(page),
    )
    .mockResolvedValueOnce(page([]));
  const view = await mounted();
  try {
    await view.render("routine-2");
    await act(async () => finish([run]));
    expect(view.container.textContent).toContain("No runs yet");
    expect(view.container.querySelectorAll("li")).toHaveLength(0);
  } finally {
    await view.close();
  }
});
it("defaults to the latest run, expands all entries, and loads older pages", async () => {
  vi.useFakeTimers();
  const older = { ...run, id: "older", messageId: "older-reply" };
  const cursor = { id: "run-1", createdAt: run.createdAt };
  api.history.mockImplementation(async (input: { before?: unknown }) =>
    input.before
      ? page([{ ...older, id: "oldest", messageId: null }])
      : { runs: [run, older], nextCursor: cursor },
  );
  const view = await mounted();
  const button = (name: string) =>
    [...view.container.querySelectorAll("button")].find((b) => b.textContent === name)!;
  try {
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    expect(button("Run history").getAttribute("aria-expanded")).toBe("false");
    await act(async () => button("Run history").click());
    expect(button("Run history").getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelectorAll("li")).toHaveLength(2);
    await act(async () => button("Load older runs").click());
    expect(api.history).toHaveBeenLastCalledWith({ routineId: "routine-1", before: cursor });
    expect(view.container.querySelectorAll("li")).toHaveLength(3);
    expect(view.container.textContent).not.toContain("Load older runs");
    await act(async () => button("Run history").click());
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    const requests = api.history.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(api.history).toHaveBeenCalledTimes(requests + 1);
    await act(async () => button("Run history").click());
    expect(view.container.querySelectorAll("li")).toHaveLength(2);
    expect(api.history).toHaveBeenCalledTimes(requests + 1);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(api.history).toHaveBeenCalledTimes(requests + 1);
  } finally {
    await view.close();
  }
});
it("ignores a collapse refresh after expanded browsing resumes", async () => {
  let finish!: (value: ReturnType<typeof page>) => void;
  const cursor = { id: run.id, createdAt: run.createdAt };
  api.history
    .mockResolvedValueOnce({ runs: [run], nextCursor: cursor })
    .mockResolvedValueOnce(page([{ ...run, id: "older" }]))
    .mockReturnValueOnce(
      new Promise<ReturnType<typeof page>>((resolve) => {
        finish = resolve;
      }),
    );
  const view = await mounted();
  const button = (name: string) =>
    [...view.container.querySelectorAll("button")].find((b) => b.textContent === name)!;
  try {
    await act(async () => button("Run history").click());
    await act(async () => button("Load older runs").click());
    await act(async () => button("Run history").click());
    await act(async () => button("Run history").click());
    await act(async () => finish(page([run])));
    expect(view.container.querySelectorAll("li")).toHaveLength(2);
  } finally {
    await view.close();
  }
});
it("ignores a collapsed poll after expanding and loading older runs", async () => {
  vi.useFakeTimers();
  let finish!: (value: ReturnType<typeof page>) => void;
  const cursor = { id: run.id, createdAt: run.createdAt };
  api.history
    .mockResolvedValueOnce({ runs: [run], nextCursor: cursor })
    .mockReturnValueOnce(
      new Promise<ReturnType<typeof page>>((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValueOnce(page([{ ...run, id: "older" }]));
  const view = await mounted();
  const button = (name: string) =>
    [...view.container.querySelectorAll("button")].find((b) => b.textContent === name)!;
  try {
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    await act(async () => button("Run history").click());
    await act(async () => button("Load older runs").click());
    await act(async () => finish(page([run])));
    expect(view.container.querySelectorAll("li")).toHaveLength(2);
  } finally {
    await view.close();
  }
});

it("keeps a newer collapsed page when an older refresh finishes last", async () => {
  vi.useFakeTimers();
  let releaseOlder!: (value: ReturnType<typeof page>) => void;
  const cursor = { id: run.id, createdAt: run.createdAt };
  api.history
    .mockResolvedValueOnce({ runs: [run], nextCursor: cursor })
    .mockResolvedValueOnce(page([{ ...run, id: "older" }]))
    .mockReturnValueOnce(
      new Promise<ReturnType<typeof page>>((resolve) => {
        releaseOlder = resolve;
      }),
    )
    .mockResolvedValueOnce(page([{ ...run, status: "failed" }]));
  const view = await mounted();
  const button = (name: string) =>
    [...view.container.querySelectorAll("button")].find((b) => b.textContent === name)!;
  try {
    await act(async () => button("Run history").click());
    await act(async () => button("Load older runs").click());
    await act(async () => button("Run history").click());
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(view.container.textContent).toContain("Failed");
    await act(async () => releaseOlder(page([run])));
    expect(view.container.textContent).toContain("Failed");
    expect(view.container.textContent).not.toContain("Done");
  } finally {
    await view.close();
  }
});
it("accepts a successful collapse refresh when the overlapping poll fails", async () => {
  vi.useFakeTimers();
  let finish!: (value: ReturnType<typeof page>) => void;
  api.history
    .mockResolvedValueOnce({ runs: [run], nextCursor: { id: run.id, createdAt: run.createdAt } })
    .mockResolvedValueOnce(page([{ ...run, id: "older" }]))
    .mockReturnValueOnce(
      new Promise<ReturnType<typeof page>>((resolve) => {
        finish = resolve;
      }),
    )
    .mockRejectedValueOnce(new Error("temporarily unavailable"));
  const view = await mounted();
  const button = (name: string) =>
    [...view.container.querySelectorAll("button")].find((b) => b.textContent === name)!;
  try {
    await act(async () => button("Run history").click());
    await act(async () => button("Load older runs").click());
    await act(async () => button("Run history").click());
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(view.container.textContent).toContain("Could not load run history");
    await act(async () => finish(page([{ ...run, status: "failed" }])));
    expect(view.container.textContent).toContain("Failed");
    expect(view.container.textContent).not.toContain("Could not load run history");
  } finally {
    await view.close();
  }
});

it("links View chat into the group thread when the run has a groupId", async () => {
  api.history.mockResolvedValue(page([{ ...run, groupId: "group-1", messageId: "reply-1" }]));
  const view = await mounted();
  try {
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(
      "/app/g/group-1?m=reply-1",
    );
  } finally {
    await view.close();
  }
});
it("keeps loaded older runs while expanded, and refreshes to the first page on collapse", async () => {
  const older = { ...run, id: "older", messageId: "older-reply" };
  const cursor = { id: "run-1", createdAt: run.createdAt };
  api.history.mockImplementation(async (input: { before?: unknown }) =>
    input.before
      ? page([{ ...older, id: "oldest", messageId: null }])
      : { runs: [run, older], nextCursor: cursor },
  );
  const view = await mounted();
  const button = (name: string) =>
    [...view.container.querySelectorAll("button")].find((b) => b.textContent === name)!;
  try {
    await act(async () => button("Run history").click());
    await act(async () => button("Load older runs").click());
    expect(view.container.querySelectorAll("li")).toHaveLength(3);
    expect(view.container.textContent).not.toContain("Load older runs");
    await act(async () => button("Run history").click());
    expect(view.container.querySelectorAll("li")).toHaveLength(1);
    expect(button("Run history").getAttribute("aria-expanded")).toBe("false");
  } finally {
    await view.close();
  }
});
