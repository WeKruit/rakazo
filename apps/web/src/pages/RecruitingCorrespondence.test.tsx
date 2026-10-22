// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { RecruitingOutreachSequenceSchema } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const preview = vi.hoisted(() => vi.fn());
const fetchArtifactBytes = vi.hoisted(() => vi.fn());
const readCorrespondence = vi.hoisted(() => vi.fn());
vi.mock("../lib/artifact-open", () => ({ fetchArtifactBytes }));
vi.mock("../lib/rpc", () => ({
  rpc: { recruiting: { correspondence: readCorrespondence } },
}));
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
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  readCorrespondence.mockResolvedValue({
    status: "not_checked",
    checkedAt: null,
    connections: [],
    emails: [],
    events: [],
    partial: false,
  });
});
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
  let currentProps = props;
  async function render(next: typeof props = {}) {
    currentProps = { ...currentProps, ...next };
    await act(async () =>
      root.render(
        <RecruitingCorrespondence
          view="sequence"
          messages={[]}
          artifactTarget={{ groupId: "role-group" }}
          onConversation={conversation}
          onOpenConnections={connections}
          {...currentProps}
        />,
      ),
    );
  }
  await render();
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
  return { container, click, conversation, connections, render };
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
  "reads saved %s results and distinguishes an unchecked service from an empty result",
  async (kind) => {
    const view = await mount({
      view: kind,
      outreachBotIds: ["outreach"],
      messages: [
        message("chat", "outreach", [{ kind: "text", text: "Sent and interview scheduled" }]),
      ],
    });
    expect(readCorrespondence).toHaveBeenCalledExactlyOnceWith({
      groupId: "role-group",
      view: kind,
    });
    expect(view.container.textContent).toContain("Not checked yet");
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

it("renders only retained email fields, supports selection and never treats assistant narration as mail", async () => {
  readCorrespondence.mockResolvedValue({
    status: "ready",
    checkedAt: "2026-10-22T01:00:00Z",
    connections: [{ name: "Mailbox", status: "configured" }],
    emails: [
      {
        id: "email-1",
        sender: "one@example.test",
        recipients: ["team@example.test"],
        subject: "Interview question",
        body: "Can we speak Thursday? <script>unsafe()</script>",
        snippet: false,
        date: "2026-10-22T00:00:00Z",
        url: null,
      },
      {
        id: "email-2",
        sender: "two@example.test",
        recipients: [],
        subject: "Another reply",
        body: "Please share the role.",
        snippet: true,
        date: null,
        url: null,
      },
    ],
    events: [],
    partial: true,
  });
  const view = await mount({ view: "inbox" });
  expect(view.container.textContent).toContain("Can we speak Thursday?");
  expect(view.container.querySelector("script")).toBeNull();
  expect(view.container.textContent).toContain("More results may be available");
  await view.click("Another reply");
  expect(view.container.textContent).toContain("Please share the role.");
  expect(view.container.textContent).toContain("Preview only");
  expect(view.conversation).not.toHaveBeenCalled();
});

it.each([
  ["inbox", "failed", "A saved check failed."],
  ["interview", "unsupported", "A saved result cannot be displayed."],
] as const)(
  "shows a service's %s check issue without hiding other saved results",
  async (kind, status, text) => {
    readCorrespondence.mockResolvedValue({
      status: "ready",
      checkedAt: "2026-10-22T01:00:00Z",
      connections: [
        { name: "Available service", status: "configured", checkIssue: null },
        {
          name: "Affected service",
          status: "configured",
          checkIssue: { status, checkedAt: "2026-10-22T01:00:00Z" },
        },
      ],
      emails: [
        {
          id: "saved",
          sender: "person@example.test",
          recipients: [],
          subject: "Saved reply",
          body: "Original reply remains",
          snippet: false,
          date: null,
          url: null,
        },
      ],
      events: [
        {
          id: "saved",
          kind: "event",
          title: "Saved interview",
          start: "2026-10-23T10:00:00Z",
          end: "2026-10-23T10:30:00Z",
          timeZone: "UTC",
          attendees: [],
          status: "accepted",
          location: null,
          url: null,
        },
      ],
      partial: true,
    });
    const view = await mount({ view: kind });
    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(text);
    expect(alert?.closest("li")?.textContent).toContain("Affected service");
    expect(view.container.textContent).toContain("Configured");
    expect(view.container.textContent).toContain(
      kind === "inbox" ? "Original reply remains" : "Saved interview",
    );
    expect(view.container.textContent).not.toMatch(/No saved results|Connect account/);
    await view.click(kind === "inbox" ? "Check inbox" : "Check availability");
    expect(view.conversation).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Don't send"),
    );
  },
);

it("shows actual observed calendar events separately from available times and does not imply booking", async () => {
  readCorrespondence.mockResolvedValue({
    status: "ready",
    checkedAt: "2026-10-22T01:00:00Z",
    connections: [],
    emails: [],
    partial: false,
    events: [
      {
        id: "event-1",
        kind: "event",
        title: "Recruiting conversation",
        start: "2026-10-23T10:00:00-07:00",
        end: "2026-10-23T10:30:00-07:00",
        timeZone: "America/Los_Angeles",
        attendees: ["one@example.test"],
        status: "tentative",
        location: null,
        url: null,
      },
      {
        id: "slot-1",
        kind: "availability",
        title: null,
        start: "2026-10-23T11:00:00-07:00",
        end: "2026-10-23T11:30:00-07:00",
        timeZone: "America/Los_Angeles",
        attendees: [],
        status: null,
        location: null,
        url: null,
      },
    ],
  });
  const view = await mount({ view: "interview" });
  expect(view.container.textContent).toContain("Recruiting conversation");
  expect(view.container.textContent).toContain("tentative");
  expect(view.container.textContent).toContain("Available time");
  expect(view.container.textContent).toContain("No invitation is created by this view");
  expect(view.conversation).not.toHaveBeenCalled();
});

it.each(["empty", "failed", "unsupported"])(
  "shows the actual %s read outcome without inventing results",
  async (status) => {
    readCorrespondence.mockResolvedValue({
      status,
      checkedAt: "2026-10-22T01:00:00Z",
      connections: [{ name: "Calendar", status: "needs_access" }],
      emails: [],
      events: [],
      partial: false,
    });
    const view = await mount({ view: "interview" });
    expect(view.container.textContent).toContain(
      status === "empty"
        ? "No saved results"
        : status === "failed"
          ? "The last check failed"
          : "This result cannot be displayed yet",
    );
    expect(view.container.textContent).toContain("Enable for this role");
    await view.click("Refresh saved results");
    expect(readCorrespondence).toHaveBeenCalledTimes(2);
    expect(view.conversation).not.toHaveBeenCalled();
  },
);

it("discards late mail from the previous role and refreshes after native completion, not streamed messages", async () => {
  let finish!: (value: unknown) => void;
  readCorrespondence.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mount({ view: "inbox", refreshSignal: 0 });
  await view.render({ artifactTarget: { groupId: "another-role" } });
  await act(async () =>
    finish({
      status: "ready",
      checkedAt: null,
      connections: [],
      emails: [{ id: "old", sender: "old@example.test", subject: "Old role email" }],
      events: [],
      partial: false,
    }),
  );
  expect(view.container.textContent).not.toContain("Old role email");
  expect(readCorrespondence).toHaveBeenCalledTimes(2);
  await view.render({
    messages: [message("stream", "main", [{ kind: "text", text: "Still checking" }])],
  });
  expect(readCorrespondence).toHaveBeenCalledTimes(2);
  await view.render({ refreshSignal: 1 });
  expect(readCorrespondence).toHaveBeenCalledTimes(3);
  expect(readCorrespondence.mock.lastCall![0]).toEqual({ groupId: "another-role", view: "inbox" });
});

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

it("renders a provider start-only slot without a fabricated end or dangling separator", async () => {
  readCorrespondence.mockResolvedValue({
    status: "ready",
    checkedAt: null,
    connections: [],
    emails: [],
    partial: false,
    events: [
      {
        id: "start-only-slot",
        kind: "availability",
        title: null,
        start: "2026-10-23T13:00:00Z",
        end: null,
        timeZone: "UTC",
        attendees: [],
        status: null,
        location: null,
        url: null,
      },
    ],
  });
  const view = await mount({ view: "interview" });
  const card = view.container.querySelector("article")!;
  expect(card.querySelectorAll("time")).toHaveLength(1);
  expect(card.textContent).not.toContain("–");
});
