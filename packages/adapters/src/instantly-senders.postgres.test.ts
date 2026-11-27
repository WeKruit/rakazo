import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { boundDirectApprovalRequest } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { createDb, type Prisma } from "@rakazo/db";
import { expect, it } from "vitest";
import type { InstantlyRest } from "./instantly-native-writes.js";
import { ownedInstantly, requireReplySendingMailboxReady } from "./instantly-native-writes.js";
import { ensureSendingIdentity } from "./instantly-senders.js";
import { oneAtATime } from "./one-at-a-time.js";

const url = process.env.DATABASE_URL;
it.skipIf(process.env.VERIFY_DATABASE !== "1" || !url)(
  "serializes the real sender cap, exact approval and exclusive legacy ownership in PostgreSQL",
  async () => {
    const db = createDb(url!);
    const p = db.prisma;
    const id = `sender-proof-${randomUUID()}`;
    let orders = 0;
    let patches = 0;
    const accounts = new Map<string, Record<string, unknown>>();
    const rest: InstantlyRest = async (method, path, body) => {
      if (method === "GET" && path.startsWith("/dfy-email-account-orders/accounts"))
        return {
          items: [
            {
              email: "existing@product.test",
              domain: "product.test",
              email_provider: 1,
              first_name: "Existing",
              last_name: "",
            },
          ],
        };
      if (method === "POST" && path === "/dfy-email-account-orders") {
        const order = body as any;
        if (order.simulation)
          return { simulation: true, order_is_valid: true, order_placed: false };
        orders++;
        const account = order.items[0].accounts[0];
        const email = `${account.email_address_prefix}@product.test`;
        accounts.set(email, {
          email,
          first_name: account.first_name,
          last_name: account.last_name,
          status: 1,
          setup_pending: false,
          warmup_status: 1,
        });
        return { order_is_valid: true, order_placed: true };
      }
      const email = decodeURIComponent(path.slice("/accounts/".length));
      if (method === "GET" && accounts.has(email)) return accounts.get(email)!;
      if (method === "PATCH" && accounts.has(email)) {
        patches++;
        Object.assign(accounts.get(email)!, body);
        return accounts.get(email)!;
      }
      throw new Error(`Unexpected fake provider request ${method} ${path}`);
    };
    try {
      await p.user.create({ data: { id, name: "Sender proof", email: `${id}@test.invalid` } });
      await p.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
      await p.space.create({ data: { id, name: id, organizationId: id } });
      await p.bot.create({ data: { id, spaceId: id, userId: id, name: id, color: "purple" } });
      await p.thread.create({ data: { id, spaceId: id, userId: id, botId: id } });
      await p.task.create({
        data: {
          id,
          spaceId: id,
          botId: id,
          threadId: id,
          userId: id,
          prompt: "isolated sender proof",
          status: "running",
        },
      });
      await p.mcpServer.create({
        data: {
          id,
          spaceId: id,
          userId: id,
          slug: id,
          name: "Proof",
          transport: "streamable_http",
          revision: 1,
        },
      });
      let seq = 0;
      const approval = async (args: Record<string, unknown>): Promise<AdapterContext> => {
        const eventSeq = ++seq;
        const runId = `${id}-${eventSeq}`;
        await p.run.create({
          data: {
            id: runId,
            spaceId: id,
            userId: id,
            botId: id,
            threadId: id,
            taskId: id,
            status: "running",
            trigger: "user",
          },
        });
        const request = boundDirectApprovalRequest(
          {
            connectorId: "mcp",
            resourceId: id,
            resourceRevision: 1,
            toolName: "native_instantly_ensure_sender",
          },
          args,
          "__rakazoCatalogTool",
        );
        const effect = await p.externalEffect.create({
          data: {
            spaceId: id,
            runId,
            kind: "connector",
            idempotencyKey: runId,
            status: "executing",
            request: request as Prisma.InputJsonValue,
          },
        });
        await p.event.create({
          data: {
            spaceId: id,
            threadId: id,
            botId: id,
            runId,
            seq: eventSeq,
            type: "effect.approval.answered",
            payload: {
              effectId: effect.id,
              answer: "allow",
              answeredByUserId: id,
              requestHash: createHash("sha256").update(stableJsonValue(request)).digest("hex"),
            },
          },
        });
        return {
          userId: id,
          spaceId: id,
          botId: id,
          runId,
          operationId: runId,
          traceId: runId,
          signal: new AbortController().signal,
          senderConfirmationEffectId: effect.id,
        };
      };
      const args = [1, 2, 3].map((n) => ({
        operation: "confirm",
        display_name: "Proof company",
        email: `${id}-${n}@product.test`,
      }));
      const contexts = await Promise.all(args.map(approval));
      const results = await Promise.allSettled(
        args.map((a, i) => ensureSendingIdentity(p, rest, contexts[i]!, id, a)),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(
        results
          .filter((r) => r.status === "rejected")
          .map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([expect.stringContaining("up to 2")]);
      expect(orders).toBe(2);
      const success = results.findIndex((r) => r.status === "fulfilled");
      await ensureSendingIdentity(p, rest, contexts[success]!, id, args[success]);
      expect(orders).toBe(2);
      // Real SQL must reject ambiguous legacy ownership before any provider name write.
      const legacyEmail = `legacy-${id}@product.test`;
      accounts.set(legacyEmail, {
        email: legacyEmail,
        first_name: "Old",
        last_name: "",
        status: 1,
        setup_pending: false,
        warmup_status: 1,
      });
      await p.$transaction(async (tx) => {
        await tx.recruitingRole.create({
          data: {
            id,
            spaceId: id,
            userId: id,
            sourceThreadId: id,
            title: "Reply proof",
            revision: 1,
            currentRevisionId: `${id}-revision`,
          },
        });
        await tx.recruitingRoleRevision.create({
          data: {
            id: `${id}-revision`,
            roleId: id,
            revision: 1,
            sourceRefs: [],
            criteria: {},
            preferences: {},
            definitionQuestions: [],
          },
        });
        await tx.thread.update({ where: { id }, data: { activeRecruitingRoleId: id } });
      });
      await p.externalEffect.create({
        data: {
          spaceId: id,
          runId: contexts[0]!.runId!,
          kind: "instantly_role_campaign",
          idempotencyKey: `instantly-role-campaign:${id}:${id}`,
          status: "completed",
          request: { serverId: id, roleId: id },
          result: { eaccount: legacyEmail, campaignId: "campaign-proof" },
        },
      });
      // Noise belongs to a different actor: history growth must not turn an owned reply into a table scan.
      await p.run.create({
        data: {
          id: `${id}-noise-run`,
          spaceId: id,
          userId: `${id}-foreign`,
          botId: id,
          threadId: id,
          taskId: id,
          status: "completed",
          trigger: "user",
        },
      });
      await p.$executeRaw`
        INSERT INTO external_effects (id, "spaceId", "runId", kind, "idempotencyKey", status, request, result, "updatedAt")
        SELECT ${id} || '-noise-' || n, ${id}, ${`${id}-noise-run`}, 'instantly_role_campaign',
          ${id} || '-noise-key-' || n, 'completed', jsonb_build_object('serverId', ${id}::text),
          jsonb_build_object('campaignId', 'unrelated', 'padding', repeat('x', 256)), now()
        FROM generate_series(1, 100000) n
      `;
      await p.$executeRawUnsafe("ANALYZE external_effects");
      const plans = [
        await p.$queryRawUnsafe<unknown[]>(
          `
          EXPLAIN (ANALYZE, FORMAT JSON) SELECT e.result FROM external_effects e JOIN runs r ON r.id=e."runId"
          WHERE e."idempotencyKey"=$1 AND e."spaceId"=$2 AND r."userId"=$2 AND r."spaceId"=$2
            AND e.kind='instantly_role_campaign' AND e.status='completed'
            AND e.request->>'serverId'=$2 AND e.request->>'roleId'=$2 AND e.result->>'campaignId'='campaign-proof'
        `,
          `instantly-role-campaign:${id}:${id}`,
          id,
        ),
        await p.$queryRawUnsafe<unknown[]>(
          `
          EXPLAIN (ANALYZE, FORMAT JSON) SELECT e.kind,e.result FROM runs r
          CROSS JOIN LATERAL (
            SELECT e.kind,e.result FROM external_effects e WHERE e."runId"=r.id AND e."spaceId"=$1
              AND e.status='completed' AND e.kind IN ('instantly_role_campaign','instantly_sender_account')
              AND e.request->>'serverId'=$1 OFFSET 0
          ) e WHERE r."spaceId"=$1 AND r."userId"=$1
        `,
          id,
        ),
      ];
      for (const rows of plans) {
        const plan = (rows[0] as { "QUERY PLAN": { Plan: unknown; "Execution Time": number }[] })[
          "QUERY PLAN"
        ][0]!;
        const text = JSON.stringify(plan.Plan);
        expect(text).toContain("external_effects");
        const check = (node: any) => {
          if (node["Relation Name"] === "external_effects")
            expect(node["Node Type"]).not.toBe("Seq Scan");
          for (const child of node.Plans ?? []) check(child);
        };
        check(plan.Plan);
        expect(plan["Execution Time"]).toBeLessThan(5_000);
      }
      const started = performance.now();
      expect((await ownedInstantly(p, id, id, id)).campaigns).toContain("campaign-proof");
      expect(performance.now() - started).toBeLessThan(5_000);
      const original = {
        eaccount: legacyEmail,
        campaign_id: "campaign-proof",
        thread_id: "provider-thread-proof",
      };
      await expect(
        requireReplySendingMailboxReady(p, rest, contexts[1]!, id, original, legacyEmail),
      ).resolves.toMatchObject({ usable: true });
      await p.externalEffect.update({
        where: { idempotencyKey: `instantly-role-campaign:${id}:${id}` },
        data: { idempotencyKey: `instantly-role-campaign:${id}:${id}:campaign:campaign-proof` },
      });
      await expect(
        requireReplySendingMailboxReady(p, rest, contexts[1]!, id, original, legacyEmail),
      ).resolves.toMatchObject({ usable: true });
      accounts.get(legacyEmail)!.status = 0;
      await expect(
        requireReplySendingMailboxReady(p, rest, contexts[1]!, id, original, legacyEmail),
      ).rejects.toThrow("sender_not_ready");
      accounts.get(legacyEmail)!.status = 1;
      for (const [ctx, source, anchor, mailbox] of [
        [{ ...contexts[1]!, userId: `${id}-foreign` }, id, original, legacyEmail],
        [{ ...contexts[1]!, spaceId: `${id}-foreign` }, id, original, legacyEmail],
        [contexts[1]!, `${id}-foreign`, original, legacyEmail],
        [contexts[1]!, id, { ...original, campaign_id: "foreign-campaign" }, legacyEmail],
        [contexts[1]!, id, { ...original, thread_id: undefined }, legacyEmail],
        [contexts[1]!, id, original, "foreign@product.test"],
      ] as const)
        await expect(
          requireReplySendingMailboxReady(p, rest, ctx, source, anchor, mailbox),
        ).rejects.toThrow("sender_unavailable");
      expect(
        await ensureSendingIdentity(p, rest, contexts[0]!, id, {
          operation: "propose",
          display_name: "Proof company",
          existing_email: legacyEmail,
        }),
      ).toMatchObject({ mode: "attach", email: legacyEmail });
      await p.externalEffect.create({
        data: {
          spaceId: id,
          runId: contexts[0]!.runId!,
          kind: "instantly_role_campaign",
          idempotencyKey: `${id}-foreign`,
          status: "completed",
          request: { serverId: id },
          result: { eaccount: legacyEmail },
        },
      });
      // A different actor on the legacy run makes the exact shared address unsafe to attach.
      await p.run.update({ where: { id: contexts[0]!.runId! }, data: { userId: `${id}-foreign` } });
      await expect(
        ensureSendingIdentity(p, rest, contexts[1]!, id, {
          operation: "propose",
          display_name: "Proof company",
          existing_email: legacyEmail,
        }),
      ).rejects.toThrow("exclusively owned");
      await expect(
        requireReplySendingMailboxReady(p, rest, contexts[1]!, id, original, legacyEmail),
      ).rejects.toThrow("sender_unavailable");
      expect(patches).toBe(0);
    } finally {
      await p.space.deleteMany({ where: { id } });
      await p.organization.deleteMany({ where: { id } });
      await p.user.deleteMany({ where: { id } });
      await p.$disconnect();
      await db.pool.end();
    }
  },
  60_000,
);

it.skipIf(process.env.VERIFY_DATABASE !== "1" || !url)(
  "runs work with the same key one at a time, and different keys side by side",
  async () => {
    const db = createDb(url!);
    const key = [`one-at-a-time-${randomUUID()}`];
    const log: string[] = [];
    const step = (name: string, ms: number) => async () => {
      log.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`${name} end`);
    };
    try {
      await Promise.all([
        oneAtATime(db.prisma, key, step("a", 300)),
        oneAtATime(db.prisma, key, step("b", 10)),
      ]);
      expect([log.slice(0, 2), log.slice(2)]).toEqual(
        log[0] === "a start"
          ? [
              ["a start", "a end"],
              ["b start", "b end"],
            ]
          : [
              ["b start", "b end"],
              ["a start", "a end"],
            ],
      );
      log.length = 0;
      await Promise.all([
        oneAtATime(db.prisma, [...key, "x"], step("x", 300)),
        oneAtATime(db.prisma, [...key, "y"], step("y", 10)),
      ]);
      expect(log.slice(0, 2).sort()).toEqual(["x start", "y start"]);
    } finally {
      await db.prisma.$disconnect();
    }
  },
);
