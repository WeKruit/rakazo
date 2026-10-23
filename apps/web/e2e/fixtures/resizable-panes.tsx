import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { PaneResizeHandle } from "../../src/components/PaneResizeHandle";
import { bootstrapI18n } from "../../src/lib/i18n";
import { clampWidth, usePaneWidth, useViewportWidth } from "../../src/lib/pane-width";
import { ResizableSidePanel } from "../../src/pages/ResizableSidePanel";
import "../../src/styles.css";

// Offline layout fixture using production resize controls, persistence and responsive CSS.
const params = new URLSearchParams(location.search);
function Panes() {
  const viewport = useViewportWidth();
  const [navigation, setNavigation] = usePaneWidth("fixture:navigation", 260);
  const navigationMax = Math.max(220, Math.min(480, viewport - 640));
  const navWidth = clampWidth(navigation, 220, navigationMax);
  const [chat, setChat] = usePaneWidth("fixture:chat", 360);
  const chatMax = Math.max(320, Math.min(720, viewport - navWidth - 320));
  const chatWidth = clampWidth(chat, 320, chatMax);
  const detail = params.has("detail");
  return (
    <div
      data-product-view="recruiting"
      className="flex h-dvh overflow-hidden bg-background text-foreground"
    >
      <aside
        className="relative hidden shrink-0 border-e border-border bg-sidebar p-5 md:block"
        style={{ width: navWidth }}
      >
        <h1>Roles</h1>
        <p>Example role</p>
        <PaneResizeHandle
          label="Resize navigation"
          width={navWidth}
          min={220}
          max={navigationMax}
          edge="end"
          onResize={setNavigation}
          onReset={() => setNavigation(260)}
          className="md:block"
        />
      </aside>
      <main
        className={
          detail
            ? "min-w-0 flex-1 p-6"
            : "hire-role-chat-workspace hire-role-chat-open min-w-0 flex-1"
        }
        style={{ "--hire-role-chat-width": `${chatWidth}px` } as CSSProperties}
      >
        <div className="recruiting-workspace-main p-6">
          <h2>Candidates</h2>
          <p>Synthetic fixture content</p>
        </div>
        {!detail ? (
          <section aria-label="Role conversation" className="hire-role-chat p-6">
            <PaneResizeHandle
              label="Resize chat"
              width={chatWidth}
              min={320}
              max={chatMax}
              edge="start"
              onResize={setChat}
              onReset={() => setChat(360)}
              className="min-[941px]:block"
            />
            <h2>Conversation</h2>
            <p>Example progress</p>
          </section>
        ) : null}
      </main>
      {detail ? (
        <ResizableSidePanel open panel="fixture" botsSidebarWidth={navWidth}>
          <div className="p-6">Example profile</div>
        </ResizableSidePanel>
      ) : null}
    </div>
  );
}
void bootstrapI18n("en").then(() => {
  document.documentElement.dir = params.get("dir") === "rtl" ? "rtl" : "ltr";
  createRoot(document.getElementById("root")!).render(<Panes />);
});
