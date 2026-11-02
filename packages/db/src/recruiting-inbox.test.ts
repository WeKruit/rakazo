import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { listRecruitingInbox, markRecruitingInbox } from "./recruiting-inbox.js";

const actor = { userId: "reader", spaceId: "space" } as Actor;
const thread = {
  sourceId: "source",
  mailbox: "mailbox",
  threadId: "provider-thread",
  organizationId: null,
};
const baseline = new Date("2026-10-01T00:00:00Z");

describe("personal inbox cursors", () => {
  it("fixes the baseline once and reads only the current user's requested space threads", async () => {
    const upsert = vi.fn().mockResolvedValue({ initializedAt: baseline });
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      recruitingInboxInitialization: { upsert },
      recruitingInboxCursor: { findMany },
    } as unknown as PrismaClient;
    expect(
      await listRecruitingInbox(prisma, actor, {
        threads: [{ ...thread, latestIncomingAt: null }],
      }),
    ).toEqual({ initializedAt: baseline.toISOString(), items: [] });
    expect(upsert.mock.calls[0]![0]).toMatchObject({
      create: { userId: "reader", spaceId: "space" },
      update: { userId: "reader" },
    });
    expect(findMany.mock.calls[0]![0].where).toMatchObject({
      userId: "reader",
      spaceId: "space",
      threadKey: { in: [JSON.stringify(["source", null, "mailbox", "provider-thread"])] },
    });
  });
  it("uses an atomic greatest cursor so a stale open cannot consume concurrent incoming mail", async () => {
    let cursor = baseline.getTime();
    let explicitUnread = false;
    const execute = vi.fn(
      async (
        sql: TemplateStringsArray,
        user: string,
        space: string,
        _key: string,
        through: Date | null,
        unread: boolean,
      ) => {
        expect(sql.join("?")).toContain(
          "GREATEST(recruiting_inbox_cursors.last_read_at, EXCLUDED.last_read_at)",
        );
        expect([user, space]).toEqual(["reader", "space"]);
        cursor = Math.max(cursor, through?.getTime() ?? 0);
        explicitUnread = unread;
      },
    );
    const prisma = {
      recruitingInboxInitialization: {
        upsert: vi.fn().mockResolvedValue({ initializedAt: baseline }),
      },
      $executeRaw: execute,
    } as unknown as PrismaClient;
    const mark = (observedIncomingAt: string, unread = false) =>
      markRecruitingInbox(prisma, actor, { thread, observedIncomingAt, unread });
    await mark("2026-10-03T00:00:00Z");
    await mark("2026-10-02T00:00:00Z");
    expect(cursor).toBe(Date.parse("2026-10-03T00:00:00Z"));
    expect(Date.parse("2026-10-04T00:00:00Z") > cursor).toBe(true);
    await mark("2026-10-03T00:00:00Z", true);
    expect(explicitUnread).toBe(true);
    await mark("2026-09-01T00:00:00Z");
    expect(explicitUnread).toBe(false);
    expect(cursor).toBe(Date.parse("2026-10-03T00:00:00Z"));
    await expect(mark("2999-01-01T00:00:00Z")).rejects.toThrow("Invalid incoming timestamp");
    expect(execute).toHaveBeenCalledTimes(4);
  });
});
