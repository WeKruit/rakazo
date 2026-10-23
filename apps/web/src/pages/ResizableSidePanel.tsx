import { t } from "@lingui/core/macro";
import type { CSSProperties, ReactNode } from "react";

import { PaneResizeHandle } from "../components/PaneResizeHandle";
import { clampWidth, usePaneWidth, useViewportWidth } from "../lib/pane-width";

const STORAGE_KEY = "rakazo:right-panel-width";
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 384;
const ABSOLUTE_MAX = 1000;
const MIN_CHAT_WIDTH = 320;

export function ResizableSidePanel({
  open,
  panel,
  botsSidebarWidth = 316,
  children,
}: {
  open: boolean;
  panel: string;
  botsSidebarWidth?: number;
  children: ReactNode;
}) {
  const viewportWidth = useViewportWidth();
  const maxWidth = Math.max(
    MIN_WIDTH,
    Math.min(ABSOLUTE_MAX, viewportWidth - botsSidebarWidth - MIN_CHAT_WIDTH),
  );
  const [preferredWidth, setPreferredWidth] = usePaneWidth(STORAGE_KEY, DEFAULT_WIDTH);
  const width = clampWidth(preferredWidth, MIN_WIDTH, maxWidth);

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
