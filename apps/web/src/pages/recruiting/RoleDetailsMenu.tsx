import { Trans, useLingui } from "@lingui/react/macro";
import { buttonVariants } from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { DeferredPopover } from "../../components/DeferredPopover";

export function RoleDetailsMenu() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [open, setOpen] = useState(false);
  return (
    <DeferredPopover
      open={open}
      onOpenChange={setOpen}
      label={t`Role details`}
      trigger={
        <>
          <Trans>Role details</Trans>
          <ChevronDown size={14} aria-hidden />
        </>
      }
      triggerProps={{
        className:
          "app-no-drag inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-sm hover:bg-accent",
      }}
      side="bottom"
      align="end"
      className="w-48 p-1"
    >
      {[
        ["brief", t`Job brief`],
        ["feedback", t`Client feedback`],
      ].map(([view, label]) => {
        const next = new URLSearchParams(params);
        next.set("view", view!);
        next.delete("detail");
        return (
          <Link
            key={view}
            to={`?${next}`}
            className={buttonVariants({
              variant: "ghost",
              className: "w-full justify-start font-normal",
            })}
            onClick={() => setOpen(false)}
          >
            {label}
          </Link>
        );
      })}
    </DeferredPopover>
  );
}
