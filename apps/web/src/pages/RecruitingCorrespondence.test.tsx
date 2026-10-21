// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { RecruitingOutreachSequenceSchema } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => vi.fn());
const fetchArtifactBytes = vi.hoisted(() => vi.fn());
vi.mock("../lib/artifact-open", () => ({ fetchArtifactBytes }));
vi.mock("../components/ArtifactFileCard", () => ({
  ArtifactFileCard: (props: { artifactId: string; name: string }) => {
    preview(props);
    return <article data-artifact-id={props.artifactId}>{props.name}</article>;
  },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { RecruitingCorrespondence } from "./RecruitingCorrespondence";

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
function file(
  artifactId: string,
  name: string,
): Extract<ThreadMessage["blocks"][number], { kind: "file" }> {
  return { kind: "file", artifactId, name, mimeType: "text/markdown", size: 120 };
}
function message(id: string, botId: string, blocks: ThreadMessage["blocks"]): ThreadMessage {
  return {
    id,
    botId,
    threadId: "role-thread",
    seq: 1,
    role: "bot",
    blocks,
    createdAt: "2026-10-21T20:00:00Z",
  };
}
async function mount(props: Partial<ComponentProps<typeof RecruitingCorrespondence>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const conversation = vi.fn();
  const connections = vi.fn();
  await act(async () =>
    root.render(
      <RecruitingCorrespondence
        view="sequence"
        messages={[]}
        artifactTarget={{ groupId: "role-group" }}
        onConversation={conversation}
        onOpenConnections={connections}
        {...props}
      />,
    ),
  );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  async function click(text: string) {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === text || item.getAttribute("aria-label") === text,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }
  return { container, click, conversation, connections };
}

it("shows saved Outreach files by actual owner, deduplicates native attachments and preserves artifact scope", async () => {
  const draft = file("real-saved-draft", "Candidate correspondence.md");
  const second = file("another-saved-draft", "Follow-ups.md");
  const view = await mount({
    outreachBotIds: ["outreach"],
    messages: [
      message("source", "sourcer", [file("not-a-draft", "Email draft.md")]),
      message("draft", "outreach", [draft, second]),
      message("repeat", "outreach", [draft]),
    ],
  });
  expect(view.container.textContent).not.toContain("Email draft.md");
  expect(view.container.querySelectorAll(".hire-step-list > button")).toHaveLength(2);
  expect(preview).toHaveBeenLastCalledWith({ target: { groupId: "role-group" }, ...draft });
  await view.click("Follow-ups.md");
  expect(preview).toHaveBeenLastCalledWith({ target: { groupId: "role-group" }, ...second });
  expect(view.container.textContent).not.toMatch(/Sent|Recipients|Scheduled/);
  expect(view.conversation).not.toHaveBeenCalled();
});

it("does not infer draft ownership or sequence steps from filenames", async () => {
  const view = await mount({
    messages: [message("draft", "unassigned-bot", [file("any-file", "First email draft.md")])],
  });
  expect(preview).not.toHaveBeenCalled();
  expect(view.container.textContent).toContain("No outreach files loaded");
  await view.click("Prepare drafts");
  expect(view.conversation).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Don't send"));
});

it.each(["inbox", "interview"] as const)(
  "keeps %s unloaded until actual provider data exists and offers real native actions",
  async (kind) => {
    const view = await mount({
      view: kind,
      outreachBotIds: ["outreach"],
      messages: [
        message("chat", "outreach", [{ kind: "text", text: "Sent and interview scheduled" }]),
      ],
    });
    expect(view.container.textContent).toContain(
      kind === "inbox" ? "Inbox not loaded" : "Availability not loaded",
    );
    expect(view.container.textContent).not.toContain("Sent and interview scheduled");
    expect(view.container.querySelector("textarea,input,select")).toBeNull();
    await view.click(kind === "inbox" ? "Check inbox" : "Check availability");
    expect(view.conversation).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Don't send"),
    );
    await view.click("Manage connections");
    expect(view.connections).toHaveBeenCalledExactlyOnceWith();
  },
);

it("edits the real three-step sequence and saves an immutable companion through the native callback", async () => {
  const sequence = {
    kind: "wekruit.outreach-sequence",
    version: 1,
    roleTitle: "Robotics engineer",
    recipients: [
      {
        name: "Taylor Example",
        linkedinUrl: "https://example.test/taylor",
        email: null,
        steps: [
          { subject: "First subject", body: "First actual body", dayOffset: 0 },
          { subject: "Follow-up", body: "Second actual body", dayOffset: 4 },
          { subject: "Last follow-up", body: "Third actual body", dayOffset: null },
        ],
      },
    ],
  };
  fetchArtifactBytes.mockResolvedValue(new TextEncoder().encode(JSON.stringify(sequence)));
  const save = vi.fn().mockResolvedValue(undefined);
  const view = await mount({
    outreachBotIds: ["outreach"],
    onSaveDraft: save,
    messages: [
      message("editable", "outreach", [
        { ...file("original-sequence", "Outreach.json"), mimeType: "application/json" },
      ]),
    ],
  });
  await vi.waitFor(() =>
    expect(view.container.querySelector('input[aria-label="Subject"]')).not.toBeNull(),
  );
  const setValue = async (label: string, value: string) =>
    act(async () => {
      const field = view.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[aria-label="${label}"]`,
      )!;
      Object.getOwnPropertyDescriptor(
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  expect(fetchArtifactBytes).toHaveBeenCalledExactlyOnceWith(
    { groupId: "role-group" },
    "original-sequence",
  );
  expect(view.container.textContent).toContain("Taylor Example");
  expect(view.container.textContent).toContain("Email missing");
  expect(view.container.querySelectorAll(".hire-step-list > button")).toHaveLength(3);
  await setValue("Subject", "Revised actual subject");
  await setValue("Message", "Revised actual body");
  await setValue("Send on day", "2");
  await view.click("Save draft");
  const saved = save.mock.calls[0]?.[0];
  expect(saved).toMatchObject({
    sourceArtifactId: "original-sequence",
    name: "Outreach.json",
    clientNonce: expect.any(String),
    sequence: {
      ...sequence,
      revisesArtifactId: "original-sequence",
      recipients: [
        {
          ...sequence.recipients[0],
          steps: [
            { subject: "Revised actual subject", body: "Revised actual body", dayOffset: 2 },
            ...sequence.recipients[0]!.steps.slice(1),
          ],
        },
      ],
    },
  });
  expect(sequence.recipients[0]!.steps[0]!.subject).toBe("First subject");
  expect(view.container.textContent).toContain("Draft saved");
  expect(view.conversation).not.toHaveBeenCalled();
});

it("validates only the editable output contract, preserving missing facts and blank draft fields", () => {
  const sequence = {
    kind: "wekruit.outreach-sequence",
    version: 1,
    roleTitle: "Engineer",
    recipients: [
      {
        name: "Taylor",
        linkedinUrl: null,
        email: null,
        steps: [{ subject: "", body: "", dayOffset: null }],
      },
    ],
  };
  expect(RecruitingOutreachSequenceSchema.parse(sequence)).toEqual(sequence);
  for (const step of [
    { subject: "A", body: "B", dayOffset: -1 },
    { subject: "A", body: "B", dayOffset: 1.5 },
  ]) {
    expect(
      RecruitingOutreachSequenceSchema.safeParse({
        ...sequence,
        recipients: [{ ...sequence.recipients[0], steps: [step] }],
      }).success,
    ).toBe(false);
  }
  expect(
    RecruitingOutreachSequenceSchema.safeParse({
      ...sequence,
      recipients: [{ ...sequence.recipients[0], linkedinUrl: "javascript:alert(1)" }],
    }).success,
  ).toBe(false);
  expect(RecruitingOutreachSequenceSchema.safeParse({ ...sequence, sent: true }).success).toBe(
    false,
  );
});

it("reuses the save nonce after an uncertain result and renews it only after an edit", async () => {
  const sequence = {
    kind: "wekruit.outreach-sequence",
    version: 1,
    roleTitle: "Engineer",
    recipients: [
      {
        name: "Taylor",
        linkedinUrl: null,
        email: null,
        steps: [{ subject: "Subject", body: "Body", dayOffset: null }],
      },
    ],
  };
  fetchArtifactBytes.mockResolvedValue(new TextEncoder().encode(JSON.stringify(sequence)));
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Lost acknowledgement"))
    .mockResolvedValue(undefined);
  const view = await mount({
    outreachBotIds: ["outreach"],
    onSaveDraft: save,
    messages: [
      message("editable", "outreach", [
        { ...file("sequence", "Outreach.json"), mimeType: "application/json" },
      ]),
    ],
  });
  await vi.waitFor(() =>
    expect(view.container.querySelector('input[aria-label="Subject"]')).not.toBeNull(),
  );
  await view.click("Save draft");
  expect(view.container.textContent).toContain("Could not save this draft");
  await view.click("Save draft");
  expect(save.mock.calls[1]?.[0]).toEqual(save.mock.calls[0]?.[0]);
  await act(async () => {
    const field = view.container.querySelector<HTMLInputElement>('input[aria-label="Subject"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "Changed subject",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await view.click("Save draft");
  expect(save.mock.calls[2]?.[0].clientNonce).not.toBe(save.mock.calls[0]?.[0].clientNonce);
});
