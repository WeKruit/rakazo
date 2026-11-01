import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Group } from "@rakazo/contracts";
import { RECRUITING_GLOBAL_AGENT_NAME } from "@rakazo/core";
import { Badge, Button, Toaster, toast } from "@rakazo/ui-web";
import { Minus } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  clampOffset,
  controlRects,
  DOCK_MARGIN,
  type DockOffset,
  findFreeOffset,
  readDockOffset,
  saveDockOffset,
} from "./kruit-dock-position";

const SURFACE =
  "border border-border/60 bg-card/80 text-card-foreground ring-1 ring-foreground/10 backdrop-blur-xl backdrop-saturate-150";

/**
 * Kruit's corner entry, floating at the bottom right. While something waits it shows a small
 * reminder that minimizes to the Kruit button with a count; one click opens what waits. It
 * steps clear of buttons on the page and can be dragged anywhere; a dragged spot is remembered.
 */
export function KruitDock({
  groups,
  groupId,
  chatting = false,
  onOpen,
}: {
  groups: Group[];
  /** The open conversation: its own card is already in view. */
  groupId?: string;
  /** A chat is on screen: start minimized. */
  chatting?: boolean;
  onOpen: (groupId: string) => void;
}) {
  const { t } = useLingui();
  const kruit = groups.find((group) => group.id.startsWith("recruiting-global-"));
  const waiting = groups.filter(
    (group) => group.id !== groupId && (group.attention ?? group.needsInput),
  );
  const [minimizedPref, setMinimized] = useState<boolean>();
  const [expanded, setExpanded] = useState(false);
  const minimized = minimizedPref ?? chatting;
  const showList = expanded && waiting.length > 0;
  const showReminder = !showList && !minimized && waiting.length > 0;
  useAttentionToasts(groups, groupId, kruit?.id, onOpen);
  const hidden = chatting ? !waiting.length : !kruit && !waiting.length;
  const dock = useFloatingDock(hidden, `${minimized}:${showList}:${waiting.length}`);
  if (hidden) return <Toaster position="top-right" />;
  // One click reaches the content: a single wait opens straight away, several show the list.
  const reveal = () => {
    const only = waiting.length === 1 ? waiting[0] : undefined;
    if (only) onOpen(only.id);
    else setExpanded(true);
  };
  const minimize = () => {
    setMinimized(true);
    setExpanded(false);
  };
  const minimizeButton = (
    <Button variant="ghost" size="icon-sm" aria-label={t`Minimize`} onClick={minimize}>
      <Minus />
    </Button>
  );
  return (
    <>
      <Toaster position="top-right" />
      <div
        ref={dock.ref}
        className="fixed z-40 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2"
        style={{ right: dock.offset.right, bottom: dock.offset.bottom }}
      >
        {showList ? (
          <div className={`w-80 max-w-full rounded-xl p-2 shadow-2xl ${SURFACE}`}>
            <div className="flex items-center justify-between ps-2">
              <span className="text-sm font-medium">
                <Trans>Needs your attention</Trans>
              </span>
              {minimizeButton}
            </div>
            <ul className="space-y-1">
              {waiting.slice(0, 5).map((group) => (
                <li key={group.id}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-foreground/5"
                    onClick={() => {
                      setExpanded(false);
                      onOpen(group.id);
                    }}
                  >
                    <span className="truncate text-sm">
                      {group.id === kruit?.id ? RECRUITING_GLOBAL_AGENT_NAME : group.name}
                    </span>
                    <Badge variant="secondary" className="shrink-0 font-normal">
                      {group.attention === "approval" ? (
                        <Trans>Needs approval</Trans>
                      ) : (
                        <Trans>Needs your response</Trans>
                      )}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {showReminder ? (
          <div
            role="status"
            className={`flex touch-none items-center gap-1 rounded-full py-1 ps-3 pe-1 shadow-xl ${SURFACE}`}
            {...dock.drag}
          >
            <button type="button" className="text-sm font-medium" onClick={reveal}>
              <Plural
                value={waiting.length}
                one="# item needs your attention"
                other="# items need your attention"
              />
            </button>
            {minimizeButton}
          </div>
        ) : (
          <button
            type="button"
            aria-label={
              waiting.length
                ? t`${RECRUITING_GLOBAL_AGENT_NAME}, ${waiting.length} waiting`
                : RECRUITING_GLOBAL_AGENT_NAME
            }
            className={`relative grid size-12 touch-none place-items-center rounded-full shadow-xl hover:bg-accent ${SURFACE}`}
            {...dock.drag}
            onClick={() => {
              // With something waiting the button opens it; otherwise it opens Kruit.
              if (showList) setExpanded(false);
              else if (waiting.length) reveal();
              else if (kruit && kruit.id !== groupId) onOpen(kruit.id);
            }}
          >
            <img
              src="/wekruit-logo.png"
              alt=""
              draggable={false}
              className="pointer-events-none size-8 select-none object-contain"
            />
            {waiting.length ? (
              <span className="absolute -end-1 -top-1 grid min-w-5 place-items-center rounded-full bg-destructive px-1 text-xs font-medium text-destructive-foreground">
                {waiting.length}
              </span>
            ) : null}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * Where the dock sits and how to drag it. Dragging moves the element with a transform straight
 * from the pointer events, with no React render and no storage write per move; the spot is
 * committed and saved once, on drop. Clearing controls runs only when the user has not placed the
 * dock, off the main path (idle time, debounced) and on control rectangles.
 */
function useFloatingDock(hidden: boolean, layout: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [stored, setStored] = useState(readDockOffset);
  const [auto, setAuto] = useState<DockOffset>({ right: DOCK_MARGIN, bottom: DOCK_MARGIN });
  const dragging = useRef(false);
  const moved = useRef(false);
  const placed = useRef(Boolean(stored));
  placed.current = Boolean(stored);
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

  const settle = useCallback(() => {
    const el = ref.current;
    if (!el || dragging.current) return;
    const box = { width: el.offsetWidth, height: el.offsetHeight };
    if (placed.current) {
      setStored((was) => {
        if (!was) return was;
        const next = clampOffset(was, box, viewport());
        return next.right === was.right && next.bottom === was.bottom ? was : next;
      });
      return;
    }
    const next = findFreeOffset(box, viewport(), controlRects(el));
    setAuto((was) => (was.right === next.right && was.bottom === next.bottom ? was : next));
  }, []);

  useLayoutEffect(() => {
    if (!hidden) settle();
  }, [hidden, layout, settle]);

  useEffect(() => {
    if (hidden) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.hidden || dragging.current) return;
        if ("requestIdleCallback" in window) window.requestIdleCallback(settle, { timeout: 1500 });
        else settle();
      }, 1000);
    };
    const observer = new MutationObserver((records) => {
      if (!placed.current && records.some((record) => !ref.current?.contains(record.target)))
        later();
    });
    observer.observe(document.body, { subtree: true, childList: true });
    window.addEventListener("resize", later);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("resize", later);
    };
  }, [hidden, settle]);

  const drag = {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      const el = ref.current;
      if (
        !el ||
        event.button > 0 ||
        (event.target as Element).closest('button[aria-label="Minimize"]')
      )
        return;
      const rect = el.getBoundingClientRect();
      const box = { width: rect.width, height: rect.height };
      const start = {
        x: event.clientX,
        y: event.clientY,
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.bottom,
      };
      let last = { right: start.right, bottom: start.bottom };
      moved.current = false;
      dragging.current = true;
      const move = (e: globalThis.PointerEvent) => {
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!moved.current && Math.hypot(dx, dy) < 5) return;
        moved.current = true;
        last = clampOffset({ right: start.right - dx, bottom: start.bottom - dy }, box, viewport());
        el.style.transform = `translate3d(${start.right - last.right}px, ${start.bottom - last.bottom}px, 0)`;
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        dragging.current = false;
        if (moved.current) {
          saveDockOffset(last);
          setStored(last);
          // The next paint uses the new right/bottom, so the transform goes in the same frame.
          requestAnimationFrame(() => {
            el.style.transform = "";
          });
          // A drag ends in a click on the same element; swallow that one, then forget it.
          setTimeout(() => {
            moved.current = false;
          }, 0);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    onClickCapture: (event: MouseEvent) => {
      if (!moved.current) return;
      event.stopPropagation();
      event.preventDefault();
    },
  };

  return { ref, offset: stored ?? auto, drag };
}

/**
 * A top-right popup when something newly starts waiting on the user in another conversation.
 * What already waits on first load is left to the corner entry.
 */
function useAttentionToasts(
  groups: Group[],
  groupId: string | undefined,
  kruitId: string | undefined,
  onOpen: (groupId: string) => void,
) {
  const { t } = useLingui();
  const seen = useRef<Set<string> | undefined>(undefined);
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    const now = new Map<string, Group>();
    for (const group of groups) {
      const kind = group.attention ?? (group.needsInput ? "question" : undefined);
      if (kind) now.set(`${group.id}:${kind}`, group);
    }
    const before = seen.current;
    seen.current = new Set(now.keys());
    if (!before) return;
    for (const [key, group] of now) {
      if (before.has(key) || group.id === groupId) continue;
      toast(group.id === kruitId ? RECRUITING_GLOBAL_AGENT_NAME : group.name, {
        id: key,
        description: group.attention === "approval" ? t`Needs approval` : t`Needs your response`,
        action: { label: t`Open`, onClick: () => open.current(group.id) },
      });
    }
  }, [groups, groupId, kruitId, t]);
}
