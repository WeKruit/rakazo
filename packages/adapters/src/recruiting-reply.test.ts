import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { prepareRecruitingReply, runRecruitingReplyPreflight } from "./recruiting-reply.js";

const candidateId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const roleId = "33333333-3333-4333-8333-333333333333";
const anchorId = "44444444-4444-4444-8444-444444444444";
const threadId = "55555555-5555-4555-8555-555555555555";
const workspaceId = "66666666-6666-4666-8666-666666666666";
const otherId = "77777777-7777-4777-8777-777777777777";
const target = {
  mcpServerId: "crm",
  serverRevision: 2,
  organizationId: orgId,
  crmRoleId: roleId,
  crmClientId: otherId,
  clientLabel: "Example",
  roleLabel: "Engineer",
};
const receipt = {
  candidate_id: candidateId,
  source_id: otherId,
  membership_id: otherId,
  organization_id: orgId,
  role_spec_id: roleId,
  linkedin_identity: "/in/synthetic-person",
  source_file: "artifact:synthetic-source#row=1",
};
const anchor = {
  id: anchorId,
  timestamp_created: "2026-10-16T12:00:00.000Z",
  timestamp_email: "2026-10-16T11:59:00.000Z",
  message_id: "<anchor@example.com>",
  subject: "A synthetic role",
  from_address_email: "candidate@example.com",
  to_address_email_list: "recruiter@example.com",
  body: { text: "Please send details." },
  organization_id: workspaceId,
  eaccount: "recruiter@example.com",
  ue_type: 2,
  thread_id: threadId,
};
const crm = {
  candidate: {
    id: candidateId,
    organization_id: orgId,
    email: "candidate@example.com",
    linkedin_url: "https://www.linkedin.com/in/Synthetic-Person",
    linkedin_identity: receipt.linkedin_identity,
    status: "sourced",
  },
  pipeline: {
    candidate_id: candidateId,
    organization_id: orgId,
    role_spec_id: roleId,
    stage: "Interested",
    reviewed: true,
    review_result: "approved",
    campaign_id: null,
    last_reply_at: null,
    last_email_id: null,
    updated_at: "2026-10-16T12:00:00.000Z",
  },
  roleInterests: [
    {
      role_key: "Engineer (Example)",
      client_label: "Example",
      role_label: "Engineer",
      interest: "interested",
      source: "manual",
    },
  ],
  canWrite: true,
  suppressed: false,
};
const envelope = <T>(data: T) => ({ structuredContent: data });
const crmEnvelope = (data: unknown) => envelope({ data });
const selection = { target, receipt, emailProof: envelope(anchor), crmProof: crmEnvelope(crm) };
const content = { subject: "Re: A synthetic role", body: { text: "Here are the details. " } };
const crmRoute = {
  connectorId: "mcp",
  resourceId: "crm",
  resourceRevision: 2,
  toolName: "get_crm_candidate_outreach_context",
};
const mailRoute = {
  connectorId: "mcp",
  resourceId: "mail",
  resourceRevision: 3,
  toolName: "reply_to_email",
};
const context: AdapterContext = {
  operationId: "preflight",
  traceId: "trace",
  spaceId: "space",
  userId: "actor",
  botId: "bot",
  runId: "run",
  signal: new AbortController().signal,
};

function historyEnvelope(
  page: { items?: (typeof anchor)[]; next_starting_after?: string },
  args: Record<string, unknown>,
) {
  const items = page.items ?? [];
  return envelope({
    source: "local_native_instantly_rest",
    anchor: envelope(anchor),
    page,
    query: {
      search: `thread:${threadId}`,
      eaccount: anchor.eaccount,
      mode: "emode_all",
      latest_of_thread: "false",
      preview_only: "false",
      limit: String(args.limit),
      ...(args.starting_after ? { starting_after: args.starting_after } : {}),
    },
    coverage: {
      scope: "exact_thread",
      anchorId,
      organizationId: workspaceId,
      account: anchor.eaccount,
      threadId,
      startingAfter: args.starting_after ?? null,
      nextStartingAfter: page.next_starting_after ?? null,
      anchorPresent: items.some((email) => email.id === anchorId),
      pageExhausted: !page.next_starting_after,
      bodiesComplete: items.every(
        (email) =>
          !(email as typeof anchor & { body_fallback_reason?: string }).body_fallback_reason &&
          (typeof email.body?.text === "string" ||
            typeof (email.body as { html?: string })?.html === "string"),
      ),
      returnedCount: items.length,
      checkedAt: "2026-10-22T20:00:00Z",
    },
  });
}

function fixture(pages: unknown[] = [{ items: [anchor] }]) {
  const outputs: unknown[] = [crmEnvelope(crm), envelope(anchor), ...pages.map(envelope)];
  const resolveCall = vi.fn(async (call) => {
    const [server, operation] = call.args.id.split(":");
    const route = {
      connectorId: "mcp",
      resourceId: server,
      resourceRevision: server === "crm" ? 2 : 3,
      toolName: decodeURIComponent(operation),
    };
    return {
      call: {
        tool: `mcp__${server}__${operation}`,
        route,
        args: call.args.arguments,
        executionId: call.executionId,
      },
      tool: {
        name: `mcp__${server}__${operation}`,
        description: "Synthetic read",
        inputSchema: {
          type: "object",
          properties:
            operation === "list_emails"
              ? {
                  mode: { type: "string", enum: ["emode_all"] },
                  latest_of_thread: { type: "boolean" },
                  preview_only: { type: "boolean" },
                }
              : {},
        },
        readOnly: true,
        route,
      },
    };
  });
  const execute = vi.fn(async function* (call: ConnectorCall): AsyncGenerator<ConnectorEvent> {
    const raw = outputs.shift() as { structuredContent?: Record<string, unknown> } | undefined;
    yield {
      type: "result" as const,
      data:
        call.route?.toolName === "native_instantly_get_thread_history" &&
        raw?.structuredContent &&
        raw.structuredContent.source !== "local_native_instantly_rest"
          ? historyEnvelope(raw.structuredContent, call.args)
          : raw,
    };
  });
  const connector = { resolveCall, execute } as unknown as ConnectorProvider;
  const run = (extra: Record<string, unknown> = {}) =>
    runRecruitingReplyPreflight({
      connector,
      context,
      crmRoute,
      mailRoute,
      selection,
      content,
      ...extra,
    });
  return { outputs, resolveCall, execute, run };
}

describe("recruiting reply draft translation", () => {
  it("derives provider account and recipient from owned CRM and inbound evidence", () => {
    expect(prepareRecruitingReply(selection, content)).toMatchObject({
      status: "ready",
      request: {
        reply_to_uuid: anchorId,
        eaccount: anchor.eaccount,
        to: crm.candidate.email,
        subject: content.subject,
        body_text: content.body.text,
        skip_validation: false,
      },
      identity: {
        providerWorkspaceId: workspaceId,
        account: anchor.eaccount,
        threadId,
        anchorId,
        crmCandidateId: candidateId,
      },
    });
  });

  it("preserves HTML and explicit recipient lists in the native request", () => {
    const result = prepareRecruitingReply(selection, {
      subject: content.subject,
      body: { html: "<p>Exact HTML.</p>" },
      cc: "Second <second@example.com>",
      bcc: "audit@example.com",
    });
    expect(result).toMatchObject({
      status: "ready",
      request: {
        body_html: "<p>Exact HTML.</p>",
        cc_address_email_list: "Second <second@example.com>",
        bcc_address_email_list: "audit@example.com",
      },
    });
    if (result.status === "ready") expect(result.request).not.toHaveProperty("body_text");
  });

  it("uses the existing SQL role key whitespace semantics without fuzzy matching", () => {
    expect(
      prepareRecruitingReply(
        { ...selection, target: { ...target, clientLabel: " Example ", roleLabel: " Engineer " } },
        content,
      ).status,
    ).toBe("ready");
  });

  it.each([
    { ...crm, suppressed: true },
    { ...crm, canWrite: false },
    { ...crm, candidate: { ...crm.candidate, status: "passed" } },
    { ...crm, candidate: { ...crm.candidate, status: "do_not_contact" } },
    { ...crm, pipeline: { ...crm.pipeline, stage: "Hold" } },
    { ...crm, pipeline: { ...crm.pipeline, stage: "On hold" } },
    { ...crm, pipeline: { ...crm.pipeline, stage: "Passed" } },
    { ...crm, pipeline: { ...crm.pipeline, review_result: "rejected" } },
    { ...crm, roleInterests: [{ ...crm.roleInterests[0], interest: "declined" }] },
    {
      ...crm,
      pipeline: { ...crm.pipeline, role_spec_id: otherId, stage: "Hold" },
      candidate: { ...crm.candidate, status: "passed" },
    },
    {
      ...crm,
      pipeline: { ...crm.pipeline, role_spec_id: otherId, stage: "Hold" },
      candidate: { ...crm.candidate, status: "do_not_contact" },
    },
    {
      ...crm,
      pipeline: { ...crm.pipeline, role_spec_id: otherId, stage: "Hold" },
      suppressed: true,
    },
    {
      ...crm,
      pipeline: { ...crm.pipeline, role_spec_id: otherId, stage: "Hold" },
      roleInterests: [{ ...crm.roleInterests[0], interest: "declined" }],
    },
  ])("stops on a definite CRM blocker %j", async (state) => {
    expect(
      prepareRecruitingReply({ ...selection, crmProof: crmEnvelope(state) }, content).status,
    ).toBe("blocked");
    const f = fixture();
    f.outputs[0] = crmEnvelope(state);
    expect((await f.run()).status).toBe("blocked");
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("retains definite suppression before unresolved role or stage details", () => {
    const state = {
      ...crm,
      suppressed: true,
      pipeline: { ...crm.pipeline, stage: "Legacy unknown" },
    };
    expect(
      prepareRecruitingReply({ ...selection, crmProof: crmEnvelope(state) }, content).status,
    ).toBe("blocked");
  });

  it.each([
    { ...crm, candidate: { ...crm.candidate, id: otherId } },
    { ...crm, candidate: { ...crm.candidate, organization_id: otherId } },
    { ...crm, candidate: { ...crm.candidate, linkedin_identity: undefined } },
    { ...crm, candidate: { ...crm.candidate, linkedin_identity: "/in/another-person" } },
    { ...crm, candidate: { ...crm.candidate, email: null } },
    { ...crm, candidate: { ...crm.candidate, email: "someone-else@example.com" } },
    { ...crm, suppressed: null },
    { ...crm, pipeline: { ...crm.pipeline, candidate_id: otherId } },
  ])("does not turn missing or mismatched identity into ready %j", (state) => {
    expect(
      prepareRecruitingReply({ ...selection, crmProof: crmEnvelope(state) }, content).status,
    ).toBe("incomplete");
  });

  it.each([null, { ...crm.pipeline, stage: "Unknown stage" }])(
    "does not require a positive pipeline stage to reply when no hold is recorded: %j",
    (pipeline) => {
      expect(
        prepareRecruitingReply(
          { ...selection, crmProof: crmEnvelope({ ...crm, pipeline }) },
          content,
        ).status,
      ).toBe("ready");
    },
  );

  it("scopes a pipeline review rejection to its recorded role", () => {
    const pipeline = { ...crm.pipeline, review_result: "rejected", role_spec_id: otherId };
    expect(
      prepareRecruitingReply({ ...selection, crmProof: crmEnvelope({ ...crm, pipeline }) }, content)
        .status,
    ).toBe("ready");
    expect(
      prepareRecruitingReply(
        {
          ...selection,
          crmProof: crmEnvelope({ ...crm, pipeline: { ...pipeline, role_spec_id: roleId } }),
        },
        content,
      ),
    ).toMatchObject({ status: "blocked", reasons: ["crm_review_rejected"] });
  });

  it("preflights a canonical CRM member without an Autumn import or an unrelated mailbox", async () => {
    const membership = {
      membership_id: otherId,
      organization_id: orgId,
      candidate_id: candidateId,
      role_spec_id: roleId,
      client_id: target.crmClientId,
    };
    const membershipProof = crmEnvelope([membership]);
    const native = {
      target,
      candidateId,
      membershipProof,
      emailProof: selection.emailProof,
      crmProof: crmEnvelope({ ...crm, pipeline: null }),
    };
    expect(prepareRecruitingReply(native, content).status).toBe("ready");
    const f = fixture();
    f.outputs[0] = native.crmProof;
    f.outputs.splice(1, 0, membershipProof);
    expect(await f.run({ selection: native })).toMatchObject({ status: "clear", gaps: [] });
    expect(f.execute).toHaveBeenCalledTimes(4);
    const wrong = crmEnvelope([{ ...membership, role_spec_id: otherId }]);
    expect(prepareRecruitingReply({ ...native, membershipProof: wrong }, content).status).toBe(
      "incomplete",
    );
  });

  it.each(["new", "contacted", "replied"])(
    "does not invent a positive-interest gate for candidate status %s",
    (status) => {
      const state = { ...crm, candidate: { ...crm.candidate, status }, roleInterests: [] };
      expect(
        prepareRecruitingReply({ ...selection, crmProof: crmEnvelope(state) }, content).status,
      ).toBe("ready");
    },
  );

  it.each([
    [otherId, "Interested", "ready"],
    [otherId, "Hold", "ready"],
    [otherId, "Passed", "ready"],
    [otherId, "Unknown stage", "ready"],
    [null, "Interested", "ready"],
    [null, "On hold", "blocked"],
    [null, "Passed", "blocked"],
    [null, "Unknown stage", "ready"],
  ] as const)(
    "preserves unknown interest with primary pipeline role %s and stage %s",
    async (role_spec_id, stage, status) => {
      const state = {
        ...crm,
        pipeline: { ...crm.pipeline, role_spec_id, stage },
        roleInterests: [{ ...crm.roleInterests[0], interest: "unknown" }],
      };
      expect(
        prepareRecruitingReply({ ...selection, crmProof: crmEnvelope(state) }, content).status,
      ).toBe(status);
      const f = fixture();
      f.outputs[0] = crmEnvelope(state);
      expect(await f.run()).toMatchObject({
        status: status === "ready" ? "clear" : status,
        gaps: [],
      });
    },
  );

  it.each([
    { ...selection, crmProof: { isError: true, structuredContent: { data: crm } } },
    { ...selection, crmProof: envelope(crm) },
    { ...selection, emailProof: envelope({ ...anchor, ue_type: 3 }) },
    { ...selection, emailProof: { isError: true, structuredContent: anchor } },
    { ...selection, receipt: { ...receipt, role_spec_id: otherId } },
  ])("requires actual canonical proof envelopes and matching target receipts %j", (input) => {
    expect(prepareRecruitingReply(input, content).status).toBe("incomplete");
  });
});

describe("fresh CRM and Instantly reply preflight", () => {
  it("does current fixed reads and exposes limited coverage rather than full G4", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({
      status: "clear",
      scope: "crm_and_instantly",
      reasons: [],
      gaps: [],
    });
    expect(f.resolveCall.mock.calls.map(([call]) => [call.args.id, call.args.arguments])).toEqual([
      ["crm:get_crm_candidate_outreach_context", { p_org: orgId, p_candidate: candidateId }],
      ["mail:get_email", { id: anchorId }],
      ["mail:native_instantly_get_thread_history", { anchor_id: anchorId, limit: 100 }],
    ]);
    expect(result.reads).toHaveLength(3);
    expect(Object.isFrozen(result.reads)).toBe(true);
    expect(Object.isFrozen(result.reads[0]?.result)).toBe(true);
  });

  it("accepts a history page that reports the replied campaign's stop_on_reply", async () => {
    const page = historyEnvelope({ items: [anchor] }, { limit: 100 }) as {
      structuredContent: Record<string, unknown>;
    };
    page.structuredContent.replyFollowUps = [
      { campaignId: "campaign", stopOnReply: false, warning: "stop_on_reply is off" },
    ];
    expect(await fixture([page.structuredContent]).run()).toMatchObject({
      status: "clear",
      reasons: [],
    });
  });

  it("walks the exact cursor through an empty tail without unread or campaign filters", async () => {
    const f = fixture([{ items: [anchor], next_starting_after: "next" }, { items: [] }]);
    const result = await f.run();
    expect(result.status).toBe("clear");
    expect(f.resolveCall.mock.calls.at(-1)?.[0].args.arguments).toEqual({
      anchor_id: anchorId,
      limit: 100,
      starting_after: "next",
    });
  });

  it("follows an empty page with a cursor and observes a later blocking reply", async () => {
    const newer = {
      ...anchor,
      id: otherId,
      timestamp_created: "2026-10-16T13:00:00.000Z",
    };
    const f = fixture([
      { items: [anchor], next_starting_after: "empty" },
      { items: [], next_starting_after: "later" },
      { items: [newer] },
    ]);
    expect(await f.run()).toMatchObject({
      status: "blocked",
      reasons: ["provider_newer_inbound"],
    });
    expect(f.resolveCall.mock.calls.at(-1)?.[0].args.arguments).toEqual({
      anchor_id: anchorId,
      limit: 100,
      starting_after: "later",
    });
  });

  it("does not clear conflicting timestamps for a repeated historical email ID", async () => {
    const earlier = { ...anchor, id: otherId, timestamp_created: "2026-10-16T10:00:00.000Z" };
    const f = fixture([
      { items: [anchor, earlier], next_starting_after: "next" },
      { items: [{ ...earlier, timestamp_created: "2026-10-16T11:00:00.000Z" }] },
    ]);
    expect(await f.run()).toMatchObject({
      status: "incomplete",
      reasons: ["provider_history_conflict"],
    });
  });

  it.each([
    { timestamp_created: "2026-10-16T11:00:00.000Z" },
    { body: { text: "Changed saved anchor body." } },
    { subject: "Changed saved anchor subject" },
    { thread_id: otherId },
  ])("requires the listed anchor to match the fresh get_email source %j", async (change) => {
    expect(await fixture([{ items: [{ ...anchor, ...change }] }]).run()).toMatchObject({
      status: "incomplete",
      reasons: [
        "thread_id" in change ? "provider_history_scope_mismatch" : "provider_history_conflict",
      ],
    });
  });

  it("does not move the original anchor ordering boundary when get_email changes its timestamp", async () => {
    const changedAnchor = { ...anchor, timestamp_created: "2026-10-16T14:00:00.000Z" };
    const newerReply = { ...anchor, id: otherId, timestamp_created: "2026-10-16T13:00:00.000Z" };
    const f = fixture([{ items: [changedAnchor, newerReply] }]);
    f.outputs[1] = envelope(changedAnchor);
    expect(await f.run()).toMatchObject({
      status: "incomplete",
      reasons: ["provider_anchor_changed"],
    });
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it("allows consistent page overlap and mutable read or preview fields", async () => {
    const f = fixture([
      { items: [anchor], next_starting_after: "next" },
      { items: [{ ...anchor, is_unread: 0, content_preview: "Updated preview" }] },
    ]);
    expect((await f.run()).status).toBe("clear");
  });

  it("pins content before an asynchronous read can mutate the original draft", async () => {
    const mutableContent = structuredClone(content);
    const f = fixture();
    f.execute.mockImplementationOnce(async function* () {
      yield { type: "result", data: f.outputs.shift() };
    });
    f.execute.mockImplementationOnce(async function* () {
      mutableContent.body.text = "Changed during source read.";
      yield { type: "result", data: f.outputs.shift() };
    });
    const result = await f.run({ content: mutableContent });
    expect(result).toMatchObject({
      status: "clear",
      prepared: { request: { body_text: content.body.text } },
    });
  });

  it("pins target and receipt evidence before reads mutate external selection references", async () => {
    const mutableSelection = structuredClone(selection);
    const f = fixture();
    f.execute.mockImplementationOnce(async function* () {
      mutableSelection.target.clientLabel = "Changed after the original selection";
      mutableSelection.receipt.linkedin_identity = "/in/changed-person";
      yield { type: "result", data: f.outputs.shift() };
    });
    expect((await f.run({ selection: mutableSelection })).status).toBe("clear");
  });

  it("uses fresh CRM instead of a retained clean result and stops before mail reads", async () => {
    const f = fixture();
    f.outputs[0] = crmEnvelope({ ...crm, suppressed: true });
    expect((await f.run()).status).toBe("blocked");
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("blocks a new incoming reply after the anchor even when read", async () => {
    const newer = {
      ...anchor,
      id: otherId,
      timestamp_created: "2026-10-16T13:00:00.000Z",
      is_unread: 0,
    };
    const f = fixture([{ items: [newer, anchor], next_starting_after: "unused" }]);
    expect(await f.run()).toMatchObject({ status: "blocked", reasons: ["provider_newer_inbound"] });
    expect(f.execute).toHaveBeenCalledTimes(3);
  });

  it.each([1, 3, 4])(
    "blocks already sent or queued exact content, direction %s",
    async (ue_type) => {
      const sent = {
        ...anchor,
        id: otherId,
        ue_type,
        from_address_email: anchor.eaccount,
        to_address_email_list: crm.candidate.email,
        subject: content.subject,
        body: { text: content.body.text },
      };
      expect(await fixture([{ items: [anchor, sent] }]).run()).toMatchObject({
        status: "blocked",
        reasons: ["provider_duplicate_message"],
      });
    },
  );

  it("blocks an independently answered anchor even when the content differs", async () => {
    const sent = {
      ...anchor,
      id: otherId,
      ue_type: 3,
      timestamp_created: "2026-10-16T13:00:00.000Z",
      from_address_email: anchor.eaccount,
      to_address_email_list: crm.candidate.email,
      body: { text: "A different answer." },
    };
    expect(await fixture([{ items: [anchor, sent] }]).run()).toMatchObject({
      status: "blocked",
      reasons: ["provider_anchor_already_answered"],
    });
  });

  it.each(
    [
      [{ items: [] }],
      [{ items: [{ ...anchor, organization_id: otherId }] }],
      [{ items: [{ ...anchor, eaccount: "other@example.com" }] }],
      [{ items: [{ ...anchor, id: otherId, ue_type: null }] }],
      [{ items: [{ ...anchor, id: otherId }] }],
      [
        { items: [anchor], next_starting_after: "same" },
        { items: [anchor], next_starting_after: "same" },
      ],
    ].map((pages) => ({ pages })),
  )("keeps incomplete history incomplete %j", async ({ pages }) => {
    expect((await fixture(pages).run()).status).toBe("incomplete");
  });

  it("does not call a resource or operation changed by catalog resolution", async () => {
    const f = fixture();
    f.resolveCall.mockImplementationOnce(async (call) => ({
      call: { ...call, route: { ...crmRoute, resourceId: "other" } },
      tool: {
        name: "other",
        description: "",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
        route: crmRoute,
      },
    }));
    expect((await f.run()).status).toBe("incomplete");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("does not accept changed arguments or a provider result with conflicting envelopes", async () => {
    const f = fixture();
    const originalResolve = f.resolveCall.getMockImplementation()!;
    f.resolveCall.mockImplementationOnce(async (call) => {
      const resolved = await originalResolve(call);
      return {
        ...resolved,
        call: { ...resolved.call, args: { p_org: otherId, p_candidate: candidateId } },
      };
    });
    expect((await f.run()).status).toBe("incomplete");
    expect(f.execute).not.toHaveBeenCalled();
    const g = fixture();
    g.outputs[0] = { ...crmEnvelope(crm), content: [{ type: "text", text: '{"data":null}' }] };
    expect((await g.run()).status).toBe("incomplete");
  });

  it("pins requested read arguments before a resolver can mutate the input object", async () => {
    const f = fixture();
    const originalResolve = f.resolveCall.getMockImplementation()!;
    f.resolveCall.mockImplementationOnce(async (call) => {
      call.args.arguments.p_org = otherId;
      return originalResolve(call);
    });
    expect((await f.run()).status).toBe("incomplete");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("bounds pagination without turning the cap into a clear result", async () => {
    const f = fixture([{ items: [anchor], next_starting_after: "more" }]);
    expect(await f.run({ maxPages: 1 })).toMatchObject({
      status: "incomplete",
      reasons: ["history_page_limit"],
    });
  });

  it("retains read errors and never sends, retries a write or hides a rate limit", async () => {
    const f = fixture();
    f.execute.mockImplementationOnce(async function* () {
      yield { type: "error", message: "429 rate limited" } as never;
    });
    const result = await f.run();
    expect(result.status).toBe("incomplete");
    expect(result.reads).toHaveLength(1);
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("does not begin reads after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fixture();
    expect((await f.run({ context: { ...context, signal: controller.signal } })).status).toBe(
      "incomplete",
    );
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("does not substitute the remote list tool when the pinned local history tool is unavailable", async () => {
    const f = fixture();
    const originalResolve = f.resolveCall.getMockImplementation()!;
    f.resolveCall.mockImplementation(async (call) => {
      const resolved = await originalResolve(call);
      return resolved.call.route?.toolName === "native_instantly_get_thread_history"
        ? {
            ...resolved,
            call: { ...resolved.call, route: { ...resolved.call.route, toolName: "list_emails" } },
          }
        : resolved;
    });
    expect(await f.run()).toMatchObject({ status: "incomplete", reasons: ["read_failed"] });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.resolveCall.mock.calls.at(-1)?.[0].args.arguments).toEqual({
      anchor_id: anchorId,
      limit: 100,
    });
  });

  it.each([
    "query",
    "thread",
    "organization",
    "account",
    "count",
    "cursor",
    "exhausted",
    "anchor",
    "bodyCoverage",
  ])("rejects a local history %s coverage mismatch", async (boundary) => {
    const f = fixture();
    const result = historyEnvelope({ items: [anchor] }, { limit: 100 });
    const row = result.structuredContent;
    if (boundary === "query") row.query.mode = "emode_focused";
    if (boundary === "thread") row.coverage.threadId = "other-thread";
    if (boundary === "organization") row.coverage.organizationId = otherId;
    if (boundary === "account") row.coverage.account = "other@example.com";
    if (boundary === "count") row.coverage.returnedCount += 1;
    if (boundary === "cursor") row.coverage.startingAfter = "wrong";
    if (boundary === "exhausted") row.coverage.pageExhausted = false;
    if (boundary === "anchor") row.coverage.anchorPresent = false;
    if (boundary === "bodyCoverage") row.coverage.bodiesComplete = false;
    f.outputs[2] = result;
    expect(await f.run()).toMatchObject({
      status: "incomplete",
      reasons: ["provider_history_scope_mismatch"],
    });
  });

  it("does not accept a changed native anchor inside a history page", async () => {
    const f = fixture();
    const result = historyEnvelope({ items: [anchor] }, { limit: 100 });
    result.structuredContent.anchor = envelope({
      ...anchor,
      body: { text: "Changed after the source read" },
    });
    f.outputs[2] = result;
    expect(await f.run()).toMatchObject({
      status: "incomplete",
      reasons: ["provider_anchor_changed"],
    });
  });

  it.each(["too_large", "unavailable", "missing"])(
    "reads a full body for %s history excerpts without changing the retained raw page",
    async (reason) => {
      const partial = {
        ...anchor,
        body: reason === "missing" ? {} : { text: "Excerpt" },
        ...(reason === "missing" ? {} : { body_fallback_reason: reason }),
      };
      const f = fixture([{ items: [partial] }]);
      f.outputs.push(envelope(anchor));
      const result = await f.run();
      expect(result.status).toBe("clear");
      expect(f.execute).toHaveBeenCalledTimes(4);
      expect(f.resolveCall.mock.calls.at(-1)?.[0].args.arguments).toEqual({ id: anchorId });
      expect(result.reads[2]?.result).toMatchObject({
        structuredContent: { page: { items: [partial] }, coverage: { bodiesComplete: false } },
      });
      expect(result.reads[3]?.result).toEqual(envelope(anchor));
    },
  );

  it("does not present a reply as source-complete when its retained anchor is only an excerpt", async () => {
    const emailProof = envelope({ ...anchor, body_fallback_reason: "too_large" });
    expect(prepareRecruitingReply({ ...selection, emailProof }, content)).toMatchObject({
      status: "incomplete",
      reasons: ["provider_anchor_body_incomplete"],
    });
    const f = fixture();
    expect(await f.run({ selection: { ...selection, emailProof } })).toMatchObject({
      status: "incomplete",
      reasons: ["provider_anchor_body_incomplete"],
    });
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it.each([
    { id: otherId },
    { organization_id: otherId },
    { thread_id: "other-thread" },
    { subject: "Changed" },
  ])("does not attach a full body to different source metadata %j", async (change) => {
    const partial = { ...anchor, body_fallback_reason: "too_large" };
    const f = fixture([{ items: [partial] }]);
    f.outputs.push(envelope({ ...anchor, ...change }));
    expect(await f.run()).toMatchObject({
      status: "incomplete",
      reasons: ["provider_history_conflict"],
    });
  });

  it("keeps an unavailable full body incomplete and never treats an excerpt as an exact duplicate receipt", async () => {
    const partial = { ...anchor, body_fallback_reason: "unavailable" };
    const f = fixture([{ items: [partial] }]);
    f.outputs.push(envelope(partial));
    expect(await f.run()).toMatchObject({
      status: "incomplete",
      reasons: ["provider_history_body_incomplete"],
    });
  });
});
