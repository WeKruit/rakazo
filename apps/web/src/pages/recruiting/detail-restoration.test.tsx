// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ContactsTab } from "./ContactsTab";
import type { RecruitingDetailTarget } from "./detail";
import {
  pendingDetailTarget,
  RecruitingDetailProvider,
  useRecruitingDetailController,
} from "./detail";

const rows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock("./useRoleCandidates", () => ({
  useRoleCandidates: () => ({
    rows: rows.value,
    total: rows.value.length,
    crm: { status: "unbound" },
    crmRead: { failed: false, loading: false },
    more: { hasMore: false },
  }),
}));
vi.mock("./CandidateDirectory", () => ({ CandidateDirectory: () => null }));
vi.mock("../../lib/rpc", () => ({
  rpc: { recruiting: { correspondence: async () => ({ roleId: "role-1", contacts: [] }) } },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  Plural: ({ value, _1, other }: { value: number; _1: string; other: string }) =>
    (value === 1 ? _1 : other).replace("#", String(value)),
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));
const key = "linkedin:synthetic.person";
const target: RecruitingDetailTarget = {
  view: "contact",
  person: { candidateId: key, name: "Synthetic person" },
  role: { roleId: "role-1", spaceId: "space-1", conversation: { groupId: "group-1" } },
};
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

it("restores only an exact candidate and known tab, including dotted candidate keys", () => {
  for (const view of ["contact", "thread", "interview", "activity", "tasks", "notes"]) {
    expect(pendingDetailTarget(target, `${view}.${key}`)).toEqual({ ...target, view });
  }
  for (const pending of [`notes.${key}.other`, `notes.other${key}`, `unknown.${key}`, `notes.`]) {
    expect(pendingDetailTarget(target, pending)).toBeUndefined();
  }
});

it("restores a reloaded Notes tab when Contacts loads its person without adding history", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rows.value = [];
  let current: ReturnType<typeof useRecruitingDetailController>;
  let back: () => void = () => undefined;
  let location = "";
  function Workbench() {
    const detail = useRecruitingDetailController("group-1");
    current = detail;
    const navigate = useNavigate();
    back = () => navigate(-1);
    const route = useLocation();
    location = `${route.pathname}${route.search}`;
    return (
      <RecruitingDetailProvider value={detail}>
        <ContactsTab {...target.role} />
      </RecruitingDetailProvider>
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  const path = `/role?view=contacts&detail=${encodeURIComponent(`notes.${key}`)}`;
  const render = () =>
    root.render(
      <MemoryRouter initialEntries={["/previous", path]} initialIndex={1}>
        <Workbench />
      </MemoryRouter>,
    );
  await act(async () => render());
  expect(current!.current).toBeUndefined();
  expect(current!.pending).toBe(`notes.${key}`);
  // The exact loaded Autumn identity supplies the snapshot. No synthetic profile or
  // URL-only target is inserted while the list is still absent.
  rows.value = [{ key, name: "Synthetic person", autumn: { candidateKey: key }, crm: null }];
  await act(async () => render());
  expect(current!.current).toMatchObject({ view: "notes", person: { candidateId: key } });
  expect(current!.pending).toBeNull();
  expect(location).toBe(path);
  expect(current!.stack).toHaveLength(1);
  await act(async () => back());
  expect(location).toBe("/previous");
  expect(current!.current).toBeUndefined();
});
