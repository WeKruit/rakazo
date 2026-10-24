import { I18nProvider } from "@lingui/react";
import type { RecruitingCandidateReport } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Bookmark } from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { applyUiAppearance } from "../../src/lib/ui-appearance";
import { CandidateDirectory } from "../../src/pages/recruiting/CandidateDirectory";
import type { RoleCandidate } from "../../src/pages/recruiting/useRoleCandidates";
import "../../src/styles.css";

// Synthetic records only. Every asset is served from local SVG fixtures by Playwright.
const field = (label: string, value: string): RecruitingCandidateReport["fields"][number] => ({
  label,
  value,
  sourceUrls: ["https://evidence.example.test/profile"],
});
const supplied: RecruitingCandidateReport["fields"] = [
  field("Profile photo URL", "https://assets.example.test/profile-photo.svg"),
  field("Company", "Example Labs"),
  field("Company logo URL", "https://assets.example.test/company-logo.svg"),
  field("Company website", "https://example.test/company"),
  field("University", "Example University"),
  field("School logo URL", "https://assets.example.test/school-logo.svg"),
  field("School website", "https://example.test/school"),
  field("Education", "Example University, BS Computer Science, 2014–2018"),
  field("Match score", "86"),
  {
    ...field("Go services", "match"),
    providerStatus: "match",
    evidence: "Built services in Go at Example Labs.",
  },
  {
    ...field("Production Rust", "unclear"),
    providerStatus: "unclear",
    evidence: "Production use has not been established.",
  },
];
function candidate(
  key: string,
  name: string | null,
  title: string | null,
  company: string | null,
  location: string | null,
  fields: RecruitingCandidateReport["fields"] = [],
): RoleCandidate {
  return {
    key,
    name,
    title,
    location,
    email: null,
    linkedinUrl: name ? `https://example.test/people/${key}` : null,
    autumn: {
      company,
      shortlisted: false,
      latestSource: { report: { fields } },
    } as RoleCandidate["autumn"],
    crm: null,
  };
}
const initial = [
  candidate(
    "avery",
    "Avery Example",
    "Staff Platform Engineer",
    "Example Labs",
    "San Francisco, CA",
    supplied,
  ),
  candidate(
    "rowan",
    "Rowan Sample",
    "Senior Software Engineer",
    "Sample Systems",
    "Remote · United States",
    [
      field("Education", "Sample Institute, MS Computer Science, 2016–2018"),
      field(
        "Requirements assessment",
        "R1: Partial match - A Go prototype is documented; production use is not established.",
      ),
    ],
  ),
  candidate(
    "jules",
    "Jules Example",
    "Engineering Lead",
    "Demonstration Studio",
    "London, United Kingdom",
    [
      { ...field("People management", "match"), providerStatus: "match" },
      {
        ...field("Rust", "miss"),
        providerStatus: "miss",
        evidence: "The profile explicitly states no Rust experience.",
      },
    ],
  ),
  candidate("morgan", "Morgan Sample", "Software Engineer", "Example Labs", "Toronto, Canada", [
    field("Education", "Example University, BS Engineering, 2015–2019"),
    { ...field("Distributed systems", "unclear"), providerStatus: "unclear" },
  ]),
  candidate(
    "long",
    "Alexandra Example With A Deliberately Long Candidate Name",
    "Principal Engineer for International Platform Infrastructure and Reliability",
    "Long Example Company Name for Layout Validation",
    "Remote · Multiple regions with a deliberately long location",
    [
      field(
        "Education",
        "Demonstration University of Engineering and Applied Computing, MS Software Engineering, 2010–2012",
      ),
    ],
  ),
  candidate("missing", null, null, null, null),
];
initial[0]!.autumn!.shortlisted = true;
initial[2]!.crm = {
  stage: "not_interested",
  company: "Demonstration Studio",
} as RoleCandidate["crm"];

function Fixture() {
  const [rows, setRows] = useState(initial);
  const [selected, setSelected] = useState<string>();
  return (
    <main className="min-h-dvh min-w-0 bg-background px-4 py-6 text-foreground sm:px-8">
      <div className="mx-auto max-w-[1440px]">
        <header className="mb-5 flex items-baseline gap-3">
          <h1 className="text-xl font-semibold">Contacts</h1>
          <span className="text-sm text-muted-foreground">{rows.length} candidates</span>
        </header>
        <CandidateDirectory
          rows={rows}
          selectedKey={selected}
          onOpen={(row) => setSelected(row.key)}
          renderActions={(row) => (
            <Button
              size="sm"
              variant="outline"
              aria-label={`Shortlist ${row.name ?? "unnamed candidate"}`}
              aria-pressed={row.autumn?.shortlisted ?? false}
              onClick={() =>
                setRows((current) =>
                  current.map((item) =>
                    item.key === row.key && item.autumn
                      ? {
                          ...item,
                          autumn: { ...item.autumn, shortlisted: !item.autumn.shortlisted },
                        }
                      : item,
                  ),
                )
              }
            >
              <Bookmark
                size={13}
                aria-hidden
                fill={row.autumn?.shortlisted ? "currentColor" : "none"}
              />
              {row.autumn?.shortlisted ? "Shortlisted" : "Shortlist"}
            </Button>
          )}
        />
        <output className="sr-only" aria-label="Opened candidate">
          {selected ?? "none"}
        </output>
      </div>
    </main>
  );
}

applyUiAppearance("light");
void bootstrapI18n("en").then(() =>
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <Fixture />
    </I18nProvider>,
  ),
);
