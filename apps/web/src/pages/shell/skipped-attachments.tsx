import { useLingui } from "@lingui/react/macro";
import { X } from "lucide-react";

/** A picked file that was not attached, with the reason shown on its chip. */
export type SkippedAttachment = { id: string; name: string; reason: string };

export function SkippedAttachmentChips({
  items,
  onRemove,
}: {
  items: readonly SkippedAttachment[];
  onRemove: (id: string) => void;
}) {
  const { t } = useLingui();
  if (!items.length) return null;
  return (
    <ul role="status" className="mb-3 flex flex-wrap gap-2" data-testid="skipped-attachments">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex max-w-full items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 py-1.5 text-[13px] text-warning"
        >
          <span className="max-w-[180px] truncate" dir="auto">
            {item.name}
          </span>
          <span className="truncate">{item.reason}</span>
          <button
            type="button"
            aria-label={t`Remove ${item.name}`}
            onClick={() => onRemove(item.id)}
            className="shrink-0 hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </li>
      ))}
    </ul>
  );
}
