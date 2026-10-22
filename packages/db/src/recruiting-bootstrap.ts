import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { BOT_COLORS, GROUP_MEMBER_MAX } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, RECRUITING_DEFAULT_BOTS } from "@rakazo/core";
import type { Bot, BotMcpServer, CapabilityInstall, McpServer, PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { resolveMaxComputersPerUser } from "./computers.js";
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

export const RECRUITING_PRESET_SOURCE = "builtin:recruiting";
const BOT_FIELDS = ["name", "title", "description", "instructions"] as const;
type ManagedBot = { id: string; fields: Partial<Record<(typeof BOT_FIELDS)[number], string>> };
type ManagedService = {
  id: string;
  signature: string;
  assignments: Record<string, { id: string; signature: string } | null>;
};
type ManagedPreset = {
  schemaVersion: 1;
  groupId: string;
  members: string[];
  bots: Record<string, ManagedBot>;
  services: Record<string, ManagedService>;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const catalogDigest = () => digest([RECRUITING_DEFAULT_BOTS, RECRUITING_SERVICES]);
export function recruitingPresetId(actor: Pick<Actor, "spaceId" | "userId">): string {
  return `recruiting-defaults-${digest([actor.spaceId, actor.userId])}`;
}
function presetWhere(actor: Actor) {
  return {
    id: recruitingPresetId(actor),
    spaceId: actor.spaceId,
    userId: actor.userId,
    kind: "plugin",
    source: RECRUITING_PRESET_SOURCE,
  };
}

function botBaseline(
  bot: Pick<Bot, "id" | "name" | "title" | "description" | "instructions">,
): ManagedBot {
  return {
    id: bot.id,
    fields: Object.fromEntries(BOT_FIELDS.map((field) => [field, digest(bot[field])])),
  };
}
function serviceSignature(server: McpServer): string {
  return digest([
    server.transport,
    server.endpoint,
    server.command,
    server.args,
    server.env,
    server.headers,
    server.secretId ?? null,
    server.enabled,
    server.revision,
  ]);
}
function assignmentSignature(
  assignment: Pick<BotMcpServer, "allowAllTools" | "allowedTools">,
): string {
  return digest([assignment.allowAllTools, assignment.allowedTools]);
}
function readPreset(value: Prisma.JsonValue): ManagedPreset {
  const object = (item: unknown): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item);
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    typeof value.groupId !== "string" ||
    !Array.isArray(value.members) ||
    !value.members.every((id) => typeof id === "string") ||
    !object(value.bots) ||
    !object(value.services)
  )
    throw new IsolationError("Recruiting defaults have no managed baseline");
  for (const bot of Object.values(value.bots))
    if (
      !object(bot) ||
      typeof bot.id !== "string" ||
      !object(bot.fields) ||
      Object.entries(bot.fields).some(
        ([key, hash]) =>
          !BOT_FIELDS.includes(key as (typeof BOT_FIELDS)[number]) || typeof hash !== "string",
      )
    )
      throw new IsolationError("Invalid recruiting bot baseline");
  for (const service of Object.values(value.services)) {
    if (
      !object(service) ||
      typeof service.id !== "string" ||
      typeof service.signature !== "string" ||
      !object(service.assignments)
    )
      throw new IsolationError("Invalid recruiting connection baseline");
    for (const assignment of Object.values(service.assignments))
      if (
        assignment !== null &&
        (!object(assignment) ||
          typeof assignment.id !== "string" ||
          typeof assignment.signature !== "string")
      )
        throw new IsolationError("Invalid recruiting assignment baseline");
  }
  return structuredClone(value) as unknown as ManagedPreset;
}
async function savePreset(
  tx: Prisma.TransactionClient,
  actor: Actor,
  config: ManagedPreset | null,
) {
  await tx.capabilityInstall.create({
    data: {
      ...presetWhere(actor),
      name: "Recruiting defaults",
      version: config ? "1" : "unmanaged",
      digest: config ? catalogDigest() : null,
      config: config ?? { managed: false },
    },
  });
}

async function recruitingComputerKind(
  tx: Prisma.TransactionClient,
  sandboxKind: string,
): Promise<string> {
  const settings = await tx.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { computerHost: true },
  });
  return sandboxKind === "docker" && settings?.computerHost === "this-mac"
    ? "desktop"
    : sandboxKind;
}

async function upgradeInTransaction(
  tx: Prisma.TransactionClient,
  actor: Actor,
  installed: CapabilityInstall,
  options: { sandboxKind: string },
) {
  if (installed.version === "unmanaged" || installed.digest === catalogDigest()) return;
  if (installed.version !== "1")
    throw new IsolationError("Unsupported recruiting defaults version");
  const baseline = readPreset(installed.config);
  if (baseline.groupId !== `recruiting-${digest([actor.spaceId, actor.userId])}`)
    throw new IsolationError("Recruiting defaults belong to another workspace");
  const originalServices = new Set(Object.keys(baseline.services));
  const newBotIds = new Set<string>();
  if (
    RECRUITING_DEFAULT_BOTS.some((role) => !baseline.bots[role.key]) &&
    resolveMaxComputersPerUser() > 0
  ) {
    // Reuse native computer quota's user/seed-1 lock before bot rows; computer switches take it first.
    const [quota] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${actor.userId}, 1)) AS acquired
    `;
    if (typeof quota?.acquired !== "boolean")
      throw new IsolationError("Could not inspect recruiting computer quota");
    if (!quota.acquired) return;
  }
  // ponytail: catalog changes lock one actor's Space; large workspaces can narrow these same native locks to recorded members.
  // Profile/assignment edits can lock their rows before appending a thread event. Never wait on that inverse order.
  // Bot FOR UPDATE also fences new Run foreign-key KEY SHARE admission until the active-run check and commit.
  for (const name of ["chat_groups", "threads", "mcp_servers", "bot_mcp_servers", "bots"]) {
    const table = Prisma.raw(name);
    const [locked] = await tx.$queryRaw<Array<{ complete: boolean }>>(Prisma.sql`
      WITH locked AS MATERIALIZED (
        SELECT id FROM ${table}
        WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}
        ORDER BY id FOR UPDATE SKIP LOCKED
      )
      SELECT (SELECT COUNT(*) FROM locked) =
        (SELECT COUNT(*) FROM ${table} WHERE "spaceId" = ${actor.spaceId} AND "userId" = ${actor.userId}) AS complete
    `);
    if (typeof locked?.complete !== "boolean")
      throw new IsolationError("Could not inspect recruiting defaults");
    if (!locked.complete) return;
  }
  if (
    await tx.run.count({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        status: { in: [...ACTIVE_RUN_STATUSES] },
      },
    })
  )
    return;
  const group = await tx.chatGroup.findFirst({
    where: { id: baseline.groupId, spaceId: actor.spaceId, userId: actor.userId },
    include: { thread: { select: { id: true } }, members: { select: { botId: true } } },
  });
  if (!group || group.archivedAt || !group.thread) return;
  const bots = await tx.bot.findMany({ where: { spaceId: actor.spaceId, userId: actor.userId } });
  const unchangedMembers =
    digest(group.members.map((member) => member.botId).sort()) ===
    digest([...baseline.members].sort());
  const spawnKey = (key: string) => `recruiting:${actor.userId}:${key}`;
  for (const role of RECRUITING_DEFAULT_BOTS) {
    let managed = baseline.bots[role.key];
    let bot = bots.find((item) => item.spawnKey === spawnKey(role.key));
    if (!managed && unchangedMembers) {
      if (group.members.length >= GROUP_MEMBER_MAX) continue;
      if (bot) {
        baseline.bots[role.key] = { id: bot.id, fields: {} };
        continue;
      }
      // New catalog roles may be added; a previously recorded/deleted role is never recreated.
      bot = await createBotInTransaction(
        tx,
        actor,
        {
          name: role.name,
          title: role.title,
          description: role.description,
          instructions: role.instructions,
          color: BOT_COLORS[bots.length % BOT_COLORS.length] ?? BOT_COLORS[0],
          notifyOnFinish: true,
          spawnKey: spawnKey(role.key),
        },
        await recruitingComputerKind(tx, options.sandboxKind),
      );
      bots.push(bot);
      newBotIds.add(bot.id);
      await tx.chatGroupMember.createMany({
        data: [{ groupId: group.id, botId: bot.id }],
        skipDuplicates: true,
      });
      group.members.push({ botId: bot.id });
      baseline.members.push(bot.id);
      managed = baseline.bots[role.key] = botBaseline(bot);
    }
    if (
      !managed ||
      !bot ||
      bot.id !== managed.id ||
      bot.archivedAt ||
      !group.members.some((member) => member.botId === bot!.id)
    )
      continue;
    for (const field of BOT_FIELDS) {
      if (digest(bot[field]) !== managed.fields[field] || bot[field] === role[field]) continue;
      const changed = await tx.bot.updateMany({
        where: {
          id: bot.id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: null,
          [field]: bot[field],
        },
        data: { [field]: role[field] },
      });
      if (changed.count === 1) managed.fields[field] = digest(role[field]);
    }
  }
  const servers = await tx.mcpServer.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId },
    include: { assignments: { where: { spaceId: actor.spaceId, userId: actor.userId } } },
  });
  for (const service of RECRUITING_SERVICES) {
    let managed = baseline.services[service.slug];
    let server = servers.find((item) => item.slug === service.slug);
    if (!managed && unchangedMembers) {
      // Existing untracked connections belong to the user, not this preset.
      if (server) continue;
      const created = await tx.mcpServer.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          slug: service.slug,
          name: service.name,
          description: service.description,
          transport: "streamable_http",
          endpoint: service.endpoint,
        },
      });
      server = { ...created, assignments: [] };
      managed = baseline.services[service.slug] = {
        id: server.id,
        signature: serviceSignature(server),
        assignments: {},
      };
    }
    if (
      !managed ||
      !server ||
      server.id !== managed.id ||
      serviceSignature(server) !== managed.signature ||
      server.endpoint !== service.endpoint ||
      !server.enabled
    )
      continue;
    for (const key of service.bots) {
      const managedBot = baseline.bots[key];
      const bot = bots.find(
        (item) =>
          item.id === managedBot?.id &&
          !item.archivedAt &&
          group.members.some((member) => member.botId === item.id),
      );
      if (!managedBot || !Object.keys(managedBot.fields).length || !bot) continue;
      const current = server.assignments.find((item) => item.botId === bot.id);
      const saved = managed.assignments[key];
      const desired = { allowAllTools: false, allowedTools: service.tools };
      if (saved === undefined) {
        // Only newly introduced service scope is auto-assigned. Missing old grants stay revoked.
        if ((originalServices.has(service.slug) && !newBotIds.has(bot.id)) || current) {
          managed.assignments[key] = null;
          continue;
        }
        await tx.botMcpServer.createMany({
          data: [
            {
              spaceId: actor.spaceId,
              userId: actor.userId,
              botId: bot.id,
              serverId: server.id,
              ...desired,
            },
          ],
          skipDuplicates: true,
        });
        const rows = await tx.botMcpServer.findMany({
          where: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            botId: bot.id,
            serverId: server.id,
          },
        });
        const added = rows.find((row) => row.botId === bot.id && row.serverId === server!.id);
        if (added && assignmentSignature(added) === assignmentSignature(desired))
          managed.assignments[key] = { id: added.id, signature: assignmentSignature(added) };
      } else if (
        saved &&
        current?.id === saved.id &&
        assignmentSignature(current) === saved.signature &&
        assignmentSignature(current) !== assignmentSignature(desired)
      ) {
        const changed = await tx.botMcpServer.updateMany({
          where: {
            id: current.id,
            spaceId: actor.spaceId,
            userId: actor.userId,
            allowAllTools: current.allowAllTools,
            allowedTools: {
              equals: current.allowedTools === null ? Prisma.JsonNull : current.allowedTools,
            },
          },
          data: desired,
        });
        if (changed.count === 1) saved.signature = assignmentSignature(desired);
      }
    }
  }
  await tx.capabilityInstall.updateMany({
    where: presetWhere(actor),
    data: { version: "1", digest: catalogDigest(), config: baseline },
  });
}

/** Upgrade existing managed defaults only; never create/adopt a returning user's workspace. */
export async function upgradeRecruitingWorkspace(
  prisma: PrismaClient,
  actor: Actor,
  options: { sandboxKind: string },
): Promise<void> {
  const installed = await prisma.capabilityInstall.findFirst({ where: presetWhere(actor) });
  if (!installed || installed.version === "unmanaged" || installed.digest === catalogDigest())
    return;
  await prisma.$transaction(
    async (tx) => {
      await lockSpaceForContentCreation(tx, actor);
      const current = await tx.capabilityInstall.findFirst({ where: presetWhere(actor) });
      if (!current) return;
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
      if (!personal) return;
      await upgradeInTransaction(tx, actor, current, options);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 15_000,
    },
  );
}

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
          select: {
            id: true,
            spawnKey: true,
            archivedAt: true,
            name: true,
            title: true,
            description: true,
            instructions: true,
          },
        }),
        tx.chatGroup.findFirst({
          where: { id: groupId, spaceId: actor.spaceId, userId: actor.userId },
          include: { thread: { select: { id: true } } },
        }),
        tx.chatGroup.count({ where: { spaceId: actor.spaceId, userId: actor.userId } }),
      ]);
      const installed = await tx.capabilityInstall.findFirst({ where: presetWhere(actor) });
      if (!existing && installed)
        throw new IsolationError(
          "The recruiting workspace was removed; use your existing conversations",
        );
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
        const kind = await recruitingComputerKind(tx, options.sandboxKind);
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
      if (existing) {
        if (installed) await upgradeInTransaction(tx, actor, installed, options);
        else await savePreset(tx, actor, null);
      } else {
        const servers = await tx.mcpServer.findMany({
          where: { spaceId: actor.spaceId, userId: actor.userId },
          include: { assignments: { where: { spaceId: actor.spaceId, userId: actor.userId } } },
        });
        const baseline: ManagedPreset = {
          schemaVersion: 1,
          groupId,
          members: ownedBots.map((bot) => bot.id),
          bots: {},
          services: {},
        };
        for (const role of RECRUITING_DEFAULT_BOTS) {
          const bot = ownedBots.find((item) => item.spawnKey === spawnKey(role.key));
          if (bot) baseline.bots[role.key] = botBaseline(bot);
        }
        for (const service of RECRUITING_SERVICES) {
          const server = servers.find((item) => item.slug === service.slug);
          if (!server) throw new IsolationError();
          const assignments: ManagedService["assignments"] = {};
          for (const key of service.bots) {
            const row = server.assignments.find((item) => item.botId === baseline.bots[key]?.id);
            if (row) assignments[key] = { id: row.id, signature: assignmentSignature(row) };
          }
          baseline.services[service.slug] = {
            id: server.id,
            signature: serviceSignature(server),
            assignments,
          };
        }
        await savePreset(tx, actor, baseline);
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
