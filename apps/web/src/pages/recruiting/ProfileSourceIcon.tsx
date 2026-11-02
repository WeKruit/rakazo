import { lightTokens } from "@rakazo/ui-tokens";
import { Globe } from "lucide-react";
import { LinkedInIcon } from "./LinkedInIcon";

/** Identify an actual supplied link; this never creates or discovers a profile URL. */
export function ProfileSourceIcon({
  href,
  className = "size-4",
}: {
  href: string;
  className?: string;
}) {
  let host = "";
  try {
    host = new URL(href).hostname.toLowerCase();
  } catch {
    /* The existing link owns URL validation. */
  }
  if (/(^|\.)linkedin\.com$/.test(host)) return <LinkedInIcon className={className} />;
  if (/(^|\.)github\.com$/.test(host))
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 16 16"
        fill="#181717"
        className={className}
      >
        <rect width="16" height="16" rx="2" fill={lightTokens.faviconPlate} />
        {/* GitHub's MIT-licensed Octicons mark-github-16 brand asset. */}
        <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
      </svg>
    );
  if (/(^|\.)stackoverflow\.com$/.test(host))
    return (
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        fill="#F48024"
        className={className}
      >
        <path d="M4 15h2v5h12v-5h2v7H4zM8 17h8v2H8z" />
        <path d="m8 13 9 2-.4 2-9-2zm1-4 8 4-.9 1.8-8-4zm3-4 6 6-1.4 1.4-6-6zm4-4 4 8-1.8.9-4-8z" />
      </svg>
    );
  return <Globe aria-hidden className={className} />;
}
