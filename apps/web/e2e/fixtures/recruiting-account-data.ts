import type { RecruitingAccountViewOutput } from "@rakazo/contracts";
import {
  appGroupId,
  appRoleId,
  checkedAt,
  revision as fixtureRevision,
  role as fixtureRole,
} from "./recruiting-app-data";
// Synthetic transport fixture; backend isolation/pagination are exercised separately against the shared reader.
export function accountRolesData() {
  return [
    {
      id: appRoleId,
      title: "Staff Platform Engineer",
      threadId: "fixture-thread",
      groupId: appGroupId,
      stage: "interview",
    },
    {
      id: "fixture-role-two",
      title: "Product Designer",
      threadId: "fixture-thread-two",
      groupId: "fixture-group-two",
      stage: "outreach",
    },
  ];
}
export const accountItem = (
  role: ReturnType<typeof accountRolesData>[number],
  index: number,
): RecruitingAccountViewOutput["items"][number] => ({
  roleId: role.id,
  workspace: {
    role: { ...fixtureRole, id: role.id, title: role.title, sourceThreadId: role.threadId },
    revision: { ...fixtureRevision, roleId: role.id },
    crmTarget: null,
  },
  candidates: {
    items: [
      {
        key: `autumn:fixture-${index}`,
        name: index ? "Blake Sample" : "Avery Example",
        title: role.title,
        location: "Remote",
        email: index ? "blake@example.test" : "avery@example.test",
        linkedinUrl: null,
        autumn: null,
        crm: null,
        shortlisted: true,
        shortlistedAt: checkedAt,
      },
    ],
    nextCursor: null,
    total: 1,
    counts: { shortlisted: 1, replied: 1 },
    crmStatus: "not_bound",
  },
  campaign: {
    stats: { sent: 3, opened: 2, replied: 1 },
    status: "ready",
    serverId: "fixture-mail",
    campaign: {
      id: `campaign-${index}`,
      name: index ? "Design outreach" : "Platform outreach",
      eaccount: "recruiter@example.test",
      status: 1,
      stopOnReply: true,
    },
    leads: [
      {
        candidateKey: `fixture-${index}`,
        email: index ? "blake@example.test" : "avery@example.test",
        status: 1,
        interestStatus: 1,
      },
    ],
  },
  correspondence: {
    roleId: role.id,
    status: "ready",
    checkedAt,
    connectionChanged: false,
    connections: [{ name: "Calendar", status: "configured" }],
    contacts: [],
    emails: [
      {
        id: `reply-${index}`,
        direction: "received",
        subject: "Interview availability",
        sender: index ? "blake@example.test" : "avery@example.test",
        recipients: ["recruiter@example.test"],
        body: "Tuesday afternoon works",
        date: checkedAt,
        sourceId: "fixture-mail",
        sourceName: "Mail",
        partial: false,
        providerMessageId: `reply-${index}`,
        providerThreadId: `mail-thread-${index}`,
        unread: true,
        step: null,
        observedAt: checkedAt,
        snippet: null,
        url: null,
        campaignId: `campaign-${index}`,
        eaccount: "recruiter@example.test",
      },
    ],
    events: [
      {
        id: `event-${index}`,
        kind: "event",
        title: index ? "Blake design interview" : "Avery platform interview",
        start: "2026-10-23T14:00:00Z",
        end: "2026-10-23T14:45:00Z",
        timeZone: "America/New_York",
        status: "confirmed",
        attendees: ["avery@example.test"],
        location: "Video call",
        url: "https://calendar.example.test/event/fixture",
      },
    ],
    partial: false,
    nextCursor: null,
  },
  reminders: {
    items: [
      {
        id: `task-${index}`,
        roleId: role.id,
        candidateKey: null,
        title: index ? "Review design portfolio" : "Prepare platform interview",
        note: null,
        dueAt: checkedAt,
        status: "open",
        completedAt: null,
        createdBy: "agent",
        createdAt: checkedAt,
      },
    ],
    overdueCount: 1,
  },
});
