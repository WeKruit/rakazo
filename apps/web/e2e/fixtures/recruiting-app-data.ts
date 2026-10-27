import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type {
  AppBootstrap,
  RecruitingCandidate,
  RecruitingCandidateReport,
  RecruitingRoleRevision,
  RecruitingSchedulingPlan,
  RecruitingSourceRef,
} from "@rakazo/contracts";

// Offline synthetic records for the actual App/Shell routes. No provider calls or data.
export const appGroupId = "fixture-group";
export const appRoleId = "fixture-role";
export const checkedAt = "2026-10-23T12:00:00Z";
const source = {
  serverId: "fixture-crm",
  serverRevision: 1,
  name: "CRM",
  organizationId: "00000000-0000-4000-8000-000000000001",
};
const crmTarget = {
  mcpServerId: source.serverId,
  serverRevision: 1,
  organizationId: source.organizationId,
  crmRoleId: "00000000-0000-4000-8000-000000000002",
  crmClientId: "00000000-0000-4000-8000-000000000003",
  clientLabel: "Example Labs",
  roleLabel: "Staff Platform Engineer",
};
const role = {
  id: appRoleId,
  spaceId: "fixture-space",
  userId: "fixture-user",
  sourceThreadId: "fixture-thread",
  title: crmTarget.roleLabel,
  revision: 1,
  currentRevisionId: "fixture-revision",
};
const criterionSource: RecruitingSourceRef = {
  id: "fixture-role-source",
  kind: "original_material",
  anchor: { kind: "message", messageId: "fixture-role-message", locator: "text:0" },
  readState: "read",
  readAt: checkedAt,
  quote: "The role requires C++ production systems experience.",
};
const revision: RecruitingRoleRevision = {
  id: "fixture-revision",
  roleId: role.id,
  revision: 1,
  sourceRefs: [criterionSource],
  brief: {
    fields: [],
    questions: [],
    rules: [
      {
        criterionId: "R4",
        origin: "user_instruction",
        effect: "flag",
        sourceRefIds: [criterionSource.id],
      },
    ],
    searchFilters: [],
    confirmation: null,
  },
  criteria: [
    {
      id: "R4",
      priority: "hard",
      expression: { kind: "atom", id: "cpp", statement: "C++ production systems" },
      sourceRefs: [criterionSource],
      definitionQuestions: [],
    },
  ],
  preferences: [],
  definitionQuestions: [],
  createdAt: checkedAt,
};
const evidenceUrl = "https://evidence.example.test/avery";
export const people = ["Avery Example", "Blake Sample", "Casey Placeholder"].map((name, index) => ({
  candidateId: `00000000-0000-4000-8000-0000000000a${index}`,
  name,
  email: `${["avery", "blake", "casey"][index]}@example.test`,
  phone: null,
  linkedinUrl: `https://www.linkedin.com/in/synthetic-profile-${index}`,
  location: index === 1 ? "Example Metropolitan Region" : "Remote · Example City",
  title: index === 0 ? "Staff Platform Engineer" : "Software Engineer",
  company: index === 2 ? null : "Example Labs",
  profile: null,
  stage: index === 0 ? "Interview" : "screening",
  contactStatus: "email_found",
  outreachStatus: index === 0 ? "replied" : "not_contacted",
  roleSpecId: crmTarget.crmRoleId,
  legacyClientLabel: crmTarget.clientLabel,
  legacyRoleLabel: crmTarget.roleLabel,
}));
export const candidates: RecruitingCandidate[] = people.map((person, index) => ({
  roleId: appRoleId,
  candidateKey: `fixture-${index}`,
  name: person.name,
  title: person.title,
  company: person.company,
  location: person.location,
  linkedinUrl: person.linkedinUrl,
  resumeUrl: null,
  evidenceUrls: [evidenceUrl],
  issues: [],
  shortlisted: index === 0,
  shortlistedAt: index === 0 ? checkedAt : null,
  decision: null,
  decisionReason: null,
  decisionAt: null,
  revision: 0,
  discoveryCount: 1,
  firstDiscoveredAt: checkedAt,
  lastDiscoveredAt: checkedAt,
  latestAssessment: null,
  crm: null,
  latestSource: {
    providerTaskId: "fixture-task",
    roleRevisionId: revision.id,
    effectId: "fixture-effect",
    rowIndex: index,
    artifactRef: { artifactId: "fixture-artifact", sha256: "a".repeat(64) },
    taskId: "fixture-task",
    actionId: "fixture-action",
    requestCursor: null,
    outputId: null,
    observedAt: checkedAt,
    report: {
      sourceUrls: [evidenceUrl],
      fields:
        index === 2
          ? []
          : [
              {
                label: "Profile photo URL",
                value: "https://assets.example.test/profile-photo.svg",
                sourceUrls: [evidenceUrl],
              },
              { label: "Current company", value: "Example Labs", sourceUrls: [evidenceUrl] },
              {
                label: "Company logo URL",
                value: "https://assets.example.test/company-logo.svg",
                sourceUrls: [evidenceUrl],
              },
              {
                label: "Company website",
                value: "https://company.example.test/about",
                sourceUrls: [evidenceUrl],
              },
              { label: "School", value: "Example University", sourceUrls: [evidenceUrl] },
              {
                label: "School logo URL",
                value: "https://assets.example.test/school-logo.svg",
                sourceUrls: [evidenceUrl],
              },
              {
                label: "School website",
                value: "https://school.example.test",
                sourceUrls: [evidenceUrl],
              },
              {
                label: "Go distributed systems",
                value: "match",
                providerStatus: "match",
                evidence: "Built Go services and a PostgreSQL-backed event system at Example Labs.",
                sourceUrls: [evidenceUrl],
              },
              {
                label: "Production Rust",
                value: "unclear",
                providerStatus: "unclear",
                evidence:
                  "No evidence of production Rust use; a personal Rust prototype is described.",
                sourceUrls: [evidenceUrl],
              },
              {
                label: "People management",
                value: "miss",
                providerStatus: "miss",
                evidence: "The supplied profile explicitly describes no direct reports.",
                sourceUrls: [evidenceUrl],
              },
              {
                label: "Requirements assessment",
                value:
                  "R4: Partial match - C++ prototyping is described, but deployment scale is not stated.\nR5: Unknown - No supplied source describes this requirement.",
                sourceUrls: [evidenceUrl],
              },
              {
                label: "Experience",
                value:
                  "Staff Engineer at Example Labs, Jan 2022–Present, Remote\nEngineer at Sample Systems, Jan 2018–Dec 2021",
                sourceUrls: [evidenceUrl],
              },
              {
                label: "Education",
                value: "Example University, BS Computer Science, 2014–2018",
                sourceUrls: [evidenceUrl],
              },
              {
                label: "Skills",
                value: "Go, Rust, C++, PostgreSQL, Kotlin",
                sourceUrls: [evidenceUrl],
              },
              {
                label: "Concern",
                value: "No evidence of production Rust use.",
                sourceUrls: [evidenceUrl],
              },
            ],
    },
  },
}));
const mail = [
  {
    id: "reply-avery",
    providerMessageId: "provider-reply",
    threadId: "thread-avery",
    candidateId: people[0]!.candidateId,
    direction: "received",
    sender: people[0]!.email,
    recipients: ["recruiter@example.test"],
    subject: "Re: Platform role",
    body: "Thanks for reaching out. Tuesday afternoon works for a conversation.\n\nAvery",
    date: "2026-10-23T11:00:00Z",
    partial: false,
  },
  {
    id: "followup-avery",
    providerMessageId: "provider-followup",
    threadId: "thread-avery",
    candidateId: people[0]!.candidateId,
    direction: "sent",
    sender: "recruiter@example.test",
    recipients: [people[0]!.email],
    subject: "Platform role",
    body: "Would Tuesday or Wednesday work for an introductory conversation?",
    date: "2026-10-22T09:00:00Z",
    partial: false,
  },
  {
    id: "intro-avery",
    providerMessageId: "provider-intro",
    threadId: "thread-avery",
    candidateId: people[0]!.candidateId,
    direction: "sent",
    sender: "recruiter@example.test",
    recipients: [people[0]!.email],
    subject: "Platform role",
    body: "Your Go systems experience may be relevant to our platform role.",
    date: "2026-10-20T09:00:00Z",
    partial: false,
  },
  {
    id: "mail-blake",
    providerMessageId: "provider-blake",
    threadId: "thread-blake",
    candidateId: people[1]!.candidateId,
    direction: "received",
    sender: people[1]!.email,
    recipients: ["recruiter@example.test"],
    subject: "Availability next week",
    body: "I can share availability next week.",
    date: "2026-10-22T10:00:00Z",
    partial: false,
  },
];
const bot: AppBootstrap["bots"][number] = {
  id: "fixture-bot",
  spaceId: "fixture-space",
  name: "Main",
  title: "Recruiter",
  description: "",
  instructions: "",
  color: "ink",
  notifyOnFinish: false,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "fixture-bot-thread",
  preview: "",
  status: "idle",
  runErrorId: null,
  computerMode: "team",
  updatedAt: checkedAt,
  createdAt: checkedAt,
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  disabledBuiltinTools: [],
  webhookConfigured: false,
  spawnKey: null,
};
const group: AppBootstrap["groups"][number] = {
  id: appGroupId,
  spaceId: "fixture-space",
  name: crmTarget.roleLabel,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  members: [{ botId: bot.id, name: bot.name, color: "ink", status: "idle" }],
  threadId: "fixture-thread",
  preview: "",
  unread: false,
  createdAt: checkedAt,
  updatedAt: checkedAt,
};
const snapshot = {
  threadId: group.threadId,
  groupId: group.id,
  groupName: group.name,
  members: group.members,
  cursor: 0,
  messages: [],
  olderCursor: null,
  run: null,
};
const bootstrap: AppBootstrap = {
  me: {
    userId: "fixture-user",
    spaceId: "fixture-space",
    name: "Example Recruiter",
    email: "recruiter@example.test",
    isDeploymentOwner: false,
    needsModel: false,
    defaultProvider: null,
    defaultModel: null,
    hostCredentialProvider: null,
    hostCredentialSource: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "none",
    avatarStyle: "organic",
    billingEnabled: false,
    ticketBoardEnabled: false,
  },
  bots: [bot],
  groups: [group],
  botSections: [],
  archivedBots: [],
  archivedGroups: [],
  thread: snapshot,
  routines: [],
  spaces: [
    {
      id: "fixture-space",
      name: "Recruiting",
      isDefault: true,
      hasContent: true,
      bots: [bot],
      groups: [group],
      externalConversations: [],
      botSections: [],
    },
  ],
};

export async function mockRecruitingApp(
  page: Page,
  options: {
    locale?: string;
    scheduling?: boolean;
    nativeScheduling?: boolean;
    emptyCalendar?: boolean;
    emptyMail?: boolean;
    multipleCampaigns?: boolean;
    calendarStatus?: "accepted" | "confirmed";
    candidateReport?: RecruitingCandidateReport;
  } = {},
) {
  const plans: RecruitingSchedulingPlan[] = [];
  const unknown: string[] = [];
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const views: Record<string, unknown>[] = [];
  await page.addInitScript((locale) => {
    localStorage.setItem("rakazo.uiAppearance", "light");
    localStorage.setItem("rakazo.uiLocale", locale);
    localStorage.setItem("rakazo:space-id", "fixture-space");
  }, options.locale ?? "en");
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.hostname === "assets.example.test" &&
      ["/profile-photo.svg", "/company-logo.svg", "/school-logo.svg"].includes(url.pathname)
    ) {
      return route.fulfill({
        path: fileURLToPath(new URL(`.${url.pathname}`, import.meta.url)),
        contentType: "image/svg+xml",
      });
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      // Existing global font import is intentionally offline; no candidate data leaves the test.
      if (url.hostname === "fonts.googleapis.com")
        return route.fulfill({ body: "", contentType: "text/css" });
      return route.abort("blockedbyclient");
    }
    if (url.pathname === "/api/auth/get-session")
      return route.fulfill({
        json: {
          user: {
            id: "fixture-user",
            name: "Example Recruiter",
            email: "recruiter@example.test",
            emailVerified: true,
            image: null,
            createdAt: checkedAt,
            updatedAt: checkedAt,
          },
          session: {
            id: "fixture-session",
            userId: "fixture-user",
            token: "synthetic-only",
            expiresAt: "2099-01-01T00:00:00Z",
            createdAt: checkedAt,
            updatedAt: checkedAt,
          },
        },
      });
    if (url.pathname === "/api/auth/capabilities")
      return route.fulfill({
        json: {
          passwordAuth: true,
          sso: null,
          passwordReset: false,
          resetUrl: null,
          billing: false,
        },
      });
    if (!url.pathname.startsWith("/rpc/")) return route.continue();
    let method = url.pathname.slice(5);
    let input = (route.request().postDataJSON()?.json ?? {}) as Record<string, unknown>;
    calls.push({ method, input });
    if (method === "threads/subscribe") {
      await new Promise<void>((resolve) => page.once("close", () => resolve()));
      return;
    }
    const viewInput = method === "recruiting/readView" ? input : undefined;
    if (viewInput) {
      method =
        viewInput.kind === "candidates" ? "recruiting/listCandidates" : "recruiting/listResearch";
      input = { ...((viewInput.query as Record<string, unknown>) ?? {}), roleId: viewInput.roleId };
    }
    let value: unknown;
    if (method === "bootstrap") value = bootstrap;
    else if (method === "me") value = bootstrap.me;
    else if (method === "spaces/list")
      value = {
        spaces: bootstrap.spaces,
        current: {
          id: "fixture-space",
          bots: bootstrap.bots,
          groups: bootstrap.groups,
          botSections: [],
        },
      };
    else if (method === "threads/get") value = snapshot;
    else if (method === "threads/head") value = { threadId: snapshot.threadId, cursor: 0 };
    else if (method === "threads/messages")
      value = { threadId: snapshot.threadId, messages: [], olderCursor: null };
    else if (method === "threads/markRead") value = { ok: true };
    else if (
      [
        "agentSkills/list",
        "routines/list",
        "skills/list",
        "connections/list",
        "connections/catalog",
        "bots/listArchived",
        "groups/listArchived",
        "memory/list",
        "models/credentials",
        "models/list",
      ].includes(method)
    )
      value = [];
    else if (["memory/providerConfig", "voice/status"].includes(method)) value = null;
    else if (method === "messaging/status") value = { enabled: false, providers: [] };
    else if (method === "usage/summary") value = { inputTokens: 0, outputTokens: 0, runs: 0 };
    else if (method === "recruiting/getWorkspace")
      value = {
        role,
        revision,
        crmTarget: options.nativeScheduling
          ? null
          : { bindingEffectId: "fixture-binding", target: crmTarget },
      };
    else if (method === "recruiting/roleSetup") value = { ready: true, attention: null, items: [] };
    else if (method === "recruiting/listCandidates") {
      const items = candidates
        .map((candidate, index) =>
          index === 0 && options.candidateReport && candidate.latestSource
            ? {
                ...candidate,
                latestSource: { ...candidate.latestSource, report: options.candidateReport },
              }
            : candidate,
        )
        .filter(
          (candidate) =>
            (input.shortlisted !== true || candidate.shortlisted) &&
            (!input.query ||
              candidate.name?.toLowerCase().includes(String(input.query).toLowerCase())),
        );
      value = {
        roleId: role.id,
        roleRevisionId: revision.id,
        crmTarget: options.nativeScheduling
          ? null
          : { bindingEffectId: "fixture-binding", target: crmTarget },
        items,
        total: items.length,
        nextCursor: null,
        sortAvailability: { rank: false, tier: false, score: false },
        counts: {
          sourceRows: 3,
          candidates: 3,
          identifiedCandidates: 3,
          unassessed: 3,
          assessed: 0,
          shortlisted: 1,
        },
      };
    } else if (method === "recruiting/roleCandidates")
      value = {
        items: options.nativeScheduling
          ? [
              {
                name: "Avery Example",
                email: "avery@example.test",
                autumn: { candidateKey: "fixture-native-candidate" },
              },
            ]
          : [],
        nextCursor: null,
        total: 3,
        counts: { shortlisted: 1, replied: 1 },
        crmStatus: "ok",
      };
    else if (method === "recruiting/listResearch")
      value = { observations: [], tasks: [], actions: [] };
    else if (method === "recruiting/listQuestions") value = { questions: [] };
    else if (["recruiting/listAssessments", "recruiting/listFeedback"].includes(method)) value = [];
    else if (method === "recruiting/listCandidateSources")
      value = {
        roleId: role.id,
        candidateKey: input.candidateKey,
        total: 0,
        nextCursor: null,
        items: [],
      };
    else if (method === "recruiting/notes/list") value = { items: [] };
    else if (method === "recruiting/reminders/list") value = { items: [], overdueCount: 0 };
    else if (method === "recruiting/profileActivity/list")
      value = {
        items: views
          .filter((entry) => entry.candidateKey === input.candidateKey)
          .map(({ id, at, actorName, roleTitle }) => ({ id, at, actorName, roleTitle })),
        hasMore: false,
      };
    else if (method === "recruiting/profileActivity/recordView") {
      const entry = {
        id: `fixture-view-${views.length}`,
        candidateKey: input.candidateKey,
        roleId: role.id,
        roleTitle: role.title,
        actorUserId: "fixture-user",
        actorName: "Example Recruiter",
        at: checkedAt,
        type: "viewed",
        viewId: input.viewId,
      };
      if (!views.some((previous) => previous.viewId === input.viewId)) views.push(entry);
      value = {
        id: entry.id,
        at: entry.at,
        actorName: entry.actorName,
        roleTitle: entry.roleTitle,
      };
    } else if (method === "recruiting/roleCampaign")
      value =
        options.multipleCampaigns && !input.campaignId
          ? { status: "unavailable", campaign: null, selectionRequired: true }
          : {
              status: "ready",
              serverId: "fixture-campaign-source",
              campaign: {
                id: input.campaignId ?? "fixture-campaign",
                name:
                  input.campaignId === "fixture-second-campaign"
                    ? "Platform follow-up"
                    : "Platform outreach",
                eaccount: "recruiter@example.test",
                status: 1,
                stopOnReply: true,
                observedDetails: {
                  schedules: [
                    {
                      name: "Business hours",
                      from: "09:00",
                      to: "17:00",
                      timezone: "America/New_York",
                      days: { "1": true },
                    },
                  ],
                  sequences: [
                    {
                      steps: [
                        {
                          type: "email",
                          delay: 2,
                          delayUnit: "days",
                          variants: [
                            {
                              subject: "Platform introduction",
                              body: "Observed introduction copy from the selected campaign.",
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
              leads: [
                {
                  email: people[0]!.email,
                  candidateKey: "fixture-0",
                  status: 1,
                  interestStatus: 1,
                },
              ],
            };
    else if (method === "recruiting/schedulingPlans")
      value = {
        plans,
        partial: false,
        slots: options.scheduling
          ? [
              {
                sourceId: "fixture-calendar",
                sourceRevision: 1,
                eventTypeId: 42,
                availabilityEffectId: "fixture-availability",
                start: "2026-11-01T05:30:00Z",
                end: "2026-11-01T06:00:00Z",
                lengthInMinutes: 30,
                observedAt: checkedAt,
              },
            ]
          : [],
      };
    else if (method === "recruiting/saveSchedulingPlan" && options.scheduling) {
      const plan = {
        ...input,
        id: "fixture-saved-plan",
        createdAt: checkedAt,
        roleTitle: role.title,
        mailSourceId: "fixture-native-mail",
        mailSourceRevision: 1,
        mailRead: {
          effectId: "fixture-read",
          linkedRunId: "fixture-run",
          messageId: "fixture-message",
        },
        bookingStatus: null,
        confirmationStatus: null,
        bookingEffectId: null,
        confirmationEffectId: null,
      } as RecruitingSchedulingPlan;
      plans.push(plan);
      value = plan;
    } else if (method === "recruiting/correspondence")
      value = {
        roleId: role.id,
        status: "ready",
        checkedAt,
        connectionChanged: false,
        connections: [{ name: "CRM", status: "configured" }],
        emails: options.emptyMail
          ? []
          : mail.map((email) => ({
              ...email,
              sourceId: source.serverId,
              sourceName: "CRM",
              savedRead: options.nativeScheduling
                ? {
                    effectId: "native-read",
                    linkedRunId: "native-run",
                    messageId: "native-message",
                  }
                : null,
              unread: email.id === "reply-avery" ? true : email.id === "mail-blake" ? null : false,
              step: email.id === "reply-avery" ? "2" : null,
              observedAt: checkedAt,
              snippet: email.partial,
              url: null,
              providerThreadId: email.threadId,
              campaignId: "fixture-campaign",
              eaccount: "recruiter@example.test",
              crm: options.nativeScheduling
                ? undefined
                : {
                    serverRevision: source.serverRevision,
                    organizationId: source.organizationId,
                    crmRoleId: crmTarget.crmRoleId,
                    candidateId: email.candidateId,
                    threadId: email.threadId,
                    campaignId: "fixture-campaign",
                    eaccount: "recruiter@example.test",
                    direction: email.direction,
                  },
            })),
        contacts: [],
        partial: false,
        nextCursor: null,
        events: options.emptyCalendar
          ? []
          : [
              {
                id: "fixture-event",
                kind: "event",
                title: "Avery · Platform interview",
                start: "2026-10-23T14:00:00Z",
                end: "2026-10-23T14:45:00Z",
                timeZone: "America/New_York",
                status: options.calendarStatus ?? "confirmed",
                attendees: [people[0]!.email, "recruiter@example.test"],
                location: "Video call",
                url: "https://calendar.example.test/event/fixture",
              },
            ],
      };
    else if (method === "recruiting/crmData") {
      const base = { operation: input.operation, source, checkedAt, offset: 0, nextOffset: null };
      if (input.operation === "memberships")
        value = { operation: "memberships", checkedAt, sources: [] };
      else if (input.operation === "candidates") {
        const items = input.stage
          ? people.filter((person) => person.stage === input.stage)
          : people;
        value = {
          ...base,
          scope: "organization",
          items,
          total: items.length,
          selectedRole: {
            crmRoleId: crmTarget.crmRoleId,
            clientId: crmTarget.crmClientId,
            clientLabel: crmTarget.clientLabel,
            roleLabel: crmTarget.roleLabel,
            summary: "Platform engineering",
            description: "Build reliable distributed services.",
            jdText: null,
            jdUrl: null,
          },
        };
      } else if (input.operation === "roleCampaigns")
        value = {
          ...base,
          scope: "stored_role_campaigns",
          crmRoleId: crmTarget.crmRoleId,
          offset: Number(input.offset ?? 0),
          nextOffset: options.multipleCampaigns && !input.offset ? 25 : null,
          items: [
            options.multipleCampaigns && input.offset === 25
              ? {
                  id: "fixture-second-campaign",
                  name: "Platform follow-up",
                  status: 1,
                  syncedAt: checkedAt,
                }
              : {
                  id: "fixture-campaign",
                  name: "Platform outreach",
                  status: 1,
                  syncedAt: checkedAt,
                },
          ],
        };
      else if (input.operation === "roleMail")
        value = {
          ...base,
          scope: "stored_role_correspondence",
          crmRoleId: crmTarget.crmRoleId,
          supported: true,
          items: options.emptyMail ? [] : mail,
        };
      else if (input.operation === "mail")
        value = {
          ...base,
          scope: "stored_candidate_correspondence",
          candidateId: input.candidateId,
          items: options.emptyMail
            ? []
            : mail.filter((email) => email.candidateId === input.candidateId),
          nativeCorrespondence: [],
          nextCursor: null,
        };
      else if (input.operation === "candidateDetails")
        value = {
          ...base,
          scope: "stored_candidate_details",
          candidateId: input.candidateId,
          review: null,
          roleTracking: [],
          roleInterests: [],
          campaignAssociations: {
            leadCampaigns: [],
            pipelineCampaign: null,
            offset: 0,
            nextOffset: null,
          },
          outbox: [],
        };
      else if (input.operation === "sequenceStats")
        value = {
          operation: "sequenceStats",
          source,
          checkedAt,
          items: input.candidateIds.includes(people[0]!.candidateId)
            ? [
                {
                  candidateId: people[0]!.candidateId,
                  sequences: 1,
                  opens: 3,
                  replies: 1,
                  lastContactAt: "2026-10-21T15:00:00Z",
                  lastReplyAt: "2026-10-22T09:30:00Z",
                  status: "active",
                  syncedAt: checkedAt,
                },
              ]
            : [],
        };
      else if (input.operation === "important")
        value = { ...base, scope: "organization_candidate_roles", items: [], total: 0 };
      else {
        unknown.push(`${method}:${String(input.operation)}`);
        return route.fulfill({ status: 400, json: { message: "Unmocked fixture operation" } });
      }
    } else {
      unknown.push(method);
      return route.fulfill({ status: 400, json: { message: "Unmocked fixture method" } });
    }
    if (viewInput)
      value = {
        kind: viewInput.kind,
        workspace: {
          role,
          revision,
          crmTarget: options.nativeScheduling
            ? null
            : { bindingEffectId: "fixture-binding", target: crmTarget },
        },
        data:
          viewInput.roleId === role.id && viewInput.roleRevisionId === revision.id ? value : null,
      };
    return route.fulfill({ json: { json: value } });
  });
  return { unknown, calls, views };
}
