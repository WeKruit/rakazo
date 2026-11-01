import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Group } from "@rakazo/contracts";
import { RECRUITING_GLOBAL_AGENT_NAME } from "@rakazo/core";
import { Badge, Button } from "@rakazo/ui-web";
import { Minus } from "lucide-react";
import { useState } from "react";

const SURFACE =
  "border border-border/60 bg-card/80 text-card-foreground ring-1 ring-foreground/10 backdrop-blur-xl backdrop-saturate-150";

/**
 * Kruit's corner entry at the bottom of the page, beside the sidebar. While something waits it
 * shows a small reminder that minimizes to the Kruit button with a count; the list of waits
 * opens only when asked for.
 */
export function KruitDock({
  groups,
  groupId,
  chatting = false,
  start = 0,
  onOpen,
}: {
  groups: Group[];
  /** The open conversation: its own card is already in view. */
  groupId?: string;
  /** A chat is on screen: start minimized and sit above its composer. */
  chatting?: boolean;
  /** Width of the sidebar the entry sits beside. */
  start?: number;
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
  if (chatting ? !waiting.length : !kruit && !waiting.length) return null;
  // One click reaches the content: a single wait opens straight away, several show the list.
  const reveal = () => {
    if (waiting.length === 1) onOpen(waiting[0].id);
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
    <div
      className={`fixed z-40 flex max-w-[calc(100vw-2rem)] flex-col items-start gap-2 ${chatting ? "bottom-24" : "bottom-4"}`}
      style={{ insetInlineStart: `calc(${start}px + 1rem)` }}
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
          className={`flex items-center gap-1 rounded-full py-1 ps-3 pe-1 shadow-xl ${SURFACE}`}
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
          className={`relative grid size-12 place-items-center rounded-full shadow-xl hover:bg-accent ${SURFACE}`}
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
  );
}
