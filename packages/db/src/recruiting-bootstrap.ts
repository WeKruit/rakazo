import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { BOT_COLORS } from "@rakazo/contracts";
import { RECRUITING_DEFAULT_BOTS } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { createGroupInTransaction } from "./groups.js";
import { createBotInTransaction } from "./repos.js";
import { IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";

const RECRUITING_SERVICES = [
  {
    slug: "autumn",
    name: "Autumn",
    description: "Platform recruiting research",
    endpoint: "https://api.autumn.ai/mcp",
    bots: ["main", "sourcer"],
    tools: ["credits", "research", "get_task", "get_rows", "reply", "stop_task"],
  },
  {
    slug: "fullenrich",
    name: "FullEnrich",
    description: "Platform contact enrichment",
    endpoint: "https://mcp.fullenrich.com/mcp",
    bots: ["main", "outreach"],
    tools: ["get_credits", "enrich_bulk", "get_enrichment_results"],
  },
];

/** Provision only a new private recruiting workspace; never repair or replace private choices. */
export async function ensureRecruitingWorkspace(
  prisma: PrismaClient,
  actor: Actor,
  options: { sandboxKind: string },
): Promise<{ botId: string; groupId: string }> {
  const groupId = `recruiting-${createHash("sha256")
    .update(JSON.stringify([actor.spaceId, actor.userId]))
    .digest("hex")}`;
  const spawnKey = (key: string) => `recruiting:${actor.userId}:${key}`;
  return prisma.$transaction(
    async (tx) => {
      await lockSpaceForContentCreation(tx, actor);
      const personal = await tx.space.findFirst({
        where: {
          id: actor.spaceId,
          createdByUserId: actor.userId,
          memberships: {
            some: { userId: actor.userId, role: "owner" },
            every: { userId: actor.userId },
          },
          organization: { members: { every: { userId: actor.userId } } },
        },
        select: { id: true },
      });
      if (!personal) throw new IsolationError("Recruiting setup requires your private Space");
      const [bots, existing, groupCount] = await Promise.all([
        tx.bot.findMany({
          where: { spaceId: actor.spaceId, userId: actor.userId },
          select: { id: true, spawnKey: true, archivedAt: true },
        }),
        tx.chatGroup.findFirst({
          where: { id: groupId, spaceId: actor.spaceId, userId: actor.userId },
          include: { thread: { select: { id: true } } },
        }),
        tx.chatGroup.count({ where: { spaceId: actor.spaceId, userId: actor.userId } }),
      ]);
      let ownedBots = bots;
      if (existing) {
        if (
          existing.archivedAt ||
          !existing.thread ||
          !bots.some((bot) => bot.spawnKey === spawnKey("main") && !bot.archivedAt)
        ) {
          throw new IsolationError(
            "The recruiting workspace was changed; use your existing conversations",
          );
        }
      } else {
        if (bots.length || groupCount)
          throw new IsolationError("This Space already has conversations");
        const settings = await tx.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { computerHost: true },
        });
        const kind =
          options.sandboxKind === "docker" && settings?.computerHost === "this-mac"
            ? "desktop"
            : options.sandboxKind;
        ownedBots = [];
        for (const [index, role] of RECRUITING_DEFAULT_BOTS.entries()) {
          ownedBots.push(
            await createBotInTransaction(
              tx,
              actor,
              {
                name: role.name,
                title: role.title,
                description: role.description,
                instructions: role.instructions,
                color: BOT_COLORS[index % BOT_COLORS.length] ?? BOT_COLORS[0],
                notifyOnFinish: true,
                spawnKey: spawnKey(role.key),
              },
              kind,
            ),
          );
        }
        await createGroupInTransaction(tx, actor, {
          id: groupId,
          name: "Recruiting",
          botIds: ownedBots.map((bot) => bot.id),
        });
      }
      if (!existing)
        for (const service of RECRUITING_SERVICES) {
          const prior = await tx.mcpServer.findFirst({
            where: { spaceId: actor.spaceId, userId: actor.userId, slug: service.slug },
          });
          if (
            prior &&
            (prior.endpoint !== service.endpoint || prior.transport !== "streamable_http")
          ) {
            throw new IsolationError(`The existing ${service.name} connection is customized`);
          }
          const server =
            prior ??
            (await tx.mcpServer.create({
              data: {
                spaceId: actor.spaceId,
                userId: actor.userId,
                slug: service.slug,
                name: service.name,
                description: service.description,
                transport: "streamable_http",
                endpoint: service.endpoint,
                secretId: undefined,
              },
            }));
          await tx.botMcpServer.createMany({
            data: ownedBots
              .filter(
                (bot) => !bot.archivedAt && service.bots.map(spawnKey).includes(bot.spawnKey ?? ""),
              )
              .map((bot) => ({
                spaceId: actor.spaceId,
                userId: actor.userId,
                botId: bot.id,
                serverId: server.id,
                allowAllTools: false,
                allowedTools: service.tools,
              })),
            skipDuplicates: true,
          });
        }
      const main = ownedBots.find((bot) => bot.spawnKey === spawnKey("main"));
      if (!main) throw new IsolationError();
      return { botId: main.id, groupId };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 15_000,
    },
  );
}
