import type { RecruitingCorrespondence } from "@rakazo/contracts";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
import { InterviewTab } from "./InterviewTab";

const correspondenceRpc = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({ rpc: { recruiting: { correspondence: correspondenceRpc } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

let refreshSignal = 0;

export async function renderSchedulingProjection(projected: RecruitingCorrespondence) {
  // Feed the actual API result across the RPC boundary into the real Interview tab.
  // CRM rows are deliberately unbound: this asserts only saved calendar projection.
  correspondenceRpc.mockResolvedValue(projected);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try {
    await act(async () =>
      root.render(
        createElement(InterviewTab, {
          spaceId: "space-1",
          roleId: "role-1",
          conversation: { groupId: "synthetic-group" },
          crmTarget: null,
          refreshSignal: ++refreshSignal,
        }),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(correspondenceRpc).toHaveBeenCalledWith({
      groupId: "synthetic-group",
      view: "interview",
    });
    expect(host.textContent).toContain("Candidate interview");
    expect(host.textContent).toContain("candidate@example.test");
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe(projected.events[0]!.start);
    expect(host.querySelector(`a[href="${projected.events[0]!.url}"]`)).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}
