// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import type { RecruitingRoleSetup as RoleSetupStatus } from "@rakazo/contracts";

vi.mock("../../lib/rpc", () => ({ rpc: {} }));

import { RoleSetup } from "./RoleSetup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement | undefined;
afterEach(() => container?.remove());

async function mount(status: RoleSetupStatus | undefined, handlers = {}) {
  const props = { onAsk: vi.fn(), onConnect: vi.fn(), ...handlers };
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RoleSetup status={status} {...props} />));
  return props;
}
const button = (label: string) =>
  [...container!.querySelectorAll("button")].find((item) => item.textContent === label)!;

it("shows nothing for a ready role", async () => {
  await mount({ ready: true, attention: null, items: [{ key: "campaign", state: "ready" }] });
  expect(container!.textContent).toBe("");
});

it("offers each missing step's own fix", async () => {
  const props = await mount({
    ready: false,
    attention: null,
    items: [
      {
        key: "campaign",
        state: "missing",
        action: { kind: "ask_agent", prompt: "为这个岗位准备 outreach campaign" },
      },
      { key: "sender", state: "ready", label: "recruiter@example.com" },
      { key: "crm", state: "ready", label: "Data Infra" },
      { key: "leads", state: "unavailable", action: { kind: "connect", serverId: "instantly" } },
    ],
  });
  expect(container!.textContent).toContain("recruiter@example.com");
  await act(async () => button("Set up").click());
  expect(props.onAsk).toHaveBeenCalledWith("为这个岗位准备 outreach campaign");
  await act(async () => button("Connect").click());
  expect(props.onConnect).toHaveBeenCalledWith("instantly");
});

it("shows a ready role's playbook stage and next step", async () => {
  await mount({
    ready: true,
    attention: null,
    playbookStage: { stage: "calibration_10", label: "10 人校准", nextStep: "给这 10 位候选人反馈" },
    items: [{ key: "campaign", state: "ready" }],
  });
  expect(container!.textContent).toContain("10 人校准");
  expect(container!.textContent).toContain("Next: 给这 10 位候选人反馈");
  expect(container!.querySelector("button")).toBeNull();
});
