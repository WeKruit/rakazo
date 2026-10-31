// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import type { EmailConversationItem } from "./EmailConversation";
import { EmailConversation } from "./EmailConversation";

const current: EmailConversationItem = {
  id: "received-1",
  candidateId: "candidate-a",
  sender: "Avery Example <avery@example.test>",
  recipients: ["recruiter@example.test"],
  subject: "Availability",
  body: "Tuesday works.\n<script>doNotExecute()</script>",
  date: "2026-10-23T12:00:00Z",
  direction: "received",
  partial: false,
};
const previous: EmailConversationItem = {
  id: "sent-1",
  candidateId: "candidate-a",
  sender: "recruiter@example.test",
  recipients: ["avery@example.test"],
  subject: "A different saved subject",
  body: "Would you like to discuss the role?",
  date: "2026-10-22T12:00:00Z",
  direction: "sent",
  partial: false,
};
let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});
async function mount(node: ReactNode) {
  const view = document.createElement("div");
  document.body.append(view);
  const root = createRoot(view);
  const render = async (next: ReactNode) => act(async () => root.render(next));
  await render(node);
  cleanup = async () => {
    await act(async () => root.unmount());
    view.remove();
  };
  return { view, render };
}
const button = (view: HTMLElement, name: string) =>
  [...view.querySelectorAll("button")].find((entry) => entry.textContent === name)!;

it("shows the selected real message and folds history without inventing reply or thread facts", async () => {
  const { view } = await mount(
    <EmailConversation
      items={[current, previous]}
      selectedId={current.id}
      onSelect={vi.fn()}
      candidateName="Avery Example"
      candidateTitle="Platform Engineer"
    />,
  );
  const selected = view.querySelector("article")!;
  expect(selected.getAttribute("aria-label")).toBe(current.subject);
  expect(selected.textContent).toContain(current.sender);
  expect(selected.textContent).toContain(current.recipients[0]);
  expect(selected.textContent).toContain(current.body);
  expect(selected.querySelector("script")).toBeNull();
  expect(selected.querySelector("time")?.dateTime).toBe(current.date);
  expect(view.querySelector("details")?.open).toBe(false);
  expect(view.querySelector("summary")?.textContent).toContain(previous.subject);
  expect(view.textContent).toContain("Received");
  expect(view.textContent).toContain("Sent");
  expect(view.textContent).not.toContain("Replied");
  expect(view.textContent).not.toContain("Read");
  expect(view.textContent).not.toContain("Opened");
});

it("selects an older message by native disclosure and drafts against that exact source object", async () => {
  const onSelect = vi.fn();
  const onDraftReply = vi.fn();
  const onOpenProfile = vi.fn();
  function Fixture() {
    const [selectedId, setSelectedId] = useState(current.id);
    return (
      <EmailConversation
        items={[current, previous]}
        selectedId={selectedId}
        onSelect={(email) => {
          onSelect(email);
          setSelectedId(email.id);
        }}
        candidateName="Avery Example"
        onOpenProfile={onOpenProfile}
        onDraftReply={onDraftReply}
      />
    );
  }
  const { view } = await mount(<Fixture />);
  await act(async () => button(view, "Draft reply").click());
  expect(onDraftReply).toHaveBeenLastCalledWith(current);
  const history = view.querySelector("details")!;
  expect(history.querySelector("summary")).not.toBeNull();
  await act(async () => {
    history.open = true;
    history.dispatchEvent(new Event("toggle"));
  });
  expect(onSelect).toHaveBeenLastCalledWith(previous);
  expect(onSelect.mock.calls.at(-1)![0]).toBe(previous);
  const selected = view.querySelector("article")!;
  expect(selected.getAttribute("aria-label")).toBe(previous.subject);
  expect(document.activeElement).toBe(selected);
  await act(async () => button(view, "Draft reply").click());
  expect(onDraftReply.mock.calls.at(-1)![0]).toBe(previous);
  await act(async () => button(view, "Profile").click());
  expect(onOpenProfile).toHaveBeenCalledOnce();
  expect([...view.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
    "Profile",
    "Draft reply",
  ]);
});

it("filters explicit foreign candidates and replaces selected draft context when records change", async () => {
  const foreign = { ...previous, id: "foreign", candidateId: "candidate-b", body: "Other person" };
  const draft = vi.fn();
  const props = {
    items: [foreign, current],
    selectedId: foreign.id,
    onSelect: vi.fn(),
    onDraftReply: draft,
  };
  const { view, render } = await mount(<EmailConversation {...props} candidateId="candidate-a" />);
  expect(view.textContent).not.toContain("Other person");
  await act(async () => button(view, "Draft reply").click());
  expect(draft.mock.calls.at(-1)![0]).toBe(current);
  await render(<EmailConversation {...props} candidateId="candidate-b" />);
  expect(view.textContent).toContain("Other person");
  expect(view.textContent).not.toContain(current.body);
  await act(async () => button(view, "Draft reply").click());
  expect(draft.mock.calls.at(-1)![0]).toBe(foreign);
  await render(<EmailConversation {...props} candidateId="candidate-c" />);
  expect(view.textContent).toContain("No replies yet.");
  expect(button(view, "Draft reply")).toBeUndefined();
});

it("preserves missing fields, preview limitations, and unknown dates without inventing assets", async () => {
  const incomplete = {
    ...current,
    sender: null,
    recipients: [],
    subject: "",
    body: "",
    date: "invalid date",
    direction: null,
    partial: true,
  };
  const { view } = await mount(<EmailConversation items={[incomplete]} onSelect={vi.fn()} />);
  expect(view.textContent).toContain("Sender unavailable");
  expect(view.textContent).toContain("Recipients unavailable");
  expect(view.textContent).toContain("Time not recorded");
  expect(view.textContent).toContain("No subject");
  expect(view.textContent).toContain("Message body unavailable");
  expect(view.textContent).toContain("Preview only.");
  expect(view.querySelector("time")).toBeNull();
  expect(view.querySelector("img")).toBeNull();
  expect(view.querySelector("button")).toBeNull();
});

it("accepts existing candidate-scoped email records without adding a candidate ID", async () => {
  const { candidateId: _candidateId, ...email } = current;
  const { view } = await mount(
    <EmailConversation
      items={[email]}
      candidateId="candidate-a"
      candidateName={"Long synthetic candidate name ".repeat(8)}
      candidateTitle={"Long role description ".repeat(8)}
      candidatePhotoUrl="https://assets.example.test/photo.png"
      onSelect={vi.fn()}
    />,
  );
  expect(view.querySelector("article")?.textContent).toContain(current.body);
  expect(view.querySelector("h3")?.textContent).toBe("Long synthetic candidate name ".repeat(8));
  expect(view.querySelector("img")?.src).toBe("https://assets.example.test/photo.png");
  expect(view.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
});

it("separates supplied provider threads and keeps unthreaded messages independent", async () => {
  const provenance = {
    sourceId: "mail",
    organizationId: "org",
    crmRoleId: "role",
    eaccount: "team@example.test",
    campaignId: "campaign",
  };
  const first = { ...current, ...provenance, threadId: "thread-a" };
  const history = { ...previous, ...provenance, threadId: "thread-a" };
  const other = {
    ...current,
    ...provenance,
    id: "other",
    threadId: "thread-b",
    subject: "Other saved conversation",
    body: "Other thread body",
  };
  const unthreaded = {
    ...previous,
    id: "without-thread",
    threadId: null,
    body: "No thread recorded",
  };
  const draft = vi.fn();
  function Fixture() {
    const [selectedId, setSelectedId] = useState(first.id);
    return (
      <EmailConversation
        items={[first, history, other, unthreaded]}
        selectedId={selectedId}
        onSelect={(email) => setSelectedId(email.id)}
        onDraftReply={draft}
      />
    );
  }
  const { view } = await mount(<Fixture />);
  const select = view.querySelector<HTMLSelectElement>(
    'select[aria-label="Email thread or message"]',
  )!;
  expect(select.options).toHaveLength(3);
  expect(view.querySelector('ol[aria-label="Emails"]')?.textContent).not.toContain(
    "Other thread body",
  );
  expect(view.querySelector("details")?.textContent).toContain(history.body);
  await act(async () => {
    select.value = select.options[1]!.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(view.querySelector("article")?.textContent).toContain("Other thread body");
  expect(view.querySelector("details")).toBeNull();
  await act(async () => button(view, "Draft reply").click());
  expect(draft.mock.calls.at(-1)?.[0]).toBe(other);
  await act(async () => {
    select.value = "message:without-thread";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(view.querySelector("article")?.textContent).toContain("No thread recorded");
  expect(view.querySelector("details")).toBeNull();
  await act(async () => button(view, "Draft reply").click());
  expect(draft.mock.calls.at(-1)?.[0]).toBe(unthreaded);
});

it.each([
  "sourceId",
  "eaccount",
  "campaignId",
  "organizationId",
  "crmRoleId",
  "candidateId",
] as const)("keeps identical provider thread IDs separate across %s", async (field) => {
  const first = {
    ...current,
    sourceId: "source",
    organizationId: "org",
    crmRoleId: "role",
    eaccount: "mailbox",
    campaignId: "campaign",
    threadId: "shared-thread",
  };
  const second = {
    ...first,
    id: "other-message",
    body: "Different scope body",
    [field]: "other-scope",
  };
  const { view } = await mount(
    <EmailConversation items={[first, second]} selectedId={first.id} onSelect={vi.fn()} />,
  );
  expect(view.querySelector("select")?.options).toHaveLength(2);
  expect(view.querySelector("ol")?.textContent).not.toContain(second.body);
});
it("does not infer a shared conversation when mailbox provenance is unknown", async () => {
  const first = { ...current, sourceId: "source", threadId: "same-thread" };
  const second = { ...previous, sourceId: "source", threadId: "same-thread" };
  const { view } = await mount(<EmailConversation items={[first, second]} onSelect={vi.fn()} />);
  expect(view.querySelector("select")?.options).toHaveLength(2);
});
