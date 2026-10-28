// @vitest-environment jsdom

import { answerableAskMessageIds, selectedAskActionLabel } from "@rakazo/core";
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("renders native form fields, validates URL and submits typed multi-select on the same card", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const answer = vi.fn().mockResolvedValue(undefined);
  const block: AskBlock = {
    kind: "ask",
    text: "Provide details",
    requestedSchema: {
      type: "object",
      properties: {
        website: { type: "string", title: "Website", format: "uri" },
        guidance: { type: "string", title: "Guidance", maxLength: 12000 },
        regions: {
          type: "array",
          title: "Regions",
          minItems: 1,
          items: {
            anyOf: [
              { const: "north", title: "North" },
              { const: "south", title: "South" },
            ],
          },
        },
        count: { type: "integer", title: "Count", minimum: 1, default: 2 },
        confirmed: { type: "boolean", title: "Confirmed", default: true },
        priority: {
          type: "string",
          title: "Priority",
          oneOf: [
            { const: "", title: "Unspecified" },
            { const: "evidence", title: "Evidence" },
          ],
          default: "",
        },
      },
      required: ["website", "regions", "priority"],
    },
  };
  try {
    act(() => root.render(<AskCard block={block} canAnswer onAnswer={answer} />));
    const guidance = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Guidance"]',
    )!;
    expect(guidance).not.toBeNull();
    const guidanceText = "Keep confirmed evidence.\nFlag missing evidence.";
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        guidance,
        guidanceText,
      );
      guidance.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Website"]')!;
    expect(input).not.toBeNull();
    expect(input.type).toBe("url");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Count"]')!.type).toBe(
      "number",
    );
    expect(input.required).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Confirmed"]')!.required,
    ).toBe(false);
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Priority"]')!;
    expect(select.required).toBe(true);
    expect(select.value).toBe("0");
    expect(select.checkValidity()).toBe(true);
    const setUrl = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    setUrl("invalid");
    act(() => {
      container.querySelector<HTMLInputElement>('input[aria-label="North"]')!.click();
      container.querySelector<HTMLInputElement>('input[aria-label="South"]')!.click();
    });
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(answer).not.toHaveBeenCalled();
    setUrl("https://example.com");
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const response = {
      action: "accept",
      content: {
        website: "https://example.com",
        guidance: guidanceText,
        regions: ["north", "south"],
        count: 2,
        confirmed: true,
        priority: "",
      },
    };
    expect(answer).toHaveBeenCalledExactlyOnceWith(response);
    act(() =>
      root.render(
        <AskCard
          block={{
            ...block,
            status: "answered",
            answer: JSON.stringify(response),
            formResponse: response as never,
          }}
          canAnswer={false}
          onAnswer={answer}
        />,
      ),
    );
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("https://example.com");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it.each(["Cancel", "Decline"])(
  "submits form %s without validating required fields or approving",
  async (label) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const answer = vi.fn().mockResolvedValue(undefined);
    try {
      act(() =>
        root.render(
          <AskCard
            block={{
              kind: "ask",
              text: "Details",
              requestedSchema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            }}
            canAnswer
            onAnswer={answer}
          />,
        ),
      );
      await act(async () => {
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent === label)!
          .click();
      });
      expect(answer).toHaveBeenCalledExactlyOnceWith({ action: label.toLowerCase() });
    } finally {
      act(() => root.unmount());
    }
  },
);

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
    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer"]');
    expect(input).not.toBeNull();
    expect(container.textContent).toContain("Evidence");
    expect(container.textContent).toContain("Location");
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
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it.each([
  ["allow", "Confirm requirements"],
  ["allow", "Approve documents"],
  ["allow", "Approve calibration"],
  ["always", "Approve future documents"],
  ["deny", "Keep the current documents"],
])("preserves the server's %s approval label %s before and after answering", async (id, label) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const answer = vi.fn().mockResolvedValue(undefined);
  const block: AskBlock = {
    kind: "ask",
    text: "Review this decision",
    approvalEffectId: "effect-test",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this tool" },
      { id: "deny", label: "Deny" },
    ].map((action) => (action.id === id ? { ...action, label } : action)),
  };
  try {
    act(() => root.render(<AskCard block={block} canAnswer onAnswer={answer} />));
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
    expect(button).toBeDefined();
    expect(container.querySelector("form, input, textarea")).toBeNull();
    await act(async () => button!.click());
    expect(answer).toHaveBeenCalledExactlyOnceWith(id, undefined);
    act(() =>
      root.render(
        <AskCard
          block={{ ...block, status: "answered", answer: id }}
          canAnswer={false}
          onAnswer={answer}
        />,
      ),
    );
    expect(container.textContent).toContain(`Answered: ${label}`);
    expect(container.querySelector("button")).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it.each([
  { id: "allow", label: "Allow once", expected: "Allowed once" },
  { id: "always", label: "Always allow this tool", expected: "Always allowed" },
  { id: "deny", label: "Deny", expected: "Denied" },
  { id: "allow", label: "Create space", outcome: "created" as const, expected: "Created" },
  { id: "deny", label: "Cancel", outcome: "cancelled" as const, expected: "Cancelled" },
])("retains the native $label approval outcome", ({ expected, ...action }) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const block: AskBlock = {
    kind: "ask",
    text: "Review this decision",
    approvalEffectId: "effect-test",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow this tool" },
      { id: "deny", label: "Deny" },
    ].map((original) => (original.id === action.id ? action : original)),
  };
  try {
    act(() => root.render(<AskCard block={block} canAnswer onAnswer={vi.fn()} />));
    expect(container.textContent).toContain(action.label);
    act(() =>
      root.render(
        <AskCard
          block={{ ...block, status: "answered", answer: action.id }}
          canAnswer={false}
          onAnswer={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).toContain(expected);
  } finally {
    act(() => root.unmount());
  }
});

it.each([
  ["allow", "Allowed once"],
  ["always", "Always allowed"],
  ["deny", "Denied"],
])(
  "keeps legacy approval answer %s readable when its action is unavailable",
  (answer, expected) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      for (const actions of [
        undefined,
        [{ id: "allow", label: "Allow once" }].filter((action) => action.id !== answer),
      ]) {
        act(() =>
          root.render(
            <AskCard
              block={{
                kind: "ask",
                text: "Review this decision",
                approvalEffectId: "effect-test",
                status: "answered",
                answer,
                actions,
              }}
              canAnswer={false}
              onAnswer={vi.fn()}
            />,
          ),
        );
        expect(container.textContent).toContain(expected);
        expect(container.textContent).not.toContain(`Answered: ${answer}`);
      }
    } finally {
      act(() => root.unmount());
    }
  },
);

it("closes an expired card even before its run ends, then shows the answer a message gave it", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const actions = [
    { id: "remote", label: "Remote is fine" },
    { id: "onsite", label: "Onsite only" },
  ];
  const render = (block: AskBlock) => {
    // Same rule the transcript uses; the run row may still read waiting for an instant.
    const canAnswer = answerableAskMessageIds({
      run: { id: "run-1", status: "waiting_input" },
      messages: [{ id: "ask-1", runId: "run-1", blocks: [block] }],
    }).includes("ask-1");
    act(() => root.render(<AskCard block={block} canAnswer={canAnswer} onAnswer={vi.fn()} />));
  };
  try {
    render({ kind: "ask", text: "Remote or onsite?", status: "expired", actions });
    expect(container.textContent).toContain("No longer active");
    expect(container.querySelectorAll("button")).toHaveLength(0);

    render({
      kind: "ask",
      text: "Remote or onsite?",
      status: "answered",
      answer: "onsite",
      actions,
    });
    expect(container.textContent).toContain("Answered: Onsite only");
    expect(container.textContent).not.toContain("No longer active");
  } finally {
    act(() => root.unmount());
  }
});
