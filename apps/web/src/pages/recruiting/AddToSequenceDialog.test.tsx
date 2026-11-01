// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ accountView: vi.fn(), sequenceDraft: vi.fn() }));
vi.mock("../../lib/rpc", () => ({ rpc: { recruiting: api } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { AddToSequenceDialog } from "./AddToSequenceDialog";

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.accountView.mockReset();
  api.sequenceDraft.mockReset();
});
afterEach(async () => {
  await cleanup?.();
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  [...document.body.querySelectorAll("button")].find((item) => item.textContent === name)!;
it("pages saved choices, previews actual steps and preserves cancel without enrollment or sending", async () => {
  const campaign = {
    id: "sequence-two",
    name: "Saved sequence",
    eaccount: "sender@example.test",
    status: 0,
  };
  api.accountView
    .mockResolvedValueOnce({ roles: [], items: [], nextCursor: "second" })
    .mockResolvedValue({
      roles: [{ id: "role-two", groupId: "group-two", title: "Role Two" }],
      items: [{ roleId: "role-two", campaigns: [{ serverId: "source", campaign }] }],
      nextCursor: null,
    });
  api.sequenceDraft.mockResolvedValue({
    roleId: "role-two",
    campaign: {
      ...campaign,
      steps: [{ subject: "Actual subject", body: "Actual saved body", delay_days: 0 }],
      timezone: "America/Chicago",
      send_hours: "weekdays_9_to_5",
    },
  });
  const onContinue = vi.fn(),
    onOpenChange = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    onContinue,
    onOpenChange,
    people: [{ key: "person", name: "Person", email: "person@example.test" }],
  };
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(<AddToSequenceDialog {...props} open />));
  expect(api.accountView.mock.calls[1]?.[0]).toMatchObject({ view: "sequence", cursor: "second" });
  const select = document.body.querySelector<HTMLSelectElement>('select[aria-label="Sequence"]')!;
  await act(async () => {
    select.value = select.options[1]!.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(api.sequenceDraft).not.toHaveBeenCalled();
  await act(async () => button("Cancel").click());
  expect(onContinue).not.toHaveBeenCalled();
  await act(async () => root.render(<AddToSequenceDialog {...props} open={false} />));
  await act(async () => root.render(<AddToSequenceDialog {...props} open />));
  expect(
    document.body.querySelector<HTMLSelectElement>('select[aria-label="Sequence"]')!.value,
  ).toBe(select.value);
  await act(async () => button("Preview steps").click());
  expect(document.body.textContent).toContain("Actual saved body");
  expect(document.body.textContent).toContain("person@example.test");
  expect(api.sequenceDraft).toHaveBeenCalledWith({
    groupId: "group-two",
    command: {
      operation: "read",
      roleId: "role-two",
      serverId: "source",
      campaignId: "sequence-two",
    },
  });
  expect(onContinue).not.toHaveBeenCalled();
  await act(async () => button("Continue in chat").click());
  expect(onContinue).toHaveBeenCalledWith(expect.stringContaining("exactly 1 selected people"));
  expect(onContinue).toHaveBeenCalledWith(
    expect.stringContaining("existing approval flow before any sending"),
  );
  expect(api.sequenceDraft.mock.calls.every(([input]) => input.command.operation === "read")).toBe(
    true,
  );
});

it("previews retained rich variants without making editable steps or executing markup", async () => {
  const campaign = {
    id: "rich",
    name: "Rich sequence",
    eaccount: "sender@example.test",
    status: 2,
  };
  api.accountView.mockResolvedValue({
    roles: [{ id: "role", groupId: "group", title: "Engineer" }],
    items: [{ roleId: "role", campaigns: [{ serverId: "source", campaign }] }],
    nextCursor: null,
  });
  api.sequenceDraft.mockResolvedValue({
    roleId: "role",
    campaign: {
      ...campaign,
      editable: false,
      steps: [],
      timezone: null,
      send_hours: null,
      observedDetails: {
        schedules: null,
        sequences: [
          {
            steps: [
              {
                type: "email",
                delay: 2,
                delayUnit: "days",
                variants: [
                  { subject: "Variant A", body: "<p>Saved rich body A</p>" },
                  { subject: "Variant B", body: "<p>Saved rich body B</p>" },
                ],
              },
            ],
          },
        ],
      },
    },
  });
  const onContinue = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () =>
    root.render(
      <AddToSequenceDialog
        open
        onOpenChange={() => undefined}
        people={[{ key: "person", name: "Person" }]}
        onContinue={onContinue}
      />,
    ),
  );
  const select = document.body.querySelector<HTMLSelectElement>('select[aria-label="Sequence"]')!;
  await act(async () => {
    select.value = select.options[1]!.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Preview steps").click());
  expect(document.body.textContent).toContain("Saved rich body A");
  expect(document.body.textContent).toContain("Saved rich body B");
  expect(document.body.querySelectorAll("script")).toHaveLength(0);
  expect(onContinue).not.toHaveBeenCalled();
  await act(async () => button("Continue in chat").click());
  expect(onContinue).toHaveBeenCalledWith(expect.stringContaining("Saved rich body B"));
  expect(api.sequenceDraft.mock.calls.every(([input]) => input.command.operation === "read")).toBe(
    true,
  );
});
