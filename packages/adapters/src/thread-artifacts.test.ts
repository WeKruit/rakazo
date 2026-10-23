import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { attachWorkspaceFileToThread, storeToolOutputArtifact } from "./thread-artifacts.js";

describe("current-turn thread files", () => {
  it("removes stored bytes when artifact metadata cannot be created", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const failure = new Error("database unavailable");
    const artifact = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockRejectedValue(failure),
    };
    const tx = { artifact, $queryRaw: vi.fn().mockResolvedValue([{ lock: "1" }]) };

    await expect(
      attachWorkspaceFileToThread(
        {
          prisma: {
            artifact,
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
          } as unknown as PrismaClient,
          artifacts: {
            put: vi.fn().mockResolvedValue({ id: "stored-1", hash: "hash" }),
            remove,
          } as unknown as ArtifactStore,
        },
        {
          spaceId: "workspace-1",
          userId: "user-1",
          botId: "bot-1",
          runId: "run-1",
          filePath: "report.pdf",
          bytes: new Uint8Array([1, 2, 3]),
          operationId: "attach-1",
        },
      ),
    ).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledWith(
      "stored-1",
      expect.objectContaining({ spaceId: "workspace-1", botId: "bot-1" }),
    );
  });
});

describe("clipped tool output artifacts", () => {
  it("stores the complete text as a plain-text artifact on the run", async () => {
    const put = vi.fn().mockResolvedValue({ id: "stored-2", hash: "hash" });
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "artifact-2",
      ...data,
    }));
    const tx = {
      artifact: { findFirst: vi.fn().mockResolvedValue(null), create },
      $queryRaw: vi.fn().mockResolvedValue([{ lock: "1" }]),
    };
    const stored = await storeToolOutputArtifact(
      {
        prisma: {
          artifact: tx.artifact,
          $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
        } as unknown as PrismaClient,
        artifacts: { put, remove: vi.fn() } as unknown as ArtifactStore,
      },
      {
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-1",
        runId: "run-1",
        toolName: "web_fetch",
        executionId: "exec-1",
        text: "long page text é",
      },
    );
    expect(stored).toEqual({ artifactId: "artifact-2", length: 16 });
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ name: "web_fetch-exec-1.txt", mimeType: "text/plain" }),
      expect.objectContaining({ spaceId: "workspace-1", botId: "bot-1" }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: "run-1",
          mimeType: "text/plain",
          storageKey: "stored-2",
        }),
      }),
    );
  });

  it("refuses text over the attachment limit without touching storage", async () => {
    const put = vi.fn();
    const stored = await storeToolOutputArtifact(
      { prisma: {} as PrismaClient, artifacts: { put } as unknown as ArtifactStore },
      {
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-1",
        runId: "run-1",
        toolName: "shell",
        executionId: "exec-2",
        text: "y".repeat(10 * 1024 * 1024 + 1),
      },
    );
    expect(stored).toBeUndefined();
    expect(put).not.toHaveBeenCalled();
  });
});
