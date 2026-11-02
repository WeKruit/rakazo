import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function rootTheme(): ToasterProps["theme"] {
  const theme =
    typeof document === "undefined" ? undefined : document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "system";
}

const Toaster = (props: ToasterProps) => (
  <Sonner
    theme={rootTheme()}
    className="toaster group"
    style={
      {
        "--normal-bg": "var(--popover)",
        "--normal-text": "var(--popover-foreground)",
        "--normal-border": "var(--border)",
        "--border-radius": "var(--radius)",
      } as CSSProperties
    }
    {...props}
  />
);

export { toast } from "sonner";
export { Toaster };
