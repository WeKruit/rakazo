import { createHash, randomUUID } from "node:crypto";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { answerRunInput } from "./events.js";
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;
const hash = (value: unknown) => createHash("sha256").update(stableJsonValue(value)).digest("hex");

describePostgres("calendar approval evidence transactions (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let sourceId: string;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
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
    const source = await prisma.mcpServer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        slug: "synthetic-calendar",
        name: "Synthetic calendar",
        transport: "http",
        endpoint: "https://mcp.cal.com/mcp",
      },
    });
    sourceId = source.id;
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

  async function fixture(toolName: string, mode = "valid") {
    const { spaceId, userId, botId, threadId } = identity;
    await prisma.run.updateMany({
      where: { threadId, status: { in: ["queued", "waiting_input"] } },
      data: { status: "cancelled" },
    });
    const task = await prisma.task.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId,
        prompt: "Synthetic calendar approval",
        status: "waiting_input",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId,
        userId,
        botId,
        threadId,
        taskId: task.id,
        status: "waiting_input",
        trigger: "user",
      },
    });
    const route = { connectorId: "mcp", resourceId: sourceId, resourceRevision: 1, toolName };
    const request = [
      "__rakazoCatalogTool",
      "direct",
      {
        route,
        args: {
          bookingUid: "synthetic-booking",
          ...(toolName === "reschedule_booking" ? { start: "2026-11-01T06:30:00Z" } : {}),
        },
      },
    ];
    const evidence = {
      kind: "cal_booking_original",
      version: 1,
      route,
      requestHash: hash(request),
      snapshot: {
        uid: "synthetic-booking",
        eventTypeId: 42,
        start: "2026-11-01T05:30:00Z",
        end: "2026-11-01T06:00:00Z",
        status: "accepted",
        attendees: [{ email: "candidate@example.test" }],
        hosts: [{ email: "host@example.test" }],
      },
    };
    const approvalEvidenceHash = hash(evidence);
    if (mode === "tampered") evidence.snapshot.uid = "different-booking";
    if (mode === "wrong-request") evidence.requestHash = "0".repeat(64);
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: run.id,
        kind: toolName,
        idempotencyKey: randomUUID(),
        status: "intended",
        request,
        ...(mode === "missing-proof" || mode === "legacy"
          ? {}
          : { result: { calendarApprovalEvidence: evidence } }),
      },
    });
    const message = await createThreadMessage(prisma, {
      threadId,
      botId,
      runId: run.id,
      role: "bot",
      blocks: [
        {
          kind: "ask",
          text: "Confirm synthetic calendar change",
          status: "pending",
          approvalEffectId: effect.id,
          ...(mode === "legacy" || mode === "missing-hash" ? {} : { approvalEvidenceHash }),
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    });
    return {
      effect,
      run,
      message,
      approvalEvidenceHash,
      input: {
        spaceId,
        threadId,
        runId: run.id,
        messageId: message.id,
        answeredByUserId: userId,
        answer: "allow",
      },
    };
  }

  it.each(["reschedule_booking", "cancel_booking"])(
    "persists exact evidence hash for %s and claims a concurrent answer once",
    async (toolName) => {
      const f = await fixture(toolName);
      const answers = await Promise.all([
        answerRunInput(prisma, f.input),
        answerRunInput(prisma, f.input),
      ]);
      expect(answers.filter(Boolean)).toHaveLength(1);
      expect(
        (await prisma.externalEffect.findUniqueOrThrow({ where: { id: f.effect.id } })).status,
      ).toBe("approved");
      expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
        "queued",
      );
      const events = await prisma.event.findMany({
        where: { runId: f.run.id, type: "effect.approval.answered" },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ approvalEvidenceHash: f.approvalEvidenceHash });
      expect(
        await prisma.event.count({ where: { runId: f.run.id, type: "thread.message.updated" } }),
      ).toBe(1);
      expect(await prisma.run.count({ where: { taskId: f.run.taskId } })).toBe(1);
    },
  );

  it.each(
    ["tampered", "wrong-request", "missing-proof", "missing-hash", "legacy"].flatMap((mode) =>
      ["reschedule_booking", "cancel_booking"].map((tool) => [tool, mode]),
    ),
  )("rejects %s evidence %s without partial transaction writes", async (tool, mode) => {
    const f = await fixture(tool!, mode);
    expect(await answerRunInput(prisma, f.input)).toBe(false);
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: f.effect.id } })).status,
    ).toBe("intended");
    expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
      "waiting_input",
    );
    expect(
      (await prisma.message.findUniqueOrThrow({ where: { id: f.message.id } })).blocks,
    ).toEqual(f.message.blocks);
    expect(await prisma.event.count({ where: { runId: f.run.id } })).toBe(0);
    // A stale approval remains dismissible without authorizing its external action.
    expect(await answerRunInput(prisma, { ...f.input, answer: "deny" })).toBe(true);
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: f.effect.id } })).status,
    ).toBe("denied");
  });
});
