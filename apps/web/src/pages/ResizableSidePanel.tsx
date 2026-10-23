import { t } from "@lingui/core/macro";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";

import { PaneResizeHandle } from "../components/PaneResizeHandle";
import { clampWidth, usePaneWidth } from "../lib/pane-width";

const STORAGE_KEY = "rakazo:right-panel-width";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 384;
const ABSOLUTE_MAX = 1000;
/** Desktop bots sidebar width (`md:w-[316px]` in Shell). */
const BOTS_SIDEBAR_WIDTH = 316;
const MIN_CHAT_WIDTH = 320;

function maximumWidth(reservedLeadingPx: number) {
  return Math.max(
    MIN_WIDTH,
    Math.min(ABSOLUTE_MAX, window.innerWidth - reservedLeadingPx - MIN_CHAT_WIDTH),
  );
}

export function ResizableSidePanel({
  open,
  panel,
  botsSidebarCollapsed = false,
  children,
}: {
  open: boolean;
  panel: string;
  botsSidebarCollapsed?: boolean;
  children: ReactNode;
}) {
  const reservedLeadingPx = botsSidebarCollapsed ? 0 : BOTS_SIDEBAR_WIDTH;
  const [preferredWidth, setPreferredWidth] = usePaneWidth(STORAGE_KEY, DEFAULT_WIDTH);
  const [maxWidth, setMaxWidth] = useState(() => maximumWidth(reservedLeadingPx));
  const width = clampWidth(preferredWidth, MIN_WIDTH, maxWidth);

  useEffect(() => {
    function syncMax() {
      setMaxWidth(maximumWidth(reservedLeadingPx));
    }
    syncMax();
    window.addEventListener("resize", syncMax);
    return () => window.removeEventListener("resize", syncMax);
  }, [reservedLeadingPx]);

  return (
    <aside
      data-testid="side-panel"
      data-panel={panel}
      style={{ "--panel-width": `${width}px` } as CSSProperties}
      className={`absolute inset-y-0 end-0 z-20 flex min-h-0 shrink-0 flex-col overflow-hidden bg-background transition-[width] duration-150 ease-out md:relative ${open ? "w-full max-w-[384px] border-s border-sidebar-border md:w-(--panel-width) md:max-w-none" : "pointer-events-none w-0"}`}
    >
      {open ? (
        <PaneResizeHandle
          label={t`Resize panel`}
          className="md:block"
          edge="start"
          width={width}
          min={MIN_WIDTH}
          max={maxWidth}
          onResize={setPreferredWidth}
          onReset={() => setPreferredWidth(DEFAULT_WIDTH)}
        />
      ) : null}
      {children}
    </aside>
  );
}
