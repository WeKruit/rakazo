import { createHash } from "node:crypto";
import path from "node:path";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  ARTIFACT_DESCRIPTION_MAX_LENGTH,
  ARTIFACT_NAME_MAX_LENGTH,
  ATTACHMENT_MAX_BYTES,
} from "@rakazo/contracts";
import {
  inferAttachmentMimeType,
  messageBlockForArtifact,
  validateAttachmentMimeType,
} from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { withResolvedArtifactVersion } from "@rakazo/db";

export async function attachWorkspaceFileToThread(
  deps: {
    prisma: PrismaClient;
    artifacts: ArtifactStore;
  },
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string;
    runId: string;
    filePath: string;
    bytes: Uint8Array;
    operationId: string;
    name?: string;
    description?: string;
  },
): Promise<{ artifactId: string; block: Extract<MessageBlock, { kind: "image" | "file" }> }> {
  const fileName = path.basename(input.filePath) || input.filePath;
  const mimeType = inferAttachmentMimeType(fileName);
  if (!mimeType) {
    throw new Error(`Unsupported attachment type for ${fileName}`);
  }
  const name = (input.name?.trim() || fileName).slice(0, ARTIFACT_NAME_MAX_LENGTH);
  validateAttachmentMimeType(mimeType);
  if (input.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new Error("file exceeds the 10 MiB attachment limit");
  }

  const context = {
    operationId: input.operationId,
    traceId: input.operationId,
    spaceId: input.spaceId,
    userId: input.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  };
  const stored = await deps.artifacts.put({ name, mimeType, bytes: input.bytes }, context);
  const hash = createHash("sha256").update(input.bytes).digest("hex");
  const row = await withResolvedArtifactVersion(
    deps.prisma,
    {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: input.botId,
      groupId: input.groupId,
      name,
    },
    (tx, { rootArtifactId, version }) =>
      tx.artifact.create({
        data: {
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          groupId: input.groupId,
          runId: input.runId,
          name,
          description: input.description?.trim().slice(0, ARTIFACT_DESCRIPTION_MAX_LENGTH) || null,
          mimeType,
          size: input.bytes.byteLength,
          hash,
          storageKey: stored.id,
          rootArtifactId,
          version,
        },
      }),
  ).catch(async (error) => {
    await deps.artifacts.remove(stored.id, context).catch(() => undefined);
    throw error;
  });
  return {
    artifactId: row.id,
    block: messageBlockForArtifact({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
    }),
  };
}
