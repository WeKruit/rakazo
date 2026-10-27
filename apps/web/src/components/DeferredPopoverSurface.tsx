import { Popover, PopoverContent } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import type { DeferredSurfaceProps } from "./DeferredPopover";

export function DeferredPopoverSurface({
  anchor,
  id,
  open,
  onOpenChange,
  align,
  side,
  className,
  label,
  children,
}: DeferredSurfaceProps & { children: ReactNode }) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        anchor={anchor}
        finalFocus={anchor}
        id={id}
        align={align}
        side={side}
        className={className}
        aria-label={label}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
