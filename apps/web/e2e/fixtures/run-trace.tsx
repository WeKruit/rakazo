import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { RunTraceDisclosure } from "../../src/components/RunTrace";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import "../../src/styles.css";

await bootstrapI18n();
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <main className="mx-auto max-w-2xl p-6">
      <RunTraceDisclosure
        runId="test-run"
        enabled={new URLSearchParams(location.search).get("developer") === "on"}
      />
    </main>
  </I18nProvider>,
);
