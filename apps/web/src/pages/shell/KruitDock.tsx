import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Group } from "@rakazo/contracts";
import { RECRUITING_GLOBAL_AGENT_NAME } from "@rakazo/core";
import { Badge, Button, Toaster, toast } from "@rakazo/ui-web";
import { Minus } from "lucide-react";
import type { MouseEvent, PointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  clampOffset,
  controlAt,
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
            <img src="/wekruit-logo.png" alt="" className="size-8 object-contain" />
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

/** Where the dock sits, how to drag it, and the clearing of controls it would otherwise cover. */
function useFloatingDock(hidden: boolean, layout: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [stored, setStored] = useState(readDockOffset);
  const [auto, setAuto] = useState<DockOffset>({ right: DOCK_MARGIN, bottom: DOCK_MARGIN });
  const moved = useRef(false);
  const latest = useRef<DockOffset | undefined>(undefined);
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

  const settle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const box = { width: el.offsetWidth, height: el.offsetHeight };
    if (readDockOffset()) {
      setStored((was) => was && clampOffset(was, box, viewport()));
      return;
    }
    const next = findFreeOffset(box, viewport(), (x, y) => controlAt(x, y, el));
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
      timer = setTimeout(settle, 400);
    };
    const observer = new MutationObserver((records) => {
      if (records.some((record) => !ref.current?.contains(record.target))) later();
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
      if (!el || (event.target as Element).closest('button[aria-label="Minimize"]')) return;
      const rect = el.getBoundingClientRect();
      const start = {
        x: event.clientX,
        y: event.clientY,
        right: window.innerWidth - rect.right,
        bottom: window.innerHeight - rect.bottom,
      };
      moved.current = false;
      const move = (e: globalThis.PointerEvent) => {
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (!moved.current && Math.hypot(dx, dy) < 5) return;
        moved.current = true;
        latest.current = clampOffset(
          { right: start.right - dx, bottom: start.bottom - dy },
          { width: rect.width, height: rect.height },
          viewport(),
        );
        setStored(latest.current);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (moved.current && latest.current) saveDockOffset(latest.current);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    onClickCapture: (event: MouseEvent) => {
      if (!moved.current) return;
      moved.current = false;
      event.stopPropagation();
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
