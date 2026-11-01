// @vitest-environment jsdom
import type { AskAnswer, MessageBlock, ThreadMessage } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const messages = vi.hoisted(() => vi.fn());
const events = vi.hoisted(() => ({
  onEvent: undefined as
    | ((event: { type: string; payload: Record<string, unknown>; seq: number }) => void)
    | undefined,
}));
const answer = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../../lib/rpc", () => ({ rpc: { threads: { messages, answer } } }));
vi.mock("@rakazo/core", async (original) => ({
  ...(await original<object>()),
  runThreadSubscription: vi.fn(async (options: { onEvent: typeof events.onEvent }) => {
    events.onEvent = options.onEvent;
  }),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../../components/AskCard", () => ({
  AskCard: ({
    block,
    onAnswer,
  }: {
    block: Extract<MessageBlock, { kind: "ask" }>;
    onAnswer: (answer: AskAnswer) => Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() => void onAnswer({ action: "send", body: "Edited reply", cc: [] })}
    >
      {block.mailReply?.body} {block.mailReply?.status}
    </button>
  ),
}));

import { MailReplyCards } from "./MailReplyCards";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const block = (body: string, sourceId = "mail"): Extract<MessageBlock, { kind: "ask" }> => ({
  kind: "ask",
  text: "Review reply",
  status: "pending",
  approvalEffectId: "effect",
  actions: [
    { id: "allow", label: "Send" },
    { id: "deny", label: "Discard" },
  ],
  mailReply: {
    from: "sender@example.test",
    to: ["recipient@example.test"],
    cc: [],
    bcc: [],
    subject: "Re: Interview",
    body,
    inReplyTo: {
      sourceId,
      emailId: "anchor",
      threadId: "email-thread",
      subject: "Interview",
      sender: "recipient@example.test",
    },
    status: "needs_approval",
    sentAt: null,
    canAnswer: true,
  },
});
const message = (id: string, seq: number, blocks: MessageBlock[]): ThreadMessage => ({
  id,
  seq,
  blocks,
  threadId: "chat",
  botId: "bot",
  runId: `run-${id}`,
  role: "bot",
  createdAt: "2026-11-01T12:00:00Z",
});
it("server-pages the same stored cards, filters each block, and clears accumulated history when the role changes", async () => {
  let release!: (value: { threadId: string; messages: ThreadMessage[]; olderCursor: null }) => void;
  const nextRole = new Promise<{ threadId: string; messages: ThreadMessage[]; olderCursor: null }>(
    (resolve) => {
      release = resolve;
    },
  );
  messages.mockImplementation(async (input: { groupId: string; before?: number }) =>
    input.groupId === "role-b"
      ? nextRole
      : {
          threadId: "chat",
          messages: [
            input.before === undefined
              ? message("latest-a", 10, [
                  block("Role A draft"),
                  block("Other source must stay hidden", "other-mail"),
                ])
              : message("older-a", 5, [block("Older role A draft")]),
          ],
          olderCursor: input.before === undefined ? 10 : null,
        },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (groupId: string) =>
    act(async () =>
      root.render(
        <MailReplyCards
          conversation={{ groupId }}
          filter={{ sourceId: "mail", threadId: "email-thread", emailIds: ["anchor"] }}
          readCacheScope="actor:space"
        />,
      ),
    );
  const settled = async (text: string) =>
    vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain(text);
    });
  try {
    await render("role-a");
    await settled("Role A draft");
    expect(container.textContent).not.toContain("Other source");
    await act(async () =>
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((item) => item.textContent === "Earlier drafts")!
        .click(),
    );
    await settled("Older role A draft");
    expect(messages).toHaveBeenLastCalledWith(
      expect.objectContaining({
        groupId: "role-a",
        before: 10,
        mailReplyFor: { sourceId: "mail", threadId: "email-thread", emailIds: ["anchor"] },
      }),
    );
    await render("role-b");
    expect(container.textContent).not.toContain("Role A");
    expect(container.textContent).not.toContain("Older role A");
    release({
      threadId: "chat-b",
      messages: [message("latest-b", 20, [block("Role B draft")])],
      olderCursor: null,
    });
    await settled("Role B draft");
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(answer).toHaveBeenCalledExactlyOnceWith({
      groupId: "role-b",
      runId: "run-latest-b",
      messageId: "latest-b",
      answer: { action: "send", body: "Edited reply", cc: [] },
    });
    expect(container.textContent).not.toContain("Role A");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("updates a loaded older card from its terminal event beyond the latest fifty drafts", async () => {
  const latest = Array.from({ length: 50 }, (_, index) =>
    message(`recent-${index}`, index + 51, [block(`Recent ${index}`)]),
  );
  const older = message("old-card", 1, [block("Older pending reply")]);
  messages.mockImplementation(async (input: { before?: number }) => ({
    threadId: "chat",
    messages: input.before === undefined ? latest : [older],
    olderCursor: input.before === undefined ? 51 : null,
  }));
  answer.mockClear();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MailReplyCards
          conversation={{ groupId: "role-a" }}
          filter={{ sourceId: "mail", threadId: "email-thread" }}
        />,
      ),
    );
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain("Earlier drafts");
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Earlier drafts")!
        .click(),
    );
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain("Older pending reply needs_approval");
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Older pending reply"))!
        .click(),
    );
    expect(messages).toHaveBeenLastCalledWith(expect.objectContaining({ before: undefined }));
    const sent = block("Edited reply");
    sent.mailReply!.status = "sent";
    sent.mailReply!.canAnswer = false;
    sent.mailReply!.sentAt = "2026-11-01T12:01:00Z";
    await act(async () =>
      events.onEvent!({
        type: "thread.message.updated",
        seq: 101,
        payload: { messageId: "old-card", blocks: [sent] },
      }),
    );
    expect(container.textContent).toContain("Edited reply sent");
    expect(container.textContent).not.toContain("Older pending reply needs_approval");
    expect(answer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ messageId: "old-card" }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
