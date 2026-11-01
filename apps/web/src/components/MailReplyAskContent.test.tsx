// @vitest-environment jsdom
import type { MailReply } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    i18n: { locale: "en" },
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { AskCard } from "./AskCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const reply: MailReply = {
  from: "Example Recruiting <team@sender.example>",
  to: ["person@example.test"],
  cc: [],
  bcc: [],
  subject: "Re: Interview",
  body: "Original draft.",
  inReplyTo: {
    emailId: "private-email-id",
    sourceId: "private-source-id",
    threadId: "private-thread-id",
    subject: "Interview",
    sender: "person@example.test",
    inboxKey: "exact-inbox-thread", roleId: "role",
  },
  status: "needs_approval",
  sentAt: null,
};
async function mount(value = reply, onAnswer = vi.fn(async () => {})) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (next: MailReply) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <AskCard
            block={{
              kind: "ask",
              text: "Approve reply",
              status: "pending",
              approvalEffectId: "private-effect-id",
              mailReply: next,
            }}
            canAnswer
            onAnswer={onAnswer}
          />
        </MemoryRouter>,
      ),
    );
  await render(value);
  const button = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === name,
    )!;
  return {
    container,
    render,
    button,
    onAnswer,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("edits only body and Cc, submits once on Send, then shows actual persisted sent content", async () => {
  const view = await mount();
  try {
    await type(view.container.querySelector("textarea")!, "Edited reply.");
    await act(async () => view.button("Add Cc").click());
    await type(
      view.container.querySelector<HTMLInputElement>('input[aria-label="Cc"]')!,
      "copy@example.test",
    );
    expect(view.onAnswer).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll("input,textarea")).toHaveLength(2);
    expect(view.container.querySelector("a")?.getAttribute("href")).toBe(
      "/app?view=inbox&role=role&mailThread=exact-inbox-thread&mailMessage=private-email-id",
    );
    expect(view.container.textContent).not.toContain("private-");
    await act(async () => {
      view.button("Send").click();
      view.button("Send")?.click();
    });
    expect(view.onAnswer).toHaveBeenCalledExactlyOnceWith({
      action: "send",
      body: "Edited reply.",
      cc: ["copy@example.test"],
    });
    expect(
      view.container.querySelector('[data-testid="mail-reply-card"]')?.getAttribute("data-status"),
    ).toBe("sending");
    expect(view.container.textContent).toContain("Edited reply.");
    await view.render({
      ...reply,
      status: "sent",
      body: "Edited reply, actually sent.",
      cc: ["copy@example.test"],
      sentAt: "2026-11-01T12:00:00.000Z",
    });
    expect(view.container.querySelector("time")?.dateTime).toBe("2026-11-01T12:00:00.000Z");
    expect(view.container.textContent).not.toContain("Edited reply, actually sent.");
    await act(async () =>
      view.container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click(),
    );
    expect(view.container.textContent).toContain("Edited reply, actually sent.");
    expect(view.container.querySelectorAll("input,textarea")).toHaveLength(0);
  } finally {
    await view.close();
  }
});
it("Discard denies the existing approval without submitting a send", async () => {
  const view = await mount();
  try {
    await act(async () => view.button("Discard").click());
    expect(view.onAnswer).toHaveBeenCalledExactlyOnceWith("deny");
    expect(
      view.container.querySelector('[data-testid="mail-reply-card"]')?.getAttribute("data-status"),
    ).toBe("discarded");
  } finally {
    await view.close();
  }
});
it("validates Cc and preserves the edited draft after a submission failure without exposing provider errors", async () => {
  const onAnswer = vi.fn(async () => {
    throw new Error("Instantly secret/internal-id");
  });
  const view = await mount(reply, onAnswer);
  try {
    await type(view.container.querySelector("textarea")!, "Keep this edit.");
    await act(async () => view.button("Add Cc").click());
    const cc = view.container.querySelector<HTMLInputElement>('input[aria-label="Cc"]')!;
    await type(cc, "not-an-email");
    await act(async () => view.button("Send").click());
    expect(onAnswer).not.toHaveBeenCalled();
    await type(cc, "valid@example.test");
    await act(async () => view.button("Send").click());
    expect(view.container.querySelector("textarea")?.value).toBe("Keep this edit.");
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not submit this reply.",
    );
    expect(view.container.textContent).not.toContain("Instantly");
    expect(view.container.textContent).not.toContain("internal-id");
  } finally {
    await view.close();
  }
});
it.each(["sent", "discarded", "failed", "unknown"] as const)(
  "renders persisted %s history without another send action",
  async (status) => {
    const view = await mount({ ...reply, status });
    try {
      expect(view.button("Send")).toBeUndefined();
      expect(view.container.querySelector("textarea")).toBeNull();
      expect(view.onAnswer).not.toHaveBeenCalled();
    } finally {
      await view.close();
    }
  },
);
