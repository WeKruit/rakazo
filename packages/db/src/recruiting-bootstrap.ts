import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { BOT_COLORS, GROUP_MEMBER_MAX } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  MEMORY_TIDY_ROUTINE_NAME,
  memoryTidyRoutineCron,
  memoryTidyRoutinePrompt,
  nextCronDate,
  RECRUITING_DEFAULT_BOTS,
  RECRUITING_DEFAULT_SKILLS,
  RECRUITING_DISABLED_BUILTIN_TOOLS,
  recruitingBotKey,
} from "@rakazo/core";
import type { Bot, BotMcpServer, CapabilityInstall, McpServer, PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { resolveMaxComputersPerUser } from "./computers.js";
import { createGroupInTransaction } from "./groups.js";
import { createBotInTransaction } from "./repos.js";
import { IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";

type RecruitingService = {
  slug: string;
  name: string;
  description: string;
  endpoint: string;
  bots: string[];
  tools: string[];
  toolsByBot?: Record<string, string[]>;
};

const RECRUITING_SERVICES: RecruitingService[] = [
  {
    slug: "autumn",
    name: "Autumn",
    description: "Platform recruiting research",
    endpoint: "https://api.autumn.ai/mcp",
    bots: ["main", "sourcer", "reviewer"],
    tools: ["credits", "research", "get_task", "get_rows", "reply", "stop_task"],
    // The quality check only starts grading requests and reads their rows.
    toolsByBot: { reviewer: ["credits", "research", "get_task", "get_rows"] },
  },
  {
    slug: "fullenrich",
    name: "FullEnrich",
    description: "Platform contact enrichment",
    endpoint: "https://mcp.fullenrich.com/mcp",
    bots: ["main", "outreach"],
    tools: ["get_credits", "enrich_bulk", "get_enrichment_results"],
  },
  {
    slug: "people-search",
    name: "People search",
    description: "Platform people search for quick calibration rounds",
    endpoint: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa",
    bots: ["main", "sourcer", "outreach"],
    tools: ["web_search_exa", "web_search_advanced_exa"],
    // Outreach searches the public web for a person's own posted email; only the advanced
    // people search saves results into the role's candidates.
    toolsByBot: { outreach: ["web_search_exa"] },
  },
];

/** The operator's staff domain: verified mailboxes here see dollar spend for every account. */
export const RECRUITING_OPERATOR_EMAIL_DOMAIN = "wekruit.com";

/**
 * List prices of the platform services by slug, for the operator's spend estimate only.
 * Research: US$850 a month for 100,000 credits. Contact enrichment: the entry monthly plan,
 * US$29 for 500 credits (charged only for found data). People search: US$7 per 1,000
 * searches with contents. Outreach mail, calendar and mailbox connectors are flat-rate or free.
 * Model tokens are priced from the model catalog instead.
 */
export const RECRUITING_SERVICE_UNIT_PRICES_USD: Readonly<
  Record<string, { credits?: number; calls?: number }>
> = {
  autumn: { credits: 850 / 100_000, calls: 0 },
  fullenrich: { credits: 29 / 500, calls: 0 },
  "people-search": { calls: 7 / 1000 },
  "recruiting-crm": { calls: 0 },
  // Flat subscriptions or free APIs: calls add no per-use cost.
  instantly: { calls: 0 },
  "cal-com": { calls: 0 },
  gmail: { calls: 0 },
};

const CRM_READ_TOOLS = [
  "whoami",
  "list_crm_memberships",
  "list_crm_candidates",
  "get_crm_role",
  "get_crm_candidate_source_context",
  "get_crm_candidate_review",
  "list_crm_candidate_messages",
  "list_crm_roles",
];
function recruitingServices(firstPartyMcpUrl?: string): RecruitingService[] {
  return firstPartyMcpUrl
    ? [
        ...RECRUITING_SERVICES,
        {
          slug: "recruiting-crm",
          name: "Recruiting CRM",
          description: "Your recruiting records",
          endpoint: firstPartyMcpUrl,
          bots: ["main", "sourcer"],
          tools: CRM_READ_TOOLS,
          toolsByBot: {
            main: [
              ...CRM_READ_TOOLS,
              "crm_import_candidate",
              "list_crm_candidate_roles",
              "list_crm_candidate_correspondence",
              "list_crm_role_correspondence",
            ],
          },
        },
      ]
    : RECRUITING_SERVICES;
}

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
  /** Default routines by bot key, recorded once so a paused or deleted one is never recreated. */
  routines?: Record<string, string>;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const catalogDigest = (firstPartyMcpUrl?: string) =>
  digest([
    RECRUITING_DEFAULT_BOTS,
    recruitingServices(firstPartyMcpUrl),
    RECRUITING_DISABLED_BUILTIN_TOOLS,
    [MEMORY_TIDY_ROUTINE_NAME, memoryTidyRoutinePrompt(true), memoryTidyRoutinePrompt(false)],
  ]);
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
    !object(value.services) ||
    !validRoutines(value.routines)
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
function validRoutines(value: unknown): value is Record<string, string> | undefined {
  return (
    value === undefined ||
    (Boolean(value) &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value as object).every((id) => typeof id === "string"))
  );
}

/**
 * Give each recruiting bot the product-default nightly memory tidy, once. A bot that already has a
 * routine by that name keeps it; a recorded routine is never recreated after a pause or delete.
 * The lead's tidy also covers the user's shared memory. Rows hold only this actor's ids and the
 * maintained prompt, and the job reconciler enqueues the first wakeup.
 */
async function ensureMemoryTidyRoutines(
  tx: Prisma.TransactionClient,
  actor: Actor,
  bots: Array<{ key: string; botId: string }>,
  recorded: Record<string, string>,
): Promise<void> {
  const cron = memoryTidyRoutineCron(actor.userId);
  for (const { key, botId } of bots) {
    if (recorded[key] !== undefined) continue;
    const existing = await tx.routine.findFirst({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId,
        name: MEMORY_TIDY_ROUTINE_NAME,
      },
      select: { id: true },
    });
    recorded[key] = (
      existing ??
      (await tx.routine.create({
        data: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          botId,
          name: MEMORY_TIDY_ROUTINE_NAME,
          prompt: memoryTidyRoutinePrompt(key === "main"),
          crons: [cron],
          timezone: "UTC",
          notify: false,
          active: true,
          nextRunAt: nextCronDate(cron, new Date()),
        },
        select: { id: true },
      }))
    ).id;
  }
}

async function savePreset(
  tx: Prisma.TransactionClient,
  actor: Actor,
  config: ManagedPreset | null,
  firstPartyMcpUrl?: string,
) {
  await tx.capabilityInstall.create({
    data: {
      ...presetWhere(actor),
      name: "Recruiting defaults",
      version: config ? "1" : "unmanaged",
      digest: config ? catalogDigest(firstPartyMcpUrl) : null,
      config: config ?? { managed: false },
    },
  });
}

/** Crews set up before the managed preset get the same defaults as new accounts. */
const LEGACY_PRESET_VERSION = "legacy";
const TURN_IN_FLIGHT_STATUSES = ["queued", "leased", "running"] as const;
const LEGACY_BOT_FIELDS = ["title", "description", "instructions"] as const;
const legacyDigest = (firstPartyMcpUrl?: string) =>
  digest([catalogDigest(firstPartyMcpUrl), RECRUITING_DEFAULT_SKILLS]);

/**
 * Adopt a crew set up before the managed preset (bots named after the default roles, with Main
 * and Sourcer on the platform research service) so the account works like a new one: replace
 * the role instructions with the current defaults and remove user copies of the built-in
 * recruiting skills, again whenever the defaults change. Returns null when the Space has no such
 * crew.
 */
async function adoptLegacyCrew(
  tx: Prisma.TransactionClient,
  actor: Actor,
  installed: CapabilityInstall | null,
  options: { firstPartyMcpUrl?: string },
): Promise<{ botId: string; groupId: string } | null> {
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const research = RECRUITING_SERVICES.find((service) => service.slug === "autumn")!;
  const bots = (await tx.bot.findMany({ where: { ...scope, archivedAt: null } })).filter(
    (bot) => !bot.archivedAt && !bot.spawnKey?.startsWith("recruiting:"),
  );
  const crew = RECRUITING_DEFAULT_BOTS.flatMap((role) => {
    const bot = bots.find((item) => item.name === role.name);
    return bot ? [{ role, bot }] : [];
  });
  const main = crew.find((item) => item.role.key === "main")?.bot;
  const sourcer = crew.find((item) => item.role.key === "sourcer")?.bot;
  if (!main || !sourcer) return null;
  const servers = await tx.mcpServer.findMany({
    where: scope,
    include: { assignments: { where: scope } },
  });
  const onResearch = (botId: string) =>
    servers.some(
      (server) =>
        server.endpoint === research.endpoint &&
        server.assignments.some((assignment) => assignment.botId === botId),
    );
  if (!onResearch(main.id) || !onResearch(sourcer.id)) return null;

  const group =
    (await tx.chatGroup.findFirst({
      where: { ...scope, archivedAt: null, members: { some: { botId: main.id } } },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    })) ??
    (await createGroupInTransaction(tx, actor, {
      name: "Recruiting",
      botIds: crew.map((item) => item.bot.id),
    }));
  const result = { botId: main.id, groupId: group.id };

  const target = legacyDigest(options.firstPartyMcpUrl);
  if (installed?.digest === target) return result;
  // Never change instructions under a running turn; the next sign-in retries. A turn paused on a
  // question or approval card starts its next step with fresh instructions, so it does not wait:
  // most recruiters always have a card open somewhere, and their crew never got new defaults.
  if (await tx.run.count({ where: { ...scope, status: { in: [...TURN_IN_FLIGHT_STATUSES] } } }))
    return result;
  for (const { role, bot } of crew) {
    const data: Record<string, string | string[]> = Object.fromEntries(
      LEGACY_BOT_FIELDS.filter((field) => bot[field] !== role[field]).map((field) => [
        field,
        role[field],
      ]),
    );
    const missing = RECRUITING_DISABLED_BUILTIN_TOOLS.filter(
      (name) => !bot.disabledBuiltinTools.includes(name),
    );
    if (missing.length) data.disabledBuiltinTools = [...bot.disabledBuiltinTools, ...missing];
    if (!Object.keys(data).length) continue;
    const changed = await tx.bot.updateMany({
      where: { id: bot.id, ...scope, archivedAt: null, updatedAt: bot.updatedAt },
      data,
    });
    if (changed.count !== 1)
      throw new IsolationError("A recruiting assistant changed during the upgrade");
  }
  // User copies of the built-in recruiting skills would shadow the maintained ones.
  const names = RECRUITING_DEFAULT_SKILLS.map((skill) => skill.name);
  await tx.agentSkill.deleteMany({
    where: { ...scope, source: "user", name: { in: names, mode: "insensitive" } },
  });
  const prior =
    installed?.config && typeof installed.config === "object" && !Array.isArray(installed.config)
      ? installed.config.routines
      : undefined;
  const routines = validRoutines(prior) && prior ? { ...prior } : {};
  await ensureMemoryTidyRoutines(
    tx,
    actor,
    crew.map(({ role, bot }) => ({ key: role.key, botId: bot.id })),
    routines,
  );
  const record = {
    version: LEGACY_PRESET_VERSION,
    digest: target,
    config: { legacy: true, routines },
  };
  if (installed) await tx.capabilityInstall.updateMany({ where: presetWhere(actor), data: record });
  else
    await tx.capabilityInstall.create({
      data: { ...presetWhere(actor), name: "Recruiting defaults", ...record },
    });
  return result;
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
  options: { sandboxKind: string; firstPartyMcpUrl?: string },
) {
  if (
    installed.version === "unmanaged" ||
    installed.digest === catalogDigest(options.firstPartyMcpUrl)
  )
    return;
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
          disabledBuiltinTools: [...RECRUITING_DISABLED_BUILTIN_TOOLS],
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
    const missing = RECRUITING_DISABLED_BUILTIN_TOOLS.filter(
      (name) => !bot.disabledBuiltinTools.includes(name),
    );
    if (missing.length) {
      const changed = await tx.bot.updateMany({
        where: {
          id: bot.id,
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: null,
          disabledBuiltinTools: { equals: bot.disabledBuiltinTools },
        },
        data: { disabledBuiltinTools: [...bot.disabledBuiltinTools, ...missing] },
      });
      if (changed.count !== 1)
        throw new IsolationError("The recruiting tool policy changed during installation");
    }
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
  baseline.routines ??= {};
  await ensureMemoryTidyRoutines(
    tx,
    actor,
    RECRUITING_DEFAULT_BOTS.flatMap((role) => {
      const managedBot = baseline.bots[role.key];
      const bot = bots.find((item) => item.id === managedBot?.id);
      return bot && !bot.archivedAt && group.members.some((member) => member.botId === bot.id)
        ? [{ key: role.key, botId: bot.id }]
        : [];
    }),
    baseline.routines,
  );
  const servers = await tx.mcpServer.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId },
    include: { assignments: { where: { spaceId: actor.spaceId, userId: actor.userId } } },
  });
  for (const service of recruitingServices(options.firstPartyMcpUrl)) {
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
      const desired = {
        allowAllTools: false,
        allowedTools: service.toolsByBot?.[key] ?? service.tools,
      };
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
    data: { version: "1", digest: catalogDigest(options.firstPartyMcpUrl), config: baseline },
  });
}

/**
 * Upgrade existing managed defaults, and bring a crew set up before the preset to the same
 * defaults; never create a returning user's workspace.
 */
export async function upgradeRecruitingWorkspace(
  prisma: PrismaClient,
  actor: Actor,
  options: { sandboxKind: string; firstPartyMcpUrl?: string },
): Promise<void> {
  const installed = await prisma.capabilityInstall.findFirst({ where: presetWhere(actor) });
  if (!installed) {
    const crew = await prisma.bot.count({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        archivedAt: null,
        name: { in: ["Main", "Sourcer"] },
      },
    });
    if (crew < 2) return;
  } else if (installed.version === LEGACY_PRESET_VERSION) {
    if (installed.digest === legacyDigest(options.firstPartyMcpUrl)) return;
  } else if (
    installed.version === "unmanaged" ||
    installed.digest === catalogDigest(options.firstPartyMcpUrl)
  )
    return;
  await prisma.$transaction(
    async (tx) => {
      await lockSpaceForContentCreation(tx, actor);
      const current = await tx.capabilityInstall.findFirst({ where: presetWhere(actor) });
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
      if (!current || current.version === LEGACY_PRESET_VERSION) {
        const home = `recruiting-${digest([actor.spaceId, actor.userId])}`;
        const managed = await tx.chatGroup.count({ where: { id: home } });
        if (!managed) await adoptLegacyCrew(tx, actor, current, options);
      } else await upgradeInTransaction(tx, actor, current, options);
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
  options: { sandboxKind: string; firstPartyMcpUrl?: string },
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
      if (!existing && (!installed || installed.version === LEGACY_PRESET_VERSION)) {
        const legacy = await adoptLegacyCrew(tx, actor, installed, options);
        if (legacy) return legacy;
      }
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
                disabledBuiltinTools: [...RECRUITING_DISABLED_BUILTIN_TOOLS],
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
      const createdServiceIds = new Set<string>();
      if (!existing)
        for (const service of recruitingServices(options.firstPartyMcpUrl)) {
          const prior = await tx.mcpServer.findFirst({
            where: { spaceId: actor.spaceId, userId: actor.userId, slug: service.slug },
          });
          // A same-slug personal CRM connection is not a product-owned installation.
          if (prior && service.slug === "recruiting-crm") continue;
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
          if (!prior) createdServiceIds.add(server.id);
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
                allowedTools:
                  service.toolsByBot?.[
                    RECRUITING_DEFAULT_BOTS.find((role) => bot.spawnKey === spawnKey(role.key))!.key
                  ] ?? service.tools,
              })),
            skipDuplicates: true,
          });
        }
      if (existing) {
        if (installed) await upgradeInTransaction(tx, actor, installed, options);
        else await savePreset(tx, actor, null, options.firstPartyMcpUrl);
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
        for (const service of recruitingServices(options.firstPartyMcpUrl)) {
          const server = servers.find((item) => item.slug === service.slug);
          if (!server) throw new IsolationError();
          if (service.slug === "recruiting-crm" && !createdServiceIds.has(server.id)) continue;
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
        baseline.routines = {};
        await ensureMemoryTidyRoutines(
          tx,
          actor,
          RECRUITING_DEFAULT_BOTS.flatMap((role) => {
            const bot = baseline.bots[role.key];
            return bot ? [{ key: role.key, botId: bot.id }] : [];
          }),
          baseline.routines,
        );
        await savePreset(tx, actor, baseline, options.firstPartyMcpUrl);
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

/**
 * Give crews the platform services added after they were set up: people search for the lead and
 * the sourcing specialist, contact enrichment for the lead and outreach. Covers crews that
 * predate the managed preset. Additive: it creates the platform connection only while none with
 * that slug exists, never changes a connection, links a customized one only when the crew
 * already uses it, skips a disabled one, and adds only missing links. It does not wait for runs,
 * because adding a tool changes nothing an active run already holds.
 */
export async function ensurePlatformServices(prisma: PrismaClient, actor: Actor): Promise<void> {
  for (const slug of ["people-search", "fullenrich"])
    await ensurePlatformService(prisma, actor, slug);
  await ensureBookingChanges(prisma, actor);
}

const BOOKING_CHANGES = ["reschedule_booking", "cancel_booking"];

/**
 * Scheduling can book on a connected Cal.com calendar, so it can also move or cancel those
 * bookings; each change still waits for the recruiter on its own card. Older connections were
 * granted booking alone. Additive: only a restricted grant that already books gains the two tools.
 */
async function ensureBookingChanges(prisma: PrismaClient, actor: Actor): Promise<void> {
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const role = RECRUITING_DEFAULT_BOTS.find((item) => item.key === "scheduling");
  if (!role) return;
  const grants = await prisma.botMcpServer.findMany({
    where: {
      ...scope,
      allowAllTools: false,
      server: { ...scope, endpoint: "https://mcp.cal.com/mcp", enabled: true },
      bot: {
        ...scope,
        archivedAt: null,
        OR: [{ spawnKey: `recruiting:${actor.userId}:${role.key}` }, { name: role.name }],
      },
    },
  });
  for (const grant of grants) {
    const tools = Array.isArray(grant.allowedTools)
      ? grant.allowedTools.filter((tool): tool is string => typeof tool === "string")
      : [];
    const missing = BOOKING_CHANGES.filter((tool) => !tools.includes(tool));
    if (!tools.includes("create_booking") || !missing.length) continue;
    await prisma.botMcpServer.updateMany({
      where: {
        id: grant.id,
        ...scope,
        allowAllTools: false,
        allowedTools: { equals: grant.allowedTools as Prisma.InputJsonValue },
      },
      data: { allowedTools: [...tools, ...missing] },
    });
  }
}

function toolsFor(
  service: RecruitingService,
  bot: { name?: string; spawnKey?: string | null },
): string[] {
  const key = recruitingBotKey(bot) ?? "";
  return service.toolsByBot?.[key] ?? service.tools;
}

async function ensurePlatformService(
  prisma: PrismaClient,
  actor: Actor,
  slug: string,
): Promise<void> {
  const service = RECRUITING_SERVICES.find((item) => item.slug === slug);
  const research = RECRUITING_SERVICES.find((item) => item.slug === "autumn");
  if (!service || !research) return;
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const roleBots = (keys: readonly string[]) =>
    keys.flatMap((key) => [
      { spawnKey: `recruiting:${actor.userId}:${key}` },
      { name: RECRUITING_DEFAULT_BOTS.find((role) => role.key === key)?.name ?? key },
    ]);
  const plan = async (client: Pick<PrismaClient, "mcpServer" | "bot" | "botMcpServer">) => {
    // Only a recruiting crew: its lead is on the platform research service.
    const lead = await client.bot.findFirst({
      where: {
        ...scope,
        archivedAt: null,
        OR: roleBots(["main"]),
        mcpServers: { some: { ...scope, server: { ...scope, endpoint: research.endpoint } } },
      },
      select: { id: true },
    });
    if (!lead) return null;
    const server = await client.mcpServer.findFirst({
      where: { ...scope, slug: service.slug },
      select: { id: true, endpoint: true, secretId: true, enabled: true },
    });
    if (server && (server.endpoint !== service.endpoint || !server.enabled)) return null;
    if (
      server?.secretId &&
      !(await client.botMcpServer.count({ where: { ...scope, serverId: server.id } }))
    )
      return null;
    const bots = await client.bot.findMany({
      where: {
        ...scope,
        archivedAt: null,
        OR: roleBots(service.bots),
        ...(server ? { NOT: { mcpServers: { some: { serverId: server.id } } } } : {}),
      },
      select: { id: true, name: true, spawnKey: true },
    });
    return bots.length ? { server, bots } : null;
  };
  if (!(await plan(prisma))) return;
  await prisma.$transaction(async (tx) => {
    await lockSpaceForContentCreation(tx, actor);
    const todo = await plan(tx);
    if (!todo) return;
    const server =
      todo.server ??
      (await tx.mcpServer.create({
        data: {
          ...scope,
          slug: service.slug,
          name: service.name,
          description: service.description,
          transport: "streamable_http",
          endpoint: service.endpoint,
        },
      }));
    await tx.botMcpServer.createMany({
      data: todo.bots.map((bot) => ({
        ...scope,
        botId: bot.id,
        serverId: server.id,
        allowAllTools: false,
        allowedTools: toolsFor(service, bot),
      })),
      skipDuplicates: true,
    });
  });
}
