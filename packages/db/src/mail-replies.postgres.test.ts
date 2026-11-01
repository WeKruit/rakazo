import { createHash, randomUUID } from "node:crypto";
import type { Actor, MailReply } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { boundDirectApprovalRequest } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Prisma, type PrismaClient } from "./client.js";
import { answerRunInput } from "./events.js";
import { projectMailReplyCards, publishMailReplyCard } from "./mail-replies.js";
import { createThreadMessage } from "./messages.js";
import { provisionMessagingIdentity } from "./messaging.js";

const url = process.env.DATABASE_URL;
const pg = process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;
pg("one persisted editable mail approval (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  const address = `+1666${Math.floor(Math.random() * 9000000 + 1000000)}`;
  beforeAll(async () => {
    const db = createDb(url!);
    prisma = db.prisma;
    close = async () => {
      await prisma.$disconnect();
      await db.pool.end();
    };
    identity = await provisionMessagingIdentity(
      prisma,
      { provider: "sendblue", address },
      { signupsEnabled: undefined, signupAllowlist: undefined },
    );
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
  async function fixture() {
    const { userId, spaceId, threadId, botId } = identity;
    await prisma.run.updateMany({
      where: { threadId, status: { in: ["waiting_input", "queued"] } },
      data: { status: "cancelled" },
    });
    const task = await prisma.task.create({
      data: {
        userId,
        spaceId,
        threadId,
        botId,
        prompt: "Reply with the reviewed text",
        status: "waiting_input",
      },
    });
    const run = await prisma.run.create({
      data: {
        userId,
        spaceId,
        threadId,
        botId,
        taskId: task.id,
        status: "waiting_input",
        trigger: "user",
      },
    });
    const draft: MailReply = {
      from: "sender@example.test",
      to: ["candidate@example.test"],
      cc: [],
      bcc: [],
      subject: "Re: Original",
      body: "Original draft",
      inReplyTo: {
        sourceId: "mail",
        emailId: "anchor",
        threadId: "mail-thread",
        subject: "Original",
        sender: "candidate@example.test",
      },
      status: "needs_approval",
      sentAt: null,
    };
    const request = boundDirectApprovalRequest(
      { connectorId: "mcp", resourceId: "mail", resourceRevision: 1, toolName: "reply_to_email" },
      {
        reply_to_uuid: "anchor",
        eaccount: draft.from,
        to: draft.to[0],
        subject: draft.subject,
        body_text: draft.body,
        skip_validation: false,
      },
      "__rakazoCatalogTool",
    );
    const effect = await prisma.externalEffect.create({
      data: {
        spaceId,
        runId: run.id,
        kind: "mcp__mail__reply_to_email",
        idempotencyKey: randomUUID(),
        status: "intended",
        request: request as Prisma.InputJsonValue,
        result: { mailReplyApproval: draft },
      },
    });
    const message = await createThreadMessage(prisma, {
      threadId,
      runId: run.id,
      botId,
      role: "bot",
      blocks: [
        {
          kind: "ask",
          text: "Reply",
          approvalEffectId: effect.id,
          mailReply: draft,
          status: "pending",
          actions: [
            { id: "allow", label: "Send" },
            { id: "deny", label: "Discard" },
          ],
        },
      ],
    });
    const actor: Actor = { userId, spaceId, email: "owner@example.test", isDeploymentOwner: false };
    return {
      effect,
      message,
      run,
      actor,
      input: { spaceId, threadId, runId: run.id, messageId: message.id, answeredByUserId: userId },
    };
  }
  it("concurrently accepts Send once, preserves the identity, and publishes its terminal receipt on the original card", async () => {
    const f = await fixture();
    const answer = {
      action: "send" as const,
      body: "The exact edited sentence",
      cc: ["copy@example.test"],
    };
    const results = await Promise.all([
      answerRunInput(prisma, { ...f.input, answer }),
      answerRunInput(prisma, { ...f.input, answer }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const approved = await prisma.externalEffect.findUniqueOrThrow({ where: { id: f.effect.id } });
    expect(approved).toMatchObject({
      id: f.effect.id,
      status: "approved",
      result: { mailReplyApproval: { body: answer.body, cc: answer.cc, status: "sending" } },
    });
    expect(approved.request).toMatchObject([
      "__rakazoCatalogTool",
      "direct",
      {
        args: {
          body_text: answer.body,
          cc_address_email_list: "copy@example.test",
          reply_to_uuid: "anchor",
          eaccount: "sender@example.test",
          to: "candidate@example.test",
        },
      },
    ]);
    expect(await prisma.externalEffect.count({ where: { runId: f.run.id } })).toBe(1);
    expect(
      await prisma.event.count({ where: { runId: f.run.id, type: "effect.approval.answered" } }),
    ).toBe(1);
    await prisma.externalEffect.update({
      where: { id: f.effect.id },
      data: { status: "completed", result: { status: "sent_recorded" } },
    });
    const event = await publishMailReplyCard(prisma, f.actor, f.effect.id);
    expect(event?.type).toBe("thread.message.updated");
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: f.message.id } });
    const blocks = MessageBlockSchema.array().parse(stored.blocks);
    expect(blocks[0]).toMatchObject({
      approvalEffectId: f.effect.id,
      mailReply: { status: "sent", body: answer.body, cc: answer.cc, sentAt: expect.any(String) },
    });
    const projected = await projectMailReplyCards(prisma, f.actor, [
      { id: stored.id, runId: stored.runId!, blocks },
    ]);
    expect(projected[0]?.blocks[0]).toMatchObject({
      mailReply: { status: "sent", canAnswer: false },
    });
    expect(await prisma.message.count({ where: { runId: f.run.id } })).toBe(1);
  });
  it.each(["valid", "stale-hash", "foreign-owner"])(
    "atomically rebinds only the owned unchanged scheduling plan: %s",
    async (mode) => {
      const f = await fixture();
      const hash = (value: unknown) =>
        createHash("sha256").update(stableJsonValue(value)).digest("hex");
      const previousHash = hash(f.effect.request);
      const foreignAddress = `+1555${Math.floor(Math.random() * 9000000 + 1000000)}`;
      const foreign =
        mode === "foreign-owner"
          ? await provisionMessagingIdentity(
              prisma,
              { provider: "sendblue", address: foreignAddress },
              { signupsEnabled: undefined, signupAllowlist: undefined },
            )
          : undefined;
      try {
        const foreignTask = foreign
          ? await prisma.task.create({
              data: {
                userId: foreign.userId,
                spaceId: foreign.spaceId,
                threadId: foreign.threadId,
                botId: foreign.botId,
                prompt: "Foreign scheduling plan",
                status: "completed",
              },
            })
          : undefined;
        const foreignRun = foreign
          ? await prisma.run.create({
              data: {
                userId: foreign.userId,
                spaceId: foreign.spaceId,
                threadId: foreign.threadId,
                botId: foreign.botId,
                taskId: foreignTask!.id,
                trigger: "user",
                status: "completed",
              },
            })
          : undefined;
        const plan = await prisma.externalEffect.create({
          data: {
            spaceId: foreign?.spaceId ?? identity.spaceId,
            runId: foreignRun?.id ?? f.run.id,
            kind: "recruiting_scheduling_plan",
            idempotencyKey: randomUUID(),
            status: "draft",
            request: {
              mailSourceId: "mail",
              mailSourceRevision: 1,
              input: { originalEmail: { providerMessageId: "anchor" } },
            },
            result: {
              confirmationEffectId: f.effect.id,
              bookingEffectId: "booking-proof",
              confirmationRequestHash: mode === "stale-hash" ? "0".repeat(64) : previousHash,
              untouched: "preserve",
            },
          },
        });
        const evidence = {
          kind: "recruiting_scheduling",
          version: 1,
          planId: plan.id,
          operation: "confirm",
          requestHash: previousHash,
          planHash: "a".repeat(64),
          bookingEffectId: "booking-proof",
        };
        await prisma.externalEffect.update({
          where: { id: f.effect.id },
          data: {
            result: {
              mailReplyApproval: (f.effect.result as Prisma.JsonObject).mailReplyApproval!,
              schedulingApprovalEvidence: evidence,
            },
          },
        });
        const blocks = MessageBlockSchema.array().parse(f.message.blocks);
        if (blocks[0]?.kind !== "ask") throw new Error("Missing ask");
        blocks[0].approvalEvidenceHash = hash(evidence);
        await prisma.message.update({ where: { id: f.message.id }, data: { blocks } });
        const answer = {
          action: "send" as const,
          body: "Edited scheduling confirmation",
          cc: ["copy@example.test"],
        };
        if (mode === "valid") {
          expect(await answerRunInput(prisma, { ...f.input, answer })).toBe(true);
          const approved = await prisma.externalEffect.findUniqueOrThrow({
            where: { id: f.effect.id },
          });
          expect(
            (await prisma.externalEffect.findUniqueOrThrow({ where: { id: plan.id } })).result,
          ).toMatchObject({
            confirmationEffectId: f.effect.id,
            bookingEffectId: "booking-proof",
            confirmationRequestHash: hash(approved.request),
            untouched: "preserve",
          });
          expect(hash(approved.request)).not.toBe(previousHash);
        } else {
          await expect(answerRunInput(prisma, { ...f.input, answer })).rejects.toThrow(
            "The bound scheduling confirmation changed",
          );
          const unchanged = await prisma.externalEffect.findUniqueOrThrow({
            where: { id: f.effect.id },
          });
          expect(unchanged.status).toBe("intended");
          expect(hash(unchanged.request)).toBe(previousHash);
          expect((await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).status).toBe(
            "waiting_input",
          );
          expect(
            (await prisma.message.findUniqueOrThrow({ where: { id: f.message.id } })).blocks,
          ).toMatchObject([{ status: "pending", mailReply: { body: "Original draft" } }]);
          expect(
            (await prisma.externalEffect.findUniqueOrThrow({ where: { id: plan.id } })).result,
          ).toEqual(plan.result);
        }
      } finally {
        if (foreign) {
          await prisma.messagingIdentity.deleteMany({
            where: { provider: "sendblue", address: foreignAddress },
          });
          await prisma.organization.deleteMany({ where: { id: foreign.spaceId } });
          await prisma.user.deleteMany({ where: { id: foreign.userId } });
        }
      }
    },
  );
  it("Discard persists on the same message without an approved effect or a send job", async () => {
    const f = await fixture();
    expect(await answerRunInput(prisma, { ...f.input, answer: "deny" })).toBe(true);
    expect(
      (await prisma.externalEffect.findUniqueOrThrow({ where: { id: f.effect.id } })).status,
    ).toBe("denied");
    expect(
      await prisma.externalEffect.count({ where: { runId: f.run.id, status: "approved" } }),
    ).toBe(0);
    const stored = await prisma.message.findUniqueOrThrow({ where: { id: f.message.id } });
    expect(stored.blocks).toMatchObject([
      { mailReply: { status: "discarded", body: "Original draft" } },
    ]);
  });
});
