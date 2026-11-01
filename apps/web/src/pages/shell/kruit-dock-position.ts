export type DockOffset = { right: number; bottom: number };
export type Box = { width: number; height: number };

const KEY = "kruit-dock-position";
export const DOCK_MARGIN = 16;
const STEP = 16;
/** Breathing room kept around the dock so it never touches a control. */
const GAP = 8;

export const INTERACTIVE =
  'button, a[href], input, textarea, select, summary, [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"], fieldset';

export function clampOffset(offset: DockOffset, box: Box, viewport: Box): DockOffset {
  const clamp = (value: number, max: number) => Math.max(8, Math.min(value, Math.max(8, max)));
  return {
    right: clamp(offset.right, viewport.width - box.width - 8),
    bottom: clamp(offset.bottom, viewport.height - box.height - 8),
  };
}

export function readDockOffset(): DockOffset | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    return typeof value?.right === "number" && typeof value?.bottom === "number"
      ? { right: value.right, bottom: value.bottom }
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveDockOffset(offset: DockOffset) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(offset));
  } catch {
    // Position is a convenience; the dock still works without storage.
  }
}

export type Rect = { left: number; top: number; right: number; bottom: number };

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/**
 * The spot along the right edge, then the left edge, going upward from the corner, with the least
 * area of the dock (plus its margin) on a control: a clear spot when there is one, otherwise the
 * least covered. Works on the controls' rectangles, so it costs arithmetic, not page hit tests.
 */
export function findFreeOffset(box: Box, viewport: Box, controls: Rect[]): DockOffset {
  const covered = (offset: DockOffset) => {
    const left = viewport.width - offset.right - box.width - GAP;
    const top = viewport.height - offset.bottom - box.height - GAP;
    const spot = {
      left,
      top,
      right: left + box.width + GAP * 2,
      bottom: top + box.height + GAP * 2,
    };
    let area = 0;
    for (const control of controls) area += overlap(spot, control);
    return area;
  };
  let best = { right: DOCK_MARGIN, bottom: DOCK_MARGIN };
  let bestArea = Number.POSITIVE_INFINITY;
  const maxBottom = Math.max(DOCK_MARGIN, viewport.height - box.height - DOCK_MARGIN);
  for (const side of ["right", "left"] as const) {
    for (let bottom = DOCK_MARGIN; bottom <= maxBottom; bottom += STEP) {
      const offset = {
        right: side === "right" ? DOCK_MARGIN : viewport.width - box.width - DOCK_MARGIN,
        bottom,
      };
      const area = covered(offset);
      if (area === 0) return offset;
      if (area < bestArea) {
        best = offset;
        bestArea = area;
      }
    }
  }
  return best;
}

/** Rectangles of the visible controls on the page, outside the dock itself. */
export function controlRects(dock: Element | null): Rect[] {
  const rects: Rect[] = [];
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (dock?.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth)
      continue;
    rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  }
  return rects;
}
