// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), answer: vi.fn(), messages: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  rpc: { threads: { get: api.get, send: api.send, answer: api.answer, messages: api.messages } },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../ShellMessage", () => ({
  MessageView: (props: {
    message: { id: string; runId: string; blocks?: { status?: string }[] };
    canAnswer: boolean;
    onAnswer: (message: unknown, answer: string) => Promise<void>;
  }) => (
    <button
      type="button"
      data-message={props.message.id}
      data-can-answer={props.canAnswer}
      data-status={props.message.blocks?.[0]?.status}
      onClick={() => void props.onAnswer(props.message, "allow")}
    >
      {props.message.id}
    </button>
  ),
}));

import { StackedConversation } from "./StackedConversation";

const snapshot = {
  threadId: "t",
  cursor: 1,
  olderCursor: null,
  run: { id: "run", status: "waiting_input" },
  activeRuns: [{ id: "run", status: "waiting_input" }],
  messages: [
    { id: "hello", runId: "old", blocks: [{ kind: "text" }] },
    { id: "continue", role: "system", internal: true, blocks: [{ kind: "text" }] },
    { id: "card", runId: "run", blocks: [{ kind: "ask", status: "pending" }] },
  ],
};
let host: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host?.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("stacks the waiting conversation, answers its card there and goes back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.get.mockResolvedValue(snapshot);
  api.answer.mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  const onBack = vi.fn();
  root = createRoot(host!);
  await act(async () =>
    root!.render(
      <StackedConversation
        groupId="role"
        title="Designer"
        bots={[]}
        onBack={onBack}
        onOpenFull={vi.fn()}
      />,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(api.get).toHaveBeenCalledWith({ groupId: "role" });
  const card = host.querySelector<HTMLButtonElement>('[data-message="card"]')!;
  expect(card.dataset.canAnswer).toBe("true");
  // An automatic continuation is internal and never shown, as in the full conversation.
  expect(host.querySelector('[data-message="continue"]')).toBeNull();
  expect(host.querySelector<HTMLElement>('[data-message="hello"]')!.dataset.canAnswer).toBe(
    "false",
  );
  await act(async () => card.click());
  expect(api.answer).toHaveBeenCalledWith({
    groupId: "role",
    runId: "run",
    messageId: "card",
    answer: "allow",
  });
  const back = [...host.querySelectorAll("button")].find((b) => b.textContent === "Back")!;
  await act(async () => back.click());
  expect(onBack).toHaveBeenCalled();
});

it("shows the answer being worked on and clears a failed refresh on the next good one", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  api.get
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValueOnce(snapshot)
    .mockRejectedValueOnce(new TypeError("Failed to fetch"));
  api.answer.mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host!);
  await act(async () =>
    root!.render(
      <StackedConversation
        groupId="role"
        title="Designer"
        bots={[]}
        onBack={vi.fn()}
        onOpenFull={vi.fn()}
      />,
    ),
  );
  expect(host.textContent).not.toContain("Thinking");
  // The answer shows as taken at once, before the run's next refresh.
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-message="card"]')!.click());
  expect(host.textContent).toContain("Thinking");
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Could not reach the server");
  api.get.mockResolvedValue({
    ...snapshot,
    run: { id: "run", status: "running" },
    activeRuns: [{ id: "run", status: "running" }],
  });
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("Thinking");
  vi.useRealTimers();
});

it("docks as a labelled pane with no Back, and Escape leaves it open", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.get.mockResolvedValue(snapshot);
  host = document.createElement("div");
  document.body.append(host);
  const onBack = vi.fn();
  root = createRoot(host!);
  await act(async () =>
    root!.render(
      <StackedConversation
        docked
        groupId="global"
        title="Kruit"
        subtitle="All roles"
        bots={[]}
        onBack={onBack}
        onOpenFull={vi.fn()}
      />,
    ),
  );
  const pane = host.querySelector<HTMLElement>("section[data-docked-conversation]")!;
  expect(pane.getAttribute("aria-label")).toBe("Kruit");
  expect(pane.className).not.toContain("fixed");
  expect(pane.querySelector("h2")!.textContent).toBe("Kruit");
  expect(pane.textContent).toContain("All roles");
  expect([...pane.querySelectorAll("button")].some((b) => b.textContent === "Back")).toBe(false);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(onBack).not.toHaveBeenCalled();
});

it("lands on the request when a link targets a hidden handoff", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  api.get.mockResolvedValue(snapshot);
  api.messages.mockResolvedValue({
    messages: [
      { id: "ask", seq: 1, role: "user", blocks: [{ kind: "text" }] },
      { id: "echo", seq: 2, runId: "r", blocks: [{ kind: "bot_message_sent" }] },
      { id: "later", seq: 3, role: "user", blocks: [{ kind: "text" }] },
    ],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host!);
  await act(async () =>
    root!.render(
      <StackedConversation
        groupId="kruit"
        messageId="echo"
        title="Kruit"
        bots={[]}
        onBack={vi.fn()}
        onOpenFull={vi.fn()}
      />,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(api.messages).toHaveBeenCalledWith({ groupId: "kruit", around: { messageId: "echo" } });
  expect(host.querySelector('[data-message-id="echo"]')).toBeNull();
  expect(host.querySelector('[data-message-id="ask"]')!.className).toContain("ring-2");
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

async function mountFocused(messageId?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <StackedConversation
        groupId="role"
        messageId={messageId}
        title="Designer"
        bots={[]}
        onBack={vi.fn()}
        onOpenFull={vi.fn()}
      />,
    );
  });
  return host;
}
async function typeDraft(value: string) {
  await act(async () => {
    const input = host!.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("returns a focused approval to live updates after an answer", async () => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  api.get.mockResolvedValue(snapshot);
  api.messages.mockResolvedValue({ messages: snapshot.messages });
  api.answer.mockResolvedValue({ ok: true });
  await mountFocused("card");
  const answered = { ...snapshot.messages[2], blocks: [{ kind: "ask", status: "answered" }] };
  api.get.mockResolvedValue({
    ...snapshot,
    messages: [answered, { id: "live-progress", blocks: [{ kind: "text" }] }],
    run: { id: "run", status: "running" },
    activeRuns: [{ id: "run", status: "running" }],
  });
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-message="card"]')!.click());
  expect(host!.querySelector('[data-message="card"]')!.getAttribute("data-can-answer")).toBe(
    "false",
  );
  expect(host!.querySelector('[data-message="live-progress"]')).not.toBeNull();
  expect(host!.textContent).toContain("Thinking");
  api.get.mockResolvedValue({
    ...snapshot,
    run: null,
    activeRuns: [],
    messages: [answered, { id: "final-result", blocks: [{ kind: "text" }] }],
  });
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(host!.querySelector('[data-message="final-result"]')).not.toBeNull();
});

it("keeps a newer draft when the previous send receipt arrives", async () => {
  api.get.mockResolvedValue(snapshot);
  let accepted!: () => void;
  api.send.mockReturnValue(
    new Promise<void>((resolve) => {
      accepted = resolve;
    }),
  );
  await mountFocused();
  await typeDraft("First message");
  await act(async () =>
    host!
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await typeDraft("New draft while waiting");
  await act(async () => accepted());
  expect(api.send).toHaveBeenCalledWith({ groupId: "role", text: "First message" });
  expect(host!.querySelector("textarea")!.value).toBe("New draft while waiting");
});

it("preserves history reading on refresh and follows again after Jump to latest", async () => {
  vi.useFakeTimers();
  api.get.mockResolvedValue(snapshot);
  await mountFocused();
  const box = host!.querySelector<HTMLDivElement>(".rk-scroll")!;
  let height = 1_000;
  Object.defineProperties(box, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 300 },
  });
  box.scrollTop = 200;
  await act(async () => box.dispatchEvent(new Event("scroll", { bubbles: true })));
  height = 1_200;
  api.get.mockResolvedValue({
    ...snapshot,
    messages: [...snapshot.messages, { id: "new-reply", blocks: [{ kind: "text" }] }],
  });
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(box.scrollTop).toBe(200);
  const jump = host!.querySelector<HTMLButtonElement>('button[aria-label="Jump to latest"]')!;
  expect(jump).not.toBeNull();
  expect(jump.getAttribute("aria-hidden")).not.toBe("true");
  await act(async () => jump.click());
  expect(box.scrollTop).toBe(height);
  height = 1_400;
  api.get.mockResolvedValue({
    ...snapshot,
    messages: [...snapshot.messages, { id: "next-reply", blocks: [{ kind: "text" }] }],
  });
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(box.scrollTop).toBe(height);
});

it("refreshes an anchored card without moving away from its history", async () => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  api.get.mockResolvedValue(snapshot);
  api.messages.mockResolvedValue({ messages: snapshot.messages });
  await mountFocused("card");
  api.get.mockResolvedValue({
    ...snapshot,
    messages: snapshot.messages.map((message) =>
      message.id === "card"
        ? { ...message, blocks: [{ kind: "ask", status: "answered" }] }
        : message,
    ),
  });
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(host!.querySelector('[data-message="card"]')!.getAttribute("data-status")).toBe(
    "answered",
  );
  expect(host!.querySelector('[data-message-id="card"]')!.className).toContain("ring-2");
});

it("clears an unchanged draft only after a successful send", async () => {
  api.get.mockResolvedValue(snapshot);
  api.send.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ ok: true });
  await mountFocused();
  await typeDraft("Keep until accepted");
  const submit = () =>
    host!
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await act(async () => submit());
  expect(host!.querySelector("textarea")!.value).toBe("Keep until accepted");
  await act(async () => submit());
  expect(host!.querySelector("textarea")!.value).toBe("");
});
