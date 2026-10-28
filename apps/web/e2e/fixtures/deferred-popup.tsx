import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DeferredMenu, DeferredPopover } from "../../src/components/DeferredPopover";
import "../../src/styles.css";

function Fixture() {
  const [popover, setPopover] = useState(false);
  const [menu, setMenu] = useState(false);
  const [result, setResult] = useState("");
  return (
    <main className="p-8">
      <button type="button">Before</button>
      <DeferredPopover open={popover} onOpenChange={setPopover} trigger="React" label="Reactions">
        <button
          type="button"
          onClick={() => {
            setResult("reacted");
            setPopover(false);
          }}
        >
          Smile
        </button>
      </DeferredPopover>
      <DeferredMenu
        open={menu}
        onOpenChange={setMenu}
        trigger="More"
        items={[
          { id: "reply", label: "Reply", onSelect: () => setResult("reply") },
          { id: "copy", label: "Copy", onSelect: () => setResult("copy") },
        ]}
      />
      <button type="button">After</button>
      <output>{result}</output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={setupI18n({ locale: "en", messages: { en: {} } })}>
    <Fixture />
  </I18nProvider>,
);
