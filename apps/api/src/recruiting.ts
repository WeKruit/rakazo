import { isDeepStrictEqual } from "node:util";
import { ORPCError } from "@orpc/server";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import {
  createRecruitingCandidateReportReader,
  hasPlatformMcpCredential,
  isRecruitingCandidateReportField,
  readActorArtifact,
  readInstantlyEmail,
} from "@rakazo/adapters";
import type {
  Actor,
  ReadRecruitingSourceInput,
  RecruitingAssessmentSourceRef,
  RecruitingCandidateSource,
  RecruitingCorrespondence,
  RecruitingSourceRef,
  RecruitingSourceSelection,
} from "@rakazo/contracts";
import { RecruitingCorrespondenceSchema } from "@rakazo/contracts";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  RecruitingPlaybookValidationError,
  readRecruitingJsonString,
  recruitingCalibrationIdentity,
  validateRecruitingTextSelection,
} from "@rakazo/core";
import { mcpObject, stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { extractPdfText } from "@rakazo/core/node/pdf-text";
import type { PrismaClient, RecruitingRoleMaterialContext } from "@rakazo/db";
import * as recruiting from "@rakazo/db";
import {
  IsolationError,
  RecruitingConflictError,
  RecruitingSourceValidationError,
} from "@rakazo/db";
import type { ParseError } from "jsonc-parser";
import { findNodeAtLocation, parseTree } from "jsonc-parser";
import type { ThreadTarget } from "./thread-target.js";

async function authenticated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IsolationError)
      throw new ORPCError("NOT_FOUND", { message: "Resource not found" });
    if (error instanceof RecruitingConflictError)
      throw new ORPCError("CONFLICT", { message: error.message });
    if (error instanceof RecruitingPlaybookValidationError)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    if (error instanceof RecruitingSourceValidationError)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
    if (error instanceof Error && error.name === "ZodError")
      throw new ORPCError("BAD_REQUEST", { message: "Invalid recruiting input" });
    throw error;
  }
}

type RecruitingReadDeps = { prisma: PrismaClient; artifacts: ArtifactStore };

function correspondenceProvider(endpoint: string | null, view: "inbox" | "interview" | "contacts") {
  if (!endpoint) return null;
  let address: string;
  try {
    const url = new URL(endpoint);
    address = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
  if (view === "inbox") {
    if (address === "https://mcp.instantly.ai/mcp")
      return { kind: "instantly", tools: ["list_emails", "get_email"] };
    if (address === "https://gmailmcp.googleapis.com/mcp/v1")
      return { kind: "gmail", tools: ["get_message", "get_thread", "search_threads"] };
  } else if (view === "interview") {
    if (address === "https://calendarmcp.googleapis.com/mcp/v1")
      return {
        kind: "calendar",
        tools: ["list_events", "get_event", "search_events", "suggest_time"],
      };
    if (address === "https://mcp.cal.com/mcp")
      return { kind: "cal", tools: ["get_bookings", "get_booking", "get_availability"] };
  } else if (address === "https://mcp.fullenrich.com/mcp") {
    return { kind: "fullenrich", tools: ["get_enrichment_results"] };
  }
  return null;
}

function correspondenceCall(request: unknown) {
  const direct = boundDirectApprovalDetails(request, "__rakazoCatalogTool");
  if (direct) return direct;
  const catalog = catalogApprovalDetails(request, "__rakazoCatalogTool");
  if (
    !catalog?.route ||
    catalog.args.id !== `${catalog.route.resourceId}:${encodeURIComponent(catalog.route.toolName)}`
  )
    return null;
  const args = catalog.args.arguments;
  return args && typeof args === "object" && !Array.isArray(args)
    ? { route: catalog.route, args: args as Record<string, unknown> }
    : null;
}

function correspondenceAllows(
  assignment: { allowAllTools: boolean; allowedTools: unknown },
  tool: string,
) {
  return (
    assignment.allowAllTools ||
    (Array.isArray(assignment.allowedTools) && assignment.allowedTools.includes(tool))
  );
}

function correspondenceRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Project saved native reads only. Opening a dashboard never invokes a provider. */
export async function getRecruitingCorrespondence(
  prisma: PrismaClient,
  actor: Actor,
  target: ThreadTarget,
  view: "inbox" | "interview" | "contacts",
): Promise<RecruitingCorrespondence> {
  return authenticated(async () => {
    const workspace = await recruiting.getRecruitingWorkspace(prisma, actor, {
      threadId: target.threadId,
    });
    const botIds = target.kind === "group" ? target.memberBotIds : [target.botId];
    const servers = await prisma.mcpServer.findMany({
      where: { userId: actor.userId, spaceId: actor.spaceId },
      select: {
        id: true,
        name: true,
        endpoint: true,
        transport: true,
        secretId: true,
        enabled: true,
        revision: true,
        assignments: {
          where: { userId: actor.userId, spaceId: actor.spaceId, botId: { in: botIds } },
          select: { botId: true, allowAllTools: true, allowedTools: true },
        },
      },
    });
    const sourceRows = servers.map((server) => ({
      ...server,
      provider: correspondenceProvider(server.endpoint, view),
    }));
    const sources = sourceRows.filter((source) => source.provider !== null);
    const output: RecruitingCorrespondence = {
      status: "not_checked",
      checkedAt: null,
      connectionChanged: false,
      emails: [],
      events: [],
      contacts: [],
      partial: false,
      connections: sources.map((source) => ({
        name: source.name,
        status: !source.enabled
          ? "disabled"
          : !source.secretId && !hasPlatformMcpCredential(source)
            ? "needs_connection"
            : !source.assignments.some((assignment) =>
                  source.provider?.tools.some((tool) => correspondenceAllows(assignment, tool)),
                )
              ? "needs_access"
              : "configured",
      })),
    };
    if (!workspace) return output;
    const readTools =
      view === "inbox"
        ? ["list_emails", "get_email", "get_message", "get_thread", "search_threads"]
        : view === "interview"
          ? [
              "get_bookings",
              "get_booking",
              "get_availability",
              "list_events",
              "get_event",
              "search_events",
              "suggest_time",
            ]
          : ["get_enrichment_results"];
    const querySources = sourceRows.filter(
      (source) =>
        source.enabled &&
        source.assignments.some((assignment) =>
          readTools.some((tool) => correspondenceAllows(assignment, tool)),
        ),
    );
    if (!querySources.length) return output;
    // Keep historical reads of the same role, including native legacy runs without an initial revision.
    const scope = {
      spaceId: actor.spaceId,
      run: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        threadId: target.threadId,
        botId: { in: botIds },
        OR: [
          { initialRecruitingRoleRevisionId: null },
          { initialRecruitingRoleRevision: { roleId: workspace.role.id } },
        ],
      },
      status: { in: ["completed", "failed"] },
    };
    const retained = await prisma.externalEffect.findMany({
      where: {
        ...scope,
        OR: querySources.flatMap((source) =>
          (source.provider?.tools ?? readTools).flatMap((tool) => [
            {
              AND: [
                { request: { path: ["2", "route", "resourceId"], equals: source.id } },
                { request: { path: ["2", "route", "toolName"], equals: tool } },
              ],
            },
            {
              AND: [
                { request: { path: ["3", "resourceId"], equals: source.id } },
                { request: { path: ["3", "toolName"], equals: tool } },
              ],
            },
          ]),
        ),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 201,
      select: {
        id: true,
        request: true,
        status: true,
        updatedAt: true,
        run: { select: { botId: true } },
      },
    });
    // ponytail: bound saved display history to 200 matching reads; a native fresh check refreshes older coverage.
    output.partial = retained.length > 200;
    const seen = new Set<string>();
    let unsupported = false;
    const reads = retained.slice(0, 200).flatMap((effect) => {
      const call = correspondenceCall(effect.request);
      const source = sourceRows.find(
        (source) => source.id === call?.route.resourceId && source.enabled,
      );
      if (
        call?.route.connectorId !== "mcp" ||
        !source ||
        !(source.provider?.tools ?? readTools).includes(call.route.toolName)
      )
        return [];
      const permission = source.assignments.find(
        (assignment) => assignment.botId === effect.run.botId,
      );
      if (!permission || !correspondenceAllows(permission, call.route.toolName)) return [];
      const query = Object.fromEntries(
        Object.entries(call.args).filter(([key]) => key !== "limit"),
      );
      const campaignId = call.args.campaign_id;
      if (
        view === "inbox" &&
        call.route.toolName === "list_emails" &&
        (typeof campaignId !== "string" || !campaignId.trim())
      )
        return []; // Account-wide exploration is not evidence of this role's correspondence.
      const key = stableJsonValue([
        source.id,
        call.route.toolName,
        call.route.toolName === "list_emails" ? { campaign_id: campaignId } : query,
      ]);
      // ponytail: Inbox shows the latest campaign check, not accumulated mailbox history; native cursor coverage stays explicit.
      // A new check replaces the prior observation, including empty/error.
      if (seen.has(key)) return [];
      seen.add(key);
      if (call.route.resourceRevision !== source.revision || !source.provider) {
        unsupported = true;
        output.checkedAt ??= effect.updatedAt.toISOString();
        output.connectionChanged ||= call.route.resourceRevision !== source.revision;
        return [];
      }
      return [{ effect, call, source, provider: source.provider }];
    });
    if (!reads.length) {
      if (unsupported) output.status = "unsupported";
      return output;
    }
    const mailCampaigns = new Set(
      reads
        .filter(
          (read) =>
            read.provider.kind === "instantly" && read.call.route.toolName === "list_emails",
        )
        .map((read) => stableJsonValue([read.source.id, read.call.args.campaign_id])),
    );
    const results = await prisma.externalEffect.findMany({
      where: { ...scope, id: { in: reads.map((read) => read.effect.id) } },
      select: { id: true, result: true },
    });
    const byId = new Map(results.map((result) => [result.id, result.result]));
    const candidateKeys = new Set(
      view === "contacts"
        ? (
            await prisma.recruitingCandidate.findMany({
              where: {
                roleId: workspace.role.id,
                role: { spaceId: actor.spaceId, userId: actor.userId },
              },
              select: { candidateKey: true },
            })
          ).map((candidate) => candidate.candidateKey)
        : [],
    );
    const contactKeys = new Set<string>();
    let parsed = false;
    let failed = false;
    const emails = new Map<string, RecruitingCorrespondence["emails"][number]>();
    const mailMembership = new Set<string>();
    // Details may supplement only messages present in the latest selected campaign snapshot.
    const projections = [
      ...reads.filter((read) => read.call.route.toolName !== "get_email"),
      ...reads.filter((read) => read.call.route.toolName === "get_email"),
    ];
    for (const { effect, call, source, provider } of projections) {
      if (
        provider.kind === "instantly" &&
        call.route.toolName === "get_email" &&
        (typeof call.args.id !== "string" || !emails.has(`${source.id}:${call.args.id}`))
      )
        continue;
      const result = byId.get(effect.id);
      if (result === undefined) continue;
      output.checkedAt ??= effect.updatedAt.toISOString();
      if (
        effect.status === "failed" ||
        (result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          ("error" in result ||
            ("isError" in result && result.isError !== false && result.isError !== undefined)))
      ) {
        failed = true;
        continue;
      }
      const body = mcpObject(result);
      if (provider.kind === "fullenrich" && body) {
        if (typeof call.args.enrichment_id !== "string" || !call.args.enrichment_id.trim()) {
          unsupported = true;
          continue;
        }
        if (body.status === "in_progress") {
          output.partial = true;
          continue;
        }
        if (body.status !== "FINISHED" || !Array.isArray(body.results)) {
          unsupported = true;
          continue;
        }
        parsed = true;
        for (const row of body.results) {
          const entry = correspondenceRecord(row);
          const input = correspondenceRecord(entry?.input);
          const profile = correspondenceRecord(entry?.profile);
          const network = correspondenceRecord(
            correspondenceRecord(profile?.social_profiles)?.professional_network,
          );
          const linkedinUrl = input?.professional_network_url;
          const identity =
            typeof linkedinUrl === "string" ? recruitingCalibrationIdentity(linkedinUrl) : null;
          const profileIdentity =
            typeof network?.url === "string" ? recruitingCalibrationIdentity(network.url) : null;
          if (!identity || identity !== profileIdentity) {
            unsupported = true;
            continue;
          }
          const candidateKey = `linkedin:${identity}`;
          if (!candidateKeys.has(candidateKey) || contactKeys.has(candidateKey)) continue;
          contactKeys.add(candidateKey);
          const info = correspondenceRecord(entry?.contact_info);
          if (!info || !Array.isArray(info.work_emails)) {
            unsupported = true;
            continue;
          }
          const addresses = [info.most_probable_work_email, ...info.work_emails]
            .filter((email) => email !== null && email !== undefined)
            .map((email) => {
              const value = correspondenceRecord(email);
              return { address: value?.email, status: value?.status };
            });
          const contact = RecruitingCorrespondenceSchema.shape.contacts.element.safeParse({
            candidateKey,
            linkedinUrl,
            emails: addresses,
            // ponytail: the observed provider phone is null; do not infer an unverified phone schema.
            phones: [],
            source: source.name,
            checkedAt: effect.updatedAt.toISOString(),
          });
          if (!contact.success) {
            unsupported = true;
            continue;
          }
          contact.data.emails = [
            ...new Map(contact.data.emails.map((email) => [email.address, email])).values(),
          ];
          output.contacts.push(contact.data);
        }
        continue;
      }
      if (provider.kind === "cal" && call.route.toolName === "get_bookings" && body) {
        // ponytail: only the verified empty Cal frame; extend with actual nonempty provider rows when available.
        if (body.status === "success" && Array.isArray(body.data) && body.data.length === 0) {
          parsed = true;
          const pagination = body.pagination;
          output.partial ||=
            !pagination ||
            typeof pagination !== "object" ||
            Array.isArray(pagination) ||
            !("hasNextPage" in pagination) ||
            pagination.hasNextPage !== false;
        } else unsupported = true;
        continue;
      }
      if (provider.kind !== "instantly" || !body) {
        unsupported = true;
        continue;
      }
      const rows = call.route.toolName === "list_emails" ? body.items : [body];
      if (!Array.isArray(rows)) {
        unsupported = true;
        continue;
      }
      if (call.route.toolName === "list_emails") parsed = true;
      output.partial ||=
        body.next_starting_after !== undefined &&
        body.next_starting_after !== null &&
        body.next_starting_after !== "";
      for (const row of rows) {
        // Display does not use provider thread IDs; outbound anchors retain their strict UUID check.
        const { thread_id: _threadId, ...display } = correspondenceRecord(row) ?? {};
        const email = readInstantlyEmail(display);
        if (!email) {
          unsupported = true;
          output.partial = true;
          continue;
        }
        const id = `${source.id}:${email.id}`;
        const membership = stableJsonValue([source.id, email.campaign_id, email.id]);
        if (
          call.route.toolName === "get_email" &&
          (email.id !== call.args.id || !mailMembership.has(membership))
        ) {
          unsupported = true;
          continue;
        }
        if (
          !email.campaign_id ||
          !mailCampaigns.has(stableJsonValue([source.id, email.campaign_id])) ||
          (call.route.toolName === "list_emails" && email.campaign_id !== call.args.campaign_id)
        ) {
          unsupported = true;
          continue;
        }
        parsed = true;
        if (emails.has(id) && call.route.toolName !== "get_email") continue;
        if (call.route.toolName === "list_emails") mailMembership.add(membership);
        const text = email.body.text || email.content_preview || "";
        const displayText =
          call.route.toolName === "list_emails"
            ? text.replace(/\[truncated — use get_email for full content\](\s*)$/u, "$1")
            : text;
        emails.set(id, {
          id,
          sender: email.from_address_email ?? null,
          recipients: email.to_address_email_list ? [email.to_address_email_list] : [],
          subject: email.subject,
          body: displayText.slice(0, 50_000),
          snippet:
            call.route.toolName === "list_emails" || !email.body.text || text.length > 50_000,
          date: email.timestamp_email,
          url: null,
        });
      }
    }
    output.emails = [...emails.values()].slice(0, 50);
    output.partial ||= emails.size > 50 || unsupported || failed;
    output.status =
      output.emails.length || output.events.length || output.contacts.length
        ? "ready"
        : failed
          ? "failed"
          : unsupported
            ? "unsupported"
            : parsed
              ? "empty"
              : "not_checked";
    // A late role switch cannot carry a previous role's saved mail into the new workspace.
    const current = await prisma.thread.findFirst({
      where: {
        id: target.threadId,
        spaceId: actor.spaceId,
        userId: actor.userId,
        activeRecruitingRoleId: workspace.role.id,
      },
      select: { id: true },
    });
    if (!current) throw new IsolationError();
    return output;
  });
}

/** Bind exact UTF-16 quotes in MCP array text to one canonical saved person. */
function selectedProviderRow(
  bytes: Uint8Array,
  text: string,
  selection: RecruitingSourceSelection | undefined,
) {
  if (selection?.kind !== "artifact_json_string") throw new IsolationError();
  const { path, start, end } = selection;
  const rowPaths = [
    ["providerResult", "structuredContent", "rows"],
    ["observation", "rows"],
  ];
  const rowPath = rowPaths.find((prefix) => prefix.every((key, index) => path[index] === key));
  if (rowPath) {
    const rowIndex = path[rowPath.length];
    if (typeof rowIndex !== "number" || !Number.isSafeInteger(rowIndex) || rowIndex < 0)
      throw new IsolationError();
    const original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    JSON.parse(original);
    const node = findNodeAtLocation(parseTree(original)!, [...rowPath, rowIndex]);
    if (node?.type !== "object") throw new IsolationError();
    return {
      rowIndex,
      row: JSON.parse(original.slice(node.offset, node.offset + node.length)) as Record<
        string,
        unknown
      >,
    };
  }
  if (
    path.length !== 4 ||
    path[0] !== "providerResult" ||
    path[1] !== "content" ||
    typeof path[2] !== "number" ||
    path[3] !== "text"
  )
    throw new IsolationError();
  JSON.parse(text);
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  const rows = root?.type === "array" ? root : root && findNodeAtLocation(root, ["rows"]);
  if (errors.length || rows?.type !== "array" || !rows.children) throw new IsolationError();
  const overlapping = rows.children.filter(
    (node) => start < node.offset + node.length && end > node.offset,
  );
  const node = overlapping[0];
  if (overlapping.length !== 1 || !node || node.type !== "object") throw new IsolationError();
  const surrounding =
    text.slice(start, Math.min(end, node.offset)) +
    text.slice(Math.max(start, node.offset + node.length), end);
  if (!/^[\s[\],]*$/.test(surrounding)) throw new IsolationError();
  return {
    rowIndex: rows.children.indexOf(node),
    row: JSON.parse(text.slice(node.offset, node.offset + node.length)) as Record<string, unknown>,
  };
}

function sameReportedRow(selected: Record<string, unknown>, canonical: unknown) {
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) return false;
  const value = (cell: unknown) =>
    cell && typeof cell === "object" && !Array.isArray(cell) && Object.hasOwn(cell, "value")
      ? (cell as { value: unknown }).value
      : cell;
  const keys = Object.keys(selected).filter(isRecruitingCandidateReportField);
  return (
    keys.length > 0 &&
    keys.length === Object.keys(canonical).filter(isRecruitingCandidateReportField).length &&
    keys.every(
      (key) =>
        Object.hasOwn(canonical, key) &&
        isDeepStrictEqual(value(selected[key]), value((canonical as Record<string, unknown>)[key])),
    )
  );
}

export const readRecruitingSource = (
  deps: { prisma: PrismaClient; artifacts: ArtifactStore },
  actor: Actor,
  input: ReadRecruitingSourceInput,
) =>
  authenticated(async () => {
    let sources: readonly (RecruitingSourceRef | RecruitingAssessmentSourceRef)[];
    if (input.kind === "role") {
      const workspace = await recruiting.getRecruitingWorkspace(deps.prisma, actor, {
        threadId: input.threadId,
      });
      if (!workspace || workspace.revision.id !== input.roleRevisionId) throw new IsolationError();
      sources = [
        ...workspace.revision.sourceRefs,
        ...workspace.revision.criteria.flatMap((criterion) => criterion.sourceRefs),
      ];
    } else {
      const snapshot = await recruiting.getRecruitingAssessment(deps.prisma, actor, {
        roleId: input.roleId,
        candidateKey: input.candidateKey,
        version: input.version,
      });
      if (!snapshot || snapshot.assessment.version !== input.version) throw new IsolationError();
      sources = snapshot.assessment.sourceRefs;
    }
    const matches = sources.filter((source) => source.id === input.sourceRefId);
    const source = matches[0];
    if (
      !source ||
      matches.some((value) => !isDeepStrictEqual(value, source)) ||
      source.readState !== "read" ||
      !source.quote ||
      source.anchor.kind !== "artifact"
    )
      throw new IsolationError();
    try {
      const { row, bytes } = await readActorArtifact(deps, actor, {
        artifactId: source.anchor.artifact.artifactId,
      });
      if (row.hash !== source.anchor.artifact.sha256) throw new IsolationError();
      const selection = "selection" in source ? source.selection : undefined;
      // ponytail: role sources attest only extracted text; other strings require the stored typed path.
      if (selection?.kind === "message_text" || (!selection && source.anchor.locator !== "text"))
        throw new IsolationError();
      const json = row.mimeType === "application/json" || row.mimeType.endsWith("+json");
      const pdf = row.mimeType === "application/pdf";
      const path =
        selection?.kind === "artifact_json_string"
          ? selection.path
          : !selection && json
            ? ["text"]
            : undefined;
      if (path ? !json : (!row.mimeType.startsWith("text/") && !pdf) || json)
        throw new IsolationError();
      const text = path
        ? readRecruitingJsonString(bytes, path)
        : pdf
          ? await extractPdfText(bytes)
          : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const start = selection?.start ?? text.indexOf(source.quote);
      const end = selection?.end ?? start + source.quote.length;
      validateRecruitingTextSelection(text, start, end, source.quote);
      if (input.kind === "assessment" && source.kind === "provider_report" && json) {
        const selected = selectedProviderRow(bytes, text, selection);
        const readReport = createRecruitingCandidateReportReader(deps, actor, input.roleId, {
          artifacts: new Map([[row.id, { row, bytes }]]),
        });
        // ponytail: use existing occurrence pagination; add an artifact selector only if histories grow large.
        const matches: RecruitingCandidateSource[] = [];
        let cursor: string | undefined;
        do {
          const page = await recruiting.listRecruitingCandidateSources(deps.prisma, actor, {
            roleId: input.roleId,
            candidateKey: input.candidateKey,
            ...(cursor ? { cursor } : {}),
          });
          matches.push(
            ...page.items.filter(
              (item) =>
                item.artifactRef.artifactId === row.id &&
                item.artifactRef.sha256 === row.hash &&
                item.rowIndex === selected.rowIndex,
            ),
          );
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        if (matches.length !== 1) throw new IsolationError();
        const retained = await readReport(matches[0]!);
        if (!sameReportedRow(selected.row, retained.row)) throw new IsolationError();
        return { kind: "report" as const, report: retained.report };
      }
      return { kind: "text" as const, text, start, end };
    } catch {
      throw new IsolationError();
    }
  });

export const createRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.createRecruitingRole>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.createRecruitingRole(prisma, actor, input, material));
export const bindRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.bindRecruitingRole>[2],
) => authenticated(() => recruiting.bindRecruitingRole(prisma, actor, input));
export const getRecruitingWorkspace = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.getRecruitingWorkspace>[2],
) => authenticated(() => recruiting.getRecruitingWorkspace(prisma, actor, input));
export const reviseRecruitingRole = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.reviseRecruitingRole>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.reviseRecruitingRole(prisma, actor, input, material));
export const listRecruitingAssessments = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingAssessments>[2],
) => authenticated(() => recruiting.listRecruitingAssessments(prisma, actor, input));
export const listRecruitingFeedback = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingFeedback>[2],
) => authenticated(() => recruiting.listRecruitingFeedback(prisma, actor, input));
export const getRecruitingAssessment = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.getRecruitingAssessment>[2],
) => authenticated(() => recruiting.getRecruitingAssessment(prisma, actor, input));
export const listRecruitingResearch = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingResearch>[2],
) => authenticated(() => recruiting.listRecruitingResearch(prisma, actor, input));

export const listRecruitingQuestions = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingQuestions>[2],
) =>
  authenticated(async () => ({
    questions: await recruiting.listRecruitingQuestions(prisma, actor, input),
  }));

export const confirmRecruitingBrief = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.confirmRecruitingBrief>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.confirmRecruitingBrief(prisma, actor, input, material));

export const editRecruitingCriteria = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.editRecruitingCriteria>[2],
  material?: RecruitingRoleMaterialContext,
) => authenticated(() => recruiting.editRecruitingCriteria(prisma, actor, input, material));

async function hydrateRecruitingCandidateReports(
  deps: RecruitingReadDeps,
  actor: Actor,
  roleId: string,
  sources: Omit<RecruitingCandidateSource, "crmImports">[],
) {
  const artifacts = new Map<string, Awaited<ReturnType<typeof readActorArtifact>>>();
  const readReport = createRecruitingCandidateReportReader(deps, actor, roleId, { artifacts });
  const byArtifact = new Map<string, typeof sources>();
  for (const source of sources) {
    const group = byArtifact.get(source.artifactRef.artifactId) ?? [];
    group.push(source);
    byArtifact.set(source.artifactRef.artifactId, group);
  }
  const groups = [...byArtifact.values()];
  // ponytail: bound parallel multi-MB reads to four pages; tune only after measured storage capacity.
  for (let start = 0; start < groups.length; start += 4) {
    await Promise.all(
      groups.slice(start, start + 4).map(async (group) => {
        for (const source of group) delete source.report;
        const artifactId = group[0]!.artifactRef.artifactId;
        try {
          artifacts.set(artifactId, await readActorArtifact(deps, actor, { artifactId }));
        } catch {
          return;
        }
        for (const source of group) {
          try {
            source.report = (await readReport(source)).report;
          } catch {
            // Authorized provenance remains readable when its report bytes are unavailable.
          }
        }
      }),
    );
  }
}

export const listRecruitingCandidates = (
  deps: RecruitingReadDeps,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingCandidates>[2],
) =>
  authenticated(async () => {
    const page = await recruiting.listRecruitingCandidates(deps.prisma, actor, input);
    await hydrateRecruitingCandidateReports(
      deps,
      actor,
      input.roleId,
      page.items.flatMap((candidate) => (candidate.latestSource ? [candidate.latestSource] : [])),
    );
    return page;
  });
export const listRecruitingCandidateSources = (
  deps: RecruitingReadDeps,
  actor: Actor,
  input: Parameters<typeof recruiting.listRecruitingCandidateSources>[2],
) =>
  authenticated(async () => {
    const page = await recruiting.listRecruitingCandidateSources(deps.prisma, actor, input);
    await hydrateRecruitingCandidateReports(deps, actor, input.roleId, page.items);
    return page;
  });
export const setRecruitingCandidateShortlist = (
  prisma: PrismaClient,
  actor: Actor,
  input: Parameters<typeof recruiting.setRecruitingCandidateShortlist>[2],
) => authenticated(() => recruiting.setRecruitingCandidateShortlist(prisma, actor, input));
