// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Text: ({ children, testID }: { children: ReactNode; testID: string }) =>
    createElement("span", { "data-testid": testID }, children),
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key),
  }),
}));

import { AskDeadline } from "../components/ask-deadline";

it("keeps the server deadline across a remount and ticks to expiry", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
  const container = document.createElement("div");
  const root = createRoot(container);
  const expiresAt = "2026-10-30T12:02:00.000Z";
  try {
    act(() => root.render(<AskDeadline expiresAt={expiresAt} />));
    expect(container.textContent).toBe("Expires in 2m 0s");
    act(() => vi.advanceTimersByTime(60_000));
    expect(container.textContent).toBe("Expires in 1m 0s");
    act(() => root.render(<AskDeadline key="reconnect" expiresAt={expiresAt} />));
    expect(container.textContent).toBe("Expires in 1m 0s");
    act(() => vi.advanceTimersByTime(60_000));
    expect(container.textContent).toBe("Expired");
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
