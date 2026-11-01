// @vitest-environment jsdom
import type { Group } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  Plural: ({ value, other }: { value: number; other: string }) => other.replace("#", String(value)),
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { KruitDock } from "./KruitDock";

const group = (id: string, extra: Partial<Group> = {}) =>
  ({ id, name: id, updatedAt: "2026-11-01T00:00:00.000Z", ...extra }) as Group;
const KRUIT = "recruiting-global-a";
let host: HTMLDivElement | undefined;
afterEach(() => host?.remove());

async function render(
  groups: Group[],
  props: { groupId?: string; chatting?: boolean; start?: number } = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  const onOpen = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () =>
    createRoot(host!).render(<KruitDock groups={groups} onOpen={onOpen} {...props} />),
  );
  return { host: host!, onOpen };
}
const find = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) =>
    (b.getAttribute("aria-label") ?? b.textContent)?.startsWith(text),
  )!;

it("opens Kruit from the button when nothing waits", async () => {
  const { host, onOpen } = await render([group(KRUIT), group("Quiet")]);
  expect(host.querySelector('[role="status"]')).toBeNull();
  await act(async () => find(host, "Kruit").click());
  expect(onOpen).toHaveBeenCalledWith(KRUIT);
});

it("shows a small reminder and lists what waits only when asked", async () => {
  const { host, onOpen } = await render([
    group(KRUIT),
    group("Designer", { attention: "approval" }),
    group("Open role", { attention: "question" }),
    group("Quiet"),
  ]);
  const reminder = host.querySelector('[role="status"]')!;
  expect(reminder.textContent).toContain("2 items need your attention");
  expect(host.textContent).not.toContain("Designer");
  await act(async () => find(host, "2 items").click());
  expect(host.textContent).toContain("Needs approval");
  expect(host.textContent).toContain("Needs your response");
  expect(host.textContent).not.toContain("Quiet");
  await act(async () => find(host, "Designer").click());
  expect(onOpen).toHaveBeenCalledWith("Designer");
  expect(host.textContent).not.toContain("Open role");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
});

it("minimizes the reminder to the Kruit button and brings it back", async () => {
  const { host } = await render([group(KRUIT), group("Designer", { attention: "approval" })]);
  await act(async () => find(host, "Minimize").click());
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(find(host, "Kruit").getAttribute("aria-label")).toBe("Kruit, 1 waiting");
  await act(async () => find(host, "Kruit").click());
  expect(host.querySelector('[role="status"]')).not.toBeNull();
});

it("sits beside the sidebar", async () => {
  const { host } = await render([group(KRUIT)], { start: 260 });
  expect((host.firstElementChild as HTMLElement).style.insetInlineStart).toBe("calc(260px + 1rem)");
});

it("in a conversation starts minimized and shows only waits from other conversations", async () => {
  const own = await render([group(KRUIT), group("Designer", { attention: "approval" })], {
    groupId: "Designer",
    chatting: true,
  });
  expect(own.host.querySelector("button")).toBeNull();
  host?.remove();
  const other = await render(
    [group(KRUIT), group("Designer"), group("Open role", { attention: "question" })],
    { groupId: "Designer", chatting: true },
  );
  expect(other.host.querySelector('[role="status"]')).toBeNull();
  expect(find(other.host, "Kruit").getAttribute("aria-label")).toBe("Kruit, 1 waiting");
  await act(async () => find(other.host, "Kruit").click());
  expect(other.host.querySelector('[role="status"]')?.textContent).toContain(
    "1 items need your attention",
  );
});
