import { lightTokens } from "@rakazo/ui-tokens";

/** A supplied mail channel/action; the enclosing control supplies its accessible name. */
export function ProfileMailIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      className={`shrink-0 ${className ?? ""}`}
      style={{ color: lightTokens.link }}
    >
      <rect x="1" y="4" width="22" height="16" rx="3" fill="currentColor" />
      <path
        d="m3 7 9 6 9-6"
        fill="none"
        stroke={lightTokens.faviconPlate}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
