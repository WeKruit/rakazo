import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { messages } from "../../src/locales/en/messages.po";
import { CandidateDirectory } from "../../src/pages/recruiting/CandidateDirectory";
import type { RoleCandidate } from "../../src/pages/recruiting/useRoleCandidates";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: { en: messages } });
const rows: RoleCandidate[] = Array.from({ length: 1000 }, (_, index) => ({
  key: `synthetic-${index}`,
  name: `Synthetic Candidate ${index}`,
  title: "Platform engineer",
  location:
    index % 3
      ? "Example City"
      : "Example City with a longer location description to exercise variable row heights",
  email: null,
  linkedinUrl: null,
  crm: null,
  autumn: {
    company: "Example Company",
    shortlisted: false,
    latestSource: { report: { fields: [] } },
  } as RoleCandidate["autumn"],
}));
function Fixture() {
  const [selected, setSelected] = useState<string>();
  const [shortlisted, setShortlisted] = useState(new Set<string>());
  return (
    <main style={{ padding: 24 }}>
      <output aria-label="Selected candidate">{selected}</output>
      <CandidateDirectory
        rows={rows}
        selectedKey={selected}
        onOpen={(row) => setSelected(row.key)}
        renderActions={(row) => (
          <button
            type="button"
            aria-pressed={shortlisted.has(row.key)}
            onClick={() =>
              setShortlisted((current) => {
                const next = new Set(current);
                if (next.has(row.key)) next.delete(row.key);
                else next.add(row.key);
                return next;
              })
            }
          >
            Shortlist
          </button>
        )}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <Fixture />
  </I18nProvider>,
);
