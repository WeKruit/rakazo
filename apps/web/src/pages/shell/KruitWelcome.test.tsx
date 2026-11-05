// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce(
        (text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`,
        "",
      ),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { KruitWelcome } from "./KruitWelcome";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("tells a new recruiter what to send and fills in an example job", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onExample = vi.fn();
  act(() => root.render(<KruitWelcome onExample={onExample} />));
  expect(container.textContent).toContain("Paste a job description to start");
  act(() => container.querySelector("button")?.click());
  expect(onExample).toHaveBeenCalledWith(expect.stringContaining("Senior Backend Engineer"));
  act(() => root.unmount());
});
