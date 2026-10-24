import { I18nProvider } from "@lingui/react";
import type { RecruitingRoleCampaign } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { applyUiAppearance } from "../../src/lib/ui-appearance";
import { ResizableSidePanel } from "../../src/pages/ResizableSidePanel";
import { RecruitingDetailPanel } from "../../src/pages/recruiting/DetailPanel";
import { useRecruitingDetailController } from "../../src/pages/recruiting/detail";
import type { EmailConversationItem } from "../../src/pages/recruiting/EmailConversation";
import { EmailConversation } from "../../src/pages/recruiting/EmailConversation";
import { InterviewCalendar } from "../../src/pages/recruiting/InterviewCalendar";
import type { InterviewCalendarEvent } from "../../src/pages/recruiting/interviewCalendar";
import { SequenceOverview } from "../../src/pages/recruiting/SequenceOverview";
import "../../src/styles.css";

// Isolated presentation checks, not a replica of app routing or business acceptance.
// Every person, message, metric, calendar event, and asset is synthetic and local.
const params = new URLSearchParams(location.search);
const surface = params.get("surface") ?? "inbox";
const empty = params.get("state") === "empty";
const now = new Date("2026-10-23T12:00:00Z");
const emails: EmailConversationItem[] = [
  {
    id: "reply-avery",
    candidateId: "avery",
    sender: "Avery Example <avery@example.test>",
    recipients: ["Jordan Recruiter <recruiter@example.test>"],
    subject: "Platform engineering conversation",
    body: "Hi Jordan,\n\nThanks for sharing the role. I would like to learn more about the team and the platform work. Friday at 14:00 UTC works for a conversation.\n\nBest,\nAvery",
    date: "2026-10-23T10:00:00Z",
    direction: "received",
    partial: false,
  },
  {
    id: "sent-avery",
    candidateId: "avery",
    sender: "Jordan Recruiter <recruiter@example.test>",
    recipients: ["Avery Example <avery@example.test>"],
    subject: "Staff Platform Engineer at Example Labs",
    body: "Hi Avery,\n\nYour work on Go services is relevant to the platform role at Example Labs. Would you be open to learning about the team?\n\nJordan",
    date: "2026-10-22T16:00:00Z",
    direction: "sent",
    partial: false,
  },
  {
    id: "blake-message",
    candidateId: "blake",
    sender: "Blake Sample <blake@example.test>",
    recipients: ["recruiter@example.test"],
    subject: "Separate candidate context",
    body: "This message belongs only to Blake.",
    date: "2026-10-23T09:00:00Z",
    direction: "received",
    partial: true,
  },
];
const campaign: RecruitingRoleCampaign = {
  status: "ready",
  serverId: "synthetic-source",
  campaign: {
    id: "synthetic-campaign",
    name: "Platform engineering introductions",
    eaccount: null,
    status: 1,
    stopOnReply: true,
  },
  leads: [
    { email: "avery@example.test", candidateKey: "avery", status: 1, interestStatus: 1 },
    { email: "blake@example.test", candidateKey: "blake", status: 1, interestStatus: null },
    { email: "casey@example.test", candidateKey: "casey", status: 3, interestStatus: -1 },
  ],
};
const event = (value: Partial<InterviewCalendarEvent>): InterviewCalendarEvent => ({
  id: "interview-avery",
  kind: "event",
  title: "Avery Example · Platform discussion",
  start: "2026-10-23T14:00:00Z",
  end: "2026-10-23T15:00:00Z",
  timeZone: "America/New_York",
  status: "confirmed",
  attendees: ["avery@example.test", "recruiter@example.test"],
  location: "Example video room",
  url: "https://calendar.example.test/synthetic-event",
  ...value,
});
const events = [
  event({}),
  event({
    id: "interview-blake",
    title: "Blake Sample · Technical conversation",
    start: "2026-10-21T13:00:00Z",
    end: "2026-10-21T14:00:00Z",
    attendees: ["blake@example.test", "recruiter@example.test"],
  }),
  event({
    id: "availability",
    kind: "availability",
    title: "Team availability",
    start: "2026-10-23T16:00:00Z",
    end: "2026-10-23T17:00:00Z",
    attendees: [],
    status: null,
    location: null,
    url: null,
  }),
  event({
    id: "date-only",
    title: "Date-only source record",
    start: "2026-10-23",
    end: null,
    status: null,
    attendees: [],
    location: null,
    url: null,
  }),
];

const actions: { kind: string; id: string }[] = [];
Object.assign(window, { recruitingSurfacesFixture: { actions } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.includes("/rpc/")) return realFetch(input, init);
  throw new Error(`Unexpected fixture RPC: ${new URL(url, location.origin).pathname}`);
};

function Fixture() {
  const controller = useRecruitingDetailController("synthetic-inbox");
  const [selectedId, setSelectedId] = useState<string>();
  const [draftId, setDraftId] = useState<string>();
  const selected = emails.find((email) => email.id === selectedId);
  const name = selected?.candidateId === "blake" ? "Blake Sample" : "Avery Example";
  return (
    <main
      data-product-view="recruiting"
      className="flex min-h-dvh min-w-0 bg-background text-foreground"
    >
      <div className="min-w-0 flex-1 p-4 sm:p-8">
        <header className="mb-6 space-y-1">
          <p className="text-sm text-muted-foreground">Staff Platform Engineer</p>
          <h1 className="text-2xl font-semibold">
            {surface === "interview" ? "Interviews" : surface === "sequence" ? "Sequence" : "Inbox"}
          </h1>
        </header>
        {surface === "sequence" ? (
          <SequenceOverview
            campaign={empty ? undefined : campaign}
            replied={empty ? null : 2}
            sendDates={
              empty
                ? []
                : [
                    "2026-10-20T08:00:00Z",
                    "2026-10-22T16:00:00Z",
                    "2026-10-23T09:30:00Z",
                    "2026-10-23T10:00:00Z",
                  ]
            }
            now={now}
          />
        ) : surface === "interview" ? (
          <InterviewCalendar
            events={empty ? [] : events}
            timeZone="UTC"
            initialDate={now}
            now={now}
            contextLabel="Staff Platform Engineer"
          />
        ) : (
          <div className="grid min-w-0 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <nav aria-label="Synthetic inbox selection" className="space-y-2">
              {emails
                .filter((email) => email.direction === "received")
                .map((email) => (
                  <Button
                    key={email.id}
                    variant={selected?.candidateId === email.candidateId ? "secondary" : "outline"}
                    className="h-auto w-full flex-col items-start gap-1 whitespace-normal p-3 text-start"
                    onClick={() => {
                      setSelectedId(email.id);
                      setDraftId(undefined);
                    }}
                  >
                    <span className="font-medium">
                      {email.candidateId === "avery" ? "Avery Example" : "Blake Sample"}
                    </span>
                    <span className="text-xs text-muted-foreground">{email.subject}</span>
                  </Button>
                ))}
            </nav>
            <div className="min-w-0">
              {selected ? (
                <EmailConversation
                  items={emails}
                  candidateId={selected.candidateId}
                  selectedId={selected.id}
                  onSelect={(email) => setSelectedId(email.id)}
                  candidateName={name}
                  candidateTitle="Staff Platform Engineer"
                  candidatePhotoUrl={
                    selected.candidateId === "avery"
                      ? "https://assets.example.test/profile-photo.svg"
                      : null
                  }
                  onOpenProfile={() =>
                    controller.open({
                      view: "contact",
                      crm: false,
                      role: {
                        roleId: "synthetic-role",
                        spaceId: "synthetic-space",
                        conversation: { groupId: "synthetic-group" },
                      },
                      person: {
                        candidateId: selected.candidateId!,
                        name,
                        title: "Staff Platform Engineer",
                        company: "Example Labs",
                        location: "Remote · Example City",
                        email: `${selected.candidateId}@example.test`,
                      },
                    })
                  }
                  onDraftReply={(email) => {
                    actions.push({ kind: "draft", id: email.id });
                    setDraftId(email.id);
                  }}
                />
              ) : (
                <div
                  role="status"
                  className="grid min-h-80 place-items-center rounded-xl border bg-card p-6 text-sm text-muted-foreground"
                >
                  Select a conversation
                </div>
              )}
              {draftId ? (
                <p role="status" className="mt-3 text-sm">
                  Draft requested for {draftId}
                </p>
              ) : null}
            </div>
          </div>
        )}
      </div>
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
        <Fixture />
      </BrowserRouter>
    </I18nProvider>,
  ),
);
