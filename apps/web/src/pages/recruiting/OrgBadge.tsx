import { Tooltip, TooltipContent, TooltipTrigger } from "@rakazo/ui-web";
import { CompanyLogo } from "./CompanyLogo";

export { CompanyLogo } from "./CompanyLogo";

/**
 * One organization (company, school, lab) shown the same way everywhere: its own site's icon,
 * its name, and what we know about it on hover.
 */
export function OrgBadge({
  name,
  label,
  src,
  host,
  kind,
  description,
  facts = [],
  logo = true,
}: {
  name: string;
  /** Text shown in place of the name, such as a tag that mentions it. */
  label?: string;
  /** A supplied logo image, preferred over the website's favicon. */
  src?: string | null;
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
        {logo ? <CompanyLogo name={name} src={src} host={host} small /> : null}
        <span className="truncate">{label ?? name}</span>
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
