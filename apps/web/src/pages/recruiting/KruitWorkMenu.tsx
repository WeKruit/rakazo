import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { DeferredPopover } from "../../components/DeferredPopover";

export function KruitWorkMenu({ onOpen }: { onOpen: (view: "tasks" | "routines") => void }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <DeferredPopover
      open={open}
      onOpenChange={setOpen}
      label={t`Work`}
      trigger={
        <>
          <Trans>Work</Trans>
          <ChevronDown size={14} aria-hidden />
        </>
      }
      triggerProps={{
        className:
          "app-no-drag inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-accent",
      }}
      side="bottom"
      align="end"
      className="w-44 p-1"
    >
      {(["tasks", "routines"] as const).map((view) => (
        <Button
          key={view}
          variant="ghost"
          className="w-full justify-start"
          onClick={() => {
            setOpen(false);
            onOpen(view);
          }}
        >
          {view === "tasks" ? <Trans>Tasks</Trans> : <Trans>Routines</Trans>}
        </Button>
      ))}
    </DeferredPopover>
  );
}
