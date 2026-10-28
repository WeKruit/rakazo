import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@rakazo/ui-web";
import { useRef } from "react";
import type { DeferredMenuItem, DeferredSurfaceProps } from "./DeferredPopover";

export function DeferredMenuSurface({
  anchor,
  id,
  open,
  onOpenChange,
  align,
  side,
  className,
  label,
  items,
  last,
}: DeferredSurfaceProps & { items: DeferredMenuItem[]; last: boolean }) {
  const popup = useRef<HTMLDivElement>(null);
  const tabDismissed = useRef(false);
  function focusInitialItem() {
    const enabled = popup.current?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])',
    );
    if (enabled?.length) enabled[last ? enabled.length - 1 : 0]?.focus();
  }
  return (
    <DropdownMenu
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen) focusInitialItem();
      }}
    >
      <DropdownMenuContent
        ref={popup}
        anchor={anchor}
        finalFocus={() => (tabDismissed.current ? false : anchor.current)}
        onKeyDownCapture={(event) => {
          if (event.key === "Tab") {
            // The stable external trigger is the browser's sequential-focus origin.
            // Let native Tab/Shift+Tab advance from it; do not trap focus in the popup.
            event.stopPropagation();
            tabDismissed.current = true;
            anchor.current?.focus();
            onOpenChange(false);
          }
        }}
        id={id}
        align={align}
        side={side}
        className={className}
        aria-label={label}
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            disabled={item.disabled}
            onClick={() => {
              onOpenChange(false);
              item.onSelect();
            }}
          >
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
