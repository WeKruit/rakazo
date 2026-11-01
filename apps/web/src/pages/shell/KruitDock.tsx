import { Trans, useLingui } from "@lingui/react/macro";
import type { Group } from "@rakazo/contracts";
import { RECRUITING_GLOBAL_AGENT_NAME } from "@rakazo/core";
import { Badge, Button } from "@rakazo/ui-web";
import { MessageSquare, X } from "lucide-react";
import { useState } from "react";

/**
 * The bottom-right entry to Kruit. Above it, the conversations waiting on the recruiter's
 * confirmation or answer, so a card raised anywhere is one click away.
 */
export function KruitDock({
  groups,
  groupId,
  onOpen,
}: {
  groups: Group[];
  /** The open conversation: its own card is already in view. */
  groupId?: string;
  onOpen: (groupId: string) => void;
}) {
  const { t } = useLingui();
  const kruit = groups.find((group) => group.id.startsWith("recruiting-global-"));
  const waiting = groups.filter(
    (group) => group.id !== groupId && (group.attention ?? group.needsInput),
  );
  const key = waiting.map((group) => `${group.id}:${group.updatedAt}`).join(",");
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!kruit && !waiting.length) return null;
  return (
    <div className="fixed end-4 bottom-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-2">
      {waiting.length && dismissed !== key ? (
        <div
          role="status"
          className="w-80 max-w-full rounded-xl border border-border bg-card p-2 text-card-foreground shadow-lg"
        >
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Dismiss`}
              onClick={() => setDismissed(key)}
            >
              <X />
            </Button>
          </div>
          <ul className="space-y-1">
            {waiting.slice(0, 5).map((group) => (
              <li key={group.id}>
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-accent"
                  onClick={() => onOpen(group.id)}
                >
                  <span className="truncate text-sm font-medium">
                    {group.id === kruit?.id ? RECRUITING_GLOBAL_AGENT_NAME : group.name}
                  </span>
                  <Badge variant="secondary" className="shrink-0 font-normal">
                    {group.attention === "approval" ? (
                      <Trans>Needs confirmation</Trans>
                    ) : (
                      <Trans>Needs input</Trans>
                    )}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {kruit && kruit.id !== groupId ? (
        <Button className="rounded-full shadow-lg" onClick={() => onOpen(kruit.id)}>
          <MessageSquare aria-hidden="true" />
          {RECRUITING_GLOBAL_AGENT_NAME}
        </Button>
      ) : null}
    </div>
  );
}
