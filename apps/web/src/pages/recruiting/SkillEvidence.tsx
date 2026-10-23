import { Trans, useLingui } from "@lingui/react/macro";
import { Badge, Button } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { SourceLinks } from "./AssessmentCard";
import { HighlightText, mentionsKeyword } from "./evidence";
import type { RequirementStatus, SkillEvidenceSource } from "./profile";

/** Select a reported skill to inspect the saved text mentioning it, including concerns. */
export function SkillEvidence({
  skills,
  evidence,
}: {
  skills: readonly string[];
  evidence: readonly SkillEvidenceSource[];
}) {
  const { t } = useLingui();
  const contextId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const selection = selected && skills.includes(selected) ? selected : null;
  const contexts = selection
    ? evidence.filter(
        (source) =>
          mentionsKeyword(source.text, selection) || mentionsKeyword(source.label, selection),
      )
    : [];
  const statusLabel: Record<RequirementStatus, string> = {
    match: t`Match`,
    gap: t`Gap`,
    partial: t`Partial match`,
    unknown: t`Unknown`,
  };
  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-1.5">
        {(expanded ? skills : skills.slice(0, 12)).map((skill) => (
          <li key={skill} className="max-w-full">
            <Button
              size="sm"
              variant={selection === skill ? "secondary" : "outline"}
              className="h-auto min-h-8 max-w-full break-words whitespace-normal text-start"
              aria-pressed={selection === skill}
              aria-controls={contextId}
              onClick={() => setSelected(selection === skill ? null : skill)}
            >
              {skill}
            </Button>
          </li>
        ))}
      </ul>
      {!expanded && skills.length > 12 ? (
        <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
          <Trans>Show more</Trans>
        </Button>
      ) : null}
      <section id={contextId} aria-label={t`Skill evidence`} aria-live="polite" aria-atomic="true">
        {selection ? (
          <div className="space-y-3 rounded-lg border p-3">
            <p className="break-words font-medium">
              {selection}{" "}
              <span className="font-normal text-muted-foreground">
                · <Trans>Source context</Trans>
              </span>
            </p>
            {contexts.map((source) => (
              <div key={source.key} className="space-y-1 border-t pt-2">
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="break-words">
                    {source.label ||
                      (source.criterionId ? <Trans>Criterion name unavailable</Trans> : null)}
                  </span>
                  {source.criterionId ? <span>{source.criterionId}</span> : null}
                  {source.kind === "listed" ? (
                    <Badge variant="outline">
                      <Trans>Listed skill</Trans>
                    </Badge>
                  ) : null}
                  {source.status ? (
                    <Badge variant="outline">{statusLabel[source.status]}</Badge>
                  ) : null}
                </p>
                {source.text ? (
                  <p className="break-words whitespace-pre-wrap">
                    <HighlightText text={source.text} terms={[selection]} />
                  </p>
                ) : (
                  <p className="text-muted-foreground">
                    <Trans>No evidence provided.</Trans>
                  </p>
                )}
                <SourceLinks urls={source.sourceUrls} />
              </div>
            ))}
            {!contexts.some((source) => source.kind !== "listed" && source.text.trim()) ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No supporting detail in the saved profile.</Trans>
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
