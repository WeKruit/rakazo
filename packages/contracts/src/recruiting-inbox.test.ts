import { describe, expect, it } from "vitest";
import {
  inboxThreadKey,
  inboxThreadUnread,
  ListRecruitingInboxInputSchema,
  MarkRecruitingInboxInputSchema,
} from "./recruiting-inbox.js";

describe("personal mail-thread reading", () => {
  it("shares one source thread across roles but separates source/mailbox identities", () => {
    const a = {
      sourceId: "source",
      threadId: "thread",
      mailbox: "person@example.test",
      organizationId: null,
    };
    expect(inboxThreadKey(a)).toBe(inboxThreadKey({ ...a }));
    expect(inboxThreadKey(a)).not.toBe(inboxThreadKey({ ...a, mailbox: "other@example.test" }));
    expect(inboxThreadKey(a)).not.toBe(inboxThreadKey({ ...a, sourceId: "other" }));
    expect(inboxThreadKey(a)).not.toBe(inboxThreadKey({ ...a, organizationId: "other" }));
  });
  it("keeps historical mail read, new inbound unread, and missing evidence unknown", () => {
    const baseline = "2026-11-01T00:00:00.000Z";
    expect(inboxThreadUnread("2026-10-31T12:00:00.000Z", null, baseline)).toBe(false);
    expect(inboxThreadUnread("2026-11-01T01:00:00.000Z", null, baseline)).toBe(true);
    expect(inboxThreadUnread(null, null, baseline)).toBe(null);
    expect(inboxThreadUnread("invalid", null, baseline)).toBe(null);
  });
  it("marks read only through observed inbound, and supports an explicit unread cursor", () => {
    const baseline = "2026-11-01T00:00:00.000Z";
    const seen = "2026-11-01T01:00:00.000Z";
    expect(inboxThreadUnread(seen, seen, baseline)).toBe(false);
    expect(inboxThreadUnread("2026-11-01T01:00:00.001Z", seen, baseline)).toBe(true);
    expect(
      inboxThreadUnread("2026-10-31T12:00:00.000Z", "1970-01-01T00:00:00.000Z", baseline),
    ).toBe(true);
  });
  it("bounds preference reads and rejects fabricated future observations", () => {
    const thread = {
      sourceId: "source",
      threadId: "thread",
      mailbox: "mailbox",
      organizationId: null,
    };
    expect(
      ListRecruitingInboxInputSchema.safeParse({
        threads: Array(201).fill({ ...thread, latestIncomingAt: null }),
      }).success,
    ).toBe(false);
    expect(
      MarkRecruitingInboxInputSchema.safeParse({
        thread,
        unread: false,
        observedIncomingAt: "2999-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      MarkRecruitingInboxInputSchema.safeParse({
        thread: { ...thread, sourceId: "" },
        unread: true,
        observedIncomingAt: "2026-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });
});
