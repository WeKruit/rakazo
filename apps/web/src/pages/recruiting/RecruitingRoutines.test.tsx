// @vitest-environment jsdom
import type { Group, RecruitingAccountViewOutput, Routine } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
const accountView = vi.hoisted(() =>
  vi.fn<() => Promise<RecruitingAccountViewOutput>>(async () => ({
    roles: [
      {
        id: "role-id",
        title: "Role",
        groupId: "role-group",
        threadId: "thread-role-group",
        stage: "sourcing",
      },
    ],
    items: [],
    routines: [],
    nextCursor: null,
  })),
);
const create = vi.hoisted(() => vi.fn(async () => ({})));
const update = vi.hoisted(() => vi.fn(async () => ({})));
const testRun = vi.hoisted(() => vi.fn(async () => ({})));
afterEach(() => vi.clearAllMocks());
vi.mock("../../lib/rpc", () => ({
  rpc: { recruiting: { accountView }, routines: { create, update, testRun } },
}));
vi.mock("../RoutineEditor", () => ({
  RoutineEditor: ({
    draft,
    onChange,
    onSave,
  }: {
    draft: { name: string; prompt: string };
    onChange: (draft: unknown) => void;
    onSave: () => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() =>
          onChange({
            ...draft,
            name: "Daily interviews",
            prompt: "Summarize upcoming interviews",
            webhookEnabled: false,
            githubEnabled: false,
          })
        }
      >
        Fill routine
      </button>
      <button type="button" onClick={onSave}>
        Save
      </button>
    </>
  ),
}));

import { RecruitingRoutines } from "./RecruitingRoutines";

it("creates an ordinary recruiter routine on the selected native group thread", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const group = (id: string): Group => ({
    id,
    spaceId: "space",
    threadId: `thread-${id}`,
    members: [{ botId: `main-${id}`, name: "Main", color: "ink" }],
    name: id,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    preview: "",
    unread: false,
    updatedAt: "2026-10-30",
    createdAt: "2026-10-30",
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <RecruitingRoutines
            accountKey="account"
            groups={[group("recruiting-global-main"), group("role-group")]}
            bots={[]}
          />
        </MemoryRouter>,
      ),
    );
    expect(accountView).toHaveBeenLastCalledWith({
      view: "routines",
      cursor: undefined,
      limit: 20,
    });
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Routine conversation"]',
    )!;
    await act(async () => {
      select.value = "role-id";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(accountView).toHaveBeenLastCalledWith({
      view: "routines",
      roleId: "role-id",
      cursor: undefined,
      limit: 20,
    });
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="routine-create-button"]')!.click(),
    );
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Fill routine")!
        .click(),
    );
    await act(async () =>
      [...host.querySelectorAll("button")].find((button) => button.textContent === "Save")!.click(),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "main-role-group",
        threadId: "thread-role-group",
        name: "Daily interviews",
        prompt: "Summarize upcoming interviews",
      }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});

const group = (id: string): Group => ({
  id,
  spaceId: "space",
  threadId: `thread-${id}`,
  members: [{ botId: `main-${id}`, name: "Main", color: "ink" }],
  name: id,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  preview: "",
  unread: false,
  updatedAt: "2026-10-30",
  createdAt: "2026-10-30",
});
async function mountRoutines(url = "/app?view=routines&role=all") {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <RecruitingRoutines
          accountKey="account"
          groups={[group("recruiting-global-main"), group("role-group")]}
          bots={[]}
        />
      </MemoryRouter>,
    ),
  );
  return { host, close: () => act(async () => root.unmount()) };
}
async function click(host: HTMLElement, text: string) {
  await act(async () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent === text)!.click(),
  );
}
it("creates the All roles routine on global Main without an extra per-bot read", async () => {
  const { host, close } = await mountRoutines();
  try {
    expect(accountView).toHaveBeenCalledTimes(1);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="routine-create-button"]')!.click(),
    );
    await click(host, "Fill routine");
    await click(host, "Save");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "main-recruiting-global-main",
        threadId: "thread-recruiting-global-main",
      }),
    );
  } finally {
    await close();
  }
});
it("never treats an unknown canonical role as global Main", async () => {
  accountView.mockResolvedValueOnce({ roles: [], items: [], routines: [], nextCursor: null });
  const { host, close } = await mountRoutines("/app?view=routines&role=foreign-role");
  try {
    expect(accountView).toHaveBeenCalledWith({
      view: "routines",
      roleId: "foreign-role",
      cursor: undefined,
      limit: 20,
    });
    expect(host.textContent).toContain("No conversation yet.");
    expect(host.querySelector('[data-testid="routine-create-button"]')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  } finally {
    await close();
  }
});
it("paginates account routines and preserves the actual routine identity for pause and run-now", async () => {
  const routine: Routine = {
    id: "routine-role",
    botId: "main-role-group",
    threadId: "thread-role-group",
    name: "Role interviews",
    prompt: "Summarize interviews",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    lastRunAt: null,
    nextRunAt: "2026-10-31T09:00:00Z",
    createdAt: "2026-10-30T09:00:00Z",
  };
  const page = {
    roles: [
      {
        id: "role-id",
        title: "Role",
        groupId: "role-group",
        threadId: "thread-role-group",
        stage: "interview",
      },
    ],
    items: [],
    routines: [routine],
    nextCursor: "routine-role",
  };
  accountView.mockResolvedValue(page);
  const { host, close } = await mountRoutines();
  try {
    await click(host, "Next page");
    expect(accountView).toHaveBeenLastCalledWith({
      view: "routines",
      cursor: "routine-role",
      limit: 20,
    });
    await click(host, "Pause");
    expect(update).toHaveBeenCalledWith({ routineId: routine.id, active: false });
    await click(host, "Run now");
    expect(testRun).toHaveBeenCalledWith({ routineId: routine.id });
  } finally {
    await close();
  }
});
