// @vitest-environment jsdom
import type { Group } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
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
  props: { groupId?: string; chatting?: boolean; onBack?: () => void } = {},
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

it("pops a card for what waits, with a count on the button, and opens its conversation", async () => {
  const { host, onOpen } = await render([
    group(KRUIT),
    group("Designer", { attention: "approval" }),
    group("Open role", { attention: "question" }),
    group("Quiet"),
  ]);
  expect(find(host, "Kruit").getAttribute("aria-label")).toBe("Kruit, 2 waiting");
  const card = host.querySelector('[role="status"]')!;
  expect(card.textContent).toContain("Needs approval");
  expect(card.textContent).toContain("Needs your response");
  expect(card.textContent).not.toContain("Quiet");
  await act(async () => find(host, "Designer").click());
  expect(onOpen).toHaveBeenCalledWith("Designer");
  expect(host.querySelector('[role="status"]')).toBeNull();
  await act(async () => find(host, "Kruit").click());
  expect(host.querySelector('[role="status"]')).not.toBeNull();
});

it("in a conversation shows no button, only cards from other conversations", async () => {
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
  expect(other.host.querySelector('[role="status"]')?.textContent).toContain("Open role");
  expect(find(other.host, "Kruit")).toBeUndefined();
});

it("offers a way back to where the recruiter was after opening a card", async () => {
  const onBack = vi.fn();
  const { host } = await render([group(KRUIT), group("Designer")], {
    groupId: "Designer",
    chatting: true,
    onBack,
  });
  await act(async () => find(host, "Back").click());
  expect(onBack).toHaveBeenCalled();
});
