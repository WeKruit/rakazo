import { randomUUID } from "node:crypto";
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
  skip = 0,
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
    skip,
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

type ProfileFacts = Omit<RecruitingSavedProfile, "personKey" | "provider" | "fetchedAt">;

export function mergeRecruitingProfileFacts(
  previous: RecruitingSavedProfile | undefined,
  incoming: ProfileFacts,
): ProfileFacts {
  const name = (value: string | null) => value?.trim().replace(/\s+/g, " ").toLowerCase();
  const unique = (values: (string | null)[]) => {
    const urls = [...new Set(values.filter((value): value is string => Boolean(value)))];
    return urls.length === 1 ? urls[0]! : null;
  };
  const merged = previous
    ? {
        ...incoming,
        headline: previous.headline ?? incoming.headline,
        profileImageUrl: previous.profileImageUrl ?? incoming.profileImageUrl,
        email: previous.email ?? incoming.email ?? null,
        githubUrl: previous.githubUrl ?? incoming.githubUrl ?? null,
        websiteUrl: previous.websiteUrl ?? incoming.websiteUrl ?? null,
        stackOverflowUrl: previous.stackOverflowUrl ?? incoming.stackOverflowUrl ?? null,
        experience: previous.experience.length
          ? previous.experience.map((job) => {
              const matches = incoming.experience.filter(
                (incoming) =>
                  job.company_name &&
                  name(incoming.company_name) === name(job.company_name) &&
                  !(
                    job.company_url &&
                    incoming.company_url &&
                    job.company_url !== incoming.company_url
                  ),
              );
              return {
                ...job,
                company_logo_url:
                  job.company_logo_url ?? unique(matches.map((item) => item.company_logo_url)),
                company_url: job.company_url ?? unique(matches.map((item) => item.company_url)),
                company_linkedin_url:
                  job.company_linkedin_url ??
                  unique(matches.map((item) => item.company_linkedin_url)),
              };
            })
          : incoming.experience,
        education: previous.education.length
          ? previous.education.map((school) => {
              const matches = incoming.education.filter(
                (incoming) =>
                  school.school_name &&
                  name(incoming.school_name) === name(school.school_name) &&
                  !(
                    school.school_url &&
                    incoming.school_url &&
                    school.school_url !== incoming.school_url
                  ),
              );
              return {
                ...school,
                school_logo_url:
                  school.school_logo_url ?? unique(matches.map((item) => item.school_logo_url)),
                school_url: school.school_url ?? unique(matches.map((item) => item.school_url)),
              };
            })
          : incoming.education,
      }
    : incoming;
  return merged;
}

/** Replace this actor's saved profile for one person with one verified lookup from the run. */
export async function saveRecruitingSavedProfile(
  prisma: Pick<PrismaClient, "externalEffect" | "recruitingSavedProfile" | "$queryRaw">,
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
    email: input.profile.email ?? null,
    githubUrl: input.profile.githubUrl ?? null,
    websiteUrl: input.profile.websiteUrl ?? null,
    stackOverflowUrl: input.profile.stackOverflowUrl ?? null,
    personKey: input.personKey,
    provider: input.provider,
    fetchedAt: input.fetchedAt.toISOString(),
  });
  const { personKey: _key, provider: _provider, fetchedAt: _at, ...facts } = profile;
  const changed = await prisma.$queryRaw<
    Array<{ personKey: string; provider: string; profile: Prisma.JsonValue; fetchedAt: Date }>
  >`INSERT INTO recruiting_saved_profiles (id,"spaceId","ownerUserId","personKey",provider,"sourceEffectId",profile,"fetchedAt","updatedAt") VALUES (${randomUUID()},${actor.spaceId},${actor.userId},${input.personKey},${input.provider},${effect.id},${JSON.stringify(facts)}::jsonb,${input.fetchedAt},now()) ON CONFLICT ("spaceId","ownerUserId","personKey") DO UPDATE SET provider=EXCLUDED.provider,"sourceEffectId"=EXCLUDED."sourceEffectId",profile=EXCLUDED.profile,"fetchedAt"=EXCLUDED."fetchedAt","updatedAt"=now() WHERE recruiting_saved_profiles."fetchedAt"<=EXCLUDED."fetchedAt" RETURNING "personKey",provider,profile,"fetchedAt"`;
  if (!changed.length) {
    const latest = await prisma.recruitingSavedProfile.findUniqueOrThrow({
      where: {
        spaceId_ownerUserId_personKey: {
          spaceId: actor.spaceId,
          ownerUserId: actor.userId,
          personKey: input.personKey,
        },
      },
    });
    const retained = view(latest);
    if (!retained) throw new IsolationError();
    return retained;
  }
  return profile;
}

/** Ingest a page's exact-person facts atomically, with bounded queries rather than per-person reads. */
export async function saveRecruitingSavedProfiles(
  prisma: Pick<
    PrismaClient,
    "externalEffect" | "recruitingSavedProfile" | "$queryRaw" | "$executeRaw"
  >,
  actor: Actor,
  runId: string,
  inputs: ReadonlyArray<{
    personKey: string;
    provider: string;
    sourceEffectId: string;
    fetchedAt: Date;
    profile: ProfileFacts;
  }>,
) {
  if (!inputs.length) return;
  const sources = [...new Set(inputs.map((input) => input.sourceEffectId))];
  const completed = await prisma.externalEffect.findMany({
    where: {
      id: { in: sources },
      spaceId: actor.spaceId,
      runId,
      status: "completed",
      run: { userId: actor.userId, spaceId: actor.spaceId },
    },
    select: { id: true },
  });
  if (completed.length !== sources.length) throw new IsolationError();
  const keys = [...new Set(inputs.map((input) => input.personKey))].sort();
  // Per-person locks also cover first insertion; sorted acquisition keeps concurrent roles ordered.
  await prisma.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(item.key,0))::text FROM (SELECT value AS key FROM jsonb_array_elements_text(${JSON.stringify(keys.map((key) => JSON.stringify([actor.userId, actor.spaceId, key])))}::jsonb) ORDER BY value) item`;
  const current = await listRecruitingSavedProfiles(prisma, actor, keys);
  const rows = new Map<
    string,
    {
      id: string;
      personKey: string;
      provider: string;
      sourceEffectId: string;
      fetchedAt: string;
      profile: ProfileFacts;
    }
  >();
  for (const input of inputs) {
    const before = current.get(input.personKey);
    if (before && Date.parse(before.fetchedAt) > input.fetchedAt.getTime()) continue;
    const merged = mergeRecruitingProfileFacts(before, input.profile);
    const profile = RecruitingSavedProfileSchema.parse({
      ...merged,
      email: merged.email ?? null,
      githubUrl: merged.githubUrl ?? null,
      websiteUrl: merged.websiteUrl ?? null,
      stackOverflowUrl: merged.stackOverflowUrl ?? null,
      personKey: input.personKey,
      provider: input.provider,
      fetchedAt: input.fetchedAt.toISOString(),
    });
    current.set(input.personKey, profile);
    const { personKey, provider, fetchedAt, ...facts } = profile;
    rows.set(personKey, {
      id: randomUUID(),
      personKey,
      provider,
      sourceEffectId: input.sourceEffectId,
      fetchedAt,
      profile: facts,
    });
  }
  if (!rows.size) return;
  await prisma.$executeRaw`INSERT INTO recruiting_saved_profiles (id,"spaceId","ownerUserId","personKey",provider,"sourceEffectId",profile,"fetchedAt","updatedAt")
    SELECT row.id,${actor.spaceId},${actor.userId},row."personKey",row.provider,row."sourceEffectId",row.profile,row."fetchedAt"::timestamp,now()
    FROM jsonb_to_recordset(${JSON.stringify([...rows.values()])}::jsonb) AS row(id text,"personKey" text,provider text,"sourceEffectId" text,profile jsonb,"fetchedAt" text)
    ON CONFLICT ("spaceId","ownerUserId","personKey") DO UPDATE SET provider=EXCLUDED.provider,"sourceEffectId"=EXCLUDED."sourceEffectId",profile=EXCLUDED.profile,"fetchedAt"=EXCLUDED."fetchedAt","updatedAt"=now() WHERE recruiting_saved_profiles."fetchedAt"<=EXCLUDED."fetchedAt"`;
}

/** The people in this actor's role pool and the runs that saved them, oldest run first. */
export async function listRecruitingRolePoolRuns(
  prisma: PrismaClient,
  actor: Actor,
  roleId: string,
): Promise<{ personKeys: string[]; runIds: string[] }> {
  const role = await prisma.recruitingRole.findFirst({
    where: { id: roleId, spaceId: actor.spaceId, userId: actor.userId },
    select: { id: true },
  });
  if (!role) throw new IsolationError();
  const [candidates, pages] = await Promise.all([
    prisma.recruitingCandidate.findMany({
      where: { roleId: role.id, candidateKey: { startsWith: "linkedin:" } },
      select: { candidateKey: true },
    }),
    prisma.recruitingCandidatePage.findMany({
      where: { roleId: role.id, effect: { spaceId: actor.spaceId, run: { userId: actor.userId } } },
      orderBy: { observedAt: "asc" },
      select: { effect: { select: { runId: true } } },
    }),
  ]);
  return {
    personKeys: candidates.map((candidate) => candidate.candidateKey),
    runIds: [...new Set(pages.map((page) => page.effect.runId))],
  };
}
