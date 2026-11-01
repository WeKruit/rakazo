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

import { ShortlistDirectory } from "./ShortlistDirectory";
import type { useRecruitingWorkspace } from "./useRecruitingWorkspace";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  vi.unstubAllGlobals();
});
it("confirms the full role shortlist count before handing off a review", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onAskChat = vi.fn();
  const model = {
    shortlistView: true,
    candidateFresh: true,
    shortlistPending: null,
    candidateFilters: { shortlisted: true },
    onAskChat,
    workspace: {
      role: { id: "role", spaceId: "space", title: "Engineer" },
      revision: { id: "revision", criteria: [] },
    },
    candidatePage: { items: [], total: 0, counts: { shortlisted: 7 }, nextCursor: null },
  } as unknown as ReturnType<typeof useRecruitingWorkspace>;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () => root.render(<ShortlistDirectory model={model} />));
  const request = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Request review",
  )!;
  await act(async () => request.click());
  expect(document.body.textContent).toContain("Review all 7 shortlisted candidates for Engineer?");
  expect(onAskChat).not.toHaveBeenCalled();
  const next = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "Continue in chat",
  )!;
  await act(async () => next.click());
  expect(onAskChat).toHaveBeenCalledWith(
    expect.stringContaining("all 7 shortlisted candidates for Engineer"),
  );
  expect(onAskChat).toHaveBeenCalledWith(
    expect.stringContaining("do not send outreach or change approvals"),
  );
});
