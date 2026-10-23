import type { Actor, RecruitingCrmSyncOutput } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { TestSink } from "@rakazo/logging";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecruitingCrmReadDeps } from "./recruiting.js";
import { syncRecruitingCrm } from "./recruiting-crm-sync.js";
import type { ThreadTarget } from "./thread-target.js";

const actor: Actor = {
  userId: "private-user",
  spaceId: "private-space",
  email: "private@example.test",
  isDeploymentOwner: false,
};
const target: ThreadTarget = {
  kind: "group",
  groupId: "private-group",
  threadId: "private-thread",
  groupName: "Private group",
  members: [],
  memberBotIds: [],
};
const counts = { seen: 3, created: 1, updated: 1, unchanged: 1, archived: 0, restored: 0 };
const result = (patch: Partial<RecruitingCrmSyncOutput> = {}): RecruitingCrmSyncOutput => ({
  dryRun: false,
  startedAt: "2026-10-23T10:00:00.000Z",
  nextCursor: null,
  organizations: 1,
  roles: { ...counts },
  contacts: { ...counts },
  links: { ...counts },
  messages: { ...counts },
  skipped: [],
  ...patch,
});

describe("CRM sync aggregate telemetry", () => {
  const previousLogger = getLogger();
  let sink: TestSink;
  let transaction: ReturnType<typeof vi.fn>;
  let deps: RecruitingCrmReadDeps;

  beforeEach(() => {
    sink = createTestSink();
    installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
    // Deliberately never invoke the callback: no database or CRM reader is used.
    transaction = vi.fn();
    deps = {
      prisma: { $transaction: transaction } as unknown as PrismaClient,
      connectors: { execute: vi.fn() },
      reauthorize: vi.fn(),
    };
  });

  afterEach(() => {
    installLogger(previousLogger);
    vi.restoreAllMocks();
  });

  it("emits a successful final report only after the transaction has committed", async () => {
    const report = result();
    let commit!: (value: RecruitingCrmSyncOutput) => void;
    transaction.mockReturnValue(
      new Promise<RecruitingCrmSyncOutput>((resolve) => {
        commit = resolve;
      }),
    );
    const pending = syncRecruitingCrm(deps, actor, target, {});
    expect(sink.events).toEqual([]);
    commit(report);
    expect(await pending).toBe(report);
    expect(sink.events).toEqual([
      {
        timestamp: expect.any(String),
        level: "info",
        message: "crm.sync.completed",
        "service.name": "rakazo-api",
        dry_run: false,
        duration_ms: expect.any(Number),
        has_more: false,
        organizations: 1,
        roles_seen: 3,
        contacts_seen: 3,
        links_seen: 3,
        messages_seen: 3,
        skipped_count: 0,
      },
    ]);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 120_000,
      maxWait: 5_000,
    });
  });

  it.each([false, true])(
    "distinguishes continuation from completion (dryRun=%s)",
    async (dryRun) => {
      transaction.mockResolvedValue(result({ dryRun, nextCursor: "private-next-cursor" }));
      await syncRecruitingCrm(deps, actor, target, { dryRun, cursor: "private-input-cursor" });
      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]).toMatchObject({
        message: "crm.sync.slice",
        dry_run: dryRun,
        has_more: true,
      });
      expect(JSON.stringify(sink.events)).not.toContain("private-");
    },
  );

  it("marks a completed dry run so it cannot count as a completed real sync", async () => {
    transaction.mockResolvedValue(result({ dryRun: true }));
    await syncRecruitingCrm(deps, actor, target, { dryRun: true });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ message: "crm.sync.completed", dry_run: true });
    expect(
      sink.events.filter((event) => event.message === "crm.sync.completed" && !event.dry_run),
    ).toEqual([]);
  });

  it.each([null, "private-next-cursor"])(
    "never reports an incomplete pass as completed (%s)",
    async (nextCursor) => {
      transaction.mockResolvedValue(
        result({
          nextCursor,
          skipped: [
            {
              organizationId: "private-organization",
              crmRoleId: "private-role",
              step: "contacts",
              reason: "private@example.test https://private.example.test?token=private-token",
            },
          ],
        }),
      );
      await syncRecruitingCrm(deps, actor, target, {});
      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]).toMatchObject({
        level: "warn",
        message: "crm.sync.incomplete",
        skipped_count: 1,
        has_more: nextCursor !== null,
      });
      expect(JSON.stringify(sink.events)).not.toContain("private");
    },
  );

  it.each([false, true])(
    "records a commit failure without its raw error (dryRun=%s)",
    async (dryRun) => {
      const failure = new Error(
        "private@example.test https://private.example.test?token=private-token",
      );
      transaction.mockRejectedValue(failure);
      await expect(syncRecruitingCrm(deps, actor, target, { dryRun })).rejects.toBe(failure);
      expect(sink.events).toEqual([
        {
          timestamp: expect.any(String),
          level: "error",
          message: "crm.sync.failed",
          "service.name": "rakazo-api",
          dry_run: dryRun,
          duration_ms: expect.any(Number),
        },
      ]);
      expect(JSON.stringify(sink.events)).not.toContain("private");
    },
  );

  it.each([
    { end: -1, expected: 0 },
    { end: 200_000, expected: 125_000 },
  ])("bounds the recorded duration ($end)", async ({ end, expected }) => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(end);
    transaction.mockResolvedValue(result());
    await syncRecruitingCrm(deps, actor, target, {});
    expect(sink.events[0]?.duration_ms).toBe(expected);
  });
});
