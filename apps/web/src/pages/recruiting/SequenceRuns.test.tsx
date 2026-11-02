// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SequenceRuns } from "./SequenceRuns";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
it("shows actual zero telemetry and awaits response readback without optimistic classification", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const change = vi.fn(async () => "pending" as const);
  await act(async () =>
    root.render(
      <SequenceRuns
        campaign={{
          status: "ready",
          serverId: "server",
          campaign: { id: "campaign", name: "Saved", status: 1, eaccount: null, stopOnReply: true },
          leads: [
            {
              candidateKey: null,
              email: "person@example.test",
              name: "Saved Person",
              status: 1,
              interestStatus: null,
              openCount: 0,
              clickCount: 2,
              replyCount: null,
            },
          ],
        }}
        people={[]}
        filter="all"
        onFilter={() => {}}
        onResponse={change}
      />,
    ),
  );
  expect(container.textContent).toContain("Saved Person");
  expect(container.textContent).toContain("Opens 0 · Clicks 2 · Replies —");
  const select = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Response for person@example.test"]',
  )!;
  await act(async () => {
    select.value = "interested";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(change).toHaveBeenCalledWith("person@example.test", "interested");
  expect(select.value).toBe("none");
  expect(container.textContent).toContain("Update pending. Refresh to check.");
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
