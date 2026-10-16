import { createHash } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { ArtifactReadInputSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";

/** Actor authorization must precede all storage access, including existence checks. */
export async function readActorArtifact(
  deps: { prisma: Pick<PrismaClient, "artifact">; artifacts: ArtifactStore },
  actor: Pick<Actor, "spaceId" | "userId">,
  input: { artifactId: string },
) {
  const row = await deps.prisma.artifact.findFirst({
    where: { id: input.artifactId, spaceId: actor.spaceId, userId: actor.userId },
  });
  if (!row) throw new IsolationError();
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
  deps: { prisma: Pick<PrismaClient, "artifact">; artifacts: ArtifactStore },
  actor: Pick<Actor, "spaceId" | "userId">,
  raw: unknown,
) {
  const parsed = ArtifactReadInputSchema.safeParse(raw);
  if (!parsed.success) return { error: "Invalid artifact_read arguments." };
  const { artifactId, offset, limit } = parsed.data;
  let saved: Awaited<ReturnType<typeof readActorArtifact>>;
  try {
    saved = await readActorArtifact(deps, actor, { artifactId });
  } catch (error) {
    if (error instanceof IsolationError) return { error: "Artifact is unavailable." };
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
      ["application/json", "application/xml", "application/javascript"].includes(mime)
    )
  )
    return { artifact: metadata, error: "This artifact format does not support text reading." };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { artifact: metadata, error: "This artifact is not valid UTF-8 text." };
  }
  // Code-point offsets never split surrogate pairs; concatenated pages preserve exact text.
  const points = Array.from(text);
  if (offset > points.length) return { error: "Artifact offset is past the end of the text." };
  const end = Math.min(offset + limit, points.length);
  return {
    artifact: metadata,
    text: points.slice(offset, end).join(""),
    offset,
    endOffset: end,
    totalLength: points.length,
    offsetUnit: "unicode_code_point",
    nextOffset: end < points.length ? end : null,
    hasMore: end < points.length,
  };
}
