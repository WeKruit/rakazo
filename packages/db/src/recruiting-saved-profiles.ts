import type { Actor, RecruitingSavedProfile } from "@rakazo/contracts";
import { RecruitingSavedProfileSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";
import { IsolationError } from "./scope.js";

/** One completed connector call from this run, as retained on its effect. */
export type RunToolResult = {
  effectId: string;
  toolName: string;
  endpoint: string;
  result: Prisma.JsonValue;
  createdAt: Date;
};

const owned = (actor: Actor) => ({ spaceId: actor.spaceId, ownerUserId: actor.userId });

function catalogRoute(request: Prisma.JsonValue) {
  if (!Array.isArray(request) || request[0] !== "__rakazoCatalogTool") return null;
  const payload = request[2];
  const route =
    request.length === 3 && request[1] === "direct"
      ? (payload as { route?: unknown } | null)?.route
      : request[3];
  if (!route || typeof route !== "object" || Array.isArray(route)) return null;
  const { connectorId, resourceId, toolName } = route as Record<string, unknown>;
  return connectorId === "mcp" && typeof resourceId === "string" && typeof toolName === "string"
    ? { resourceId, toolName }
    : null;
}

/**
 * Completed connector calls of this actor's run, newest first, with their server endpoint.
 * The caller decides which provider shapes it understands; nothing here is dispatched.
 */
export async function listRunToolResults(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
  limit = 40,
): Promise<RunToolResult[]> {
  const run = await prisma.run.findFirst({
    where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!run) throw new IsolationError();
  const effects = await prisma.externalEffect.findMany({
    where: {
      spaceId: actor.spaceId,
      runId: run.id,
      status: "completed",
      request: { path: ["0"], equals: "__rakazoCatalogTool" },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  const routes = effects.flatMap((effect) => {
    const route = catalogRoute(effect.request);
    return route ? [{ effect, route }] : [];
  });
  const servers = await prisma.mcpServer.findMany({
    where: {
      id: { in: [...new Set(routes.map(({ route }) => route.resourceId))] },
      spaceId: actor.spaceId,
      userId: actor.userId,
    },
    select: { id: true, endpoint: true },
  });
  const endpoints = new Map(servers.map((server) => [server.id, server.endpoint]));
  return routes.flatMap(({ effect, route }) => {
    const endpoint = endpoints.get(route.resourceId);
    return endpoint
      ? [
          {
            effectId: effect.id,
            toolName: route.toolName,
            endpoint,
            result: effect.result,
            createdAt: effect.createdAt,
          },
        ]
      : [];
  });
}

/** Endpoints of the enabled MCP servers this actor has assigned to the bot. */
export async function assignedMcpEndpoints(
  prisma: Pick<PrismaClient, "botMcpServer">,
  actor: Actor,
  botId: string,
): Promise<string[]> {
  const rows = await prisma.botMcpServer.findMany({
    where: { botId, spaceId: actor.spaceId, userId: actor.userId, server: { enabled: true } },
    select: { server: { select: { endpoint: true } } },
  });
  return rows.flatMap((row) => (row.server.endpoint ? [row.server.endpoint] : []));
}

function view(row: {
  personKey: string;
  provider: string;
  fetchedAt: Date;
  profile: Prisma.JsonValue;
}): RecruitingSavedProfile | null {
  const parsed = RecruitingSavedProfileSchema.safeParse({
    ...(row.profile && typeof row.profile === "object" && !Array.isArray(row.profile)
      ? row.profile
      : {}),
    personKey: row.personKey,
    provider: row.provider,
    fetchedAt: row.fetchedAt.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

/** The saved profiles this actor already has for these people (the lookup cache). */
export async function listRecruitingSavedProfiles(
  prisma: Pick<PrismaClient, "recruitingSavedProfile">,
  actor: Actor,
  personKeys: readonly string[],
): Promise<Map<string, RecruitingSavedProfile>> {
  if (!personKeys.length) return new Map();
  const rows = await prisma.recruitingSavedProfile.findMany({
    where: { ...owned(actor), personKey: { in: [...new Set(personKeys)] } },
  });
  return new Map(
    rows.flatMap((row) => {
      const profile = view(row);
      return profile ? [[row.personKey, profile] as const] : [];
    }),
  );
}

/** Replace this actor's saved profile for one person with one verified lookup from the run. */
export async function saveRecruitingSavedProfile(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
  input: {
    personKey: string;
    provider: string;
    sourceEffectId: string;
    fetchedAt: Date;
    profile: Omit<RecruitingSavedProfile, "personKey" | "provider" | "fetchedAt">;
  },
): Promise<RecruitingSavedProfile> {
  const effect = await prisma.externalEffect.findFirst({
    where: {
      id: input.sourceEffectId,
      spaceId: actor.spaceId,
      runId,
      status: "completed",
      run: { userId: actor.userId },
    },
    select: { id: true },
  });
  if (!effect) throw new IsolationError();
  const profile = RecruitingSavedProfileSchema.parse({
    ...input.profile,
    personKey: input.personKey,
    provider: input.provider,
    fetchedAt: input.fetchedAt.toISOString(),
  });
  const { personKey: _key, provider: _provider, fetchedAt: _at, ...facts } = profile;
  const data = {
    provider: input.provider,
    sourceEffectId: effect.id,
    profile: facts as Prisma.InputJsonObject,
    fetchedAt: input.fetchedAt,
  };
  await prisma.recruitingSavedProfile.upsert({
    where: {
      spaceId_ownerUserId_personKey: {
        spaceId: actor.spaceId,
        ownerUserId: actor.userId,
        personKey: input.personKey,
      },
    },
    create: { ...owned(actor), personKey: input.personKey, ...data },
    update: data,
  });
  return profile;
}
