export type DockOffset = { right: number; bottom: number };
export type Box = { width: number; height: number };

const KEY = "kruit-dock-position";
export const DOCK_MARGIN = 16;
const STEP = 16;
const SAMPLE = 16;
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

/**
 * First spot along the right edge, then the left edge, going upward from the corner, where no
 * point of the dock lands on a control. `blocked` tells whether a viewport point holds one.
 */
export function findFreeOffset(
  box: Box,
  viewport: Box,
  blocked: (x: number, y: number) => boolean,
): DockOffset {
  const fallback = { right: DOCK_MARGIN, bottom: DOCK_MARGIN };
  const free = (offset: DockOffset) => {
    const left = viewport.width - offset.right - box.width - GAP;
    const top = viewport.height - offset.bottom - box.height - GAP;
    const width = box.width + GAP * 2;
    const height = box.height + GAP * 2;
    for (let x = 0; x <= width; x += SAMPLE) {
      for (let y = 0; y <= height; y += SAMPLE) {
        if (blocked(left + Math.min(x, width - 1), top + Math.min(y, height - 1))) return false;
      }
    }
    return true;
  };
  const maxBottom = viewport.height * 0.6;
  for (const side of ["right", "left"] as const) {
    for (let bottom = DOCK_MARGIN; bottom <= maxBottom; bottom += STEP) {
      const offset = {
        right: side === "right" ? DOCK_MARGIN : viewport.width - box.width - DOCK_MARGIN,
        bottom,
      };
      if (free(offset)) return offset;
    }
  }
  return fallback;
}

export function controlAt(x: number, y: number, dock: Element | null): boolean {
  return (document.elementsFromPoint?.(x, y) ?? []).some(
    (el) => !dock?.contains(el) && el.closest(INTERACTIVE) !== null,
  );
}
