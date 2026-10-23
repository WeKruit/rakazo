import { useState } from "react";

export function clampWidth(width: number, min: number, max: number) {
  return Math.max(min, Math.min(max, width));
}

function readSavedWidth(storageKey: string) {
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved > 0) return saved;
  } catch {
    /* Storage may be disabled. */
  }
  return undefined;
}

/**
 * A pane width the user can drag. The saved width is read on the first render,
 * so the pane does not jump after load, and each change is written back.
 */
export function usePaneWidth(storageKey: string, fallback: number) {
  const [width, setWidthState] = useState(() => readSavedWidth(storageKey) ?? fallback);
  function setWidth(next: number) {
    setWidthState(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {
      /* Storage may be disabled. */
    }
  }
  return [width, setWidth] as const;
}
