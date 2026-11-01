// @vitest-environment jsdom
import type { RecruitingSequenceOutput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SequenceEditor } from "./SequenceEditor";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const id = "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69";
const campaign: RecruitingSequenceOutput = {
  roleId: "role",
  roleTitle: "Engineer",
  mailboxes: ["team@example.test"],
  campaign: {
    id,
    name: "Engineer",
    status: 0,
    editable: true,
    eaccount: "team@example.test",
    timezone: "America/Chicago",
    send_hours: "any_time",
    steps: [
      { subject: "Hi {{first_name}}", body: "Hello", delay_days: 0 },
      { subject: "Follow up", body: "Any thoughts?", delay_days: 3 },
    ],
  },
};

it("reopens actual steps and save never activates; sending goes through the agent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const execute = vi.fn(async () => campaign);
  const ask = vi.fn();
  await act(async () =>
    root.render(
      <SequenceEditor roleId="role" serverId="server" execute={execute} onAskAgent={ask} />,
    ),
  );
  expect([...container.querySelectorAll("textarea")].map((el) => el.value)).toEqual([
    "Hello",
    "Any thoughts?",
  ]);
  expect(
    [...container.querySelectorAll('input[type="number"]')].map(
      (el) => (el as HTMLInputElement).value,
    ),
  ).toEqual(["0", "3"]);
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(execute).toHaveBeenLastCalledWith({
    operation: "save",
    roleId: "role",
    serverId: "server",
    campaignId: id,
    draft: {
      name: "Engineer",
      eaccount: "team@example.test",
      timezone: "America/Chicago",
      send_hours: "any_time",
      steps: campaign.campaign!.steps,
    },
  });
  const calls = execute.mock.calls.length;
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Review and send")!
      .click(),
  );
  expect(ask).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledTimes(calls);
  await act(async () => root.unmount());
});

it("ignores an earlier role read that resolves after changing role", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolve!: (value: RecruitingSequenceOutput) => void;
  const old = new Promise<RecruitingSequenceOutput>((done) => {
    resolve = done;
  });
  const execute = vi.fn(({ roleId }: { roleId: string }) =>
    roleId === "old" ? old : Promise.resolve({ ...campaign, roleId: "new", campaign: null }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<SequenceEditor roleId="old" serverId="server" execute={execute} />),
  );
  await act(async () =>
    root.render(<SequenceEditor roleId="new" serverId="server" execute={execute} />),
  );
  await act(async () => resolve(campaign));
  expect(container.textContent).toContain("Create draft");
  expect(container.querySelector("textarea")!.value).toBe("");
  await act(async () => root.unmount());
});

it("uses the browser timezone for a new draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const resolved = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions");
  const options = new Intl.DateTimeFormat().resolvedOptions();
  resolved.mockReturnValue({ ...options, timeZone: "Asia/Tokyo" });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <SequenceEditor
          roleId="role"
          serverId="server"
          execute={async () => ({ ...campaign, campaign: null })}
        />,
      ),
    );
    expect((host.querySelector('input[name="timezone"]') as HTMLInputElement).value).toBe(
      "Asia/Tokyo",
    );
  } finally {
    await act(async () => root.unmount());
    resolved.mockRestore();
  }
});
