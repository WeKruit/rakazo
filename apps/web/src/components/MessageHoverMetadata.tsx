import type { ReactNode } from "react";

export function MessageHoverMetadata({
  side,
  below = false,
  pinned = false,
  children,
}: {
  side: "start" | "end";
  below?: boolean;
  pinned?: boolean;
  children: ReactNode;
}) {
  // Touch shows the rail in-flow below the bubble; hover-capable pointers reveal it beside the bubble on demand.
  const reveal = pinned
    ? "pointer-events-auto opacity-100"
    : "pointer-events-auto opacity-100 [@media(hover:hover)_and_(pointer:fine)]:pointer-events-none [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/message:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:focus-within:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:focus-within:opacity-100";

  return (
    <div
      data-testid="message-hover-rail"
      className={`z-10 flex items-center transition-opacity ${reveal} ${
        below
          ? `static mt-1 w-full ${side === "end" ? "justify-start" : "justify-end"}`
          : `absolute top-1/2 -translate-y-1/2 ${
              side === "end" ? "start-full ms-1" : "end-full me-1"
            } [@media(hover:none)]:static [@media(hover:none)]:mt-1 [@media(hover:none)]:w-full [@media(hover:none)]:translate-y-0 ${
              side === "end"
                ? "[@media(hover:none)]:ms-0 [@media(hover:none)]:justify-start"
                : "[@media(hover:none)]:me-0 [@media(hover:none)]:justify-end"
            }`
      }`}
    >
      {children}
    </div>
  );
}
