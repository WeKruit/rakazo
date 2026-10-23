import { I18nProvider } from "@lingui/react";
import type { Group, RecruitingCandidate } from "@rakazo/contracts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { RecruitingPanel } from "../../src/pages/RecruitingPanel";
import { ResizableSidePanel } from "../../src/pages/ResizableSidePanel";
import {
  RecruitingDetailPanel,
  RecruitingDetailProvider,
  useRecruitingDetailController,
} from "../../src/pages/recruiting";
import type { RecruitingWorkspaceView } from "../../src/pages/shell/RecruitingNavigation";
import { RecruitingNavigation } from "../../src/pages/shell/RecruitingNavigation";
import "../../src/styles.css";

// Synthetic fixtures only: every name, address and id below is invented for screenshots.
const params = new URLSearchParams(location.search);
const view = (params.get("view") ?? "results") as RecruitingWorkspaceView;
const state = params.get("state") ?? "ready";

const ORG = "00000000-0000-4000-8000-000000000001";
const CRM_ROLE = "00000000-0000-4000-8000-000000000002";
const CLIENT = "00000000-0000-4000-8000-000000000003";
const checkedAt = "2026-10-22T10:00:00Z";
const source = { serverId: "crm-source", serverRevision: 1, name: "CRM", organizationId: ORG };
const crmTarget = {
  mcpServerId: "crm-source",
  serverRevision: 1,
  organizationId: ORG,
  crmRoleId: CRM_ROLE,
  crmClientId: CLIENT,
  clientLabel: "Example Robotics",
  roleLabel: "Senior Perception Engineer",
};
const names = [
  "Avery Example",
  "Blake Sample with a deliberately long synthetic display name",
  "Casey Placeholder",
  "Devon Fixture",
  "Emery Synthetic",
  "Finley Demo",
];
const people = names.map((name, i) => ({
  candidateId: `00000000-0000-4000-8000-0000000000a${i}`,
  name,
  email: i === 3 ? null : `person${i}@example.test`,
  phone: null,
  linkedinUrl: `https://www.linkedin.com/in/example-${i}`,
  location: i % 2 ? "Example City, Example Region with a long location label" : "Remote",
  title: i === 1 ? "Staff Perception and Sensor Fusion Engineer, Autonomy Platform" : "Engineer",
  stage: ["screening", "Interview", "sourced", "Interview", "offer", "screening"][i]!,
  contactStatus: i === 3 ? "not_found" : "email_found",
  outreachStatus: ["replied", "contacted", "not_contacted", "replied", "contacted", "bounced"][i]!,
  roleSpecId: CRM_ROLE,
  legacyClientLabel: crmTarget.clientLabel,
  legacyRoleLabel: crmTarget.roleLabel,
}));
const role = {
  id: "role-demo",
  spaceId: "space-demo",
  userId: "user-demo",
  sourceThreadId: "thread-0",
  title: crmTarget.roleLabel,
  revision: 1,
  currentRevisionId: "revision-demo",
};
const criteria = [
  ["perception", "hard", "3+ years shipping perception models on robots"],
  ["fusion", "hard", "Sensor fusion across lidar, radar and camera"],
  ["cpp", "soft", "Production C++ and Python"],
] as const;
const revision = {
  id: "revision-demo",
  roleId: role.id,
  revision: 1,
  sourceRefs: [],
  brief: { fields: [], questions: [], rules: [], searchFilters: [], confirmation: null },
  criteria: criteria.map(([id, priority, statement]) => ({
    id,
    priority,
    expression: { kind: "atom", id: `${id}-atom`, statement },
    sourceRefs: [],
    definitionQuestions: [],
  })),
  preferences: [],
  definitionQuestions: [],
  createdAt: checkedAt,
};
const verdicts = ["met", "unmet", "unknown"] as const;
const judgment = (verdict: (typeof verdicts)[number]) => ({
  verdict,
  factIds: [],
  evidence: [],
  missing: [],
});
const assessments = people.slice(0, 4).map((_person, i) => ({
  assessment: {
    roleId: role.id,
    roleRevisionId: revision.id,
    candidateKey: `fixture-${i}`,
    version: 1,
    basedOnVersion: null,
    createdByRunId: "run-demo",
    createdAt: checkedAt,
    facts: [],
    sourceRefs: [],
    questions: [],
    judgments: {
      atoms: criteria.map(([id], c) => ({
        atomId: `${id}-atom`,
        ...judgment(verdicts[(i + c) % 3]!),
      })),
      criteria: criteria.map(([id], c) => ({
        criterionId: id,
        ...judgment(verdicts[(i + c) % 3]!),
      })),
      employment: [],
      hardGate: verdicts[i % 3],
    },
  },
  isCurrent: true,
  roleRevision: revision,
  sourceMessageTargets: [],
}));
const candidates: RecruitingCandidate[] = people.map((person, i) => ({
  roleId: role.id,
  candidateKey: `fixture-${i}`,
  name: person.name,
  title: person.title,
  company: i === 1 ? "Example Autonomous Systems International Holdings" : "Example Labs",
  location: person.location,
  linkedinUrl: person.linkedinUrl,
  resumeUrl: null,
  evidenceUrls: ["https://example.test/profile"],
  issues: [],
  shortlisted: i < 2,
  shortlistedAt: i < 2 ? checkedAt : null,
  decision: null,
  decisionReason: null,
  decisionAt: null,
  latestSource: {
    providerTaskId: "provider-task-demo",
    roleRevisionId: revision.id,
    effectId: "effect-demo",
    rowIndex: i,
    artifactRef: { artifactId: "result-demo", sha256: "a".repeat(64) },
    taskId: "task-demo",
    actionId: "action-demo",
    requestCursor: null,
    outputId: null,
    observedAt: checkedAt,
    report: {
      sourceUrls: ["https://example.test/profile"],
      fields: [
        { label: "Rank", value: String(i + 1), sourceUrls: [] },
        { label: "Score", value: String(92 - i * 7), sourceUrls: [] },
        ...criteria.map(([, , statement], c) => {
          const status = (["match", "miss", "unclear"] as const)[(i + c) % 3]!;
          return {
            label: statement,
            value: status,
            providerStatus: status,
            evidence:
              c === 0
                ? "Led the perception team that shipped a lidar-camera detector to a fleet of warehouse robots across three sites."
                : undefined,
            sourceUrls: ["https://example.test/profile"],
          };
        }),
        {
          label: "Fit reasons",
          value: "Shipped perception on robots; fusion depth unclear from public sources.",
          sourceUrls: [],
        },
      ],
    },
  },
  revision: 0,
  discoveryCount: 1,
  firstDiscoveredAt: checkedAt,
  lastDiscoveredAt: checkedAt,
  latestAssessment:
    i < 4
      ? {
          version: 1,
          roleRevisionId: revision.id,
          createdAt: checkedAt,
          isCurrent: true,
          hardGate: verdicts[i % 3]!,
        }
      : null,
  crm: null,
}));
const mail = people.slice(0, 4).map((_person, i) => ({
  id: `mail-${i}`,
  providerMessageId: `mail-${i}`,
  threadId: null,
  direction: i % 2 ? "sent" : "received",
  sender: i % 2 ? "recruiter@example.test" : person.email,
  recipients: [i % 2 ? person.email : "recruiter@example.test"],
  subject:
    i === 0
      ? "Re: Senior Perception Engineer at Example Robotics — availability for a quick call next week"
      : `Senior Perception Engineer (${i})`,
  body: "Thanks for reaching out. I'm interested and free Tuesday or Wednesday afternoon.\n\nBest,\nAvery",
  date: `2026-10-2${i}T10:00:00Z`,
  partial: false,
  candidateId: person.candidateId,
}));
const empty = state === "empty";
const page = <T,>(items: T[]) => (empty ? [] : items);

function crmData(input: Record<string, unknown>) {
  const op = input.operation;
  if (op === "candidates") {
    const items = page(
      input.stage ? people.filter((person) => person.stage === input.stage) : people,
    );
    return {
      operation: "candidates",
      source,
      checkedAt,
      scope: "organization",
      selectedRole: {
        crmRoleId: CRM_ROLE,
        clientId: CLIENT,
        clientLabel: crmTarget.clientLabel,
        roleLabel: crmTarget.roleLabel,
        summary: "Perception lead for warehouse robots.",
        description: empty ? null : "Own the perception stack for a fleet of warehouse robots.",
        jdText: null,
        jdUrl: null,
      },
      items,
      total: items.length,
      offset: 0,
      nextOffset: null,
    };
  }
  if (op === "roleCampaigns")
    return {
      operation: "roleCampaigns",
      source,
      checkedAt,
      scope: "stored_role_campaigns",
      crmRoleId: CRM_ROLE,
      items: page([
        { id: "c1", name: "Perception outreach — first touch", status: 1, syncedAt: checkedAt },
        { id: "c2", name: "Perception follow-up", status: 2, syncedAt: checkedAt },
      ]),
      offset: 0,
      nextOffset: null,
    };
  if (op === "mail")
    return {
      operation: "mail",
      source,
      checkedAt,
      scope: "stored_candidate_correspondence",
      candidateId: input.candidateId,
      items: page(mail.filter((item) => item.candidateId === input.candidateId)),
      nativeCorrespondence: [],
      nextCursor: null,
    };
  if (op === "roleMail")
    return {
      operation: "roleMail",
      source,
      checkedAt,
      scope: "stored_role_correspondence",
      crmRoleId: CRM_ROLE,
      supported: true,
      items: page(mail),
      offset: 0,
      nextOffset: null,
    };
  if (op === "candidateDetails")
    return {
      operation: "candidateDetails",
      source,
      checkedAt,
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
  if (op === "important")
    return {
      operation: "important",
      source,
      checkedAt,
      scope: "organization_candidate_roles",
      items: [],
      total: 0,
      offset: 0,
      nextOffset: null,
    };
  throw new Error(`unmocked ${String(op)}`);
}

const fixtureNotes: {
  id: string;
  roleId: string;
  candidateKey: string;
  body: string;
  createdBy: "user";
  authorName: string;
  createdAt: string;
  updatedAt: string;
}[] = [];

const rpc: Record<string, (input: Record<string, unknown>) => unknown> = {
  "recruiting/notes/list": () => ({ items: fixtureNotes }),
  "recruiting/notes/create": (input) => {
    const note = {
      id: `note-${fixtureNotes.length}`,
      roleId: role.id,
      candidateKey: String(input.candidateKey),
      body: String(input.body),
      createdBy: "user" as const,
      authorName: "Example",
      createdAt: checkedAt,
      updatedAt: checkedAt,
    };
    fixtureNotes.push(note);
    return note;
  },
  "recruiting/reminders/list": () => ({ items: [], overdueCount: 0 }),
  "recruiting/getWorkspace": () => ({ role, revision, crmTarget }),
  "recruiting/listCandidates": () => {
    const items = page(candidates);
    return {
      sortAvailability: { rank: true, tier: false, score: true },
      roleId: role.id,
      roleRevisionId: revision.id,
      crmTarget: { bindingEffectId: "binding-demo", target: crmTarget },
      items,
      total: items.length,
      nextCursor: null,
      counts: {
        sourceRows: items.length,
        candidates: items.length,
        identifiedCandidates: items.length,
        unassessed: items.filter((candidate) => !candidate.latestAssessment).length,
        assessed: items.filter((candidate) => candidate.latestAssessment).length,
        shortlisted: items.filter((candidate) => candidate.shortlisted).length,
      },
    };
  },
  "recruiting/listAssessments": () => page(assessments),
  "recruiting/getAssessment": (input) =>
    assessments.find((item) => item.assessment.candidateKey === input.candidateKey) ??
    assessments[0],
  "recruiting/listResearch": () => ({ observations: [], tasks: [], actions: [] }),
  "recruiting/listQuestions": () => ({ questions: [] }),
  "recruiting/listFeedback": () => [],
  "recruiting/listCandidateSources": (input) => ({
    roleId: role.id,
    candidateKey: input.candidateKey,
    total: 0,
    nextCursor: null,
    items: [],
  }),
  "recruiting/crmData": crmData,
  "recruiting/correspondence": () => ({
    roleId: role.id,
    status: empty ? "empty" : "ready",
    checkedAt,
    connectionChanged: false,
    connections: [],
    emails: [],
    events: [],
    contacts: [],
    partial: false,
  }),
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.includes("/rpc/")) return realFetch(input, init);
  const path = new URL(url, location.origin).pathname.replace(/^\/rpc\//, "");
  // The loading state keeps every workbench read pending.
  if (state === "loading" && path.startsWith("recruiting/")) return new Promise<Response>(() => {});
  const request = input instanceof Request ? input : new Request(url, init);
  const body = (await request
    .clone()
    .json()
    .catch(() => ({}))) as { json?: Record<string, unknown> };
  const handler = rpc[path];
  try {
    const value = handler ? await handler(body.json ?? {}) : [];
    return new Response(JSON.stringify({ json: value }), {
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ json: { message: String(error) } }), { status: 500 });
  }
};

const roleGroups: Group[] = [
  crmTarget.roleLabel,
  "Founding Infrastructure Engineer with an unusually long role title",
  params.has("duplicate-roles") ? crmTarget.roleLabel : "Product Designer",
].map((name, i) => ({
  id: `group-${i}`,
  spaceId: "space-demo",
  name,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  members: [],
  threadId: `thread-${i}`,
  preview: "",
  unread: false,
  createdAt: new Date(Date.parse(checkedAt) + i * 86400000).toISOString(),
  updatedAt: checkedAt,
}));

function Workbench() {
  const [current, setCurrent] = useState<RecruitingWorkspaceView>(view);
  const [candidateId, setCandidateId] = useState<string>();
  const detail = useRecruitingDetailController("thread-0");
  return (
    <RecruitingDetailProvider value={detail}>
      <main data-product-view="recruiting" className="flex h-dvh bg-background text-foreground">
        <aside
          data-testid="role-list"
          className="hidden w-[248px] shrink-0 flex-col border-e border-sidebar-border bg-sidebar pt-6 md:flex"
        >
          <RecruitingNavigation
            groups={roleGroups}
            archivedGroups={[]}
            archivedOpen={false}
            groupId="group-0"
            query=""
            view={current}
            onView={setCurrent}
            onCollapse={() => undefined}
            canOpenDashboard
            canCreateRole={false}
            onQueryChange={() => undefined}
            onOpenRole={() => undefined}
            onNewRole={() => undefined}
            canCreateRoleFrom={() => false}
            onNewRoleFrom={() => undefined}
            onRoleMenu={() => undefined}
            onToggleArchived={() => undefined}
            onRestoreRole={() => undefined}
          />
        </aside>
        <div className="rk-scroll recruiting-workspace-main min-h-0 min-w-0 flex-1 overflow-y-auto">
          <RecruitingPanel
            threadId="thread-0"
            groupId="group-0"
            onClose={() => undefined}
            roleConversation
            crmBrowse={{
              selection: {
                serverId: source.serverId,
                serverRevision: source.serverRevision,
                organizationId: ORG,
                crmRoleId: CRM_ROLE,
              },
              view: current,
              candidateId,
              onSelectCandidate: (id, next = "inbox") => {
                setCandidateId(id);
                setCurrent(next);
              },
              onDraftReply: () => undefined,
            }}
          />
        </div>
        <ResizableSidePanel
          open={Boolean(detail.current)}
          panel="recruiting-detail"
          botsSidebarCollapsed
        >
          <RecruitingDetailPanel
            controller={detail}
            onAskChat={() => undefined}
            onDraftReply={() => undefined}
          />
        </ResizableSidePanel>
      </main>
    </RecruitingDetailProvider>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <BrowserRouter>
        <Workbench />
      </BrowserRouter>
    </I18nProvider>,
  );
});
