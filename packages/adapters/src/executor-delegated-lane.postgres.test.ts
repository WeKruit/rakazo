import { randomUUID } from "node:crypto";
import { boundDirectApprovalRequest } from "@rakazo/core";
import { answerRunInput, createDb, type Prisma, pauseRunForInput } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { messageBot } from "./bot-messages.js";
import { createRunExecutor } from "./executor.js";
import { handoffToGroupBot } from "./group-handoff.js";

it.skipIf(process.env.VERIFY_DATABASE !== "1" || !process.env.DATABASE_URL)(
  "resumes real approved/denied handoffs past their canonical ancestors, preserving unrelated lane blockers",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const p = db.prisma;
    const id = `delegated-lane-${randomUUID()}`;
    const scope = { spaceId: id, userId: id, threadId: id };
    const enqueue = vi.fn(async () => undefined);
    try {
      await p.user.create({ data: { id, name: "Synthetic owner", email: `${id}@test.invalid` } });
      await p.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
      await p.space.create({ data: { id, name: id, organizationId: id } });
      for (const bot of ["main", "child", "specialist", "unrelated"])
        await p.bot.create({
          data: { id: `${id}-${bot}`, spaceId: id, userId: id, name: bot, color: "purple" },
        });
      await p.chatGroup.create({
        data: {
          id,
          spaceId: id,
          userId: id,
          name: "Synthetic team",
          members: {
            create: ["main", "child", "specialist", "unrelated"].map((bot) => ({
              botId: `${id}-${bot}`,
            })),
          },
        },
      });
      await p.thread.create({ data: { id, spaceId: id, userId: id, groupId: id } });
      const task = await p.task.create({
        data: {
          ...scope,
          botId: `${id}-main`,
          prompt: "Delegate the reviewed reply",
          status: "running",
        },
      });
      const main = await p.run.create({
        data: {
          ...scope,
          botId: `${id}-main`,
          taskId: task.id,
          trigger: "tool_background",
          status: "running",
        },
      });
      const older = await p.run.create({
        data: {
          ...scope,
          botId: `${id}-unrelated`,
          taskId: task.id,
          trigger: "bot_message",
          status: "queued",
          createdAt: new Date(0),
        },
      });
      const deps = {
        prisma: p,
        jobs: { enqueue },
        events: { notify: vi.fn(async () => undefined) },
      } as unknown as Parameters<typeof handoffToGroupBot>[0];
      const first = await handoffToGroupBot(deps, main, id, {
        bot_id: `${id}-child`,
        message: "Prepare the reply",
        report_back: true,
      });
      expect(first).toMatchObject({ ok: true });
      if (!("runId" in first) || typeof first.runId !== "string")
        throw new Error("Native handoff did not create its child");
      const child = await p.run.update({
        where: { id: first.runId },
        data: { status: "running", trigger: "tool_background" },
      });
      const unrelated = await p.run.create({
        data: {
          ...scope,
          botId: `${id}-unrelated`,
          taskId: task.id,
          trigger: "routine",
          status: "running",
        },
      });
      const executor = createRunExecutor({
        prisma: p,
        jobs: { enqueue },
        secrets: [],
      } as unknown as Parameters<typeof createRunExecutor>[0]);
      const claimed = "stop after the real lease claim";
      const stop = vi.spyOn(p.run, "findUniqueOrThrow").mockRejectedValue(new Error(claimed));
      for (const answer of ["deny", "send"] as const) {
        let specialistId: string;
        if (answer === "deny") {
          const next = await handoffToGroupBot(deps, child, id, {
            turnKey: answer,
            bot_id: `${id}-specialist`,
            message: "Show the reviewed draft",
            report_back: true,
          });
          if (!("runId" in next) || typeof next.runId !== "string")
            throw new Error("Native nested handoff did not create its child");
          specialistId = next.runId;
        } else {
          expect(
            await messageBot(
              deps,
              child,
              { id: child.botId, name: "child" },
              {
                bot_id: `${id}-specialist`,
                thread_id: id,
                message: "Show the reviewed draft",
                intent: "request",
                deliveryKey: answer,
              },
            ),
          ).toMatchObject({ ok: true });
          specialistId = (
            await p.run.findFirstOrThrow({
              where: {
                threadId: id,
                botId: `${id}-specialist`,
                sourceMessage: { clientNonce: `bot-message:${answer}` },
              },
            })
          ).id;
        }
        const specialist = await p.run.update({
          where: { id: specialistId },
          data: {
            status: "running",
            trigger: "tool_background",
            leaseOwner: "synthetic-worker",
            leaseFence: 1,
          },
        });
        const attempt = await p.attempt.create({
          data: { runId: specialist.id, fence: 1, status: "running" },
        });
        const draft = {
          from: "sender@example.test",
          to: ["candidate@example.test"],
          cc: [],
          bcc: [],
          subject: "Re: Synthetic",
          body: "Reviewed reply",
          inReplyTo: {
            sourceId: "synthetic-mail",
            emailId: "anchor",
            threadId: "mail-thread",
            subject: "Synthetic",
            sender: "candidate@example.test",
          },
          status: "needs_approval" as const,
          sentAt: null,
        };
        const effect = await p.externalEffect.create({
          data: {
            spaceId: id,
            runId: specialist.id,
            kind: "synthetic_reply",
            idempotencyKey: randomUUID(),
            status: "intended",
            request: boundDirectApprovalRequest(
              { connectorId: "mcp", resourceId: "synthetic-mail", toolName: "reply_to_email" },
              {
                reply_to_uuid: "anchor",
                eaccount: draft.from,
                to: draft.to[0],
                subject: draft.subject,
                body_text: draft.body,
                skip_validation: false,
              },
              "__rakazoCatalogTool",
            ) as Prisma.InputJsonValue,
            result: { mailReplyApproval: draft },
          },
        });
        expect(
          await pauseRunForInput(p, {
            ...scope,
            botId: specialist.botId,
            runId: specialist.id,
            attemptId: attempt.id,
            leaseOwner: "synthetic-worker",
            leaseFence: 1,
            blocks: [
              {
                kind: "ask",
                text: "Review reply",
                status: "pending",
                approvalEffectId: effect.id,
                mailReply: draft,
                actions: [
                  { id: "allow", label: "Send" },
                  { id: "deny", label: "Discard" },
                ],
              },
            ],
          }),
        ).toBe(true);
        const card = await p.message.findFirstOrThrow({
          where: { runId: specialist.id, role: "bot" },
        });
        expect(
          await answerRunInput(p, {
            spaceId: id,
            threadId: id,
            runId: specialist.id,
            messageId: card.id,
            answeredByUserId: id,
            answer: answer === "deny" ? "deny" : { action: "send", body: draft.body, cc: [] },
          }),
        ).toBe(true);
        expect((await p.run.findUnique({ where: { id: specialist.id } }))!.status).toBe("queued");
        expect((await p.externalEffect.findUnique({ where: { id: effect.id } }))!.status).toBe(
          answer === "deny" ? "denied" : "approved",
        );
        // An unrelated live run still owns the lane, even when both true ancestors are exempt.
        await p.run.update({ where: { id: unrelated.id }, data: { status: "running" } });
        await executor.continueRun(specialist.id, "resume-worker");
        expect((await p.run.findUnique({ where: { id: specialist.id } }))!.status).toBe("queued");
        await p.run.update({ where: { id: unrelated.id }, data: { status: "completed" } });
        await executor.continueRun(older.id, "resume-worker");
        expect((await p.run.findUnique({ where: { id: older.id } }))!.status).toBe("queued");
        const source = await p.message.findUniqueOrThrow({
          where: { id: specialist.sourceMessageId! },
        });
        const block = (source.blocks as unknown as Array<Record<string, unknown>>)[0]!;
        const invalid =
          block.kind === "handoff"
            ? [
                { ...block, toBotId: `${id}-other` },
                { ...block, fromBotId: `${id}-other` },
                { ...block, report: "progress" },
              ]
            : [
                { ...block, fromBotId: `${id}-other` },
                { ...block, intent: "fyi" },
                { ...block, text: "Not the server-authored request" },
                { ...block, returnToMessageId: "unknown-message" },
              ];
        for (const bad of invalid) {
          await p.message.update({
            where: { id: source.id },
            data: { blocks: [bad] as Prisma.InputJsonArray },
          });
          await executor.continueRun(specialist.id, "resume-worker");
          expect((await p.run.findUnique({ where: { id: specialist.id } }))!.status).toBe("queued");
        }
        await p.message.update({
          where: { id: source.id },
          data: { blocks: source.blocks as Prisma.InputJsonValue },
        });
        await p.run.update({ where: { id: child.id }, data: { userId: `${id}-foreign` } });
        await executor.continueRun(specialist.id, "resume-worker");
        expect((await p.run.findUnique({ where: { id: specialist.id } }))!.status).toBe("queued");
        await p.run.update({ where: { id: child.id }, data: { userId: id } });
        await expect(executor.continueRun(specialist.id, "resume-worker")).rejects.toThrow(claimed);
        expect((await p.run.findUnique({ where: { id: specialist.id } }))!.status).toBe("leased");
        expect((await p.run.findUnique({ where: { id: main.id } }))!.status).toBe("running");
        expect((await p.run.findUnique({ where: { id: child.id } }))!.status).toBe("running");
        await p.run.update({ where: { id: specialist.id }, data: { status: "completed" } });
      }
      // Without an active canonical ancestor, the same delegated source must obey queued FIFO.
      const later = await handoffToGroupBot(deps, child, id, {
        turnKey: "after-turn",
        bot_id: `${id}-specialist`,
        message: "Later work",
      });
      if (!("runId" in later) || typeof later.runId !== "string")
        throw new Error("Missing later handoff");
      await p.run.update({
        where: { id: later.runId },
        data: { trigger: "tool_background", leaseFence: 1 },
      });
      await p.run.updateMany({
        where: { id: { in: [main.id, child.id] } },
        data: { status: "completed" },
      });
      await executor.continueRun(later.runId, "resume-worker");
      expect((await p.run.findUnique({ where: { id: later.runId } }))!.status).toBe("queued");
      await expect(executor.continueRun(older.id, "resume-worker")).rejects.toThrow(claimed);
      expect((await p.run.findUnique({ where: { id: older.id } }))!.status).toBe("leased");
      await p.run.update({ where: { id: older.id }, data: { status: "completed" } });
      await expect(executor.continueRun(later.runId, "resume-worker")).rejects.toThrow(claimed);
      stop.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await p.space.deleteMany({ where: { id } });
      await p.organization.deleteMany({ where: { id } });
      await p.user.deleteMany({ where: { id } });
      await p.$disconnect();
      await db.pool.end();
    }
  },
  30_000,
);
