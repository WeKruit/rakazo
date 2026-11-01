import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { Group } from "@rakazo/contracts";
import { RECRUITING_GLOBAL_AGENT_NAME } from "@rakazo/core";
import { Badge, Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useState } from "react";

/**
 * Kruit's bottom-right button. Its badge counts what waits on the recruiter; a new wait shows a
 * small reminder that can be closed, and the list of waits opens only when asked for.
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
  /** A chat is on screen: no button over its composer, and cards sit at the top instead. */
  chatting?: boolean;
  onOpen: (groupId: string) => void;
}) {
  const { t } = useLingui();
  const kruit = groups.find((group) => group.id.startsWith("recruiting-global-"));
  const waiting = groups.filter(
    (group) => group.id !== groupId && (group.attention ?? group.needsInput),
  );
  const key = waiting.map((group) => `${group.id}:${group.updatedAt}`).join(",");
  // A new wait shows the small reminder; closing it keeps it closed until something changes.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const showList = expanded && waiting.length > 0;
  const showReminder = !showList && waiting.length > 0 && closedFor !== key;
  if (chatting ? !showList && !showReminder : !kruit && !waiting.length) return null;
  const close = () => {
    setClosedFor(key);
    setExpanded(false);
  };
  return (
    <div
      className={`fixed end-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2 ${chatting ? "top-20" : "bottom-4"}`}
    >
      {showReminder ? (
        <div
          role="status"
          className="flex items-center gap-1 rounded-full border border-border/60 bg-card/80 py-1 ps-3 pe-1 text-card-foreground shadow-xl ring-1 ring-foreground/10 backdrop-blur-xl backdrop-saturate-150"
        >
          <button type="button" className="text-sm font-medium" onClick={() => setExpanded(true)}>
            <Plural
              value={waiting.length}
              one="# item needs your attention"
              other="# items need your attention"
            />
          </button>
          <Button variant="ghost" size="icon-sm" aria-label={t`Close`} onClick={close}>
            <X />
          </Button>
        </div>
      ) : null}
      {showList ? (
        <div className="w-80 max-w-full rounded-xl border border-border/60 bg-card/80 p-2 text-card-foreground shadow-2xl ring-1 ring-foreground/10 backdrop-blur-xl backdrop-saturate-150">
          <div className="flex items-center justify-between ps-2">
            <span className="text-sm font-medium">
              <Trans>Needs your attention</Trans>
            </span>
            <Button variant="ghost" size="icon-sm" aria-label={t`Close`} onClick={close}>
              <X />
            </Button>
          </div>
          <ul className="space-y-1">
            {waiting.slice(0, 5).map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-foreground/5"
                  onClick={() => {
                    close();
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
      {chatting ? null : (
        <button
          type="button"
          aria-label={
            waiting.length
              ? t`${RECRUITING_GLOBAL_AGENT_NAME}, ${waiting.length} waiting`
              : RECRUITING_GLOBAL_AGENT_NAME
          }
          className="relative grid size-12 place-items-center rounded-full border border-border/60 bg-card/80 shadow-xl ring-1 ring-foreground/10 backdrop-blur-xl backdrop-saturate-150 hover:bg-accent"
          onClick={() => {
            // With something waiting the button lists it; otherwise it opens Kruit.
            if (waiting.length) setExpanded((open) => !open);
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
