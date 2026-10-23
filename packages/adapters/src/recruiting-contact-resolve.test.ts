import type { ConnectorCall } from "@rakazo/adapter-kit";
import { RECRUITING_DEFAULT_BOTS } from "@rakazo/core";
import type * as Database from "@rakazo/db";
import { listRecruitingCandidates } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentCrmCandidatesArgs } from "./mcp-connector.js";
import {
  resolveRecruitingContact,
  resolveRecruitingContactAcrossRoles,
  unresolvedContactEmailError,
} from "./recruiting-tools.js";

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Database>()),
  listRecruitingCandidates: vi.fn(),
}));

// Same CRM shapes as apps/api recruiting.test.ts "live CRM browser reads".
const org = "10000000-0000-4000-8000-000000000001";
const roleId = "20000000-0000-4000-8000-000000000002";
const clientId = "30000000-0000-4000-8000-000000000003";
const target = {
  mcpServerId: "crm",
  serverRevision: 3,
  organizationId: org,
  crmRoleId: roleId,
  crmClientId: clientId,
  clientLabel: "Dyna",
  roleLabel: "Data Infra",
};
const crmRow = (candidate: string, full_name: string, email: string | null) => ({
  candidate_id: `40000000-0000-4000-8000-00000000000${candidate}`,
  full_name,
  email,
  phone: null,
  linkedin_url: null,
  location: null,
  headline: null,
  stage: "Contacted",
  contact_status: "found",
  outreach_status: "replied",
  role_spec_id: null,
  client_label: "Dyna",
  role_label: "Data Infra",
});
const actor = { userId: "u1", spaceId: "w1" } as never;

function fixture(
  rows: ReturnType<typeof crmRow>[],
  pool: { name: string; linkedinUrl: string | null }[] = [],
) {
  vi.mocked(listRecruitingCandidates).mockResolvedValue({
    crmTarget: { bindingEffectId: "binding", target },
    items: pool.map((row, index) => ({ ...row, candidateKey: `key-${index}` })),
    nextCursor: null,
  } as never);
  const calls: ConnectorCall[] = [];
  const connector = {
    async *execute(call: ConnectorCall) {
      calls.push(call);
      yield {
        type: "result" as const,
        data: { structuredContent: { data: { total: rows.length, rows } } },
      };
    },
  };
  const context = { runId: "run-resolve", operationId: "op", signal: new AbortController().signal };
  const resolve = (nameOrEmail: string) =>
    resolveRecruitingContact(
      { prisma: {} as never, connector },
      actor,
      { roleId: "native-role", nameOrEmail },
      context as never,
    );
  return { calls, resolve, connector };
}

describe("resolveRecruitingContact", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves Sumeet to the role's stored CRM contact via role labels, not the role id", async () => {
    const f = fixture([
      crmRow("4", "Sumeet Parekh", "sumeetparekh1@gmail.com"),
      crmRow("5", "Other Person", "other@example.test"),
    ]);
    const result = await f.resolve("Sumeet");
    expect(result).toMatchObject({
      status: "resolved",
      crm: "read",
      matches: [
        {
          name: "Sumeet Parekh",
          email: "sumeetparekh1@gmail.com",
          sources: ["crm_contact"],
          outreachStatus: "replied",
        },
      ],
    });
    expect(f.calls[0]).toMatchObject({
      route: { resourceId: "crm", resourceRevision: 3, toolName: "list_crm_candidates" },
      args: { p_org: org, p_client: "Dyna", p_role: "Data Infra", p_not_reviewed: false },
    });
    expect(unresolvedContactEmailError("run-resolve", "sumeetparekh1@gmail.com", "Sumeet")).toBe(
      null,
    );
    expect(unresolvedContactEmailError("run-resolve", "sumeet.parekh@gmail.com", "Sumeet")).toBe(
      "No stored email for Sumeet; resolve the contact first, never guess an address",
    );
  });

  it("matches partial, case- and accent-insensitive names across CRM and the saved pool", async () => {
    const f = fixture(
      [crmRow("4", "José Álvarez", "jose@example.test")],
      [{ name: "Zoë  Müller", linkedinUrl: "https://www.linkedin.com/in/zoe" }],
    );
    expect((await f.resolve("jose alv")).matches).toMatchObject([
      { name: "José Álvarez", email: "jose@example.test" },
    ]);
    expect(await f.resolve("ZOE muller")).toMatchObject({
      status: "resolved",
      matches: [{ name: "Zoë  Müller", email: null, sources: ["saved_pool"] }],
    });
    expect((await f.resolve("JOSE@example.test")).matches).toHaveLength(1);
  });

  it("returns every match for disambiguation when several people share the name", async () => {
    const f = fixture([
      crmRow("4", "Sumeet Parekh", "sumeetparekh1@gmail.com"),
      crmRow("5", "Sumeet Shah", "sumeet.shah@example.test"),
    ]);
    const result = await f.resolve("sumeet");
    expect(result.status).toBe("ambiguous");
    expect(result.matches.map((match) => match.email)).toEqual([
      "sumeetparekh1@gmail.com",
      "sumeet.shah@example.test",
    ]);
  });

  it("tells agents to resolve through role records and never guess an email", () => {
    for (const bot of RECRUITING_DEFAULT_BOTS)
      expect(bot.instructions).toContain(
        "Resolve a person named in chat through the role's contacts and saved pool first",
      );
    expect(RECRUITING_DEFAULT_BOTS[0].instructions).toContain("never invent or guess an email");
  });

  it("resolves Sumeet without a thread role through the user's Data Infra role", async () => {
    const f = fixture([crmRow("4", "Sumeet Parekh", "sumeetparekh1@gmail.com")]);
    vi.mocked(listRecruitingCandidates).mockImplementation(
      async (_prisma, _actor, input) =>
        ({
          crmTarget: input.roleId === "data-infra" ? { bindingEffectId: "b", target } : null,
          items: [],
          nextCursor: null,
        }) as never,
    );
    const findMany = vi.fn(async (_query: unknown) => [
      { id: "designer", title: "Designer" },
      { id: "data-infra", title: "Dyna Robotics — Software Engineer, Data Infra" },
    ]);
    const result = await resolveRecruitingContactAcrossRoles(
      { prisma: { recruitingRole: { findMany } } as never, connector: f.connector },
      actor,
      "sumeet",
      { runId: "run-roleless", operationId: "op", signal: new AbortController().signal } as never,
    );
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: { spaceId: "w1", userId: "u1", archivedAt: null },
    });
    expect(result).toMatchObject({
      scope: "all_user_roles",
      status: "resolved",
      matches: [
        {
          name: "Sumeet Parekh",
          email: "sumeetparekh1@gmail.com",
          roleId: "data-infra",
          roleTitle: "Dyna Robotics — Software Engineer, Data Infra",
        },
      ],
    });
    expect(unresolvedContactEmailError("run-roleless", "sumeetparekh1@gmail.com", "Sumeet")).toBe(
      null,
    );
  });
});

describe("agent list_crm_candidates arguments", () => {
  it("includes contacted people and translates a role id to the role's labels", async () => {
    const readRole = vi.fn(async () => ({
      structuredContent: {
        data: { role_spec_id: roleId, client_label: "Dyna", role_label: "Data Infra" },
      },
    }));
    expect(
      await agentCrmCandidatesArgs({ p_org: org, p_role: roleId, p_q: "Sumeet" }, readRole),
    ).toEqual({
      p_org: org,
      p_q: "Sumeet",
      p_not_reviewed: false,
      p_client: "Dyna",
      p_role: "Data Infra",
    });
    expect(readRole).toHaveBeenCalledWith({ p_org: org, p_role: roleId });
    // Labels and an explicit p_not_reviewed pass through untouched.
    expect(
      await agentCrmCandidatesArgs(
        { p_org: org, p_role: "Data Infra", p_not_reviewed: true },
        readRole,
      ),
    ).toEqual({ p_org: org, p_role: "Data Infra", p_not_reviewed: true });
    expect(readRole).toHaveBeenCalledTimes(1);
  });
});
