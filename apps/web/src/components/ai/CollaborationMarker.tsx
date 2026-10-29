import type { GroupAvatarMember } from "@rakazo/ui-web";
import { BotAvatar, GroupAvatar } from "@rakazo/ui-web";
import { LoadingState } from "./primitives";

/** Lightweight peer event shown without exposing the exchanged message body. */
export function CollaborationMarker({
  ariaLabel,
  color,
  identity,
  label,
  onClick,
  status,
}: {
  ariaLabel: string;
  color: string;
  identity: string;
  label: string;
  onClick?: () => void;
  status?: "running" | "completed" | "failed";
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <div className="flex justify-start">
      <Tag
        type={onClick ? "button" : undefined}
        data-testid={status ? "specialist-work" : "peer-receipt-chip"}
        role={status === "running" ? "status" : undefined}
        aria-label={ariaLabel}
        onClick={onClick}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] text-muted-foreground"
      >
        <BotAvatar color={color} identity={identity} size={16} />
        {status ? (
          <span
            aria-hidden
            className={status === "failed" ? "text-warning" : "text-muted-foreground"}
          >
            {status === "running" ? "◷" : status === "failed" ? "!" : "✓"}
          </span>
        ) : null}
        <span dir="auto" className="truncate">
          {label}
        </span>
      </Tag>
    </div>
  );
}

export function ActiveBotGlyph({ bots, label }: { bots: GroupAvatarMember[]; label: string }) {
  return (
    <div className="flex min-h-10 items-center px-1">
      <LoadingState indicator={<GroupAvatar members={bots} size={28} />} label={label} />
    </div>
  );
}
