import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { Check, Pencil, X } from "lucide-react";
import { useState } from "react";

export interface QueuedMessage {
  id: string;
  blocks: readonly MessageBlock[];
}

/** One plain text part can be rewritten; attachments and feedback selections cannot. */
export function queuedMessageEditable(blocks: readonly MessageBlock[]): boolean {
  const text = blocks.filter((block) => block.kind === "text");
  return text.length === 1 && !text[0]?.recruitingFeedback;
}

function queuedText(blocks: readonly MessageBlock[]): string {
  return blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

/** Messages a working reply has not read yet, shown above the composer until it does. */
export function QueuedMessages({
  messages,
  onEdit,
  onRemove,
  onSendNow,
}: {
  messages: readonly QueuedMessage[];
  onEdit: (id: string, text: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onSendNow: (id: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  if (messages.length === 0) return null;
  const run = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    try {
      await action();
    } finally {
      setBusyId((current) => (current === id ? null : current));
    }
  };
  const save = (id: string, text: string) =>
    run(id, async () => {
      await onEdit(id, text.trim());
      setEditing(null);
    });
  return (
    <ul aria-label={t`Queued messages`} aria-live="polite" className="mb-2 flex flex-col gap-1">
      {messages.map((message) => {
        const text = queuedText(message.blocks);
        const busy = busyId === message.id;
        const draft = editing?.id === message.id ? editing : null;
        return (
          <li
            key={message.id}
            className="flex items-center gap-1 rounded-xl border border-border bg-muted py-1 pr-1 pl-3 text-[13px]"
          >
            {draft ? (
              <form
                className="flex min-w-0 flex-1 items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (draft.text.trim()) void save(message.id, draft.text).catch(() => undefined);
                }}
              >
                <Input
                  autoFocus
                  aria-label={t`Edit queued message`}
                  value={draft.text}
                  disabled={busy}
                  onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    setEditing(null);
                  }}
                  className="h-6 min-w-0 flex-1 text-[13px]"
                />
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Save`}
                  disabled={busy || !draft.text.trim()}
                >
                  <Check aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Cancel edit`}
                  disabled={busy}
                  onClick={() => setEditing(null)}
                >
                  <X aria-hidden="true" />
                </Button>
              </form>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">
                  <Trans>Queued</Trans>
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="auto">
                  {text || t`Attachment`}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void run(message.id, () => onSendNow(message.id)).catch(() => {})}
                >
                  <Trans>Send now</Trans>
                </Button>
                {queuedMessageEditable(message.blocks) ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t`Edit queued message`}
                    disabled={busy}
                    onClick={() => setEditing({ id: message.id, text })}
                  >
                    <Pencil aria-hidden="true" />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t`Remove queued message`}
                  disabled={busy}
                  onClick={() => void run(message.id, () => onRemove(message.id)).catch(() => {})}
                >
                  <X aria-hidden="true" />
                </Button>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
