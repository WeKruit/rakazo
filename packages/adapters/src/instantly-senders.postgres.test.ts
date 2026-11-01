import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { boundDirectApprovalRequest } from "@rakazo/core";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { createDb, type Prisma } from "@rakazo/db";
import { expect, it } from "vitest";
import type { InstantlyRest } from "./instantly-native-writes.js";
import { ensureSendingIdentity } from "./instantly-senders.js";

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
      await p.externalEffect.create({
        data: {
          spaceId: id,
          runId: contexts[0]!.runId!,
          kind: "instantly_role_campaign",
          idempotencyKey: `${id}-legacy`,
          status: "completed",
          request: { serverId: id },
          result: { eaccount: legacyEmail },
        },
      });
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
      expect(patches).toBe(0);
    } finally {
      await p.space.deleteMany({ where: { id } });
      await p.organization.deleteMany({ where: { id } });
      await p.user.deleteMany({ where: { id } });
      await p.$disconnect();
      await db.pool.end();
    }
  },
  30_000,
);
