import { expect, it } from "vitest";
import { buildActivity, relativeTime } from "./activity";

const email = (id: string, extra: Record<string, unknown>) => ({
  id,
  providerMessageId: `p-${id}`,
  threadId: null,
  direction: null,
  sender: null,
  recipients: [],
  subject: `Subject ${id}`,
  body: "",
  date: null,
  partial: false,
  ...extra,
});

it("merges stored mail, outbox, status and review newest first without duplicates", () => {
  const items = buildActivity({
    email: "Ada@Example.com",
    roleKey: "Staff Engineer (Acme)",
    crmRoleId: "role-a",
    mail: {
      nativeCorrespondence: [
        {
          id: "n1",
          status: "sent_recorded",
          email: {
            id: "e1",
            providerMessageId: "p-m1",
            sender: "me@example.com",
            recipients: ["ada@example.com"],
            subject: "Staff role",
            date: "2026-10-20T10:00:00Z",
          },
        },
      ],
      items: [
        email("m1", { direction: "sent", date: "2026-10-20T10:00:00Z" }),
        email("m2", { direction: "received", date: "2026-10-21T10:00:00Z", subject: "Re: Staff" }),
      ],
    } as never,
    saved: [
      {
        id: "s1",
        providerMessageId: "p-m2",
        sender: "ada@example.com",
        recipients: [],
        subject: "dup",
        date: "2026-10-21T10:00:00Z",
      },
      {
        id: "s2",
        providerMessageId: "p-other",
        sender: "someone@example.com",
        recipients: ["else@example.com"],
        subject: "Not about Ada",
        date: "2026-10-22T10:00:00Z",
      },
    ] as never,
    details: {
      outbox: [
        {
          id: "o1",
          body: "Hi",
          polishedBody: null,
          status: "failed",
          providerMessageId: null,
          createdAt: "2026-10-19T10:00:00Z",
          sentAt: null,
        },
      ],
      roleTracking: [
        {
          roleKey: "Staff Engineer (Acme)",
          workflowStatus: "needs_scheduling",
          statusChangedAt: "2026-10-22T09:00:00Z",
          highSignal: false,
          highSignalAt: null,
        },
        {
          roleKey: "Other (Acme)",
          workflowStatus: "scheduled",
          statusChangedAt: "2026-10-23T09:00:00Z",
          highSignal: true,
          highSignalAt: "2026-10-23T09:00:00Z",
        },
      ],
      review: {
        id: "r1",
        crmRoleId: "role-a",
        result: "approved",
        notes: " Strong ",
        updatedAt: "2026-10-18T10:00:00Z",
      },
    } as never,
  });
  expect(items.map((item) => [item.kind, item.at])).toEqual([
    ["status", "2026-10-22T09:00:00Z"],
    ["received", "2026-10-21T10:00:00Z"],
    ["sent", "2026-10-20T10:00:00Z"],
    ["failed", "2026-10-19T10:00:00Z"],
    ["review", "2026-10-18T10:00:00Z"],
  ]);
  expect(items[1]).toMatchObject({ subject: "Re: Staff" });
  expect(items[4]).toMatchObject({ notes: "Strong", result: "approved" });
});

it("keeps undated records last and returns nothing without records", () => {
  expect(buildActivity({})).toEqual([]);
  const items = buildActivity({
    mail: {
      nativeCorrespondence: [],
      items: [
        email("a", { direction: "manual" }),
        email("b", { direction: "sent", date: "2026-10-01T00:00:00Z" }),
      ],
    } as never,
  });
  expect(items.map((item) => item.kind)).toEqual(["sent", "email"]);
});

it("formats relative time in the given locale", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  expect(relativeTime("2026-10-21T12:00:00Z", "en", now)).toBe("2 days ago");
  expect(relativeTime("2026-10-23T11:59:30Z", "en", now)).toBe("now");
  expect(relativeTime("2026-10-24T12:00:00Z", "en", now)).toBe("tomorrow");
  expect(relativeTime("2026-10-21T12:00:00Z", "zh-CN", now)).toBe("前天");
});
