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
  const event = projected.events[0]!;
  // Only Date is faked: keep async React/read timers real while opening the week
  // containing the receipt, including either side of the DST repeated hour.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(event.start));
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
      limit: 200,
    });
    const zone = host.querySelector<HTMLSelectElement>('select[aria-label="Display timezone"]')!;
    await act(async () => {
      zone.value = "UTC";
      zone.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const trigger = [...host.querySelectorAll<HTMLButtonElement>("button[data-event-id]")].find(
      (button) => button.dataset.eventId === event.id,
    )!;
    expect(trigger).toBeDefined();
    expect(trigger.textContent).toContain("Candidate interview");
    await act(async () => trigger.click());
    const details = host.querySelector<HTMLElement>('aside[aria-label="Event details"]')!;
    expect(details.textContent).toContain("candidate@example.test");
    expect(details.querySelector("time")?.getAttribute("datetime")).toBe(event.start);
    expect(details.querySelector(`a[href="${event.url}"]`)).not.toBeNull();
    expect(zone.value).toBe("UTC");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
}
