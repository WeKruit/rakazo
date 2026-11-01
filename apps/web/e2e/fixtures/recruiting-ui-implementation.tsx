import { I18nProvider } from "@lingui/react";
import type {
  RecruitingAnalyticsInput,
  RecruitingAnalyticsOutput,
  RecruitingSequenceInput,
  RecruitingSequenceOutput,
} from "@rakazo/contracts";
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { applyUiAppearance } from "../../src/lib/ui-appearance";
import { RecruitingAnalytics } from "../../src/pages/recruiting/RecruitingAnalytics";
import { SequenceEditor } from "../../src/pages/recruiting/SequenceEditor";
import "../../src/styles.css";

// Synthetic presentation fixture. Saves stay in this component; no service or booking calls.
const roleTitle = "Senior Platform Engineer · 全球平台工程与基础设施招聘";
const analytics: RecruitingAnalyticsOutput = {
  roles: [{ id: "role-example", title: roleTitle, groupId: "group-example" }],
  trend: [
    { date: "2026-10-02", contacted: 2, replied: 1 },
    { date: "2026-10-09", contacted: 4, replied: 1 },
    { date: "2026-10-16", contacted: 3, replied: 1 },
  ],
  groups: [{ roleId: "role-example", title: roleTitle, contacted: 9, replied: 3 }],
  observedShortlistedPeople: 14,
  shortlistDateUnknownPeople: 2,
  observedContactedPeople: 9,
  observedRepliedPeople: 3,
  firstContactedPeople: null,
  replyRate: null,
  coverage: "partial",
  sources: {
    storedCrmMessages: "observed",
    nativeCorrespondence: "not_included",
    importedCorrespondence: "not_included",
    firstSendHistory: "unknown",
    replyClassification: "unknown",
    identityResolution: "partial",
    shortlistHistory: "unknown",
  },
};
const load = async (_input: RecruitingAnalyticsInput) => analytics;
const initialSequence: RecruitingSequenceOutput = {
  roleId: "role-example",
  roleTitle,
  mailboxes: ["recruiter@example.test"],
  campaign: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Platform engineering introductions",
    status: 0,
    editable: true,
    revision: "a".repeat(64),
    eaccount: "recruiter@example.test",
    steps: [
      {
        subject: "Platform engineering at Example Labs",
        body: "Hi {{first_name}},\n\nYour platform engineering work caught our attention. Would you be open to learning about our team?\n\nAlex",
        delay_days: 0,
      },
      {
        subject: "Following up on the platform role",
        body: "Hi {{first_name}},\n\nFollowing up on the platform engineering opportunity. Happy to share more about the team.\n\nAlex",
        delay_days: 3,
      },
    ],
    timezone: "America/Chicago",
    send_hours: "weekdays_9_to_5",
  },
};
function Fixture() {
  const params = new URLSearchParams(location.search);
  const rich = params.has("rich");
  const [open, setOpen] = useState(true);
  const [mount, setMount] = useState(0);
  const saved = useRef<RecruitingSequenceOutput>(
    params.has("new")
      ? { ...initialSequence, campaign: null }
      : rich
        ? {
            ...initialSequence,
            campaign: {
              ...initialSequence.campaign!,
              editable: false,
              steps: [],
              observedDetails: {
                schedules: [],
                sequences: [
                  {
                    steps: [
                      {
                        type: "email",
                        delay: 0,
                        delayUnit: "days",
                        variants: [
                          {
                            subject: "Retained rich subject",
                            body: "<p>Hello <strong>{{first_name}}</strong></p>",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          }
        : initialSequence,
  );
  const execute = useCallback(
    async (input: RecruitingSequenceInput): Promise<RecruitingSequenceOutput> => {
      if (input.operation === "save" || input.operation === "create") {
        saved.current = {
          ...saved.current,
          campaign: {
            id: initialSequence.campaign!.id,
            status: 0,
            editable: true,
            revision: "a".repeat(64),
            ...input.draft,
          },
        };
      } else if (input.operation === "pause" && saved.current.campaign) {
        saved.current = { ...saved.current, campaign: { ...saved.current.campaign, status: 2 } };
      }
      return saved.current;
    },
    [],
  );
  const surface = new URLSearchParams(location.search).get("surface");
  return (
    <main className="mx-auto min-w-0 max-w-7xl space-y-8 p-4 text-foreground">
      {surface !== "sequence" && <RecruitingAnalytics accountKey="synthetic-account" load={load} />}
      {surface !== "analytics" &&
        (open ? (
          <SequenceEditor
            key={mount}
            roleId="role-example"
            serverId="source-example"
            execute={execute}
            onDone={() => setOpen(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setMount((value) => value + 1);
              setOpen(true);
            }}
          >
            Reopen saved sequence
          </button>
        ))}
    </main>
  );
}
applyUiAppearance("light");
void bootstrapI18n("en").then(() =>
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <MemoryRouter initialEntries={["/?analyticsSince=2026-10-01&analyticsUntil=2026-10-31"]}>
        <Fixture />
      </MemoryRouter>
    </I18nProvider>,
  ),
);
