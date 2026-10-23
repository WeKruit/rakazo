import { createHash } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ArtifactReadInputSchema } from "@rakazo/contracts";
import { parseCsv, readRecruitingJsonString } from "@rakazo/core";
import { extractPdfText } from "@rakazo/core/node/pdf-text";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, Prisma } from "@rakazo/db";

/** Internal role-context/request records: tool reads refuse them, but say why and what to read instead. */
export const INTERNAL_ARTIFACT_ERROR =
  "This artifact is an internal recruiting role-context or research-request record and is not readable by tools. Use recruiting_role for the current role context, and recruiting_candidates (sources) for saved candidates and their evidence artifactRef IDs.";

/** Actor authorization must precede all storage access, including existence checks. */
export async function readActorArtifact(
  deps: { prisma: Pick<PrismaClient, "artifact" | "$queryRaw">; artifacts: ArtifactStore },
  actor: Pick<Actor, "spaceId" | "userId">,
  input: { artifactId: string; fromTool?: true },
) {
  const row = await deps.prisma.artifact.findFirst({
    where: { id: input.artifactId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!row) throw new IsolationError();
  if (input.fromTool) {
    // Context and formal requests contain private memory. Tool reads cannot reopen their families.
    const rootId = row.rootArtifactId ?? row.id;
    const internal = await deps.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT internal.id FROM "artifacts" internal
      WHERE internal."spaceId" = ${actor.spaceId} AND internal."userId" = ${actor.userId}
        AND (internal.id = ${rootId} OR internal."rootArtifactId" = ${rootId})
        AND (
          EXISTS (
            SELECT 1 FROM "events" event
            WHERE event."runId" = internal."runId" AND event."spaceId" = internal."spaceId"
              AND (internal."botId" IS NULL OR event."botId" = internal."botId")
              AND event.type = 'recruiting.context.adopted'
              AND event.payload->'contextArtifact'->>'artifactId' = internal.id
              AND event.payload->'contextArtifact'->>'sha256' = internal.hash
          ) OR EXISTS (
            SELECT 1 FROM "recruiting_research_actions" action
            WHERE (action."contextArtifactId" = internal.id AND action."contextArtifactHash" = internal.hash)
              OR (action."requestArtifactId" = internal.id AND action."requestArtifactHash" = internal.hash)
          )
        )
      LIMIT 1
    `);
    if (internal.length) throw new IsolationError(INTERNAL_ARTIFACT_ERROR);
  }
  const bytes = await deps.artifacts.get(row.storageKey, {
    operationId: `artifact-get:${row.id}`,
    traceId: `artifact-get:${row.id}`,
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: row.botId ?? row.groupId ?? row.id,
    signal: new AbortController().signal,
  });
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== row.size || hash !== row.hash)
    throw new Error("Saved artifact integrity check failed.");
  return { row, bytes };
}

export async function artifactReadFromTool(
  deps: { prisma: Pick<PrismaClient, "artifact" | "$queryRaw">; artifacts: ArtifactStore },
  actor: Pick<Actor, "spaceId" | "userId">,
  raw: unknown,
) {
  const parsed = ArtifactReadInputSchema.safeParse(raw);
  if (!parsed.success) return { error: "Invalid artifact_read arguments." };
  const { artifactId, jsonPath, offset, limit, csv } = parsed.data;
  let saved: Awaited<ReturnType<typeof readActorArtifact>>;
  try {
    saved = await readActorArtifact(deps, actor, { artifactId, fromTool: true });
  } catch (error) {
    if (error instanceof IsolationError)
      return {
        error:
          error.message === INTERNAL_ARTIFACT_ERROR
            ? INTERNAL_ARTIFACT_ERROR
            : "Artifact is unavailable.",
      };
    // Storage errors may contain paths, credentials or provider internals.
    return { error: "Saved artifact could not be read or verified." };
  }
  const { row, bytes } = saved;
  const metadata = {
    id: row.id,
    botId: row.botId,
    groupId: row.groupId,
    runId: row.runId,
    name: row.name,
    description: row.description,
    mimeType: row.mimeType,
    size: row.size,
    hash: row.hash,
    version: row.version,
    rootArtifactId: row.rootArtifactId,
    createdAt: row.createdAt.toISOString(),
  };
  const mime = row.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    !(
      mime.startsWith("text/") ||
      ["application/json", "application/xml", "application/javascript", "application/pdf"].includes(
        mime,
      )
    )
  )
    return { artifact: metadata, error: "This artifact format does not support text reading." };
  if (csv && mime !== "text/csv")
    return { artifact: metadata, error: "csv requires a text/csv artifact." };
  let text: string;
  if (jsonPath !== undefined) {
    if (mime !== "application/json")
      return { artifact: metadata, error: "JSON string selection requires a JSON artifact." };
    try {
      text = readRecruitingJsonString(bytes, jsonPath);
    } catch {
      return { artifact: metadata, error: "Artifact path does not select a valid JSON string." };
    }
  } else if (mime === "application/pdf") {
    try {
      text = await extractPdfText(bytes);
    } catch {
      return { artifact: metadata, error: "PDF text could not be read or verified." };
    }
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { artifact: metadata, error: "This artifact is not valid UTF-8 text." };
    }
  }
  if (csv) return { artifact: metadata, csv: parseCsv(text) };
  // Code-point offsets never split surrogate pairs; concatenated pages preserve exact text.
  const points = Array.from(text);
  if (offset > points.length) return { error: "Artifact offset is past the end of the text." };
  const end = Math.min(offset + limit, points.length);
  return {
    artifact: metadata,
    ...(jsonPath === undefined ? {} : { jsonPath }),
    text: points.slice(offset, end).join(""),
    offset,
    endOffset: end,
    totalLength: points.length,
    offsetUnit: "unicode_code_point",
    nextOffset: end < points.length ? end : null,
    hasMore: end < points.length,
  };
}
