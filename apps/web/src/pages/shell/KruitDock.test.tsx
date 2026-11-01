// @vitest-environment jsdom
import type { Group } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));

import { KruitDock } from "./KruitDock";

const group = (id: string, extra: Partial<Group> = {}) =>
  ({ id, name: id, updatedAt: "2026-11-01T00:00:00.000Z", ...extra }) as Group;
let host: HTMLDivElement | undefined;
afterEach(() => host?.remove());

async function render(groups: Group[], groupId?: string) {
  host = document.createElement("div");
  document.body.append(host);
  const onOpen = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () =>
    createRoot(host!).render(<KruitDock groups={groups} groupId={groupId} onOpen={onOpen} />),
  );
  return { host: host!, onOpen };
}

it("opens Kruit and every other conversation that waits on the recruiter", async () => {
  const { host, onOpen } = await render([
    group("recruiting-global-a"),
    group("Designer", { attention: "approval" }),
    group("Open role", { attention: "question" }),
    group("Quiet"),
  ]);
  expect(host.textContent).toContain("Designer");
  expect(host.textContent).not.toContain("Quiet");
  const designer = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Designer"),
  )!;
  await act(async () => designer.click());
  expect(onOpen).toHaveBeenCalledWith("Designer");
  const kruit = [...host.querySelectorAll("button")].find((b) => b.textContent === "Kruit")!;
  await act(async () => kruit.click());
  expect(onOpen).toHaveBeenCalledWith("recruiting-global-a");
});

it("leaves out the open conversation's own card", async () => {
  const { host } = await render(
    [group("recruiting-global-a"), group("Designer", { attention: "approval" })],
    "Designer",
  );
  expect(host.querySelector('[role="status"]')).toBeNull();
});
