// @vitest-environment jsdom
import type { Group } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
const list = vi.hoisted(() => vi.fn(async () => []));
const create = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../../lib/rpc", () => ({ rpc: { routines: { list, create } } }));
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
          onChange({ ...draft, name: "Daily interviews", prompt: "Summarize upcoming interviews" })
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
    members: [{ botId: "main-bot", name: "Main", color: "ink" }],
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
    expect(list).toHaveBeenLastCalledWith({
      botId: "main-bot",
      allConversations: true,
    });
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Routine conversation"]',
    )!;
    await act(async () => {
      select.value = "role-group";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(list).toHaveBeenLastCalledWith({ botId: "main-bot", threadId: "thread-role-group" });
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
        botId: "main-bot",
        threadId: "thread-role-group",
        name: "Daily interviews",
        prompt: "Summarize upcoming interviews",
      }),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
