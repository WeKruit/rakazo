// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const notes = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("../../lib/read-retry", () => ({
  retryTransientRead: <T,>(read: () => Promise<T>) => read(),
}));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    recruiting: {
      notes,
      reminders: { list: vi.fn(async () => ({ items: [], overdueCount: 0 })) },
    },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import type { RecruitingCandidateNote } from "@rakazo/contracts";
import { RecruitingChatContextProvider } from "../shell/recruiting-chat-context";
import { RecruitingDetailPanel } from "./DetailPanel";
import type { RecruitingDetailController, RecruitingDetailTarget } from "./detail";
import { NotesTab, noteCandidateKeys } from "./NotesTab";

const ADA = "00000000-0000-4000-8000-00000000000a";
const day = 24 * 3600 * 1000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
const role = { roleId: "role-1", spaceId: "space-1", conversation: { groupId: "group-1" } };
const person = { candidateId: ADA, name: "Ada" };

function note(id: string, extra: Partial<RecruitingCandidateNote> = {}): RecruitingCandidateNote {
  return {
    id,
    roleId: "role-1",
    candidateKey: `crm:${ADA}`,
    body: id,
    createdBy: "user",
    authorName: "Riley",
    createdAt: ago(1),
    updatedAt: ago(1),
    ...extra,
  };
}
function notesMock(items: RecruitingCandidateNote[]) {
  notes.list.mockImplementation(async () => ({ items }));
  notes.create.mockImplementation(async () => note("new"));
  notes.update.mockImplementation(async () => note("x"));
  notes.delete.mockImplementation(async () => ({ ok: true }));
  return notes;
}

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  await settle();
  await settle();
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
const button = (view: HTMLElement, name: string) =>
  [...view.querySelectorAll("button")].find((item) => item.textContent === name);
async function type(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const keys = ["autumn:k1", `crm:${ADA}`];
const tab = () => <NotesTab roleId="role-1" candidateKeys={keys} createKey="autumn:k1" />;

it("lists notes newest first with author and relative time", async () => {
  const api = notesMock([
    note("Older", { createdAt: ago(3) }),
    note("From the agent", { createdBy: "agent", authorName: "Sourcer", createdAt: ago(0.5) }),
    note("Newer", { createdAt: ago(1) }),
  ]);
  const view = await mount(tab());
  expect(api.list).toHaveBeenCalledWith({ candidateKeys: keys });
  const items = [...view.querySelectorAll("li")].map((item) => item.textContent);
  expect(items[0]).toContain("Assistant");
  expect(items[0]).not.toContain("Sourcer");
  expect(items[1]).toMatch(/Riley.*yesterday.*Newer/);
  expect(items[2]).toContain("3 days ago");
});

it("adds a note once it has text and clears the box", async () => {
  const api = notesMock([]);
  const view = await mount(tab());
  expect(view.textContent).toContain("No notes yet.");
  expect(button(view, "Add note")?.disabled).toBe(true);
  const box = view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')!;
  expect(box.placeholder).toBe("Type your note here");
  await type(box, "   ");
  expect(button(view, "Add note")?.disabled).toBe(true);
  await type(box, " Prefers remote ");
  await act(async () => button(view, "Add note")!.click());
  await settle();
  expect(api.create).toHaveBeenCalledWith({
    candidateKey: "autumn:k1",
    roleId: "role-1",
    body: "Prefers remote",
  });
  expect(api.list).toHaveBeenCalledTimes(2);
  expect(view.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')!.value).toBe("");
});

it("edits and deletes a note", async () => {
  const api = notesMock([note("n1", { body: "Call Tuesday" })]);
  const view = await mount(tab());
  await act(async () => button(view, "Edit")!.click());
  const boxes = view.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Note"]');
  expect(boxes[1]!.value).toBe("Call Tuesday");
  await type(boxes[1]!, "Call Wednesday");
  await act(async () => button(view, "Save")!.click());
  await settle();
  expect(api.update).toHaveBeenCalledWith({ id: "n1", body: "Call Wednesday" });
  await act(async () => button(view, "Delete")!.click());
  await settle();
  expect(api.delete).toHaveBeenCalledWith({ id: "n1" });
});

it("shows loading, a retry when notes fail to load and an alert when a change fails", async () => {
  const api = notesMock([note("n1")]);
  let release: () => void = () => undefined;
  api.list.mockImplementationOnce(
    () => new Promise((_, reject) => (release = () => reject(new Error("down")))),
  );
  const view = await mount(tab());
  expect(view.querySelector('[role="status"]')).not.toBeNull();
  await act(async () => release());
  await settle();
  expect(view.querySelector('[role="alert"]')?.textContent).toContain("Could not load notes.");
  await act(async () => button(view, "Retry")!.click());
  await settle();
  expect(view.querySelector('[role="alert"]')).toBeNull();
  api.delete.mockRejectedValueOnce(new Error("down"));
  await act(async () => button(view, "Delete")!.click());
  await settle();
  expect(view.querySelector('[role="alert"]')?.textContent).toContain("Could not save the note.");
});

it("keys notes by every key the person has and mounts in the detail panel", async () => {
  expect(noteCandidateKeys("k1", ADA)).toEqual(["autumn:k1", `crm:${ADA}`]);
  expect(noteCandidateKeys(undefined, ADA)).toEqual([`crm:${ADA}`]);
  expect(noteCandidateKeys("k1", false)).toEqual(["autumn:k1"]);
  expect(noteCandidateKeys("has space", false)).toEqual([]);
  const api = notesMock([]);
  const current: RecruitingDetailTarget = { view: "notes", person, role };
  const controller: RecruitingDetailController = {
    stack: [current],
    current,
    open: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    close: vi.fn(),
    pending: null,
    restore: vi.fn(),
  };
  const view = await mount(
    <RecruitingChatContextProvider
      value={{ setSelectedContact: () => undefined, setSelectedEmail: () => undefined }}
    >
      <RecruitingDetailPanel controller={controller} />
    </RecruitingChatContextProvider>,
  );
  expect(button(view, "Notes")?.getAttribute("aria-pressed")).toBe("true");
  expect(api.list).toHaveBeenCalledWith({ candidateKeys: [`crm:${ADA}`] });
  expect(view.querySelector('section[aria-label="Notes"]')).not.toBeNull();
});
