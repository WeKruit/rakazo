import { randomUUID } from "node:crypto";
import type { Actor, RecruitingSchedulingPlanInput } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb, type Prisma } from "./client.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { createRecruitingRole, openVerifiedRecruitingCrmWorkspace } from "./recruiting.js";
import {
  bindRecruitingSchedulingOperation,
  createRecruitingSchedulingPlan,
  loadVerifiedRecruitingSchedulingPlan,
} from "./recruiting-scheduling.js";

const url = process.env.DATABASE_URL;
const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);
const database = process.env.VERIFY_DATABASE === "1" && local ? describe.sequential : describe.skip;

database("scheduling plan persistence (local PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let actor: Actor;
  let input: RecruitingSchedulingPlanInput;
  let revisionId: string;
  let calendarId: string;
  let mailId: string;
  let runId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const request = (resourceId: string, toolName: string, args: object) => [
    "__rakazoCatalogTool",
    "direct",
    { route: { connectorId: "mcp", resourceId, resourceRevision: 1, toolName }, args },
  ];

  async function effect(
    source: string,
    tool: string,
    args: object,
    result?: object,
    executionRun = runId,
  ) {
    return prisma.externalEffect.create({
      data: {
        spaceId: actor.spaceId,
        runId: executionRun,
        kind: tool,
        idempotencyKey: randomUUID(),
        status: result ? "completed" : "intended",
        request: request(source, tool, args) as Prisma.InputJsonValue,
        ...(result ? { result: { structuredContent: result } as Prisma.InputJsonValue } : {}),
      },
    });
  }
  async function run() {
    const task = await prisma.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: identity.botId,
        threadId: identity.threadId,
        prompt: "Synthetic scheduling",
        status: "running",
      },
    });
    return prisma.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: identity.botId,
        threadId: identity.threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        sourceMessageId: input?.originalEmail.savedRead?.messageId,
        initialRecruitingRoleRevisionId: revisionId,
      },
    });
  }
  beforeAll(async () => {
    const db = createDb(url!);
    prisma = db.prisma;
    close = async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    identity = await provisionMessagingIdentity(
      prisma,
      { provider: "sendblue", address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
    actor = {
      spaceId: identity.spaceId,
      userId: identity.userId,
      email: "owner@example.test",
      isDeploymentOwner: false,
    };
    const message = await prisma.message.create({
      data: {
        threadId: identity.threadId,
        seq: 0,
        role: "user",
        blocks: [{ kind: "text", text: "Hire an engineer" }],
      },
    });
    const created = await createRecruitingRole(prisma, actor, {
      sourceThreadId: identity.threadId,
      expectedRevision: 0,
      title: "Synthetic role",
      sourceRefs: [
        {
          id: "jd",
          kind: "original_material",
          anchor: { kind: "message", messageId: message.id, locator: "text:0" },
          readState: "read",
          readAt: new Date().toISOString(),
        },
      ],
      criteria: [],
      preferences: [],
      definitionQuestions: [],
    });
    revisionId = created.role.currentRevisionId!;
    await prisma.recruitingCandidate.create({
      data: { roleId: created.role.id, candidateKey: "candidate@example.test" },
    });
    for (const kind of ["calendar", "mail"]) {
      const source = await prisma.mcpServer.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          slug: kind,
          name: kind,
          transport: "http",
          endpoint:
            kind === "calendar" ? "https://mcp.cal.com/mcp" : "https://mail.example.test/mcp",
        },
      });
      await prisma.botMcpServer.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          serverId: source.id,
          botId: identity.botId,
          allowAllTools: true,
        },
      });
      if (kind === "calendar") calendarId = source.id;
      else mailId = source.id;
    }
    runId = (await run()).id;
    await prisma.run.update({ where: { id: runId }, data: { sourceMessageId: message.id } });
    const start = "2026-11-01T06:30:00Z",
      end = "2026-11-01T07:00:00Z";
    const availability = await effect(
      calendarId,
      "get_availability",
      { eventTypeId: 42, start, end, duration: 30, format: "range" },
      { status: "success", data: { day: [{ start, end }] } },
    );
    const mail = await effect(
      mailId,
      "get_email",
      { id: "original-email" },
      {
        id: "original-email",
        thread_id: "original-thread",
        eaccount: "recruiter@example.test",
        from_address_email: "candidate@example.test",
      },
    );
    input = {
      threadId: identity.threadId,
      roleId: created.role.id,
      expectedRoleRevision: created.role.revision,
      originalEmail: {
        threadId: identity.threadId,
        roleId: created.role.id,
        emailId: "observed-email",
        sourceId: mailId,
        providerMessageId: "original-email",
        providerThreadId: "original-thread",
        eaccount: "recruiter@example.test",
        savedRead: { messageId: message.id, linkedRunId: runId, effectId: mail.id },
        sourceName: "Synthetic mail",
        sender: "candidate@example.test",
        subject: "Interview",
        date: null,
        snippet: false,
      },
      candidate: {
        candidateKey: "candidate@example.test",
        name: "Candidate",
        email: "candidate@example.test",
        timeZone: "America/New_York",
      },
      interviewer: {
        name: "Interviewer",
        email: "recruiter@example.test",
        timeZone: "Europe/London",
      },
      calendar: {
        sourceId: calendarId,
        sourceRevision: 1,
        eventTypeId: 42,
        availabilityEffectId: availability.id,
        start,
        end,
        lengthInMinutes: 30,
      },
    };
  });
  afterAll(async () => {
    try {
      if (identity) {
        await prisma.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await prisma.organization.deleteMany({ where: { id: identity.spaceId } });
        await prisma.user.deleteMany({ where: { id: identity.userId } });
      }
    } finally {
      await close?.();
    }
  });

  it("creates one immutable plan under concurrent duplicate requests", async () => {
    const plans = await Promise.all([
      createRecruitingSchedulingPlan(prisma, actor, input),
      createRecruitingSchedulingPlan(prisma, actor, input),
    ]);
    expect(plans[0]!.id).toBe(plans[1]!.id);
    expect(
      await prisma.externalEffect.count({
        where: { spaceId: actor.spaceId, kind: "recruiting_scheduling_plan" },
      }),
    ).toBe(1);
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: plans[0]!.id } })).request,
    ).toMatchObject({ input, mailSourceRevision: 1 });
  });
  it.each(["owner", "role", "source", "mailbox", "thread", "candidate"])(
    "rejects substituted %s evidence without creating a plan",
    async (field) => {
      const changed = structuredClone(input);
      const caller = { ...actor };
      if (field === "owner") caller.userId = "different-owner";
      if (field === "role") changed.roleId = "different-role";
      if (field === "source") changed.originalEmail.sourceId = calendarId;
      if (field === "mailbox") changed.originalEmail.eaccount = "different@example.test";
      if (field === "thread") changed.originalEmail.providerThreadId = "different-thread";
      if (field === "candidate") changed.candidate.email = "different@example.test";
      const before = await prisma.externalEffect.count({
        where: { spaceId: actor.spaceId, kind: "recruiting_scheduling_plan" },
      });
      await expect(createRecruitingSchedulingPlan(prisma, caller, changed)).rejects.toThrow();
      expect(
        await prisma.externalEffect.count({
          where: { spaceId: actor.spaceId, kind: "recruiting_scheduling_plan" },
        }),
      ).toBe(before);
    },
  );
  it("claims one booking across different runs and preserves the same binding on retry", async () => {
    const plan = await createRecruitingSchedulingPlan(prisma, actor, input);
    const args = {
      eventTypeId: 42,
      start: input.calendar.start,
      lengthInMinutes: 30,
      attendee: {
        name: input.candidate.name,
        email: input.candidate.email,
        timeZone: input.candidate.timeZone,
      },
    };
    const first = await effect(calendarId, "create_booking", args);
    const second = await effect(calendarId, "create_booking", args, undefined, (await run()).id);
    const bind = (effectId: string) =>
      bindRecruitingSchedulingOperation(prisma, actor, {
        threadId: input.threadId,
        planId: plan.id,
        operation: "book",
        effectId,
      });
    const outcomes = await Promise.allSettled([bind(first.id), bind(second.id)]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const saved = await loadVerifiedRecruitingSchedulingPlan(prisma, actor, {
      threadId: input.threadId,
      planId: plan.id,
    });
    expect([first.id, second.id]).toContain(saved.bookingEffectId);
    expect((await bind(saved.bookingEffectId!)).bookingEffectId).toBe(saved.bookingEffectId);
    await prisma.externalEffect.update({
      where: { id: saved.bookingEffectId! },
      data: { status: "uncertain", result: { uncertain: true } },
    });
    await expect(bind(saved.bookingEffectId === first.id ? second.id : first.id)).rejects.toThrow();
  });
  it("rejects evidence from a previous role epoch even on the same actor and thread", async () => {
    await prisma.run.update({
      where: { id: runId },
      data: { initialRecruitingRoleRevisionId: null },
    });
    try {
      await expect(createRecruitingSchedulingPlan(prisma, actor, input)).rejects.toThrow();
    } finally {
      await prisma.run.update({
        where: { id: runId },
        data: { initialRecruitingRoleRevisionId: revisionId },
      });
    }
  });
  it("rejects a disabled source and a revoked membership on existing plan reads", async () => {
    const plan = await createRecruitingSchedulingPlan(prisma, actor, input);
    await prisma.mcpServer.update({ where: { id: calendarId }, data: { enabled: false } });
    try {
      await expect(
        loadVerifiedRecruitingSchedulingPlan(prisma, actor, {
          threadId: input.threadId,
          planId: plan.id,
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.mcpServer.update({ where: { id: calendarId }, data: { enabled: true } });
    }
    const member = await prisma.spaceMember.findFirstOrThrow({
      where: { spaceId: actor.spaceId, userId: actor.userId },
    });
    await prisma.spaceMember.delete({ where: { id: member.id } });
    try {
      await expect(
        loadVerifiedRecruitingSchedulingPlan(prisma, actor, {
          threadId: input.threadId,
          planId: plan.id,
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.spaceMember.create({ data: member });
    }
  });
  it("binds one exact-thread confirmation after verified booking readback and never substitutes another mailbox", async () => {
    const start = "2026-11-02T06:30:00Z",
      end = "2026-11-02T07:00:00Z";
    const available = await effect(
      calendarId,
      "get_availability",
      { eventTypeId: 42, start, end, duration: 30, format: "range" },
      { status: "success", data: { day: [{ start, end }] } },
    );
    const confirmationInput = {
      ...input,
      calendar: { ...input.calendar, start, end, availabilityEffectId: available.id },
    };
    const plan = await createRecruitingSchedulingPlan(prisma, actor, {
      ...confirmationInput,
      interviewer: { ...confirmationInput.interviewer, name: "Confirmation test" },
    });
    const booking = await effect(calendarId, "create_booking", {
      eventTypeId: 42,
      start: confirmationInput.calendar.start,
      lengthInMinutes: 30,
      attendee: confirmationInput.candidate,
    });
    await bindRecruitingSchedulingOperation(prisma, actor, {
      threadId: confirmationInput.threadId,
      planId: plan.id,
      operation: "book",
      effectId: booking.id,
    });
    const booked = {
      uid: "synthetic-booking",
      status: "accepted",
      start: confirmationInput.calendar.start,
      end: confirmationInput.calendar.end,
      attendees: [confirmationInput.candidate],
      hosts: [confirmationInput.interviewer],
    };
    await prisma.externalEffect.update({
      where: { id: booking.id },
      data: {
        status: "completed",
        result: { structuredContent: { status: "success", data: booked } },
      },
    });
    const args = {
      reply_to_uuid: "original-email",
      eaccount: "recruiter@example.test",
      body: { text: "Confirmed" },
    };
    const first = await effect(mailId, "native_instantly_reply_to_email", args);
    const second = await effect(
      mailId,
      "native_instantly_reply_to_email",
      args,
      undefined,
      (await run()).id,
    );
    const bind = (effectId: string) =>
      bindRecruitingSchedulingOperation(prisma, actor, {
        threadId: confirmationInput.threadId,
        planId: plan.id,
        operation: "confirm",
        effectId,
      });
    await expect(bind(first.id)).rejects.toThrow();
    await effect(
      calendarId,
      "get_booking",
      { bookingUid: booked.uid },
      { status: "success", data: booked },
    );
    const wrong = await effect(mailId, "native_instantly_reply_to_email", {
      ...args,
      eaccount: "wrong@example.test",
    });
    await expect(bind(wrong.id)).rejects.toThrow();
    const outcomes = await Promise.allSettled([bind(first.id), bind(second.id)]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const saved = await loadVerifiedRecruitingSchedulingPlan(prisma, actor, {
      threadId: confirmationInput.threadId,
      planId: plan.id,
    });
    expect(saved.bookingEffectId).toBe(booking.id);
    expect([first.id, second.id]).toContain(saved.confirmationEffectId);
    expect((await bind(saved.confirmationEffectId!)).confirmationEffectId).toBe(
      saved.confirmationEffectId,
    );
    await prisma.externalEffect.update({
      where: { id: saved.confirmationEffectId! },
      data: { status: "uncertain", result: { uncertain: true } },
    });
    await expect(
      bind(saved.confirmationEffectId === first.id ? second.id : first.id),
    ).rejects.toThrow();
  });
  it("rejects a replaced mail source epoch even when the retained read is rewritten to the new epoch", async () => {
    const plan = await createRecruitingSchedulingPlan(prisma, actor, input);
    const id = input.originalEmail.savedRead!.effectId;
    const mail = await prisma.externalEffect.findUniqueOrThrow({ where: { id } });
    const changed = structuredClone(mail.request) as unknown as [
      string,
      string,
      { route: { resourceRevision: number } },
    ];
    changed[2].route.resourceRevision = 2;
    await prisma.mcpServer.update({ where: { id: mailId }, data: { revision: 2 } });
    await prisma.externalEffect.update({
      where: { id },
      data: { request: changed as Prisma.InputJsonValue },
    });
    try {
      await expect(
        loadVerifiedRecruitingSchedulingPlan(prisma, actor, {
          threadId: input.threadId,
          planId: plan.id,
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.mcpServer.update({ where: { id: mailId }, data: { revision: 1 } });
      await prisma.externalEffect.update({
        where: { id },
        data: { request: mail.request as Prisma.InputJsonValue },
      });
    }
  });
  async function legacyFixture() {
    if ((await prisma.bot.count({ where: { spaceId: actor.spaceId, userId: actor.userId } })) < 2)
      await prisma.bot.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: "Second assistant",
          color: "blue",
        },
      });
    const server = await prisma.mcpServer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        slug: `legacy-${randomUUID()}`,
        name: "Legacy CRM",
        transport: "http",
      },
    });
    const botIds = (
      await prisma.bot.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true },
      })
    ).map((bot) => bot.id);
    await prisma.botMcpServer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        serverId: server.id,
        botId: identity.botId,
        allowAllTools: true,
      },
    });
    const target = {
      mcpServerId: server.id,
      serverRevision: 1,
      organizationId: randomUUID(),
      crmRoleId: randomUUID(),
      crmClientId: randomUUID(),
      clientLabel: "Client",
      roleLabel: "Legacy role",
    };
    const opened = await openVerifiedRecruitingCrmWorkspace(prisma, actor, {
      target,
      verifiedBotId: identity.botId,
      botIds,
      roleText: "Existing synthetic role",
    });
    const role = await prisma.recruitingRole.findUniqueOrThrow({ where: { id: opened.roleId } });
    const candidateId = randomUUID(),
      campaignId = randomUUID();
    const projectionScope = {
      spaceId: actor.spaceId,
      userId: actor.userId,
      mcpServerId: server.id,
      organizationId: target.organizationId,
    };
    const projected = await prisma.recruitingCrmRole.create({
      data: {
        ...projectionScope,
        crmRoleId: target.crmRoleId,
        clientId: target.crmClientId,
        clientLabel: target.clientLabel,
        roleLabel: target.roleLabel,
        syncedAt: new Date(),
      },
    });
    const contact = await prisma.recruitingCrmContact.create({
      data: {
        ...projectionScope,
        crmCandidateId: candidateId,
        name: "Candidate",
        email: input.candidate.email,
        contactStatus: "unknown",
        outreachStatus: "unknown",
        clientLabel: target.clientLabel,
        roleLabel: target.roleLabel,
        syncedAt: new Date(),
      },
    });
    await prisma.recruitingCrmRoleContact.create({
      data: { roleId: projected.id, contactId: contact.id, syncedAt: new Date() },
    });
    const task = await prisma.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: identity.botId,
        threadId: opened.threadId,
        prompt: "Read selected legacy correspondence",
        status: "running",
      },
    });
    const execution = await prisma.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: identity.botId,
        threadId: opened.threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        initialRecruitingRoleRevisionId: role.currentRevisionId,
      },
    });
    const providerMessageId = randomUUID(),
      providerThreadId = randomUUID();
    await prisma.recruitingCrmMessage.create({
      data: {
        ...projectionScope,
        crmMessageId: providerMessageId,
        crmCandidateId: candidateId,
        crmRoleId: target.crmRoleId,
        threadId: providerThreadId,
        direction: "received",
        sender: input.candidate.email,
        recipients: ["recruiter@example.test"],
        syncedAt: new Date(),
      },
    });
    const email = {
      id: providerMessageId,
      thread_id: providerThreadId,
      eaccount: "recruiter@example.test",
      campaign_id: campaignId,
      from_address_email: input.candidate.email,
    };
    const mail = await effect(mailId, "get_email", { id: providerMessageId }, email, execution.id);
    const availability = await effect(
      calendarId,
      "get_availability",
      {
        eventTypeId: 42,
        start: input.calendar.start,
        end: input.calendar.end,
        duration: 30,
        format: "range",
      },
      {
        status: "success",
        data: { day: [{ start: input.calendar.start, end: input.calendar.end }] },
      },
      execution.id,
    );
    const legacy: RecruitingSchedulingPlanInput = {
      ...structuredClone(input),
      threadId: opened.threadId,
      roleId: opened.roleId,
      expectedRoleRevision: role.revision,
      candidate: { ...input.candidate, candidateKey: candidateId },
      calendar: { ...input.calendar, availabilityEffectId: availability.id },
      originalEmail: {
        ...input.originalEmail,
        threadId: opened.threadId,
        roleId: opened.roleId,
        sourceId: server.id,
        savedRead: null,
        providerMessageId,
        providerThreadId,
        campaignId,
        crm: {
          serverRevision: 1,
          organizationId: target.organizationId,
          crmRoleId: target.crmRoleId,
          candidateId,
          threadId: providerThreadId,
          campaignId,
          direction: "received",
          eaccount: "recruiter@example.test",
        },
      },
    };
    return { legacy, server, mail, email, execution, target };
  }
  it("adopts one exact native mail read for a legacy CRM attachment without earlier chat", async () => {
    const f = await legacyFixture();
    expect(await prisma.message.count({ where: { threadId: f.legacy.threadId } })).toBe(0);
    expect(f.legacy.originalEmail.savedRead).toBeNull();
    expect(f.legacy.originalEmail.sourceId).not.toBe(mailId);
    const plan = await createRecruitingSchedulingPlan(prisma, actor, f.legacy);
    expect(plan.originalEmail.providerMessageId).toBe(f.email.id);
    expect(plan.originalEmail.providerThreadId).toBe(f.email.thread_id);
    expect(plan.originalEmail.eaccount).toBe(f.email.eaccount);
    expect(plan.originalEmail.sourceId).toBe(f.server.id);
    expect(plan.originalEmail.savedRead).toBeNull();
    expect(plan.mailSourceId).toBe(mailId);
    expect(plan.mailRead.effectId).toBe(f.mail.id);
    expect(plan.mailRead.messageId).toBeNull();
  });
  it.each(["organization", "campaign", "missing-message", "mailbox"])(
    "rejects a foreign legacy %s without adopting the native read",
    async (field) => {
      const f = await legacyFixture();
      if (field === "organization") f.legacy.originalEmail.crm!.organizationId = randomUUID();
      else if (field === "missing-message")
        await prisma.recruitingCrmMessage.deleteMany({ where: { mcpServerId: f.server.id } });
      else if (field === "mailbox") {
        f.legacy.originalEmail.eaccount = "foreign@example.test";
        f.legacy.originalEmail.crm!.eaccount = "foreign@example.test";
      } else {
        f.legacy.originalEmail.campaignId = randomUUID();
        f.legacy.originalEmail.crm!.campaignId = f.legacy.originalEmail.campaignId;
      }
      await expect(createRecruitingSchedulingPlan(prisma, actor, f.legacy)).rejects.toThrow();
      expect(
        await prisma.externalEffect.count({
          where: { runId: f.execution.id, kind: "recruiting_scheduling_plan" },
        }),
      ).toBe(0);
    },
  );
  it("rejects two equally matching native mail sources instead of choosing one", async () => {
    const f = await legacyFixture();
    const second = await prisma.mcpServer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        slug: `mail-${randomUUID()}`,
        name: "Second mailbox source",
        transport: "http",
        endpoint: "https://second.example.test/mcp",
      },
    });
    await prisma.botMcpServer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        serverId: second.id,
        botId: identity.botId,
        allowAllTools: true,
      },
    });
    await effect(second.id, "get_email", { id: f.email.id }, f.email, f.execution.id);
    await expect(createRecruitingSchedulingPlan(prisma, actor, f.legacy)).rejects.toThrow();
  });
  it("does not bypass an uncertain booking by creating a cosmetically changed plan", async () => {
    const plan = await createRecruitingSchedulingPlan(prisma, actor, {
      ...input,
      interviewer: { ...input.interviewer, name: "Renamed interviewer", timeZone: "UTC" },
    });
    const alternate = await effect(
      calendarId,
      "create_booking",
      {
        eventTypeId: 42,
        start: input.calendar.start,
        lengthInMinutes: 30,
        attendee: input.candidate,
      },
      undefined,
      (await run()).id,
    );
    await expect(
      bindRecruitingSchedulingOperation(prisma, actor, {
        threadId: input.threadId,
        planId: plan.id,
        operation: "book",
        effectId: alternate.id,
      }),
    ).rejects.toThrow();
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: alternate.id } })).status,
    ).toBe("intended");
  });
  it("rejects changed request bytes on a previously bound execution", async () => {
    const plan = await createRecruitingSchedulingPlan(prisma, actor, input);
    const id = plan.bookingEffectId!;
    const original = await prisma.externalEffect.findUniqueOrThrow({ where: { id } });
    const changed = structuredClone(original.request) as unknown as [
      string,
      string,
      { args: Record<string, unknown> },
    ];
    changed[2].args.metadata = { changedAfterBinding: true };
    await prisma.externalEffect.update({
      where: { id },
      data: { request: changed as Prisma.InputJsonValue },
    });
    try {
      await expect(
        bindRecruitingSchedulingOperation(prisma, actor, {
          threadId: input.threadId,
          planId: plan.id,
          operation: "book",
          effectId: id,
        }),
      ).rejects.toThrow();
    } finally {
      await prisma.externalEffect.update({
        where: { id },
        data: { request: original.request as Prisma.InputJsonValue },
      });
    }
  });
});
