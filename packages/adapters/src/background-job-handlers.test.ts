import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "./background-job-handlers.js";
import { createRunExecutor } from "./executor.js";
import { projectRecruitingCandidateProfiles } from "./recruiting-profiles.js";
import { projectRecruitingInboxJob } from "./recruiting-reads.js";

vi.mock("./recruiting-reads.js", async (original) => ({
  ...(await original<typeof import("./recruiting-reads.js")>()),
  projectRecruitingInboxJob: vi.fn(async () => undefined),
}));
vi.mock("./recruiting-profiles.js", () => ({
  projectRecruitingCandidateProfiles: vi.fn(async () => undefined),
}));
vi.mock("./messaging-delivery.js", () => ({
  deliverMessagingOutbound: vi.fn(async () => undefined),
  mirrorMessagingOutbound: vi.fn(async () => undefined),
}));

describe("createBackgroundJobHandlers", () => {
  it("registers canonical inbox projection and retains Graphile retry on a transient failure", async () => {
    const deps = { prisma: {}, events: {} } as Parameters<typeof createBackgroundJobHandlers>[0];
    const handlers = createBackgroundJobHandlers(deps);
    const payload = { effectId: "mail-receipt" };
    await handlers["recruiting_inbox.project"](payload);
    expect(projectRecruitingInboxJob).toHaveBeenCalledWith(
      { prisma: deps.prisma, events: deps.events },
      payload,
    );
    vi.mocked(projectRecruitingInboxJob).mockRejectedValueOnce(new Error("database busy"));
    await expect(handlers["recruiting_inbox.project"](payload)).rejects.toThrow("database busy");
  });
  it("registers saved-profile projection with the existing worker and lets queue failures retry", async () => {
    const deps = { prisma: {}, events: {} } as Parameters<typeof createBackgroundJobHandlers>[0];
    const handlers = createBackgroundJobHandlers(deps);
    const payload = { pageEffectId: "page-effect-1" };
    await handlers["recruiting_profile.project"](payload);
    expect(projectRecruitingCandidateProfiles).toHaveBeenCalledWith(
      { prisma: deps.prisma, events: deps.events },
      payload,
    );
    vi.mocked(projectRecruitingCandidateProfiles).mockRejectedValueOnce(new Error("database busy"));
    await expect(handlers["recruiting_profile.project"](payload)).rejects.toThrow("database busy");
  });

  it("resolves the deployment model when no user credential is configured", async () => {
    const prisma = {
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
      deploymentModelKey: "deployment-key",
      deploymentModelConfigured: true,
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "openrouter",
      id: "openai/gpt-6-luna",
      apiKey: "deployment-key",
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });

  it("preserves a configured local model when resolving background compaction", async () => {
    const prisma = {
      spaceModelPreference: { findFirst: vi.fn(async () => null) },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "local",
          defaultModelId: "qwen3:4b",
        })),
      },
    } as unknown as PrismaClient;
    const executor = createRunExecutor({
      prisma,
    } as Parameters<typeof createRunExecutor>[0]);

    await expect(
      executor.resolveModel({ userId: "user-1", spaceId: "workspace-1" }),
    ).resolves.toEqual({
      provider: "local",
      id: "qwen3:4b",
      apiKey: undefined,
      baseUrl: undefined,
      thinkingLevel: null,
      oauth: undefined,
    });
  });
});
