// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
    i18n: { locale: "en" },
  }),
}));

const setEffort = vi.fn(async (_input: unknown) => ({ ok: true }));
vi.mock("../../lib/rpc", () => ({
  rpc: { threads: { setEffort: (input: unknown) => setEffort(input) } },
}));

import { EffortPicker } from "./effort-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows the chat's mode and saves a new one for that chat", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<EffortPicker mode="fast" target={{ groupId: "group-1" }} />));
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="effort-picker"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Effort: Fast");
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      trigger?.click();
    });
    const deep = [...document.querySelectorAll('[role="menuitemradio"]')].find(
      (item) => item.textContent === "Deep",
    ) as HTMLElement | undefined;
    expect(deep).toBeDefined();
    await act(async () => deep?.click());
    expect(setEffort).toHaveBeenCalledWith({ groupId: "group-1", mode: "deep" });
    expect(trigger?.getAttribute("aria-label")).toBe("Effort: Deep");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
