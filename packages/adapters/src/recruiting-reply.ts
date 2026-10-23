import type {
  AdapterContext,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorRoute,
} from "@rakazo/adapter-kit";
import type { RecruitingCrmImportReceipt, RecruitingCrmTarget } from "@rakazo/contracts";
import { RecruitingCrmImportReceiptSchema, RecruitingCrmTargetSchema } from "@rakazo/contracts";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { z } from "zod";
import { catalogExecuteToolName, catalogIdForRoute } from "./approval-effect.js";
import type { InstantlyEmail, InstantlyReplyRequest } from "./instantly-reply.js";
import {
  classifyInstantlyReplyReceipt,
  instantReplyAnchorMatches,
  readInstantlyEmail,
  readInstantlyEmailPage,
  readInstantlyReplyRequest,
  sameInstantlyAddresses,
} from "./instantly-reply.js";
import { CATALOG_EXECUTE } from "./lazy-tool-catalog.js";
import { mcpObject } from "./recruiting-research.js";

const Time = z.iso.datetime({ offset: true });
const RoleInterest = z.strictObject({
  role_key: z.string(),
  client_label: z.string(),
  role_label: z.string(),
  interest: z.enum(["interested", "declined", "unknown"]),
  source: z.enum(["manual", "ai", "instantly"]).nullable(),
});
const CrmContext = z.strictObject({
  candidate: z.strictObject({
    id: z.uuid(),
    organization_id: z.uuid(),
    email: z.string().nullable(),
    linkedin_url: z.string().nullable(),
    // PostgreSQL supplies this identity; never reproduce its Unicode case folding in JS.
    linkedin_identity: z
      .string()
      .regex(/^\/in\/[^/]+$/)
      .nullable(),
    status: z.enum([
      "new",
      "sourced",
      "contacted",
      "replied",
      "interviewing",
      "offered",
      "hired",
      "passed",
      "do_not_contact",
    ]),
  }),
  pipeline: z
    .strictObject({
      candidate_id: z.uuid(),
      organization_id: z.uuid(),
      role_spec_id: z.uuid().nullable(),
      stage: z.string(),
      reviewed: z.boolean().nullable(),
      review_result: z.enum(["approved", "rejected", "pooled"]).nullable(),
      campaign_id: z.string().nullable(),
      last_reply_at: Time.nullable(),
      last_email_id: z.string().nullable(),
      updated_at: Time,
    })
    .nullable(),
  roleInterests: z.array(RoleInterest),
  canWrite: z.boolean(),
  suppressed: z.boolean().nullable(),
});
const Content = z.strictObject({
  subject: z.string(),
  body: z.strictObject({ text: z.string().optional(), html: z.string().optional() }),
  cc: z.string().optional(),
  bcc: z.string().optional(),
});
const Route = z.object({
  connectorId: z.literal("mcp"),
  resourceId: z.string().min(1),
  resourceRevision: z.number().int().positive(),
  toolName: z.string().min(1),
});
const ThreadHistory = z.strictObject({
  source: z.literal("local_native_instantly_rest"),
  anchor: z.unknown(),
  page: z.unknown(),
  query: z.record(z.string(), z.string()),
  coverage: z.strictObject({
    scope: z.literal("exact_thread"),
    anchorId: z.uuid(),
    organizationId: z.uuid(),
    account: z.string().min(1),
    threadId: z.string().min(1),
    startingAfter: z.string().min(1).nullable(),
    nextStartingAfter: z.string().min(1).nullable(),
    anchorPresent: z.boolean(),
    pageExhausted: z.boolean(),
    bodiesComplete: z.boolean(),
    returnedCount: z.number().int().nonnegative(),
    checkedAt: Time,
  }),
});
function completeBody(email: InstantlyEmail): boolean {
  return (
    email.body_fallback_reason == null &&
    (typeof email.body.text === "string" || typeof email.body.html === "string")
  );
}
type PinnedRoute = z.infer<typeof Route>;
export type RecruitingReplyContent = z.infer<typeof Content>;
export type RecruitingReplySelection = {
  target: RecruitingCrmTarget;
  receipt?: RecruitingCrmImportReceipt | null;
  candidateId?: string;
  membershipProof?: unknown;
  emailProof: unknown;
  crmProof: unknown;
};
export type PreparedRecruitingReply = {
  status: "ready";
  request: InstantlyReplyRequest;
  identity: {
    providerWorkspaceId: string;
    account: string;
    threadId: string;
    anchorId: string;
    crmCandidateId: string;
  };
};
type NotReady = { status: "blocked" | "incomplete"; reasons: string[] };
export type RecruitingReplyRead = Readonly<{
  route: Readonly<PinnedRoute>;
  args: Readonly<Record<string, unknown>>;
  result: unknown;
}>;
export type RecruitingReplyPreflight = {
  status: "blocked" | "incomplete" | "clear";
  scope: "crm_and_instantly";
  gaps: readonly string[];
  reasons: readonly string[];
  reads: readonly RecruitingReplyRead[];
  prepared?: PreparedRecruitingReply;
};

function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

function payload(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const envelope = raw as Record<string, unknown>;
  if ((envelope.isError !== undefined && envelope.isError !== false) || "error" in envelope)
    return undefined;
  return mcpObject(raw);
}

function targetAndReceipt(selection: RecruitingReplySelection) {
  const target = RecruitingCrmTargetSchema.safeParse(selection?.target);
  if (!target.success) return null;
  if (selection.receipt) {
    const receipt = RecruitingCrmImportReceiptSchema.safeParse(selection.receipt);
    return receipt.success &&
      target.data.organizationId === receipt.data.organization_id &&
      target.data.crmRoleId === receipt.data.role_spec_id
      ? { target: target.data, candidateId: receipt.data.candidate_id, receipt: receipt.data }
      : null;
  }
  const rows = payload(selection.membershipProof)?.data;
  const candidateId = selection.candidateId;
  if (
    !z.uuid().safeParse(candidateId).success ||
    !Array.isArray(rows) ||
    !rows.every(
      (row) =>
        row &&
        typeof row === "object" &&
        row.organization_id === target.data.organizationId &&
        row.candidate_id === candidateId &&
        z.uuid().safeParse(row.membership_id).success,
    ) ||
    !rows.some(
      (row) =>
        row.role_spec_id === target.data.crmRoleId && row.client_id === target.data.crmClientId,
    )
  )
    return null;
  return { target: target.data, candidateId: candidateId!, receipt: null };
}

// Same btrim/default semantics as the existing CRM crm_role_key SQL function.
function roleKey(target: RecruitingCrmTarget): string {
  const client = target.clientLabel.replace(/^ +| +$/g, "");
  const role = target.roleLabel.replace(/^ +| +$/g, "");
  return client && role ? `${role} (${client})` : role || client || "No role";
}

export function prepareRecruitingReply(
  selection: RecruitingReplySelection,
  content: RecruitingReplyContent,
): PreparedRecruitingReply | NotReady {
  const bound = targetAndReceipt(selection);
  const parsed = CrmContext.safeParse(payload(selection?.crmProof)?.data);
  if (!bound || !parsed.success) return { status: "incomplete", reasons: ["crm_context_invalid"] };
  const { target, receipt, candidateId } = bound;
  const crm = parsed.data;
  if (
    crm.candidate.id !== candidateId ||
    crm.candidate.organization_id !== target.organizationId ||
    (crm.pipeline &&
      (crm.pipeline.candidate_id !== candidateId ||
        crm.pipeline.organization_id !== target.organizationId))
  )
    return { status: "incomplete", reasons: ["crm_identity_mismatch"] };
  const interests = crm.roleInterests.filter((entry) => entry.role_key === roleKey(target));
  const block = !crm.canWrite
    ? "crm_permission_denied"
    : crm.suppressed === true
      ? "crm_suppressed"
      : ["passed", "do_not_contact"].includes(crm.candidate.status)
        ? "crm_candidate_blocked"
        : crm.pipeline &&
            (crm.pipeline.role_spec_id === null ||
              crm.pipeline.role_spec_id === target.crmRoleId) &&
            [
              "hold",
              "on hold",
              "pass",
              "passed",
              "declined",
              "not a fit",
              "do not contact",
              "do_not_contact",
            ].includes(crm.pipeline.stage.trim().toLowerCase())
          ? "crm_pipeline_blocked"
          : crm.pipeline?.review_result === "rejected" &&
              (crm.pipeline.role_spec_id === null || crm.pipeline.role_spec_id === target.crmRoleId)
            ? "crm_review_rejected"
            : interests.some((entry) => entry.interest === "declined")
              ? "crm_role_declined"
              : null;
  if (block) return { status: "blocked", reasons: [block] };
  if (
    receipt &&
    (crm.candidate.linkedin_identity !== receipt.linkedin_identity ||
      !crm.candidate.linkedin_identity)
  )
    return { status: "incomplete", reasons: ["crm_identity_mismatch"] };
  if (crm.suppressed !== false || !crm.candidate.email || /[\r\n\0]/.test(crm.candidate.email))
    return { status: "incomplete", reasons: ["crm_suppression_unknown"] };
  if (
    interests.length > 1 ||
    interests.some(
      (interest) =>
        interest.client_label !== target.clientLabel.replace(/^ +| +$/g, "") ||
        interest.role_label !== target.roleLabel.replace(/^ +| +$/g, ""),
    )
  )
    return { status: "incomplete", reasons: ["crm_role_interest_unknown"] };
  const anchor = readInstantlyEmail(payload(selection.emailProof));
  const message = Content.safeParse(content);
  if (!anchor || !message.success)
    return { status: "incomplete", reasons: ["native_email_invalid"] };
  if (!completeBody(anchor))
    return { status: "incomplete", reasons: ["provider_anchor_body_incomplete"] };
  const body = message.data.body;
  const request = readInstantlyReplyRequest({
    reply_to_uuid: anchor.id,
    eaccount: anchor.eaccount,
    to: crm.candidate.email.trim(),
    subject: message.data.subject,
    skip_validation: false,
    ...(body.text !== undefined ? { body_text: body.text } : {}),
    ...(body.html !== undefined ? { body_html: body.html } : {}),
    ...(message.data.cc !== undefined ? { cc_address_email_list: message.data.cc } : {}),
    ...(message.data.bcc !== undefined ? { bcc_address_email_list: message.data.bcc } : {}),
  });
  if (!request || !instantReplyAnchorMatches(request, anchor))
    return { status: "incomplete", reasons: ["recipient_mismatch"] };
  return immutable({
    status: "ready",
    request,
    identity: {
      providerWorkspaceId: anchor.organization_id,
      account: request.eaccount,
      threadId: anchor.thread_id!,
      anchorId: anchor.id,
      crmCandidateId: candidateId,
    },
  });
}

function historyFingerprint(email: InstantlyEmail) {
  return {
    facts: stableJsonValue({
      id: email.id,
      organizationId: email.organization_id,
      threadId: email.thread_id ?? null,
      createdAt: Date.parse(email.timestamp_created),
      messageId: email.message_id,
      direction: email.ue_type ?? null,
      subject: email.subject,
      body: email.body,
      bodyFallbackReason: email.body_fallback_reason ?? null,
    }),
    addresses: [
      email.eaccount,
      email.from_address_email,
      email.to_address_email_list,
      email.cc_address_email_list,
      email.bcc_address_email_list,
      email.reply_to,
    ],
  };
}

function sameHistoryFingerprint(
  left: ReturnType<typeof historyFingerprint>,
  right: ReturnType<typeof historyFingerprint>,
) {
  return (
    left.facts === right.facts &&
    left.addresses.every((address, index) =>
      sameInstantlyAddresses(address, right.addresses[index]),
    )
  );
}

function historyDecision(
  prepared: PreparedRecruitingReply,
  anchor: InstantlyEmail,
  email: InstantlyEmail,
): NotReady | null {
  const incomplete = (reason: string): NotReady => ({ status: "incomplete", reasons: [reason] });
  const blocked = (reason: string): NotReady => ({ status: "blocked", reasons: [reason] });
  if (
    email.organization_id !== anchor.organization_id ||
    !sameInstantlyAddresses(email.eaccount, anchor.eaccount)
  )
    return incomplete("provider_history_identity_mismatch");
  if (!email.thread_id) return incomplete("provider_history_thread_unknown");
  if (email.thread_id !== anchor.thread_id) return null;
  if (email.id === anchor.id)
    return instantReplyAnchorMatches(prepared.request, email)
      ? null
      : incomplete("provider_anchor_changed");
  const time = Date.parse(email.timestamp_created) - Date.parse(anchor.timestamp_created);
  if (email.ue_type === 2) {
    if (!instantReplyAnchorMatches({ ...prepared.request, reply_to_uuid: email.id }, email))
      return incomplete("provider_thread_participants_changed");
    return time > 0
      ? blocked("provider_newer_inbound")
      : time === 0
        ? incomplete("provider_history_order_unknown")
        : null;
  }
  if (
    ![1, 3, 4].includes(email.ue_type ?? 0) ||
    !sameInstantlyAddresses(email.from_address_email, prepared.request.eaccount) ||
    !sameInstantlyAddresses(email.to_address_email_list, prepared.request.to)
  )
    return incomplete("provider_thread_participants_changed");
  // API type 1 is a campaign send, so use the existing outbound comparison without
  // changing the retained raw record or claiming it was a manual reply.
  if (
    classifyInstantlyReplyReceipt(
      prepared.request,
      anchor,
      email.ue_type === 1 ? { ...email, ue_type: 3 } : email,
    ).status !== "unknown"
  )
    return blocked("provider_duplicate_message");
  if (email.ue_type === 4) return incomplete("provider_pending_outbound");
  return time > 0
    ? blocked("provider_anchor_already_answered")
    : time === 0
      ? incomplete("provider_history_order_unknown")
      : null;
}

export async function runRecruitingReplyPreflight(input: {
  connector: ConnectorProvider;
  context: AdapterContext;
  crmRoute: ConnectorRoute;
  mailRoute: ConnectorRoute;
  selection: RecruitingReplySelection;
  content: RecruitingReplyContent;
  maxPages?: number;
}): Promise<RecruitingReplyPreflight> {
  const reads: RecruitingReplyRead[] = [];
  const done = (
    status: RecruitingReplyPreflight["status"],
    reasons: readonly string[],
    prepared?: PreparedRecruitingReply,
  ): RecruitingReplyPreflight =>
    immutable({
      status,
      reasons,
      scope: "crm_and_instantly",
      gaps: [],
      reads,
      ...(prepared ? { prepared } : {}),
    });
  try {
    input.context.signal.throwIfAborted();
    const selection = immutable(structuredClone(input.selection));
    const content = immutable(structuredClone(input.content));
    const bound = targetAndReceipt(selection);
    const original = readInstantlyEmail(payload(selection.emailProof));
    const crmRoute = Route.safeParse(input.crmRoute);
    const mailRoute = Route.safeParse(input.mailRoute);
    const maxPages = input.maxPages ?? 20;
    if (
      !bound ||
      !original ||
      !crmRoute.success ||
      !mailRoute.success ||
      crmRoute.data.resourceId !== bound.target.mcpServerId ||
      crmRoute.data.resourceRevision !== bound.target.serverRevision ||
      crmRoute.data.toolName !== "get_crm_candidate_outreach_context" ||
      mailRoute.data.toolName !== "reply_to_email" ||
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1
    )
      return done("incomplete", ["preflight_identity_invalid"]);
    const read = async (
      base: PinnedRoute,
      operation: string,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      input.context.signal.throwIfAborted();
      if (!input.connector.resolveCall) throw new Error("read_unavailable");
      const route = { ...base, toolName: operation };
      const resolve = async (readArgs: Record<string, unknown>) => {
        const requestedArgs = stableJsonValue(readArgs);
        const resolved = await input.connector.resolveCall!(
          {
            tool: catalogExecuteToolName("mcp"),
            route: { connectorId: "mcp", toolName: CATALOG_EXECUTE },
            args: { id: catalogIdForRoute(route), arguments: readArgs },
            executionId: `${input.context.operationId}:reply-preflight:${reads.length}`,
          },
          input.context,
        );
        if (
          !resolved ||
          stableJsonValue(Route.safeParse(resolved.call.route).data) !== stableJsonValue(route) ||
          stableJsonValue(Route.safeParse(resolved.tool.route).data) !== stableJsonValue(route) ||
          stableJsonValue(resolved.call.args) !== requestedArgs
        )
          throw new Error("read_route_changed");
        return resolved;
      };
      const readArgs = args;
      const resolved = await resolve(readArgs);
      const events: ConnectorEvent[] = [];
      try {
        input.context.signal.throwIfAborted();
        for await (const event of input.connector.execute(resolved.call, input.context))
          events.push(event);
      } catch {
        events.push({ type: "error", message: "Connector read failed." });
      }
      const results = events.filter((event) => event.type === "result");
      const errors = events.some((event) => event.type === "error");
      const result = results.length === 1 && !errors ? results[0]!.data : { events };
      const record = immutable(structuredClone({ route, args: readArgs, result }));
      reads.push(record);
      input.context.signal.throwIfAborted();
      if (results.length !== 1 || errors || !payload(record.result)) throw new Error("read_failed");
      return record.result;
    };
    const crmProof = await read(crmRoute.data, "get_crm_candidate_outreach_context", {
      p_org: bound.target.organizationId,
      p_candidate: bound.candidateId,
    });
    const membershipProof = selection.receipt
      ? selection.membershipProof
      : await read(crmRoute.data, "list_crm_candidate_roles", {
          p_org: bound.target.organizationId,
          p_candidate: bound.candidateId,
        });
    const currentSelection = { ...selection, crmProof, membershipProof };
    const initial = prepareRecruitingReply(currentSelection, content);
    if (initial.status !== "ready") return done(initial.status, initial.reasons);
    const emailProof = await read(mailRoute.data, "get_email", { id: original.id });
    const anchor = readInstantlyEmail(payload(emailProof));
    const prepared = prepareRecruitingReply({ ...currentSelection, emailProof }, content);
    if (prepared.status !== "ready") return done(prepared.status, prepared.reasons);
    if (
      !anchor ||
      !sameHistoryFingerprint(historyFingerprint(original), historyFingerprint(anchor)) ||
      stableJsonValue(prepared.identity) !== stableJsonValue(initial.identity) ||
      stableJsonValue(prepared.request) !== stableJsonValue(initial.request)
    )
      return done("incomplete", ["provider_anchor_changed"]);
    const seenEmails = new Map([[anchor.id, historyFingerprint(anchor)]]);
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let anchorSeen = false;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      const raw = await read(mailRoute.data, "native_instantly_get_thread_history", {
        anchor_id: original.id,
        limit: 100,
        ...(cursor ? { starting_after: cursor } : {}),
      });
      const history = ThreadHistory.safeParse(payload(raw));
      const page = history.success ? readInstantlyEmailPage(history.data.page) : null;
      if (!history.success || !page) return done("incomplete", ["provider_history_invalid"]);
      const currentAnchor = readInstantlyEmail(payload(history.data.anchor));
      if (
        !currentAnchor ||
        !completeBody(currentAnchor) ||
        !sameHistoryFingerprint(historyFingerprint(anchor), historyFingerprint(currentAnchor))
      )
        return done("incomplete", ["provider_anchor_changed"]);
      const { coverage, query } = history.data;
      const expectedQuery = {
        search: `thread:${prepared.identity.threadId}`,
        eaccount: prepared.identity.account,
        mode: "emode_all",
        latest_of_thread: "false",
        preview_only: "false",
        limit: "100",
        ...(cursor ? { starting_after: cursor } : {}),
      };
      if (
        stableJsonValue(query) !== stableJsonValue(expectedQuery) ||
        coverage.anchorId !== anchor.id ||
        coverage.organizationId !== anchor.organization_id ||
        !sameInstantlyAddresses(coverage.account, anchor.eaccount) ||
        coverage.threadId !== anchor.thread_id ||
        coverage.startingAfter !== (cursor ?? null) ||
        coverage.nextStartingAfter !== (page.next_starting_after ?? null) ||
        coverage.returnedCount !== page.items.length ||
        coverage.pageExhausted !== !page.next_starting_after ||
        coverage.anchorPresent !== page.items.some((email) => email.id === anchor.id) ||
        coverage.bodiesComplete !== page.items.every(completeBody) ||
        page.items.some(
          (email) =>
            email.organization_id !== anchor.organization_id ||
            email.thread_id !== anchor.thread_id ||
            !sameInstantlyAddresses(email.eaccount, anchor.eaccount),
        )
      )
        return done("incomplete", ["provider_history_scope_mismatch"]);
      for (const listed of page.items) {
        let email = listed;
        if (!completeBody(listed)) {
          const full = readInstantlyEmail(
            payload(await read(mailRoute.data, "get_email", { id: listed.id })),
          );
          if (!full || !completeBody(full))
            return done("incomplete", ["provider_history_body_incomplete"]);
          if (
            !sameHistoryFingerprint(
              historyFingerprint({
                ...listed,
                body: full.body,
                body_fallback_reason: full.body_fallback_reason,
              }),
              historyFingerprint(full),
            )
          )
            return done("incomplete", ["provider_history_conflict"]);
          email = full;
        }
        const fingerprint = historyFingerprint(email);
        const previous = seenEmails.get(email.id);
        if (previous && !sameHistoryFingerprint(previous, fingerprint))
          return done("incomplete", ["provider_history_conflict"]);
        seenEmails.set(email.id, fingerprint);
        const decision = historyDecision(prepared, anchor, email);
        if (decision) return done(decision.status, decision.reasons);
        if (email.id === anchor.id) anchorSeen = true;
      }
      if (!page.next_starting_after)
        return anchorSeen
          ? done("clear", [], prepared)
          : done("incomplete", ["provider_anchor_not_listed"]);
      if (cursors.has(page.next_starting_after))
        return done("incomplete", ["history_cursor_repeated"]);
      cursors.add(page.next_starting_after);
      cursor = page.next_starting_after;
    }
    return done("incomplete", ["history_page_limit"]);
  } catch {
    return done("incomplete", [input.context.signal.aborted ? "read_aborted" : "read_failed"]);
  }
}
