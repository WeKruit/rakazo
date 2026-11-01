// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import type { MailReply } from "@rakazo/contracts";
import { MailReplySendAnswerSchema } from "@rakazo/contracts";
import React, { act, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";

const file = import.meta.url;
const source = readFileSync(new URL("../components/MailReplyAskContent.tsx", file), "utf8");
const compiled = ts.transpileModule(
  `${source
    .slice(source.indexOf("export function MailReplyAskContent("), source.indexOf("\nconst styles"))
    .replace("export function", "function")}\nreturn MailReplyAskContent;`,
  { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } },
).outputText;
const scope = {
  React,
  useEffect,
  useRef,
  useState,
  MailReplySendAnswerSchema,
  styles: {},
  useMobileTokens: () => ({}),
  useI18n: () => ({
    locale: "en",
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_match, key) => values?.[key] ?? key),
  }),
  dateLocaleForUi: () => "en-US",
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TextInput: ({
    accessibilityLabel,
    value,
    editable,
    onChangeText,
  }: {
    accessibilityLabel: string;
    value: string;
    editable: boolean;
    onChangeText: (value: string) => void;
  }) => (
    <textarea
      aria-label={accessibilityLabel}
      value={value}
      readOnly={!editable}
      onInput={(event) => onChangeText(event.currentTarget.value)}
      onChange={() => {}}
    />
  ),
  NativeActionButton: ({
    label,
    disabled,
    busy,
    onPress,
  }: {
    label: string;
    disabled: boolean;
    busy: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled || busy} onClick={onPress}>
      {label}
    </button>
  ),
};
const Content = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
const reply: MailReply = {
  from: "recruiter@example.test",
  to: ["candidate@example.test"],
  cc: [],
  bcc: ["audit@example.test"],
  subject: "Re: Platform role",
  body: "Saved draft",
  inReplyTo: {
    emailId: "private-email-id",
    sourceId: "private-source-id",
    threadId: "private-thread-id",
    subject: "Platform role",
    sender: "Candidate <candidate@example.test>",
  },
  status: "needs_approval",
  sentAt: null,
};
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function fixture(value = reply) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onAnswer = vi.fn(async (_answer: unknown) => {});
  await act(async () =>
    root.render(<Content reply={value} canAnswer pending onAnswer={onAnswer} />),
  );
  return { host, root, onAnswer };
}
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent === label)!;
it("keeps sender, recipients, subject and anchor immutable and only sends on the explicit Send action", async () => {
  const { host, root, onAnswer } = await fixture();
  expect(host.textContent).toContain(reply.from);
  expect(host.textContent).toContain(reply.inReplyTo.subject);
  expect(host.textContent).toContain(reply.bcc[0]);
  expect(host.textContent).not.toContain("private-");
  expect(
    [...host.querySelectorAll("textarea")].map((input) => input.getAttribute("aria-label")),
  ).toEqual(["Cc", "Reply message"]);
  const body = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply message"]')!;
  const cc = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Cc"]')!;
  await act(async () => {
    body.value = "Edited exact body\n";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    cc.value = "reviewer@example.test";
    cc.dispatchEvent(new Event("input", { bubbles: true }));
    body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(onAnswer).not.toHaveBeenCalled();
  await act(async () => button(host, "Send").click());
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
    action: "send",
    body: "Edited exact body\n",
    cc: ["reviewer@example.test"],
  });
  expect(host.textContent).not.toContain("Sent at");
  await act(async () => root.unmount());
});
it("Discard uses the existing deny answer and does not send even with an invalid draft", async () => {
  const { host, root, onAnswer } = await fixture({ ...reply, body: "" });
  expect(button(host, "Send").disabled).toBe(true);
  await act(async () => button(host, "Discard").click());
  expect(onAnswer).toHaveBeenCalledExactlyOnceWith("deny");
  await act(async () => root.unmount());
});
it.each(["sending", "sent", "discarded", "failed", "unknown"] as const)(
  "reopens authoritative %s history without editable controls or raw provider errors",
  async (status) => {
    const sentAt = "2026-11-01T15:34:00.000Z";
    const { host, root, onAnswer } = await fixture({
      ...reply,
      status,
      sentAt: status === "sent" ? sentAt : null,
      error: "private-provider-tool-id",
    });
    expect(button(host, "Send")).toBeUndefined();
    expect(button(host, "Discard")).toBeUndefined();
    expect(host.querySelectorAll("textarea")).toHaveLength(0);
    await act(async () => button(host, "View email").click());
    expect(host.querySelectorAll("textarea")).toHaveLength(2);
    expect([...host.querySelectorAll("textarea")].every((input) => input.readOnly)).toBe(true);
    expect(host.textContent).not.toContain("private-");
    if (status === "sent")
      expect(host.textContent).toContain(new Date(sentAt).toLocaleString("en-US"));
    else expect(host.textContent).not.toContain("Sent at");
    expect(onAnswer).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  },
);
it("blocks duplicate Send presses while the existing answer request is pending and preserves edits after failure", async () => {
  const { host, root, onAnswer } = await fixture();
  let reject!: (error: Error) => void;
  onAnswer.mockImplementation(
    () =>
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  await act(async () => {
    button(host, "Send").click();
    button(host, "Send").click();
  });
  expect(onAnswer).toHaveBeenCalledOnce();
  expect(host.textContent).toContain("Sending…");
  await act(async () => reject(new Error("private-provider-id")));
  expect(host.textContent).toContain("Could not send this reply.");
  expect(host.textContent).not.toContain("private-");
  expect(
    host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply message"]')!.value,
  ).toBe(reply.body);
  await act(async () => root.unmount());
});

it("does not submit malformed Cc or a no-longer-answerable draft", async () => {
  const { host, root, onAnswer } = await fixture();
  const cc = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Cc"]')!;
  await act(async () => {
    cc.value = "invalid-address";
    cc.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button(host, "Send").disabled).toBe(true);
  expect(onAnswer).not.toHaveBeenCalled();
  await act(async () =>
    root.render(<Content reply={reply} canAnswer={false} pending={false} onAnswer={onAnswer} />),
  );
  expect(button(host, "Send")).toBeUndefined();
  expect([...host.querySelectorAll("textarea")].every((input) => input.readOnly)).toBe(true);
  expect(onAnswer).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});
