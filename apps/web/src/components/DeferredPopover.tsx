import type { ButtonHTMLAttributes, ReactNode, RefObject } from "react";
import { useId, useRef, useState } from "react";
import { lazyPanel } from "./ErrorBoundary";

const PopoverSurface = lazyPanel(() =>
  import("./DeferredPopoverSurface").then((m) => m.DeferredPopoverSurface),
);
const MenuSurface = lazyPanel(() =>
  import("./DeferredMenuSurface").then((m) => m.DeferredMenuSurface),
);
type TriggerProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "onClick" | "onKeyDown"
>;
export type DeferredPopupProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  triggerProps?: TriggerProps;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  label?: string;
};
export type DeferredSurfaceProps = Omit<DeferredPopupProps, "trigger" | "triggerProps"> & {
  anchor: RefObject<HTMLButtonElement | null>;
  id: string;
};
export type DeferredMenuItem = {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
};

/** Keep the trigger mounted; download popup behavior only after an opening interaction. */
export function DeferredPopover({
  trigger,
  triggerProps,
  children,
  ...props
}: DeferredPopupProps & { children: ReactNode }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <>
      <button
        {...triggerProps}
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={props.open}
        aria-controls={props.open ? id : undefined}
        onClick={() => props.onOpenChange(!props.open)}
      >
        {trigger}
      </button>
      {props.open ? (
        <PopoverSurface {...props} anchor={anchor} id={id}>
          {children}
        </PopoverSurface>
      ) : null}
    </>
  );
}

export function DeferredMenu({
  trigger,
  triggerProps,
  items,
  ...props
}: DeferredPopupProps & { items: DeferredMenuItem[] }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [last, setLast] = useState(false);
  return (
    <>
      <button
        {...triggerProps}
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={props.open}
        aria-controls={props.open ? id : undefined}
        onClick={() => {
          setLast(false);
          props.onOpenChange(!props.open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setLast(event.key === "ArrowUp");
            props.onOpenChange(true);
          }
        }}
      >
        {trigger}
      </button>
      {props.open ? (
        <MenuSurface {...props} anchor={anchor} id={id} items={items} last={last} />
      ) : null}
    </>
  );
}
