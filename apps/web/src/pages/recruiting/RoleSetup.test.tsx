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

async function mount(status: RoleSetupStatus | undefined) {
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RoleSetup status={status} />));
}

it("shows nothing until the role has a stage, then the stage and its next step", async () => {
  await mount({});
  expect(container!.textContent).toBe("");
  container!.remove();
  await mount({
    playbookStage: { stage: "calibration_10", next: { step: "find_first_10", count: 3 } },
  });
  expect(container!.textContent).toBe("First 10 peopleNext: Finding 3 more of the first 10");
});
