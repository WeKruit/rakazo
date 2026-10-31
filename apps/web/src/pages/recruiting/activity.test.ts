import { expect, it } from "vitest";
import { buildActivity, relativeTime } from "./activity";

it("retains dated imported status changes only for the selected candidate", () => {
  const items = buildActivity({
    candidateKey: "linkedin:/in/candidate-a",
    history: [
      {
        id: "stage-1",
        candidateKey: "linkedin:/in/candidate-a",
        at: "2026-01-02T00:00:00Z",
        label: "Stage",
        before: "Interested",
        after: "Interview",
      },
      {
        id: "review-1",
        candidateKey: "linkedin:/in/candidate-a",
        at: "2026-01-03T00:00:00Z",
        label: "Reviewed",
        before: "false",
        after: "true",
      },
      {
        id: "foreign",
        candidateKey: "linkedin:/in/candidate-b",
        at: "2026-01-04T00:00:00Z",
        label: "Stage",
        before: "Interested",
        after: "Declined",
      },
    ],
  });
  expect(items.map((item) => item.id)).toEqual(["import:review-1", "import:stage-1"]);
  expect(items[1]).toMatchObject({
    kind: "change",
    label: "Stage",
    before: "Interested",
    after: "Interview",
  });
});

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
    ["review", "2026-10-18T10:00:00Z"],
    ["failed", null],
  ]);
  expect(items[1]).toMatchObject({ subject: "Re: Staff" });
  expect(items[3]).toMatchObject({ notes: "Strong", result: "approved" });
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

it("matches complete email addresses and preserves the actual sender as actor", () => {
  const saved = [
    {
      id: "wrong",
      providerMessageId: "wrong",
      sender: "notada@example.test",
      recipients: [],
      subject: "Wrong person",
      date: null,
    },
    {
      id: "domain",
      providerMessageId: "domain",
      sender: "ada@example.test.evil",
      recipients: [],
      subject: "Wrong domain",
      date: null,
    },
    {
      id: "real",
      providerMessageId: "real",
      sender: "Ada <ADA@example.test>",
      recipients: [],
      subject: "Initial inbound",
      date: "2026-10-23T10:00:00Z",
    },
  ];
  expect(buildActivity({ email: "ada@example.test", saved: saved as never })).toEqual([
    expect.objectContaining({
      id: "saved:real",
      kind: "received",
      actor: "Ada <ADA@example.test>",
      source: "mailbox",
    }),
  ]);
});
it("never invents sent/failure times or actors from an outbox creation time", () => {
  const items = buildActivity({
    details: {
      outbox: [
        { id: "sent", status: "sent", body: "", createdAt: "2026-10-01T00:00:00Z", sentAt: null },
        { id: "failed", status: "failed", body: "", createdAt: "2026-10-01T00:00:00Z" },
      ],
    } as never,
  });
  expect(items).toHaveLength(2);
  expect(items.every((item) => item.at === null && item.actor === null)).toBe(true);
});
it("requires the exact role for status and review activity", () => {
  const details = {
    outbox: [],
    roleTracking: [
      {
        roleKey: "Another role",
        workflowStatus: "scheduled",
        statusChangedAt: "2026-10-23T00:00:00Z",
      },
    ],
    review: {
      id: "review",
      crmRoleId: "other",
      result: "approved",
      updatedAt: "2026-10-23T00:00:00Z",
    },
  };
  expect(buildActivity({ details: details as never })).toEqual([]);
  expect(
    buildActivity({ details: details as never, roleKey: "Selected role", crmRoleId: "selected" }),
  ).toEqual([]);
});
it("merges actual profile views and keeps unknown/invalid dates undated", () => {
  const items = buildActivity({
    views: [
      {
        id: "view",
        at: "2026-10-23T12:00:00Z",
        actorName: "Recruiter",
        roleTitle: "Synthetic role",
      },
    ],
    mail: { items: [email("bad-date", { date: "not-a-date", direction: "received" })] } as never,
  });
  expect(items[0]).toMatchObject({ kind: "viewed", actor: "Recruiter", source: "profile" });
  expect(items[1]?.at).toBeNull();
});

it("does not attribute scheduling to the future message sender/date", () => {
  const items = buildActivity({
    mail: {
      nativeCorrespondence: [
        {
          id: "scheduled",
          status: "scheduled",
          email: {
            providerMessageId: "future",
            subject: "Scheduled",
            sender: "sender@example.test",
            date: "2026-10-24T12:00:00Z",
          },
        },
      ],
    } as never,
  });
  expect(items[0]).toMatchObject({ kind: "scheduled", actor: null, at: null });
});

it("uses the recorded candidate identity for imported mail even when its address is absent from headers", () => {
  const source = {
    id: "original",
    providerMessageId: "provider-original",
    imported: true,
    candidateKey: "person-a",
    direction: "received",
    sender: "alias@example.test",
    recipients: ["team@example.test"],
    subject: "Original reply",
    date: "2026-01-02T00:00:00Z",
  };
  const items = buildActivity({
    candidateKey: "person-a",
    email: "person@example.test",
    saved: [
      source,
      {
        ...source,
        id: "foreign",
        providerMessageId: "foreign",
        candidateKey: "person-b",
        sender: "person@example.test",
      },
    ] as never,
  });
  expect(items).toEqual([
    expect.objectContaining({ id: "saved:original", kind: "received", subject: "Original reply" }),
  ]);
});
