import { createHash } from "node:crypto";
import type {
  Actor,
  RecruitingSchedulingPlan,
  RecruitingSchedulingPlanInput,
  RecruitingSchedulingPrepareInput,
} from "@rakazo/contracts";
import {
  RecruitingCrmImportArgsSchema,
  RecruitingSchedulingPlanInputSchema,
  RecruitingSchedulingPlanSchema,
  RecruitingSchedulingSlotSchema,
} from "@rakazo/contracts";
import {
  boundDirectApprovalDetails,
  catalogApprovalDetails,
  parseRecruitingCrmImportReceipt,
} from "@rakazo/core";
import { mcpObject, stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { getRecruitingWorkspace } from "./recruiting.js";
import { IsolationError, requireMembership } from "./scope.js";

type Tx = Prisma.TransactionClient;
const KIND = "recruiting_scheduling_plan";
const LIMIT = 100;
const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function call(request: unknown) {
  const direct = boundDirectApprovalDetails(request, "__rakazoCatalogTool");
  const catalog = catalogApprovalDetails(request, "__rakazoCatalogTool");
  const route = direct?.route ?? catalog?.route;
  const args = obj(direct?.args ?? catalog?.args.arguments);
  if (
    !route ||
    route.connectorId !== "mcp" ||
    typeof route.resourceId !== "string" ||
    typeof route.resourceRevision !== "number" ||
    !args
  )
    throw new IsolationError();
  return {
    route: { ...route, resourceId: route.resourceId, resourceRevision: route.resourceRevision },
    args,
  };
}
function successful(effect: { status: string; result: unknown }) {
  const envelope = obj(effect.result);
  const body = envelope && mcpObject(envelope);
  if (
    effect.status !== "completed" ||
    !envelope ||
    envelope.error ||
    envelope.isError ||
    envelope.uncertain ||
    !body ||
    body.error ||
    body.status === "error" ||
    body.isError ||
    body.uncertain
  )
    throw new IsolationError();
  const value = obj(body.result) ?? body;
  if (value.error || value.isError || value.uncertain || value.status === "error")
    throw new IsolationError();
  return value;
}
async function scope(prisma: PrismaClient, actor: Actor, threadId: string) {
  await requireMembership(prisma, actor.userId, actor.spaceId);
  const workspace = await getRecruitingWorkspace(prisma, actor, { threadId });
  if (!workspace) throw new IsolationError();
  return workspace;
}
async function lockScope(
  tx: Tx,
  actor: Actor,
  input: { threadId: string; roleId: string; expectedRoleRevision: number },
) {
  await requireMembership(tx, actor.userId, actor.spaceId);
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM threads WHERE id=${input.threadId} AND "spaceId"=${actor.spaceId} AND "userId"=${actor.userId} FOR UPDATE`,
  );
  const thread = await tx.thread.findFirst({
    where: {
      id: input.threadId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      activeRecruitingRoleId: input.roleId,
    },
  });
  const role = await tx.recruitingRole.findFirst({
    where: {
      id: input.roleId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      revision: input.expectedRoleRevision,
      archivedAt: null,
    },
  });
  if (!thread || !role) throw new IsolationError();
}
async function effect(tx: Tx, actor: Actor, threadId: string, id: string) {
  const row = await tx.externalEffect.findFirst({
    where: {
      id,
      spaceId: actor.spaceId,
      run: { spaceId: actor.spaceId, userId: actor.userId, threadId },
    },
    include: { run: true },
  });
  if (!row) throw new IsolationError();
  return row;
}
async function grant(
  tx: Tx,
  actor: Actor,
  row: Awaited<ReturnType<typeof effect>>,
  tools?: string[],
) {
  const native = call(row.request);
  const server = await tx.mcpServer.findFirst({
    where: {
      id: native.route.resourceId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      enabled: true,
      revision: native.route.resourceRevision,
    },
  });
  const assignment = await tx.botMcpServer.findFirst({
    where: {
      serverId: native.route.resourceId,
      botId: row.run.botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
  });
  const allowed = assignment?.allowedTools;
  // Local Instantly tools ride the official server's get_email + list_emails grant, as the
  // executor authorizes them.
  const required = (tools ?? [native.route.toolName]).flatMap((tool) =>
    tool.startsWith("native_instantly_") ? ["get_email", "list_emails"] : [tool],
  );
  if (
    !server ||
    !assignment ||
    (!assignment.allowAllTools &&
      (!Array.isArray(allowed) || !required.every((tool) => allowed.includes(tool))))
  )
    throw new IsolationError();
  return native;
}
function slots(row: Awaited<ReturnType<typeof effect>>) {
  const { route, args } = call(row.request);
  if (route.toolName !== "get_availability" || args.format !== "range") return [];
  const body = successful(row);
  if (body.status !== "success" || !obj(body.data)) return [];
  // Slots read in a local zone carry an offset; plans keep UTC. A fixed-length event type is read
  // without a duration, so the slot's own interval is its length.
  const utc = (value: unknown) =>
    typeof value === "string" &&
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value))
      ? value.endsWith("Z")
        ? value
        : new Date(value).toISOString()
      : undefined;
  return Object.values(obj(body.data)!)
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .flatMap((value) => {
      const slot = obj(value);
      const start = utc(slot?.start);
      const end = utc(slot?.end);
      const parsed = RecruitingSchedulingSlotSchema.safeParse({
        sourceId: route.resourceId,
        sourceRevision: route.resourceRevision,
        eventTypeId: args.eventTypeId,
        availabilityEffectId: row.id,
        start,
        end,
        lengthInMinutes:
          args.duration ??
          (start && end ? (Date.parse(end) - Date.parse(start)) / 60_000 : undefined),
      });
      return parsed.success &&
        typeof args.start === "string" &&
        typeof args.end === "string" &&
        Date.parse(parsed.data.start) >= Date.parse(args.start) &&
        Date.parse(parsed.data.end) <= Date.parse(args.end)
        ? [parsed.data]
        : [];
    });
}
async function importedCandidate(
  tx: Tx,
  actor: Actor,
  input: RecruitingSchedulingPlanInput,
  workspace: Awaited<ReturnType<typeof scope>>,
) {
  const target = workspace.crmTarget?.target;
  if (!target) return null;
  const imports = await tx.recruitingCrmImport.findMany({
    where: {
      occurrence: { roleId: input.roleId, candidateKey: input.candidate.candidateKey },
      effect: { spaceId: actor.spaceId, run: { spaceId: actor.spaceId, userId: actor.userId } },
    },
    include: { effect: { include: { run: true } }, occurrence: true },
    take: LIMIT + 1,
  });
  if (imports.length > LIMIT) throw new IsolationError();
  const ids = new Set<string>();
  for (const imported of imports) {
    try {
      const native = await grant(tx, actor, imported.effect);
      const args = RecruitingCrmImportArgsSchema.parse(native.args);
      if (args.p_linkedin_url !== imported.occurrence.linkedinUrl) continue;
      const receipt = parseRecruitingCrmImportReceipt(imported.effect, target, args);
      if (receipt) ids.add(receipt.candidate_id);
    } catch (error) {
      if (!(error instanceof IsolationError)) throw error;
    }
  }
  if (ids.size !== 1) return null;
  return [...ids][0]!;
}
async function verify(
  tx: Tx,
  actor: Actor,
  input: RecruitingSchedulingPlanInput,
  workspace: Awaited<ReturnType<typeof scope>>,
  retained?: Pick<RecruitingSchedulingPlan, "mailRead" | "mailSourceId" | "mailSourceRevision">,
) {
  await lockScope(tx, actor, input);
  if (
    workspace.role.id !== input.roleId ||
    workspace.role.revision !== input.expectedRoleRevision ||
    input.originalEmail.roleId !== input.roleId ||
    input.originalEmail.threadId !== input.threadId
  )
    throw new IsolationError();
  const availability = await effect(tx, actor, input.threadId, input.calendar.availabilityEffectId);
  if (availability.run.initialRecruitingRoleRevisionId !== workspace.role.currentRevisionId)
    throw new IsolationError();
  await grant(tx, actor, availability, ["get_availability", "create_booking", "get_booking"]);
  if (
    !slots(availability).some((slot) => stableJsonValue(slot) === stableJsonValue(input.calendar))
  )
    throw new IsolationError();
  const saved = retained?.mailRead ?? input.originalEmail.savedRead;
  let mail: Awaited<ReturnType<typeof effect>>;
  if (saved) mail = await effect(tx, actor, input.threadId, saved.effectId);
  else {
    const target = workspace.crmTarget?.target;
    if (!input.originalEmail.crm || !target || input.originalEmail.sourceId !== target.mcpServerId)
      throw new IsolationError("Read the original email before preparing a scheduling plan");
    const rows = await tx.externalEffect.findMany({
      where: {
        spaceId: actor.spaceId,
        run: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          threadId: input.threadId,
          initialRecruitingRoleRevisionId: workspace.role.currentRevisionId,
        },
      },
      include: { run: true },
      orderBy: { createdAt: "desc" },
      take: LIMIT + 1,
    });
    if (rows.length > LIMIT) throw new IsolationError("Original email proof search is incomplete");
    const matches: typeof rows = [];
    const seen = new Set<string>();
    for (const row of rows) {
      try {
        const candidate = call(row.request);
        if (
          !["get_email", "native_instantly_get_email"].includes(candidate.route.toolName) ||
          candidate.args.id !== input.originalEmail.providerMessageId ||
          seen.has(candidate.route.resourceId)
        )
          continue;
        seen.add(candidate.route.resourceId);
        await grant(tx, actor, row);
        const value = successful(row);
        if (
          value.id === input.originalEmail.providerMessageId &&
          value.thread_id === input.originalEmail.providerThreadId &&
          value.eaccount === input.originalEmail.eaccount &&
          value.from_address_email === input.candidate.email &&
          value.campaign_id === input.originalEmail.campaignId
        )
          matches.push(row);
      } catch (error) {
        if (!(error instanceof IsolationError)) throw error;
      }
    }
    if (matches.length !== 1)
      throw new IsolationError("The original email needs one exact authorized native read");
    mail = matches[0]!;
  }
  if (mail.run.initialRecruitingRoleRevisionId !== workspace.role.currentRevisionId)
    throw new IsolationError();
  const native = await grant(tx, actor, mail);
  if (
    !["get_email", "native_instantly_get_email"].includes(native.route.toolName) ||
    native.args.id !== input.originalEmail.providerMessageId ||
    (saved && (mail.runId !== saved.linkedRunId || mail.run.sourceMessageId !== saved.messageId)) ||
    (!input.originalEmail.crm && native.route.resourceId !== input.originalEmail.sourceId)
  )
    throw new IsolationError();
  const email = successful(mail);
  if (
    email.id !== input.originalEmail.providerMessageId ||
    typeof email.thread_id !== "string" ||
    email.thread_id !== input.originalEmail.providerThreadId ||
    typeof email.eaccount !== "string" ||
    email.eaccount !== input.originalEmail.eaccount ||
    input.candidate.email !== email.from_address_email ||
    (email.campaign_id ?? null) !== (input.originalEmail.campaignId ?? null)
  )
    throw new IsolationError();
  const crm = input.originalEmail.crm;
  if (crm) {
    const target = workspace.crmTarget?.target;
    if (
      !target ||
      input.originalEmail.sourceId !== target.mcpServerId ||
      target.organizationId !== crm.organizationId ||
      target.crmRoleId !== crm.crmRoleId ||
      target.serverRevision !== crm.serverRevision ||
      (crm.candidateId !== input.candidate.candidateKey &&
        crm.candidateId !== (await importedCandidate(tx, actor, input, workspace)))
    )
      throw new IsolationError();
    const contact = await tx.recruitingCrmContact.findFirst({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        mcpServerId: target.mcpServerId,
        organizationId: target.organizationId,
        crmCandidateId: crm.candidateId,
        email: input.candidate.email,
        archivedAt: null,
        roles: {
          some: {
            archivedAt: null,
            role: {
              crmRoleId: target.crmRoleId,
              organizationId: target.organizationId,
              mcpServerId: target.mcpServerId,
              archivedAt: null,
            },
          },
        },
      },
    });
    if (!contact) throw new IsolationError();
    if (!input.originalEmail.savedRead) {
      const message = await tx.recruitingCrmMessage.findFirst({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          mcpServerId: target.mcpServerId,
          organizationId: target.organizationId,
          crmRoleId: target.crmRoleId,
          crmCandidateId: crm.candidateId,
          crmMessageId: input.originalEmail.providerMessageId,
          threadId: input.originalEmail.providerThreadId,
        },
      });
      if (!message)
        throw new IsolationError("The selected original email is not saved for this CRM role");
    }
  } else {
    const candidate = await tx.recruitingCandidate.findUnique({
      where: {
        roleId_candidateKey: { roleId: input.roleId, candidateKey: input.candidate.candidateKey },
      },
    });
    if (!candidate) throw new IsolationError();
    if (input.candidate.candidateKey !== input.candidate.email.toLowerCase()) {
      const id = await importedCandidate(tx, actor, input, workspace);
      const target = workspace.crmTarget?.target;
      if (!id || !target) {
        // Native campaign lead persistence already records exact candidate_key -> lead/email.
        // Reuse that identity; a free-form email or LinkedIn similarity is never a join.
        const binding = await tx.externalEffect.findUnique({
          where: {
            idempotencyKey: `instantly-role-campaign:${native.route.resourceId}:${input.roleId}`,
          },
          include: { run: true },
        });
        const value = obj(binding?.result);
        const lead = obj(obj(value?.leads)?.[input.candidate.candidateKey]);
        if (
          !binding ||
          binding.spaceId !== actor.spaceId ||
          binding.run.spaceId !== actor.spaceId ||
          binding.run.userId !== actor.userId ||
          binding.kind !== "instantly_role_campaign" ||
          binding.status !== "completed" ||
          typeof value?.campaignId !== "string" ||
          value.campaignId !== email.campaign_id ||
          typeof lead?.leadId !== "string" ||
          lead.email !== input.candidate.email ||
          // The provider's `lead` is the lead's address and `lead_id` its id.
          (email.lead_id != null && email.lead_id !== lead.leadId) ||
          (typeof email.lead === "string" &&
            email.lead.toLowerCase() !== String(lead.email).toLowerCase()) ||
          (typeof value.eaccount === "string" && value.eaccount !== email.eaccount)
        )
          throw new IsolationError("An exact saved campaign/contact identity is required");
      } else {
        const contact = await tx.recruitingCrmContact.findFirst({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            mcpServerId: target.mcpServerId,
            organizationId: target.organizationId,
            crmCandidateId: id,
            email: input.candidate.email,
            archivedAt: null,
            roles: {
              some: {
                archivedAt: null,
                role: {
                  mcpServerId: target.mcpServerId,
                  organizationId: target.organizationId,
                  crmRoleId: target.crmRoleId,
                  archivedAt: null,
                },
              },
            },
          },
        });
        if (!contact) throw new IsolationError();
      }
    }
  }
  const displaySource = await tx.mcpServer.findFirst({
    where: {
      id: input.originalEmail.sourceId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      enabled: true,
    },
  });
  if (!displaySource) throw new IsolationError();
  const originalEmail = {
    ...input.originalEmail,
    subject: typeof email.subject === "string" ? email.subject : "",
    sender: typeof email.from_address_email === "string" ? email.from_address_email : null,
    date:
      typeof email.timestamp_email === "string" &&
      Number.isFinite(Date.parse(email.timestamp_email))
        ? new Date(email.timestamp_email).toISOString()
        : null,
    sourceName: displaySource.name,
  };
  return {
    availability,
    originalEmail,
    mailSourceRevision: native.route.resourceRevision,
    mailSourceId: native.route.resourceId,
    mailRead: { effectId: mail.id, linkedRunId: mail.runId, messageId: mail.run.sourceMessageId },
  };
}
function projection(row: {
  id: string;
  request: unknown;
  result: unknown;
  createdAt: Date;
}): RecruitingSchedulingPlan {
  const links = obj(row.result);
  return RecruitingSchedulingPlanSchema.parse({
    ...RecruitingSchedulingPlanInputSchema.parse(obj(row.request)?.input),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    roleTitle: obj(row.request)?.roleTitle,
    mailSourceRevision: obj(row.request)?.mailSourceRevision,
    mailSourceId: obj(row.request)?.mailSourceId,
    mailRead: obj(row.request)?.mailRead,
    bookingStatus: null,
    confirmationStatus: null,
    bookingEffectId: links?.bookingEffectId ?? null,
    confirmationEffectId: links?.confirmationEffectId ?? null,
  });
}
async function outcome(tx: Tx, actor: Actor, plan: RecruitingSchedulingPlan, links: unknown) {
  const status = async (id: string | null) => {
    if (!id) return null;
    const row = await effect(tx, actor, plan.threadId, id);
    await grant(tx, actor, row);
    const key = id === plan.bookingEffectId ? "bookingRequestHash" : "confirmationRequestHash";
    if (
      obj(links)?.[key] !== createHash("sha256").update(stableJsonValue(row.request)).digest("hex")
    )
      throw new IsolationError("The bound operation request changed");
    if (row.status === "uncertain" || obj(row.result)?.uncertain) return "uncertain" as const;
    if (row.status === "failed") return "failed" as const;
    if (row.status !== "completed") return "pending" as const;
    try {
      const body = successful(row);
      if (id === plan.bookingEffectId) {
        const booking = obj(body.data);
        return body.status === "success" &&
          typeof booking?.uid === "string" &&
          booking.status === "accepted" &&
          Date.parse(String(booking.start)) === Date.parse(plan.calendar.start) &&
          Date.parse(String(booking.end)) === Date.parse(plan.calendar.end)
          ? ("completed" as const)
          : ("uncertain" as const);
      }
      const args = call(row.request).args;
      const content = obj(args.body);
      const recorded = (value: Record<string, unknown>) =>
        typeof value.id === "string" &&
        value.id !== plan.originalEmail.providerMessageId &&
        value.thread_id === plan.originalEmail.providerThreadId &&
        value.reply_to_uuid === plan.originalEmail.providerMessageId &&
        value.eaccount === plan.originalEmail.eaccount &&
        value.from_address_email === plan.originalEmail.eaccount &&
        value.to_address_email_list === plan.candidate.email &&
        value.ue_type === 3 &&
        typeof value.timestamp_email === "string" &&
        Number.isFinite(Date.parse(value.timestamp_email)) &&
        value.subject === args.subject &&
        value.body_fallback_reason == null &&
        !value.cc_address_email_list &&
        !value.bcc_address_email_list &&
        (content?.text === undefined || obj(value.body)?.text === content.text) &&
        (content?.html === undefined || obj(value.body)?.html === content.html);
      if (recorded(body)) return "completed" as const;
      if (typeof body.id !== "string") return "uncertain" as const;
      const reads = await tx.externalEffect.findMany({
        where: {
          spaceId: actor.spaceId,
          createdAt: { gte: row.updatedAt },
          run: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            threadId: plan.threadId,
            initialRecruitingRoleRevision: {
              roleId: plan.roleId,
              revision: plan.expectedRoleRevision,
            },
          },
        },
        include: { run: true },
        orderBy: { createdAt: "desc" },
        take: LIMIT + 1,
      });
      if (reads.length > LIMIT) return "uncertain" as const;
      for (const read of reads) {
        let parsed: ReturnType<typeof call>;
        try {
          parsed = call(read.request);
        } catch (error) {
          if (error instanceof IsolationError) continue;
          throw error;
        }
        if (
          !["get_email", "native_instantly_get_email"].includes(parsed.route.toolName) ||
          parsed.route.resourceId !== plan.mailSourceId ||
          parsed.route.resourceRevision !== plan.mailSourceRevision ||
          parsed.args.id !== body.id
        )
          continue;
        await grant(tx, actor, read);
        const observed = successful(read);
        return observed.id === body.id && recorded(observed)
          ? ("completed" as const)
          : ("uncertain" as const);
      }
      return "uncertain" as const;
    } catch {
      return "failed" as const;
    }
  };
  return {
    ...plan,
    bookingStatus: await status(plan.bookingEffectId),
    confirmationStatus: await status(plan.confirmationEffectId),
  };
}
export async function createRecruitingSchedulingPlan(
  prisma: PrismaClient,
  actor: Actor,
  raw: RecruitingSchedulingPlanInput,
) {
  const input = RecruitingSchedulingPlanInputSchema.parse(raw);
  const workspace = await scope(prisma, actor, input.threadId);
  return prisma.$transaction(async (tx) => {
    const read = await verify(tx, actor, input, workspace);
    const canonical = { ...input, originalEmail: read.originalEmail };
    const key = `recruiting-scheduling:${actor.spaceId}:${actor.userId}:${createHash("sha256").update(stableJsonValue(canonical)).digest("hex")}`;
    const prior = await tx.externalEffect.findUnique({ where: { idempotencyKey: key } });
    if (prior) return projection(prior);
    return projection(
      await tx.externalEffect.create({
        data: {
          spaceId: actor.spaceId,
          runId: read.availability.runId,
          kind: KIND,
          idempotencyKey: key,
          status: "draft",
          request: {
            input: canonical,
            roleTitle: workspace.role.title,
            mailSourceRevision: read.mailSourceRevision,
            mailSourceId: read.mailSourceId,
            mailRead: read.mailRead,
          } as Prisma.InputJsonValue,
          result: { bookingEffectId: null, confirmationEffectId: null },
        },
      }),
    );
  });
}
/**
 * The agent's way to draft a plan: it names the candidate email it read and the time it picked,
 * and the saved mail and availability reads of this conversation supply the exact references.
 * The plan is then verified exactly like one drafted from the workbench.
 */
export async function prepareRecruitingSchedulingPlan(
  prisma: PrismaClient,
  actor: Actor,
  input: RecruitingSchedulingPrepareInput & { threadId: string },
) {
  const workspace = await scope(prisma, actor, input.threadId);
  const rows = await prisma.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      status: "completed",
      run: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        threadId: input.threadId,
        initialRecruitingRoleRevisionId: workspace.role.currentRevisionId,
      },
    },
    include: { run: true },
    orderBy: { createdAt: "desc" },
    take: LIMIT,
  });
  const start = Date.parse(input.start);
  let mail: (typeof rows)[number] | undefined;
  let slot: ReturnType<typeof slots>[number] | undefined;
  for (const row of rows) {
    try {
      const native = call(row.request);
      if (
        !mail &&
        row.run.sourceMessageId &&
        ["get_email", "native_instantly_get_email"].includes(native.route.toolName) &&
        native.args.id === input.emailId
      ) {
        successful(row);
        mail = row;
      } else if (!slot && native.route.toolName === "get_availability")
        slot = slots(row).find(
          (value) =>
            Date.parse(value.start) === start &&
            value.lengthInMinutes === input.lengthInMinutes &&
            (input.eventTypeId === undefined || value.eventTypeId === input.eventTypeId),
        );
    } catch (error) {
      if (!(error instanceof IsolationError)) throw error;
    }
    if (mail && slot) break;
  }
  if (!mail)
    throw new IsolationError(
      "Read the candidate's email (get_email with this id) in this conversation first",
    );
  if (!slot)
    throw new IsolationError(
      "No calendar availability read in this conversation offers that start and length; read availability (format range, duration) first",
    );
  const native = call(mail.request);
  const email = successful(mail);
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const sender = text(email.from_address_email);
  if (!sender) throw new IsolationError("The email has no sender");
  return createRecruitingSchedulingPlan(prisma, actor, {
    threadId: input.threadId,
    roleId: workspace.role.id,
    expectedRoleRevision: workspace.role.revision,
    originalEmail: {
      threadId: input.threadId,
      roleId: workspace.role.id,
      emailId: `${native.route.resourceId}:${input.emailId}`,
      sourceId: native.route.resourceId,
      providerMessageId: input.emailId,
      providerThreadId: text(email.thread_id),
      campaignId: text(email.campaign_id),
      eaccount: text(email.eaccount),
      savedRead: {
        messageId: mail.run.sourceMessageId!,
        linkedRunId: mail.runId,
        effectId: mail.id,
      },
      sourceName: "",
      sender,
      subject: text(email.subject) ?? "",
      date: null,
      snippet: false,
    },
    candidate: { ...input.candidate, email: sender },
    interviewer: input.interviewer,
    calendar: slot,
  });
}
export async function loadVerifiedRecruitingSchedulingPlan(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; planId: string },
) {
  const workspace = await scope(prisma, actor, input.threadId);
  return prisma.$transaction(async (tx) => {
    const row = await effect(tx, actor, input.threadId, input.planId);
    if (row.kind !== KIND || row.status !== "draft") throw new IsolationError();
    const plan = projection(row);
    const verified = await verify(
      tx,
      actor,
      RecruitingSchedulingPlanInputSchema.parse(obj(row.request)?.input),
      workspace,
      plan,
    );
    if (
      verified.mailSourceRevision !== plan.mailSourceRevision ||
      verified.mailSourceId !== plan.mailSourceId ||
      stableJsonValue(verified.originalEmail) !== stableJsonValue(plan.originalEmail)
    )
      throw new IsolationError();
    return outcome(tx, actor, plan, row.result);
  });
}
export async function listRecruitingSchedulingPlans(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string },
) {
  const workspace = await scope(prisma, actor, input.threadId);
  const rows = await prisma.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      run: { userId: actor.userId, spaceId: actor.spaceId, threadId: input.threadId },
    },
    include: { run: true },
    orderBy: { createdAt: "desc" },
    take: LIMIT + 1,
  });
  const plans: RecruitingSchedulingPlan[] = [];
  const available: Array<ReturnType<typeof slots>[number] & { observedAt: string }> = [];
  for (const row of rows.slice(0, LIMIT)) {
    try {
      if (row.kind === KIND)
        plans.push(
          await loadVerifiedRecruitingSchedulingPlan(prisma, actor, {
            threadId: input.threadId,
            planId: row.id,
          }),
        );
      else if (row.run.initialRecruitingRoleRevisionId === workspace.role.currentRevisionId) {
        await prisma.$transaction((tx) =>
          grant(tx, actor, row, ["get_availability", "create_booking", "get_booking"]),
        );
        available.push(
          ...slots(row).map((slot) => ({ ...slot, observedAt: row.updatedAt.toISOString() })),
        );
      }
    } catch (error) {
      if (!(error instanceof IsolationError)) throw error;
    }
  }
  const current = await scope(prisma, actor, input.threadId);
  if (current.role.id !== workspace.role.id || current.role.revision !== workspace.role.revision)
    throw new IsolationError();
  return { plans, slots: available, partial: rows.length > LIMIT };
}
export async function bindRecruitingSchedulingOperation(
  prisma: PrismaClient,
  actor: Actor,
  input: { threadId: string; planId: string; operation: "book" | "confirm"; effectId: string },
) {
  const workspace = await scope(prisma, actor, input.threadId);
  return prisma.$transaction(async (tx) => {
    await lockScope(tx, actor, {
      threadId: input.threadId,
      roleId: workspace.role.id,
      expectedRoleRevision: workspace.role.revision,
    });
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM external_effects WHERE id=${input.planId} FOR UPDATE`,
    );
    const row = await effect(tx, actor, input.threadId, input.planId);
    if (row.kind !== KIND) throw new IsolationError();
    const plan = projection(row);
    const verified = await verify(
      tx,
      actor,
      RecruitingSchedulingPlanInputSchema.parse(obj(row.request)?.input),
      workspace,
      plan,
    );
    if (
      verified.mailSourceRevision !== plan.mailSourceRevision ||
      verified.mailSourceId !== plan.mailSourceId ||
      stableJsonValue(verified.originalEmail) !== stableJsonValue(plan.originalEmail)
    )
      throw new IsolationError();
    const operation = await effect(tx, actor, input.threadId, input.effectId);
    if (
      operation.run.initialRecruitingRoleRevisionId !== workspace.role.currentRevisionId ||
      !["intended", "approved", "executing", "completed", "uncertain", "failed"].includes(
        operation.status,
      )
    )
      throw new IsolationError();
    const native = await grant(tx, actor, operation);
    const key = input.operation === "book" ? "bookingEffectId" : "confirmationEffectId";
    const fingerprint = (value: RecruitingSchedulingPlan) =>
      stableJsonValue([
        value.threadId,
        value.roleId,
        value.originalEmail.providerMessageId,
        value.mailSourceId,
        value.mailSourceRevision,
        value.candidate.email.toLowerCase(),
        value.calendar.sourceId,
        value.calendar.sourceRevision,
        value.calendar.eventTypeId,
        Date.parse(value.calendar.start),
        Date.parse(value.calendar.end),
      ]);
    const siblings = await tx.externalEffect.findMany({
      where: {
        kind: KIND,
        spaceId: actor.spaceId,
        run: { spaceId: actor.spaceId, userId: actor.userId, threadId: input.threadId },
        AND: [
          {
            request: {
              path: ["input", "originalEmail", "providerMessageId"],
              equals: plan.originalEmail.providerMessageId,
            },
          },
          {
            request: {
              path: ["input", "calendar", "eventTypeId"],
              equals: plan.calendar.eventTypeId,
            },
          },
        ],
      },
      take: LIMIT + 1,
    });
    if (siblings.length > LIMIT)
      throw new IsolationError("Scheduling operation history is incomplete");
    for (const sibling of siblings) {
      const other = projection(sibling);
      if (other.id !== plan.id && fingerprint(other) === fingerprint(plan) && other[key])
        throw new IsolationError(
          "This original email and interval already have an operation; reconcile its existing outcome",
        );
    }
    const inverse = await tx.externalEffect.findFirst({
      where: {
        kind: KIND,
        spaceId: actor.spaceId,
        id: { not: plan.id },
        run: { spaceId: actor.spaceId, userId: actor.userId, threadId: input.threadId },
        OR: [
          { result: { path: ["bookingEffectId"], equals: operation.id } },
          { result: { path: ["confirmationEffectId"], equals: operation.id } },
        ],
      },
    });
    if (inverse)
      throw new IsolationError("This operation already belongs to another scheduling plan");
    const requestHash = createHash("sha256")
      .update(stableJsonValue(operation.request))
      .digest("hex");
    const hashKey = input.operation === "book" ? "bookingRequestHash" : "confirmationRequestHash";
    if (plan[key] && obj(row.result)?.[hashKey] !== requestHash)
      throw new IsolationError("The bound operation request changed");

    if (!plan[key] && !["intended", "approved"].includes(operation.status))
      throw new IsolationError("Only a new reviewed operation may be linked");
    if (plan[key] && plan[key] !== operation.id)
      throw new IsolationError(
        "This plan already has an operation; reconcile its existing outcome",
      );
    if (input.operation === "book") {
      const attendee = obj(native.args.attendee);
      if (
        native.route.toolName !== "create_booking" ||
        native.route.resourceId !== plan.calendar.sourceId ||
        native.route.resourceRevision !== plan.calendar.sourceRevision ||
        native.args.eventTypeId !== plan.calendar.eventTypeId ||
        native.args.start !== plan.calendar.start ||
        native.args.lengthInMinutes !== plan.calendar.lengthInMinutes ||
        attendee?.email !== plan.candidate.email ||
        attendee?.timeZone !== plan.candidate.timeZone
      )
        throw new IsolationError();
    } else {
      if (!plan.bookingEffectId) throw new IsolationError();
      const booking = await effect(tx, actor, input.threadId, plan.bookingEffectId);
      await grant(tx, actor, booking);
      if (
        obj(row.result)?.bookingRequestHash !==
        createHash("sha256").update(stableJsonValue(booking.request)).digest("hex")
      )
        throw new IsolationError("The bound booking request changed");
      const booked = obj(successful(booking).data);
      if (!booked || typeof booked.uid !== "string") throw new IsolationError();
      // A read of A cannot authorize confirmation after A was changed elsewhere. The
      // provider UID belongs to this owner/source, not just the plan's current thread.
      const mutations = await tx.externalEffect.findMany({
        where: {
          spaceId: actor.spaceId,
          id: { not: booking.id },
          status: { in: ["executing", "uncertain", "completed", "failed"] },
          updatedAt: { gte: booking.updatedAt },
          run: { spaceId: actor.spaceId, userId: actor.userId },
          OR: [
            {
              AND: [
                { request: { path: ["2", "route", "resourceId"], equals: plan.calendar.sourceId } },
                {
                  request: {
                    path: ["2", "route", "resourceRevision"],
                    equals: plan.calendar.sourceRevision,
                  },
                },
                { request: { path: ["2", "args", "bookingUid"], equals: booked.uid } },
              ],
            },
            {
              AND: [
                { request: { path: ["3", "resourceId"], equals: plan.calendar.sourceId } },
                {
                  request: {
                    path: ["3", "resourceRevision"],
                    equals: plan.calendar.sourceRevision,
                  },
                },
                { request: { path: ["2", "arguments", "bookingUid"], equals: booked.uid } },
              ],
            },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: LIMIT + 1,
      });
      if (mutations.length > LIMIT)
        throw new IsolationError("Booking mutation history is incomplete");
      let observedAfter = booking.updatedAt;
      for (const mutation of mutations) {
        const parsed = call(mutation.request);
        if (
          parsed.route.resourceId !== plan.calendar.sourceId ||
          parsed.route.resourceRevision !== plan.calendar.sourceRevision ||
          parsed.args.bookingUid !== booked.uid ||
          ![
            "cancel_booking",
            "reschedule_booking",
            "confirm_booking",
            "add_booking_attendee",
          ].includes(parsed.route.toolName)
        )
          continue;
        const envelope = obj(mutation.result);
        const body = envelope && mcpObject(envelope);
        const unresolved = [envelope, body, obj(body?.result)].some(
          (value) => value?.uncertain === true,
        );
        if (mutation.status === "executing" || mutation.status === "uncertain" || unresolved)
          throw new IsolationError(
            "Reconcile the existing booking change before confirming this plan",
          );
        if (mutation.updatedAt > observedAfter) observedAfter = mutation.updatedAt;
        let result: Record<string, unknown> | undefined;
        try {
          result = successful(mutation);
        } catch (error) {
          if (!(error instanceof IsolationError)) throw error;
        }
        const changed = obj(result?.data);
        if (
          result?.status === "success" &&
          changed &&
          ((parsed.route.toolName === "cancel_booking" &&
            changed.uid === booked.uid &&
            changed.status === "cancelled") ||
            (parsed.route.toolName === "reschedule_booking" &&
              typeof changed.uid === "string" &&
              ((changed.uid !== booked.uid && changed.rescheduledFromUid === booked.uid) ||
                (changed.uid === booked.uid &&
                  typeof changed.start === "string" &&
                  Date.parse(changed.start) !== Date.parse(plan.calendar.start)))))
        )
          throw new IsolationError(
            "This immutable plan's original booking was cancelled or superseded",
          );
      }
      const reads = await tx.externalEffect.findMany({
        where: {
          spaceId: actor.spaceId,
          createdAt: { gt: observedAfter },
          run: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            threadId: input.threadId,
            initialRecruitingRoleRevisionId: workspace.role.currentRevisionId,
          },
        },
        include: { run: true },
        orderBy: { createdAt: "desc" },
        take: LIMIT + 1,
      });
      if (reads.length > LIMIT) throw new IsolationError("Booking readback history is incomplete");
      let readback = false;
      for (const read of reads) {
        let parsed: ReturnType<typeof call>;
        try {
          parsed = call(read.request);
        } catch (error) {
          if (error instanceof IsolationError) continue;
          throw error;
        }
        if (
          parsed.route.toolName !== "get_booking" ||
          parsed.route.resourceId !== plan.calendar.sourceId ||
          parsed.route.resourceRevision !== plan.calendar.sourceRevision ||
          parsed.args.bookingUid !== booked.uid
        )
          continue;
        await grant(tx, actor, read);
        const actual = obj(successful(read).data);
        readback = Boolean(
          actual?.uid === booked.uid &&
            actual.status === "accepted" &&
            Date.parse(String(actual.start)) === Date.parse(plan.calendar.start) &&
            Date.parse(String(actual.end)) === Date.parse(plan.calendar.end) &&
            Array.isArray(actual.attendees) &&
            actual.attendees.some((value) => obj(value)?.email === plan.candidate.email) &&
            Array.isArray(actual.hosts) &&
            actual.hosts.some((value) => obj(value)?.email === plan.interviewer.email),
        );
        break;
      }
      if (
        !readback ||
        !["reply_to_email", "native_instantly_reply_to_email"].includes(native.route.toolName) ||
        native.route.resourceId !== plan.mailSourceId ||
        native.route.resourceRevision !== plan.mailSourceRevision ||
        native.args.reply_to_uuid !== plan.originalEmail.providerMessageId ||
        native.args.eaccount !== plan.originalEmail.eaccount
      )
        throw new IsolationError();
    }
    return projection(
      await tx.externalEffect.update({
        where: { id: row.id },
        data: {
          result: {
            bookingRequestHash:
              typeof obj(row.result)?.bookingRequestHash === "string"
                ? String(obj(row.result)?.bookingRequestHash)
                : null,
            confirmationRequestHash:
              typeof obj(row.result)?.confirmationRequestHash === "string"
                ? String(obj(row.result)?.confirmationRequestHash)
                : null,
            [hashKey]: requestHash,
            bookingEffectId: plan.bookingEffectId,
            confirmationEffectId: plan.confirmationEffectId,
            [key]: operation.id,
          },
        },
      }),
    );
  });
}
