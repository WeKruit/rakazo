// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
vi.mock("./SequenceTab", () => ({
  useInstantlyStatus: () => ({ campaign: new Map() }),
  statusLabel: () => "Saved status",
}));
const data = vi.hoisted(() => ({
  candidateId: "person",
  campaignAssociations: {
    pipelineCampaign: null,
    leadCampaigns: [
      {
        campaign: {
          id: "own",
          name: "Same role sequence",
          crmRoleId: "crm-role",
          status: null,
          syncedAt: "2026-10-01T00:00:00Z",
        },
      },
      {
        campaign: {
          id: "other",
          name: "Other role sequence",
          crmRoleId: "another-role",
          status: null,
          syncedAt: "2026-10-01T00:00:00Z",
        },
      },
    ],
    nextOffset: null,
  },
}));
vi.mock("./shared", () => ({
  useRoleCrm: () => ({ status: "ready", target: { crmRoleId: "crm-role" } }),
  useCrmData: () => ({ data, loading: false, failed: false }),
  formatDate: (date: string) => date,
}));

import { ProfileSequenceHistory } from "./ProfileSequenceHistory";

it("shows actual associations but exposes role actions only for the exact known role", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onAskChat = vi.fn(),
    onReply = vi.fn();
  try {
    await act(async () =>
      root.render(
        <ProfileSequenceHistory
          role={{ roleId: "product-role", spaceId: "space" }}
          candidateId="person"
          name="Person"
          onAvailable={() => undefined}
          onAskChat={onAskChat}
          onReply={onReply}
        />,
      ),
    );
    expect(host.textContent).toContain("Same role sequence");
    expect(host.textContent).toContain("Other role sequence");
    const mark = [...host.querySelectorAll("button")].filter(
      (button) => button.textContent === "Mark as replied",
    );
    const reply = [...host.querySelectorAll("button")].filter(
      (button) => button.textContent === "Reply",
    );
    expect(mark).toHaveLength(1);
    expect(reply).toHaveLength(1);
    await act(async () => mark[0]!.click());
    expect(onAskChat).toHaveBeenCalledWith(expect.stringContaining("Same role sequence"));
    expect(onAskChat).not.toHaveBeenCalledWith(expect.stringContaining("Other role sequence"));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
