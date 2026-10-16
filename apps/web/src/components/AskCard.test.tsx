// @vitest-environment jsdom

import { selectedAskActionLabel } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

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

import type { AskBlock } from "./AskCard";
import { AskCard } from "./AskCard";

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});

it("submits a custom answer on the original choice card", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const answer = vi.fn().mockResolvedValue(undefined);
  const block: AskBlock = {
    kind: "ask",
    text: "Which sourcing priority?",
    actions: [
      { id: "choice-1", label: "Evidence" },
      { id: "choice-2", label: "Location" },
    ],
  };
  try {
    act(() => root.render(<AskCard block={block} canAnswer onAnswer={answer} />));
    const other = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Type your answer",
    );
    expect(other).toBeDefined();
    act(() => other!.click());
    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer"]');
    expect(input).not.toBeNull();
    const raw = " \n  Robotics evidence first 😀\n  ";
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        " \n\t ",
      );
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(answer).not.toHaveBeenCalled();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        raw,
      );
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(answer).toHaveBeenCalledExactlyOnceWith(raw, undefined);

    act(() =>
      root.render(
        <AskCard
          block={{ ...block, status: "answered", answer: raw }}
          canAnswer={false}
          onAnswer={answer}
        />,
      ),
    );
    expect(container.textContent).toContain(`Answered: ${raw}`);
    expect(container.querySelector("form")).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("keeps approval cards restricted to their native decisions", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <AskCard
          block={{
            kind: "ask",
            text: "Approve this exact operation?",
            approvalEffectId: "effect-test",
            actions: [
              { id: "allow", label: "Allow once" },
              { id: "deny", label: "Deny" },
            ],
          }}
          canAnswer
          onAnswer={vi.fn()}
        />,
      ),
    );
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Allow once",
      "Deny",
    ]);
    expect(container.querySelector("input")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
