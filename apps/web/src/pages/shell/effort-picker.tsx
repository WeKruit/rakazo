import { useLingui } from "@lingui/react/macro";
import type { EffortMode } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { rpc } from "../../lib/rpc";

/** How hard this chat's replies think. Shown only when the server says the account may choose. */
export function EffortPicker({
  mode,
  target,
}: {
  mode: EffortMode;
  target: { botId: string } | { groupId: string };
}) {
  const { t } = useLingui();
  const [selected, setSelected] = useState(mode);
  const labels: Record<EffortMode, string> = {
    fast: t`Fast`,
    balanced: t`Balanced`,
    deep: t`Deep`,
  };
  const choose = (next: EffortMode) => {
    const previous = selected;
    setSelected(next);
    rpc.threads.setEffort({ ...target, mode: next }).catch(() => setSelected(previous));
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            data-testid="effort-picker"
            aria-label={t`Effort: ${labels[selected]}`}
            className="h-8 gap-1 rounded-full px-2.5 text-[13px] text-muted-foreground hover:text-foreground"
          />
        }
      >
        {labels[selected]}
        <ChevronDown size={14} strokeWidth={1.8} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={selected}
          onValueChange={(value) => choose(value as EffortMode)}
        >
          {(["fast", "balanced", "deep"] as const).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {labels[value]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
