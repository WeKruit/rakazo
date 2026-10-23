import { cn, Skeleton } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import "./beautiful-ui.css";

/* Beautiful UI primitives — hand-ported from beautifului.dev
   (github.com/TurboKach/ai-native-react-components, MIT © 2026 Turbo).
   The upstream components are demo showcases; these ports keep their visual
   and motion language (pixel-grid loader, shimmer sweep, pop-in success) and
   expose real props. */

/** A light sweep travelling across a text label. */
export function Shimmer({ children }: { children: React.ReactNode }) {
  return (
    <span className="animate-[bui-shimmer-text_1.4s_linear_infinite] bg-linear-to-r from-muted-foreground from-35% via-foreground via-50% to-muted-foreground to-65% bg-size-[200%_100%] bg-clip-text text-transparent">
      {children}
    </span>
  );
}

// Chevron wavefront: each 3×3 cell fires by column distance from the center row.
const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const column = i % 3;
  return (column + Math.abs(row - 1)) * 90;
});

/** Format wall-clock seconds since `startedAtMs` as `0.0s` / `1m 2.3s`. */
export function formatElapsed(startedAtMs: number, nowMs: number): string {
  const totalTenths = Math.round(Math.max(0, nowMs - startedAtMs) / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = (totalTenths % 600) / 10;
  if (minutes === 0) return `${seconds.toFixed(1)}s`;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function useElapsed(startedAtMs?: number): string {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  return formatElapsed(startedAtMs ?? mountedAt, now);
}

/** Pixel-grid loader with shimmering label and live elapsed timer. */
function DefaultLoadingState({ label, startedAt }: { label: string; startedAt?: number }) {
  const elapsed = useElapsed(startedAt);
  return (
    <>
      <span aria-hidden className="grid grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {CHEVRON_DELAYS.map((delay, i) => (
          <span
            key={i}
            className="h-[4px] w-[4px] rounded-[1px] bg-foreground opacity-15"
            style={{ animation: `bui-pixel-on 650ms ease-in-out ${delay}ms infinite` }}
          />
        ))}
      </span>
      <span className="text-[13.5px] font-medium">
        <Shimmer>{label}</Shimmer>
      </span>
      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">{elapsed}</span>
    </>
  );
}

export function LoadingState({
  indicator,
  label = "working",
  startedAt,
}: {
  indicator?: React.ReactNode;
  label?: string;
  /** Epoch ms when the run started. Falls back to mount time when omitted. */
  startedAt?: number;
}) {
  if (indicator) {
    return (
      <span role="status" className="flex w-fit items-center gap-2.5">
        <span className="sr-only">{label}</span>
        {indicator}
      </span>
    );
  }
  return (
    <span className="flex w-fit items-center gap-2.5">
      <DefaultLoadingState label={label} startedAt={startedAt} />
    </span>
  );
}

/** Pop-in green check with a fading-up label — the approval-card success beat. */
export function SuccessPop({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className="flex h-6 w-6 items-center justify-center rounded-full bg-success text-background"
        style={{ animation: "bui-pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
      <span
        className="text-[13px] font-medium text-foreground"
        style={{ animation: "bui-fade-up 350ms cubic-bezier(0.23,1,0.32,1) 100ms both" }}
      >
        {label}
      </span>
    </span>
  );
}

const SKELETON_MESSAGES = [
  { mine: false, lines: ["w-3/5", "w-4/5", "w-2/5"] },
  { mine: true, lines: ["w-1/3"] },
  { mine: false, lines: ["w-4/5", "w-1/2"] },
] as const;

/** Message-shaped placeholders while a conversation's first read is in flight. */
export function MessageSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col justify-end gap-6 overflow-hidden px-6 py-6"
    >
      {SKELETON_MESSAGES.map(({ mine, lines }, index) => (
        <div key={index} className={cn("flex gap-3", mine && "justify-end")}>
          {mine ? null : <Skeleton className="size-8 shrink-0 rounded-full" />}
          <div className={cn("flex flex-1 flex-col gap-2", mine && "max-w-sm items-end")}>
            {lines.map((width, line) => (
              <Skeleton key={line} className={cn("h-3", mine ? "h-9 w-1/2 rounded-2xl" : width)} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Card shell. */
export function BuiCard({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      className={cn("rounded-2xl border border-border bg-card shadow-sm", className)}
    />
  );
}
