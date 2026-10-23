import type { PointerEvent } from "react";
import { useEffect, useRef } from "react";

import { clampWidth } from "../lib/pane-width";

const KEY_STEP_PX = 16;

/**
 * Drag handle on the inner edge of a pane. Dragging, arrow keys, Home/End and
 * double-click (reset) all go through `onResize` and `onReset`.
 */
export function PaneResizeHandle({
  label,
  width,
  min,
  max,
  edge,
  onResize,
  onReset,
  className = "",
}: {
  label: string;
  width: number;
  min: number;
  max: number;
  /** The pane edge the handle sits on; `end` grows toward the inline end. */
  edge: "start" | "end";
  onResize: (width: number) => void;
  onReset: () => void;
  className?: string;
}) {
  const drag = useRef<{ x: number; width: number; sign: number } | null>(null);

  useEffect(
    () => () => {
      if (drag.current) delete document.documentElement.dataset.paneResizing;
    },
    [],
  );

  /** Width change per physical pixel moved toward the pane's inside. */
  function growthSign() {
    const rtl = document.documentElement.dir === "rtl";
    return (edge === "end" ? 1 : -1) * (rtl ? -1 : 1);
  }

  function stopDrag() {
    drag.current = null;
    delete document.documentElement.dataset.paneResizing;
  }

  function startDrag(event: PointerEvent<HTMLHRElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, sign: growthSign() };
    document.documentElement.dataset.paneResizing = "";
  }

  return (
    <hr
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      className={`absolute inset-y-0 z-30 m-0 hidden h-full w-2 touch-none cursor-col-resize border-0 bg-transparent hover:bg-border focus-visible:bg-border focus-visible:outline-none ${edge === "end" ? "end-0" : "start-0"} ${className}`}
      onPointerDown={startDrag}
      onPointerMove={(event) => {
        const start = drag.current;
        if (start)
          onResize(clampWidth(start.width + (event.clientX - start.x) * start.sign, min, max));
      }}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onLostPointerCapture={stopDrag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          const physical = event.key === "ArrowRight" ? 1 : -1;
          onResize(clampWidth(width + physical * growthSign() * KEY_STEP_PX, min, max));
        } else if (event.key === "Home") {
          event.preventDefault();
          onResize(min);
        } else if (event.key === "End") {
          event.preventDefault();
          onResize(max);
        }
      }}
    />
  );
}
