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
 * The spot along the right edge, then the left edge, going upward from the corner, with the
 * fewest points of the dock on a control: a clear spot when there is one, otherwise the least
 * covered. `blocked` tells whether a viewport point holds a control.
 */
export function findFreeOffset(
  box: Box,
  viewport: Box,
  blocked: (x: number, y: number) => boolean,
): DockOffset {
  const covered = (offset: DockOffset) => {
    const left = viewport.width - offset.right - box.width - GAP;
    const top = viewport.height - offset.bottom - box.height - GAP;
    const width = box.width + GAP * 2;
    const height = box.height + GAP * 2;
    let count = 0;
    for (let x = 0; x <= width; x += SAMPLE) {
      for (let y = 0; y <= height; y += SAMPLE) {
        if (blocked(left + Math.min(x, width - 1), top + Math.min(y, height - 1))) count += 1;
      }
    }
    return count;
  };
  let best = { right: DOCK_MARGIN, bottom: DOCK_MARGIN };
  let bestCount = Number.POSITIVE_INFINITY;
  const maxBottom = Math.max(DOCK_MARGIN, viewport.height - box.height - DOCK_MARGIN);
  for (const side of ["right", "left"] as const) {
    for (let bottom = DOCK_MARGIN; bottom <= maxBottom; bottom += STEP) {
      const offset = {
        right: side === "right" ? DOCK_MARGIN : viewport.width - box.width - DOCK_MARGIN,
        bottom,
      };
      const count = covered(offset);
      if (count === 0) return offset;
      if (count < bestCount) {
        best = offset;
        bestCount = count;
      }
    }
  }
  return best;
}

export function controlAt(x: number, y: number, dock: Element | null): boolean {
  return (document.elementsFromPoint?.(x, y) ?? []).some(
    (el) => !dock?.contains(el) && el.closest(INTERACTIVE) !== null,
  );
}
