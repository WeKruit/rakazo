// @vitest-environment jsdom
import type { RecruitingCandidate } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({ rpc: { recruiting: { listCandidates: list } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { TalentInsights, talentFacts } from "./TalentInsights";

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  list.mockReset();
});
afterEach(async () => {
  await cleanup?.();
  vi.unstubAllGlobals();
});
const person = (key: string, location: string | null): RecruitingCandidate =>
  ({
    candidateKey: key,
    location,
    company: null,
    savedProfile: null,
    latestSource: undefined,
  }) as RecruitingCandidate;
const page = (items: RecruitingCandidate[], nextCursor: string | null, roleId = "role-one") => ({
  items,
  nextCursor,
  roleId,
  roleRevisionId: `${roleId}-revision`,
  total: 2,
});
async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = async (next: ReactNode) => {
    await act(async () => root.render(next));
  };
  await render(node);
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, render };
}
it("waits for every scoped shortlist page before presenting denominators", async () => {
  let finish!: (value: ReturnType<typeof page>) => void;
  list
    .mockResolvedValueOnce(page([person("one", "City One")], "cursor-two"))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const { host } = await mount(
    <TalentInsights
      roleId="role-one"
      roleTitle="Role One"
      filters={{ query: "engineer", rankingGroup: "worth_talking" }}
      onBack={() => {}}
    />,
  );
  expect(list).toHaveBeenCalledTimes(2);
  expect(list.mock.calls[1]?.[0]).toMatchObject({
    roleId: "role-one",
    shortlisted: true,
    query: "engineer",
    rankingGroup: "worth_talking",
    cursor: "cursor-two",
  });
  expect(host.textContent).not.toContain("City One");
  await act(async () => finish(page([person("two", null)], null)));
  expect(host.textContent).toContain("2 shortlisted candidates");
  const locations = host.querySelector('[aria-label="Top locations"]')!;
  expect(locations.textContent).toContain("1 known · 1 unknown · 2 people");
  expect(locations.textContent).toContain("City One");
});
it("discards an old role's delayed page after switching scope", async () => {
  let finish!: (value: ReturnType<typeof page>) => void;
  list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { host, render } = await mount(
    <TalentInsights roleId="role-one" roleTitle="Role One" filters={{}} onBack={() => {}} />,
  );
  list.mockResolvedValueOnce(page([person("a", "New City"), person("b", null)], null, "role-two"));
  await render(
    <TalentInsights roleId="role-two" roleTitle="Role Two" filters={{}} onBack={() => {}} />,
  );
  await act(async () => finish(page([person("old", "Old City")], null)));
  expect(host.textContent).toContain("New City");
  expect(host.textContent).not.toContain("Old City");
});
it("counts supplied categories once per person and does not manufacture missing facts", () => {
  const saved = person("one", null);
  saved.latestSource = {
    report: { fields: [{ label: "Skills", value: "TypeScript, TypeScript", sourceUrls: [] }] },
  } as unknown as RecruitingCandidate["latestSource"];
  const facts = talentFacts([saved, person("two", null)]);
  expect(facts.known.locations).toBe(0);
  expect(facts.dimensions.companies.size).toBe(0);
  expect(facts.dimensions.skills.get("TypeScript")).toBe(1);
  expect(facts.experience).toEqual([]);
});
