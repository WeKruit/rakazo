import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web";
import { useState } from "react";

function logoInitials(name: string) {
  const letters = [...name].filter((char) => /\p{L}|\p{N}/u.test(char));
  const words = name.split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => [...word][0] ?? "")
      .join("")
      .toUpperCase();
  }
  return letters.slice(0, 2).join("").toUpperCase();
}

/** Initials on a muted tile; a favicon from the field's own source host replaces them when it loads. */
export function CompanyLogo({
  name,
  host,
  small = false,
}: {
  name: string;
  host?: string | null;
  small?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-muted font-medium text-muted-foreground ${
        small ? "size-4 rounded-sm text-[8px]" : "size-10 rounded-md text-xs"
      }`}
    >
      {host && failed !== host ? (
        <img
          src={`https://${host}/favicon.ico`}
          alt=""
          className="size-full object-contain"
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailed(host)}
        />
      ) : (
        logoInitials(name)
      )}
    </span>
  );
}

/**
 * One organization (company, school, lab) shown the same way everywhere: its own site's icon,
 * its name, and what we know about it on hover.
 */
export function OrgBadge({
  name,
  host,
  kind,
  description,
  facts = [],
  logo = true,
}: {
  name: string;
  host?: string | null;
  /** What it is, such as company, school or lab. */
  kind?: string | null;
  description?: string | null;
  facts?: readonly (string | null | undefined)[];
  /** False where a larger logo already sits beside the name. */
  logo?: boolean;
}) {
  const lines = [
    ...[kind, description, ...facts].filter((fact): fact is string => Boolean(fact?.trim())),
    host,
  ].filter(Boolean);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span />}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-foreground underline decoration-dotted decoration-muted-foreground/60 underline-offset-2"
      >
        {logo ? <CompanyLogo name={name} host={host} small /> : null}
        <span className="truncate">{name}</span>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        <span className="font-medium">{name}</span>
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
