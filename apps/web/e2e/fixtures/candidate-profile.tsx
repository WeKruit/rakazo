import { I18nProvider } from "@lingui/react";
import type { RecruitingCandidate, RecruitingCandidateReport } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { applyUiAppearance } from "../../src/lib/ui-appearance";
import { ResizableSidePanel } from "../../src/pages/ResizableSidePanel";
import { RecruitingDetailPanel } from "../../src/pages/recruiting/DetailPanel";
import type { RecruitingDetailTarget } from "../../src/pages/recruiting/detail";
import { detailKey, useRecruitingDetailController } from "../../src/pages/recruiting/detail";
import "../../src/styles.css";

// Entirely synthetic fixtures. Asset requests are fulfilled with local SVGs by Playwright.
const params = new URLSearchParams(location.search);
const checkedAt = "2026-10-23T10:00:00Z";
const role = {
  roleId: "fixture-role",
  spaceId: "fixture-space",
  conversation: { groupId: "fixture-group" },
};
const source = {
  serverId: "fixture-source",
  serverRevision: 1,
  name: "CRM",
  organizationId: "00000000-0000-4000-8000-000000000001",
};
const crmTarget = {
  mcpServerId: source.serverId,
  serverRevision: source.serverRevision,
  organizationId: source.organizationId,
  crmRoleId: "00000000-0000-4000-8000-000000000002",
  crmClientId: "00000000-0000-4000-8000-000000000003",
  clientLabel: "Example Labs",
  roleLabel: "Staff Platform Engineer",
};
const sourceUrl = "https://evidence.example.test/avery-profile";
const fields: RecruitingCandidateReport["fields"] = [
  {
    label: "Profile photo URL",
    value: "https://assets.example.test/profile-photo.svg",
    sourceUrls: [sourceUrl],
  },
  { label: "Current company", value: "Example Labs", sourceUrls: [sourceUrl] },
  {
    label: "Company logo URL",
    value: "https://assets.example.test/company-logo.svg",
    sourceUrls: [sourceUrl],
  },
  { label: "University", value: "Example University", sourceUrls: [sourceUrl] },
  {
    label: "School logo URL",
    value: "https://assets.example.test/school-logo.svg",
    sourceUrls: [sourceUrl],
  },
  {
    label: "Recommendation",
    value: "Strong Go service experience; production Rust and team scope need follow-up.",
    sourceUrls: [sourceUrl],
  },
  {
    label: "Go distributed systems",
    value: "match",
    providerStatus: "match",
    evidence: "Built services in Go at Example Labs, including a PostgreSQL-backed event system.",
    sourceUrls: [sourceUrl],
  },
  {
    label: "Production Rust",
    value: "unclear",
    providerStatus: "unclear",
    evidence: "No evidence of production Rust use; a personal Rust prototype is described.",
    sourceUrls: [sourceUrl],
  },
  {
    label: "People management",
    value: "miss",
    providerStatus: "miss",
    evidence:
      "The supplied profile explicitly describes an individual contributor role with no direct reports.",
    sourceUrls: [sourceUrl],
  },
  {
    label: "Requirements assessment",
    value: "R4: Partial match - C++ prototyping is described, but deployment scale is not stated.",
    sourceUrls: [sourceUrl],
  },
  {
    label: "Experience",
    value:
      "Staff Engineer at Example Labs, Jan 2022–Present, Remote\nEngineer at Sample Systems, Jan 2018–Dec 2021",
    sourceUrls: [sourceUrl],
  },
  {
    label: "Education",
    value: "Example University, BS Computer Science, 2014–2018",
    sourceUrls: [sourceUrl],
  },
  { label: "Skills", value: "Go, Rust, C++, PostgreSQL, Kotlin", sourceUrls: [sourceUrl] },
  {
    label: "Concern",
    value: "No evidence of production Rust use. The profile does not state direct reports.",
    sourceUrls: [sourceUrl],
  },
  {
    label: "Counterevidence",
    value: "The personal Rust prototype provides some Rust exposure, but not production ownership.",
    sourceUrls: [sourceUrl],
  },
];

function candidate(index: number): RecruitingCandidate {
  const name = [
    "Avery Example",
    "Blake Sample with a deliberately long synthetic display name",
    "Casey Placeholder",
  ][index]!;
  const reportFields =
    index === 2
      ? []
      : index === 1
        ? [
            {
              label: "Experience",
              value: `Principal Engineer at Example Autonomous Infrastructure and Distributed Systems International Holdings, 2018–Present, Example Metropolitan Region with an intentionally long location`,
              sourceUrls: ["https://evidence.example.test/blake"],
            },
            { label: "Skills", value: "TypeScript", sourceUrls: [] },
          ]
        : fields;
  return {
    roleId: role.roleId,
    candidateKey: `fixture-${index}`,
    name,
    title:
      index === 2
        ? null
        : index === 1
          ? "Principal Engineer for Autonomous Infrastructure and Distributed Systems"
          : "Staff Platform Engineer",
    company:
      index === 2
        ? null
        : index === 1
          ? "Example Autonomous Infrastructure and Distributed Systems International Holdings"
          : "Example Labs",
    location:
      index === 2
        ? null
        : index === 1
          ? "Example Metropolitan Region with an intentionally long location"
          : "Remote · Example City",
    linkedinUrl: null,
    resumeUrl: null,
    evidenceUrls: index === 2 ? [] : [sourceUrl],
    issues: [],
    shortlisted: false,
    shortlistedAt: null,
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
      providerTaskId: "fixture-provider-task",
      roleRevisionId: "fixture-revision",
      effectId: "fixture-effect",
      rowIndex: index,
      artifactRef: { artifactId: "fixture-result", sha256: "a".repeat(64) },
      taskId: "fixture-task",
      actionId: "fixture-action",
      requestCursor: null,
      outputId: null,
      observedAt: checkedAt,
      report: { fields: reportFields, sourceUrls: index === 2 ? [] : [sourceUrl] },
    },
  };
}
const candidates = [0, 1, 2].map(candidate);
function target(index: number): RecruitingDetailTarget {
  const value = candidates[index]!;
  return {
    view: "contact",
    role,
    candidate: value,
    crm: index !== 2,
    person: {
      candidateId: `00000000-0000-4000-8000-00000000000${index}`,
      name: value.name!,
      title: value.title,
      company: value.company,
      location: value.location,
      email: index === 2 ? null : `person${index}@example.test`,
      stage: index === 2 ? null : "screening",
      outreachStatus: index === 0 ? "replied" : null,
    },
    walk: (step) =>
      index + step >= 0 && index + step < candidates.length ? target(index + step) : undefined,
  };
}

const requests: { path: string; input: Record<string, unknown> }[] = [];
const deferred: (() => void)[] = [];
const deferredViews: (() => void)[] = [];
let viewsReleased = false;
const profileViews: {
  id: string;
  candidateKey: string;
  at: string;
  actorName: string;
  roleTitle: string;
}[] = [];
const state = {
  requests,
  profileViews,
  releaseActivity: () => {
    for (const release of deferred.splice(0)) release();
  },
  releaseViews: () => {
    viewsReleased = true;
    for (const release of deferredViews.splice(0)) release();
  },
};
Object.assign(window, { candidateProfileFixture: state });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.includes("/rpc/")) return realFetch(input, init);
  const request =
    input instanceof Request ? input : new Request(new URL(url, location.origin), init);
  const path = new URL(request.url).pathname.replace(/^\/rpc\//, "");
  const body = (await request.clone().json()) as { json?: Record<string, unknown> };
  const value = body.json ?? {};
  requests.push({ path, input: value });
  let result: unknown;
  if (path === "recruiting/profileActivity/recordView") {
    if (params.has("delayed-view") && !viewsReleased)
      await new Promise<void>((resolve) => deferredViews.push(resolve));
    let entry = profileViews.find((item) => item.id === value.viewId);
    if (!entry) {
      entry = {
        id: String(value.viewId),
        candidateKey: String(value.candidateKey),
        at: checkedAt,
        actorName: "Jordan Recruiter",
        roleTitle: crmTarget.roleLabel,
      };
      profileViews.push(entry);
    }
    result = entry;
  } else if (path === "recruiting/profileActivity/list") {
    result = {
      items: profileViews.filter((item) => item.candidateKey === value.candidateKey),
      hasMore: false,
    };
  } else if (path === "recruiting/listCandidates")
    result = { crmTarget: { bindingEffectId: "fixture-binding", target: crmTarget } };
  else if (path === "recruiting/roleCampaign")
    result = { status: "none", campaign: null, leads: [] };
  else if (path === "recruiting/correspondence")
    result = {
      roleId: role.roleId,
      status: "ready",
      checkedAt,
      connectionChanged: false,
      connections: [],
      emails: [],
      events: [],
      contacts: [],
      partial: false,
    };
  else if (path === "recruiting/crmData") {
    const first = String(value.candidateId).endsWith("0");
    if (params.has("delayed") && first)
      await new Promise<void>((resolve) => deferred.push(resolve));
    const common = {
      operation: value.operation,
      source,
      checkedAt,
      candidateId: value.candidateId,
    };
    if (value.operation === "mail")
      result = {
        ...common,
        scope: "stored_candidate_correspondence",
        nativeCorrespondence: [],
        nextCursor: null,
        items: [
          {
            id: first ? "mail-a" : "mail-b",
            providerMessageId: first ? "provider-a" : "provider-b",
            sender: first
              ? "Avery Example <person0@example.test>"
              : "Blake Sample <person1@example.test>",
            recipients: ["Jordan Recruiter <recruiter@example.test>"],
            direction: "received",
            subject: first ? "Avery availability" : "Blake availability",
            body: "Thanks for reaching out.",
            date: "2026-10-23T09:30:00Z",
            partial: false,
          },
        ],
      };
    else if (value.operation === "candidateDetails")
      result = {
        ...common,
        scope: "stored_candidate_details",
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
    else throw new Error(`Unexpected fixture CRM operation: ${String(value.operation)}`);
  } else if (path === "recruiting/notes/list") result = { items: [] };
  else if (path === "recruiting/reminders/list") result = { items: [], overdueCount: 0 };
  else throw new Error(`Unexpected fixture RPC: ${path}`);
  return new Response(JSON.stringify({ json: result }), {
    headers: { "content-type": "application/json" },
  });
};

function ProfileFixture() {
  const controller = useRecruitingDetailController("fixture-thread");
  useEffect(() => {
    const matched = candidates
      .map((_candidate, index) => target(index))
      .find((item) => detailKey(item) === controller.pending);
    if (matched) controller.restore(matched);
  }, [controller.pending, controller.restore]);
  return (
    <main
      data-product-view="recruiting"
      className="flex h-dvh min-w-0 bg-background text-foreground"
    >
      <section className="min-w-0 flex-1 space-y-4 p-4">
        <h1 className="font-semibold">Staff Platform Engineer</h1>
        <p className="text-sm text-muted-foreground">Synthetic profile validation</p>
        <div className="flex flex-col items-start gap-3">
          {candidates.map((value, index) => (
            <Button
              key={value.candidateKey}
              variant="outline"
              className="h-auto max-w-full break-words whitespace-normal text-start"
              onClick={() =>
                controller.current
                  ? controller.replace(target(index))
                  : controller.open(target(index))
              }
            >
              {value.name}
            </Button>
          ))}
          <Button
            variant="ghost"
            onClick={() => controller.current && controller.replace({ ...controller.current })}
          >
            Refresh profile
          </Button>
        </div>
      </section>
      <ResizableSidePanel
        open={Boolean(controller.current)}
        panel="recruiting-detail"
        botsSidebarWidth={0}
      >
        <RecruitingDetailPanel controller={controller} />
      </ResizableSidePanel>
    </main>
  );
}

applyUiAppearance("light");
void bootstrapI18n("en").then(() =>
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <BrowserRouter>
        <ProfileFixture />
      </BrowserRouter>
    </I18nProvider>,
  ),
);
