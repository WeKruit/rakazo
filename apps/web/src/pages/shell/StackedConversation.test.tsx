// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), answer: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  rpc: { threads: { get: api.get, send: api.send, answer: api.answer } },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../ShellMessage", () => ({
  MessageView: (props: {
    message: { id: string; runId: string };
    canAnswer: boolean;
    onAnswer: (message: unknown, answer: string) => Promise<void>;
  }) => (
    <button
      type="button"
      data-message={props.message.id}
      data-can-answer={props.canAnswer}
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
afterEach(() => {
  host?.remove();
  vi.resetAllMocks();
});

it("stacks the waiting conversation, answers its card there and goes back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.get.mockResolvedValue(snapshot);
  api.answer.mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  const onBack = vi.fn();
  await act(async () =>
    createRoot(host!).render(
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
