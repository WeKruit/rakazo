// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  crm: { status: "ready", target: { crmRoleId: "role" } } as Record<string, unknown>,
  pages: {} as Record<string, unknown>,
}));
vi.mock("./shared", () => ({
  useRoleCrm: () => reads.crm,
  useCrmPages: () => reads.pages,
}));

import { type SourcedCandidatesRead, useRoleCandidates } from "./useRoleCandidates";

const ada = { candidateKey: "ada", name: "Ada", linkedinUrl: "https://linkedin.com/in/ada" };
const crmAda = { ...ada, candidateId: "crm-ada" };
const sourced = (extra = {}): SourcedCandidatesRead => ({
  items: [ada] as never[],
  total: 100,
  hasMore: true,
  loading: false,
  failed: false,
  retry: vi.fn(),
  loadMore: vi.fn(),
  sortByScore: true,
  includeCrm: true,
  ...extra,
});
let root: ReturnType<typeof createRoot>;
let result: ReturnType<typeof useRoleCandidates>;
function Probe({ value }: { value?: SourcedCandidatesRead }) {
  result = useRoleCandidates({ roleId: "role", spaceId: "space", sourced: value });
  return null;
}
async function render(value?: SourcedCandidatesRead) {
  await act(async () => root.render(<Probe value={value} />));
  return result;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  reads.crm = { status: "ready", target: { crmRoleId: "role" } };
  reads.pages = {
    data: { items: [crmAda], total: 100 },
    hasMore: true,
    loading: false,
    failed: false,
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
});

it("does not subtract only loaded overlaps from complete source totals", async () => {
  const list = await render(sourced());
  expect(list.total).toBeNull();
  expect(list.loadedCount).toBe(1);
});
it("uses the merged row count after both sources are exhausted", async () => {
  reads.pages = { ...reads.pages, data: { items: [crmAda], total: 1 }, hasMore: false };
  const list = await render(sourced({ total: 1, hasMore: false }));
  expect(list.total).toBe(1);
  expect(list.loadedCount).toBe(1);
});
it.each(["loading", "failed", "unavailable"])(
  "does not treat a %s CRM source as zero",
  async (status) => {
    reads.crm = { status };
    reads.pages = { loading: status === "loading", failed: status === "failed" };
    expect((await render(sourced({ total: 1, hasMore: false }))).total).toBeNull();
  },
);
it.each([{ loading: true }, { failed: true }, { total: null }])(
  "does not treat an unread search-result source as zero: %j",
  async (state) => {
    expect((await render(sourced(state))).total).toBeNull();
  },
);
it("preserves a trusted single-source CRM total while pages remain", async () => {
  expect((await render()).total).toBe(100);
});
it.each(["excluded", "unbound"])(
  "preserves a trusted search-result total when CRM is %s",
  async (state) => {
    if (state === "unbound") reads.crm = { status: "unbound" };
    expect((await render(sourced({ includeCrm: state !== "excluded" }))).total).toBe(100);
  },
);
it("does not report exact totals after a failed CRM read", async () => {
  reads.pages = { ...reads.pages, failed: true, hasMore: false };
  expect((await render(sourced({ total: 1, hasMore: false }))).total).toBeNull();
});

it.each([true, false])(
  "keeps total unknown when only one source has more pages (search results: %s)",
  async (sourcedHasMore) => {
    reads.pages = { ...reads.pages, hasMore: !sourcedHasMore };
    expect((await render(sourced({ hasMore: sourcedHasMore }))).total).toBeNull();
  },
);
