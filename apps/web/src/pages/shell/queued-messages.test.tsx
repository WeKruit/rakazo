// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueuedMessages } from "./queued-messages";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label,
  );
  if (!found) throw new Error(`No ${label} button`);
  return found;
};

function render(handlers: Partial<Parameters<typeof QueuedMessages>[0]> = {}) {
  const props = {
    messages: [
      { id: "m-1", blocks: [{ kind: "text" as const, text: "Only senior people" }] },
      {
        id: "m-2",
        blocks: [
          { kind: "text" as const, text: "Not this one" },
          { kind: "text" as const, text: "Or this one" },
        ],
      },
    ],
    onEdit: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    onSendNow: vi.fn().mockResolvedValue(undefined),
    ...handlers,
  };
  act(() => root.render(<QueuedMessages {...props} />));
  return props;
}

it("shows nothing when no message waits", () => {
  act(() =>
    root.render(
      <QueuedMessages messages={[]} onEdit={vi.fn()} onRemove={vi.fn()} onSendNow={vi.fn()} />,
    ),
  );
  expect(container.innerHTML).toBe("");
});

it("lists queued messages compactly and sends one now or removes it", async () => {
  const props = render();
  const list = container.querySelector('ul[aria-label="Queued messages"]');
  expect(list?.querySelectorAll("li")).toHaveLength(2);
  expect(list?.textContent).toContain("Only senior people");
  // Two text parts are not one editable message.
  expect(list?.querySelectorAll('button[aria-label="Edit queued message"]')).toHaveLength(1);

  await act(async () => button("Send now").click());
  expect(props.onSendNow).toHaveBeenCalledWith("m-1");
  await act(async () => button("Remove queued message").click());
  expect(props.onRemove).toHaveBeenCalledWith("m-1");
});

it("edits a queued message in place and saves the trimmed text", async () => {
  const props = render();
  await act(async () => button("Edit queued message").click());
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Edit queued message"]',
  )!;
  expect(input.value).toBe("Only senior people");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "  Only staff engineers ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save").click());
  expect(props.onEdit).toHaveBeenCalledWith("m-1", "Only staff engineers");
  expect(container.querySelector('input[aria-label="Edit queued message"]')).toBeNull();
});

it("keeps the draft open when the edit fails and cancels with Escape", async () => {
  render({ onEdit: vi.fn().mockRejectedValue(new Error("offline")) });
  await act(async () => button("Edit queued message").click());
  await act(async () => button("Save").click());
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Edit queued message"]',
  );
  expect(input).not.toBeNull();
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(container.querySelector('input[aria-label="Edit queued message"]')).toBeNull();
  expect(container.textContent).toContain("Only senior people");
});
