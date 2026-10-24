import type { ConnectorCall } from "@rakazo/adapter-kit";
import { RECRUITING_DEFAULT_BOTS } from "@rakazo/core";
import type * as Database from "@rakazo/db";
import { listRecruitingCandidates } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentCrmCandidatesArgs } from "./mcp-connector.js";
import {
  listRecruitingRoleReplies,
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
  const mail = { messages: [] as Record<string, unknown>[], fail: false, roleId };
  const connector = {
    async *execute(call: ConnectorCall) {
      calls.push(call);
      if (call.route?.toolName === "list_crm_role_correspondence") {
        if (mail.fail) {
          yield { type: "error" as const, message: "provider down" };
          return;
        }
        yield {
          type: "result" as const,
          data: {
            structuredContent: {
              data: {
                version: 2,
                organization_id: org,
                role_id: mail.roleId,
                candidate_id: (call.args as { p_candidate: string }).p_candidate,
                pagination: "offset",
                messages: mail.messages.slice(
                  Number(call.args.p_offset),
                  Number(call.args.p_offset) + Number(call.args.p_limit),
                ),
                next_offset:
                  Number(call.args.p_offset) + Number(call.args.p_limit) < mail.messages.length
                    ? Number(call.args.p_offset) + Number(call.args.p_limit)
                    : null,
              },
            },
          },
        };
        return;
      }
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
  const replies = (limit?: number) =>
    listRecruitingRoleReplies(
      { prisma: {} as never, connector },
      actor,
      { roleId: "native-role", ...(limit ? { limit } : {}) },
      context as never,
    );
  return { calls, resolve, replies, connector, mail };
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
  const binding = {
    mcpServerId: "crm-server",
    serverRevision: 1,
    organizationId: org,
    crmRoleId: roleId,
    crmClientId: "30000000-0000-4000-8000-000000000003",
    clientLabel: "Example Client",
    roleLabel: "Data Infra",
  };
  it("fills only missing exact-workspace filters and includes contacted people", async () => {
    expect(await agentCrmCandidatesArgs({ p_q: "Example" }, [binding])).toEqual({
      p_org: org,
      p_q: "Example",
      p_not_reviewed: false,
      p_client: binding.clientLabel,
      p_role: binding.roleLabel,
    });
    expect(
      await agentCrmCandidatesArgs({ p_org: org, p_role: roleId, p_not_reviewed: true }, [binding]),
    ).toEqual({
      p_org: org,
      p_not_reviewed: true,
      p_client: binding.clientLabel,
      p_role: binding.roleLabel,
    });
  });
  it.each([
    { p_org: "other-org" },
    { p_client: "Other client" },
    { p_role: "Other role" },
    { p_q: "Example", p_role: "Other role" },
  ])("refuses mismatched explicit scope instead of rewriting or broadening: %j", async (args) => {
    await expect(agentCrmCandidatesArgs(args, [binding])).rejects.toThrow(/current role workspace/);
  });
  it("refuses missing or ambiguous scope instead of selecting another owned role", async () => {
    await expect(agentCrmCandidatesArgs({ p_org: org, p_role: roleId })).rejects.toThrow(
      /workspace/,
    );
    await expect(
      agentCrmCandidatesArgs({ p_q: "Example" }, [binding, { ...binding, roleLabel: "Other" }]),
    ).rejects.toThrow(/workspace/);
  });

  it("finds incoming candidate mail beyond the former twenty-page cutoff", async () => {
    const f = fixture([crmRow("4", "Example Person", "person@example.test")]);
    f.mail.messages = Array.from({ length: 1051 }, (_, index) => ({
      id: `mail-${index}`,
      organization_id: org,
      candidate_id: "40000000-0000-4000-8000-000000000004",
      lead_email: null,
      thread_id: "thread",
      direction: index === 1050 ? "received" : "sent",
      timestamp_email: "2026-10-22T00:00:00Z",
      campaign_id: null,
      from_address: "person@example.test",
      to_address: "team@example.test",
      subject: "Role",
      body_text: `body-${index}`,
    }));
    const result = await f.resolve("Example");
    expect(result.matches[0]).toMatchObject({
      correspondence: { status: "read", latestReceived: { preview: "body-1050" } },
    });
    const calls = f.calls.filter((call) => call.route?.toolName === "list_crm_role_correspondence");
    expect(calls).toHaveLength(22);
    expect(calls.at(-1)?.args).toMatchObject({
      p_candidate: "40000000-0000-4000-8000-000000000004",
      p_offset: 1050,
    });
  });
  it("does not report a foreign role correspondence page as successfully read", async () => {
    const f = fixture([crmRow("4", "Example Person", "person@example.test")]);
    f.mail.roleId = org;
    expect((await f.resolve("Example")).matches[0]).toMatchObject({
      correspondence: { status: "unavailable", latest: null },
    });
  });
  it("answers latest mail from the role's stored correspondence (the Inbox source)", async () => {
    const f = fixture([crmRow("4", "Sumeet Parekh", "sumeetparekh1@gmail.com")]);
    const message = (id: string, direction: string, at: string, from: string, to: string) => ({
      id,
      organization_id: org,
      candidate_id: "40000000-0000-4000-8000-000000000004",
      lead_email: "sumeetparekh1@gmail.com",
      thread_id: "t",
      direction,
      timestamp_email: at,
      campaign_id: null,
      from_address: from,
      to_address: to,
      subject: "Re: Data Infra",
      body_text: "Thanks, happy to chat",
    });
    f.mail.messages = [
      message("old", "received", "2026-10-21T14:14:00Z", "sumeetparekh1@gmail.com", "team@x.test"),
      message("new", "received", "2026-10-22T23:14:58Z", "sumeetparekh1@gmail.com", "team@x.test"),
      message("sent", "sent", "2026-10-22T01:00:00Z", "team@x.test", "sumeetparekh1@gmail.com"),
    ];
    const result = await f.resolve("Sumeet");
    expect(f.calls.at(-1)).toMatchObject({
      route: { toolName: "list_crm_role_correspondence" },
      args: { p_org: org, p_role: roleId, p_limit: 50, p_offset: 0 },
    });
    expect(result.matches[0]).toMatchObject({
      correspondence: {
        source: "crm_role_correspondence",
        status: "read",
        latest: { direction: "received", at: "2026-10-22T23:14:58Z" },
        latestReceived: { at: "2026-10-22T23:14:58Z" },
      },
    });
    // A failed read is reported as unavailable, never as no mail.
    f.mail.fail = true;
    expect((await f.resolve("Sumeet")).matches[0]).toMatchObject({
      correspondence: { status: "unavailable", latest: null },
    });
  });
});

describe("listRecruitingRoleReplies", () => {
  beforeEach(() => vi.clearAllMocks());
  const mail = (id: string, candidate: string, direction: string, at: string) => ({
    id,
    organization_id: org,
    candidate_id: `40000000-0000-4000-8000-00000000000${candidate}`,
    lead_email: null,
    thread_id: `t-${candidate}`,
    direction,
    timestamp_email: at,
    campaign_id: null,
    from_address: direction === "received" ? `p${candidate}@example.test` : "team@example.test",
    to_address: direction === "received" ? "team@example.test" : `p${candidate}@example.test`,
    subject: "Re: Data Infra",
    body_text: `reply from ${candidate}`,
  });

  it("lists everyone on the role who replied, newest first, from the Inbox source", async () => {
    const f = fixture([
      crmRow("4", "Ada Example", "p4@example.test"),
      crmRow("5", "Ben Example", "p5@example.test"),
      crmRow("6", "Cy Example", "p6@example.test"),
    ]);
    f.mail.messages = [
      mail("a2", "4", "received", "2026-10-22T10:00:00Z"),
      mail("b1", "5", "received", "2026-10-23T09:00:00Z"),
      mail("a1", "4", "received", "2026-10-21T10:00:00Z"),
      mail("c1", "6", "sent", "2026-10-20T10:00:00Z"),
    ];
    const result = await f.replies();
    expect(result).toMatchObject({ correspondence: "read", complete: true, total: 2 });
    expect(result.people.map((person) => [person.name, person.replies])).toEqual([
      ["Ben Example", 1],
      ["Ada Example", 2],
    ]);
    expect(result.people[1]?.latestReceived).toMatchObject({ at: "2026-10-22T10:00:00Z" });
    // The whole role is read: no candidate filter, exact org and role scope.
    const reads = f.calls.filter((call) => call.route?.toolName === "list_crm_role_correspondence");
    expect(reads[0]?.args).toEqual({ p_org: org, p_role: roleId, p_limit: 50, p_offset: 0 });
    // Listed addresses count as resolved for later correspondence lookups in this run.
    expect(unresolvedContactEmailError("run-resolve", "p5@example.test", "Ben Example")).toBeNull();
  });

  it("reports unbound or unreadable correspondence, never an empty reply list", async () => {
    const f = fixture([crmRow("4", "Ada Example", "p4@example.test")]);
    f.mail.fail = true;
    expect(await f.replies()).toEqual({ correspondence: "unavailable", people: [] });
    f.mail.fail = false;
    f.mail.roleId = org;
    expect(await f.replies()).toEqual({ correspondence: "unavailable", people: [] });
    vi.mocked(listRecruitingCandidates).mockResolvedValue({
      crmTarget: null,
      items: [],
      nextCursor: null,
    } as never);
    expect(await f.replies()).toEqual({ correspondence: "not_bound", people: [] });
  });

  it("rejects a page carrying another candidate's scope echo", async () => {
    const f = fixture([crmRow("4", "Ada Example", "p4@example.test")]);
    f.mail.messages = [mail("a1", "4", "received", "2026-10-22T10:00:00Z")];
    const execute = f.connector.execute.bind(f.connector);
    f.connector.execute = async function* (call: ConnectorCall) {
      for await (const event of execute(call)) {
        if (event.type === "result" && call.route?.toolName === "list_crm_role_correspondence")
          (
            event.data as { structuredContent: { data: Record<string, unknown> } }
          ).structuredContent.data.candidate_id = "40000000-0000-4000-8000-000000000009";
        yield event;
      }
    } as typeof f.connector.execute;
    expect(await f.replies()).toEqual({ correspondence: "unavailable", people: [] });
  });
});

describe("first campaign email", () => {
  it("routes sending through activate_campaign's confirmation card", async () => {
    const { nativeInstantlyWrites } = await import("./instantly-native-writes.js");
    const activate = nativeInstantlyWrites.find((t) => t.name === "activate_campaign")!;
    expect(activate.description).toContain("confirmation card");
    for (const bot of RECRUITING_DEFAULT_BOTS.filter((b) => ["main", "outreach"].includes(b.key)))
      expect(bot.instructions).toContain(
        "call ensure_role_campaign, optionally get_campaign to show its name, id and lead count, then activate_campaign; its confirmation card is the one-time approval",
      );
  });
});
