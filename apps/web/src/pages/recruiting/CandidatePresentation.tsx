import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ListRecruitingCandidatesOutput,
  RecruitingCandidate,
  RecruitingCandidateReport,
  RecruitingCorrespondence,
  RecruitingCrmCandidateSync,
  RecruitingCrmTarget,
  RecruitingResearchAction,
} from "@rakazo/contracts";
import { isVendorUrl, recruitingGateLabels } from "@rakazo/core";
import { Badge, Checkbox } from "@rakazo/ui-web";
import {
  ArrowRight,
  Bookmark,
  BriefcaseBusiness,
  Building2,
  Mail,
  MapPin,
  Sparkles,
} from "lucide-react";
import type { Ref } from "react";
import { quickOutput } from "../recruiting/quickOutput";
import type { Snapshot } from "../recruiting/workspace-types";
import { VerdictLabel } from "./VerdictLabel";

export function CandidateDecision({ decision }: Pick<RecruitingCandidate, "decision">) {
  if (!decision) return null;
  return (
    <span className="whitespace-nowrap text-xs font-normal text-muted-foreground">
      {" · "}
      {decision === "hold" ? (
        <Trans>On hold</Trans>
      ) : decision === "pass" ? (
        <Trans>Not pursuing</Trans>
      ) : (
        <Trans>Consideration resumed</Trans>
      )}
    </span>
  );
}

export function CandidateCounts({ counts }: { counts: ListRecruitingCandidatesOutput["counts"] }) {
  const { t } = useLingui();
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3" aria-label={t`Saved candidate totals`}>
      {[
        [<Trans key="source">Saved source rows</Trans>, counts.sourceRows],
        [<Trans key="candidates">Candidates</Trans>, counts.candidates],
        [<Trans key="identified">Identified profiles</Trans>, counts.identifiedCandidates],
        [<Trans key="shortlist">Shortlist</Trans>, counts.shortlisted],
      ].map(([label, value], index) => (
        <div key={index}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-lg font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CandidateResumeStatus({ value }: { value: string }) {
  switch (value.trim().toLowerCase()) {
    case "not_checked":
      return <Trans>Not checked</Trans>;
    case "inaccessible":
      return <Trans>Could not access</Trans>;
    case "available":
      return <Trans>Available</Trans>;
    case "missing":
      return <Trans>Missing</Trans>;
    case "unknown":
      return <Trans>Unknown</Trans>;
    default:
      return value;
  }
}

export function CandidateProfile({
  candidate,
  showDiagnostics = false,
}: {
  candidate: RecruitingCandidate;
  showDiagnostics?: boolean;
}) {
  const resumeStatus = candidate.latestSource?.report?.fields
    .find((field) => field.label === "Resume status")
    ?.value?.trim();
  return (
    <div className="space-y-1 text-xs">
      {!candidate.name ? (
        <p className="text-muted-foreground">
          <Trans>Name missing</Trans>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {candidate.linkedinUrl ? (
          <a className="underline" href={candidate.linkedinUrl} target="_blank" rel="noreferrer">
            <Trans>LinkedIn</Trans>
          </a>
        ) : (
          <span className="text-muted-foreground">
            <Trans>LinkedIn missing</Trans>
          </span>
        )}
        {candidate.resumeUrl ? (
          <a className="underline" href={candidate.resumeUrl} target="_blank" rel="noreferrer">
            <Trans>Resume</Trans>
            {resumeStatus ? (
              <>
                {" "}
                ({showDiagnostics ? resumeStatus : <CandidateResumeStatus value={resumeStatus} />})
              </>
            ) : null}
          </a>
        ) : (
          <span className="text-muted-foreground">
            {resumeStatus ? (
              <>
                <Trans>Resume</Trans>:{" "}
                {showDiagnostics ? resumeStatus : <CandidateResumeStatus value={resumeStatus} />}
              </>
            ) : (
              <Trans>Resume missing</Trans>
            )}
          </span>
        )}
      </div>
      {candidate.discoveryCount || candidate.issues.length || candidate.evidenceUrls?.length ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            <Trans>Profile details</Trans>
          </summary>
          {candidate.discoveryCount ? (
            <p>{showDiagnostics ? "provider_report" : <Trans>Research findings</Trans>}</p>
          ) : null}
          {showDiagnostics ? candidate.issues.map((issue) => <p key={issue}>{issue}</p>) : null}
          {candidate.evidenceUrls?.map((url) => (
            <a
              key={url}
              className="block break-all underline"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              {showDiagnostics ? url : new URL(url).hostname}
            </a>
          ))}
        </details>
      ) : null}
    </div>
  );
}

export function recruitingMatchSummaryText(value: string): string {
  // ponytail: ambiguous codes may name companies/products; translate only explicit gate expressions.
  return value.replace(
    /https?:\/\/\S+|\bnot qualification,\s*not G[0-4](?=$|[.,;:!?)]|\s+gate\b)|\b(?:playbook\s+)?gate\s+G[0-4]\b/gi,
    (expression) =>
      /^https?:\/\//i.test(expression)
        ? expression
        : expression.replace(
            /\bG[0-4]\b/gi,
            (gate) => recruitingGateLabels[gate.toUpperCase() as keyof typeof recruitingGateLabels],
          ),
  );
}

export function CandidateReportValue({
  label,
  value,
  providerStatus,
  compact = false,
  showDiagnostics = false,
}: Pick<RecruitingCandidateReport["fields"][number], "label" | "value" | "providerStatus"> & {
  compact?: boolean;
  showDiagnostics?: boolean;
}) {
  const { t } = useLingui();
  if (providerStatus)
    return (
      <VerdictLabel
        verdict={
          providerStatus === "match" ? "met" : providerStatus === "miss" ? "unmet" : "unknown"
        }
        label={
          providerStatus === "match"
            ? t`Match`
            : providerStatus === "miss"
              ? t`Does not match`
              : t`Unclear`
        }
      />
    );
  if (label === "Resume status" && value !== null && !showDiagnostics)
    return (
      <p className={compact ? "line-clamp-2" : "whitespace-pre-wrap"}>
        <CandidateResumeStatus value={value} />
      </p>
    );
  if (
    value === null ||
    value.length <= 240 ||
    !["Recommendation", "Match judgment", "Fit reasons"].includes(label)
  )
    return (
      <p className={compact ? "line-clamp-2" : "whitespace-pre-wrap"}>
        {value ?? <Trans>Unknown</Trans>}
      </p>
    );
  return (
    <details className="group/summary">
      <summary aria-label={`${label}: ${t`Details`}`} className="cursor-pointer">
        <span className="line-clamp-2 whitespace-pre-wrap group-open/summary:hidden">{value}</span>
        <span className="text-xs text-muted-foreground">
          <Trans>Details</Trans>
        </span>
      </summary>
      <p className="whitespace-pre-wrap">{value}</p>
    </details>
  );
}

export function CandidateResearchMatch({
  candidate,
  roleRevisionId,
  showDiagnostics,
  compact = false,
}: {
  candidate: RecruitingCandidate;
  roleRevisionId?: string;
  showDiagnostics: boolean;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const source = candidate.latestSource;
  const hasHigherRank = source?.report?.fields.some((field) =>
    ["Updated rank", "Overall rank", "Rank"].includes(field.label),
  );
  const fields = source?.report?.fields.filter(
    (field) =>
      ([
        "Rank",
        "Updated rank",
        "Overall rank",
        "Original pool rank",
        "Batch rank",
        "Recommendation",
        "Match judgment",
        "Fit reasons",
        "Score",
        "Match score",
        "Match tier",
        "Grade",
      ].includes(field.label) ||
        (!compact && field.providerStatus !== undefined)) &&
      (!compact || field.label !== "Fit reasons") &&
      (field.label !== "Batch rank" || !hasHigherRank),
  );
  fields?.sort((a, b) => Number(a.label === "Fit reasons") - Number(b.label === "Fit reasons"));
  const hasMatchRating = fields?.some((field) =>
    ["Score", "Match score", "Match tier", "Grade"].includes(field.label),
  );
  return (
    <dl aria-label={t`Research match`} className="hire-candidate-match space-y-1 text-xs">
      <dt className="text-muted-foreground">
        <Trans>Research match</Trans>
      </dt>
      <dd>
        {source && roleRevisionId && source.roleRevisionId !== roleRevisionId ? (
          <p className="text-muted-foreground">
            <Trans>Saved before latest role update</Trans>
          </p>
        ) : null}
        {source && !source.report ? (
          <p className="text-muted-foreground">
            <Trans>Source unavailable</Trans>
          </p>
        ) : (
          <>
            {!hasMatchRating ? (
              <p className="text-muted-foreground">
                <Trans>Score / tier not returned</Trans>
              </p>
            ) : null}
            {fields?.length ? (
              <dl>
                {fields.map((field) => (
                  <div
                    key={field.label}
                    className={`flex flex-wrap gap-x-2 ${field.providerStatus ? "hire-candidate-criterion" : ""}`}
                  >
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd
                      className={`wrap-anywhere ${
                        compact
                          ? showDiagnostics &&
                            ["Recommendation", "Match judgment"].includes(field.label)
                            ? "line-clamp-2"
                            : ""
                          : "whitespace-pre-wrap text-base"
                      }`}
                    >
                      {field.providerStatus ? (
                        <CandidateReportValue
                          label={field.label}
                          value={field.value}
                          providerStatus={field.providerStatus}
                          compact={compact}
                        />
                      ) : field.value === null ? (
                        <Trans>Unknown</Trans>
                      ) : showDiagnostics ||
                        !["Recommendation", "Match judgment", "Fit reasons"].includes(
                          field.label,
                        ) ? (
                        field.value
                      ) : (
                        <CandidateReportValue
                          label={field.label}
                          value={recruitingMatchSummaryText(field.value)}
                          compact={compact}
                        />
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </>
        )}
      </dd>
    </dl>
  );
}

export function SourcingCandidateCard({
  candidate,
  selected,
  triggerRef,
  onOpen,
  onShortlist,
  shortlistPending,
  shortlistFailed,
  onEmailDraft,
}: {
  candidate: RecruitingCandidate;
  selected: boolean;
  triggerRef?: Ref<HTMLButtonElement>;
  onOpen: (trigger: HTMLButtonElement) => void;
  onShortlist: () => void;
  shortlistPending: boolean;
  shortlistFailed: boolean;
  onEmailDraft?: () => void;
}) {
  const { t } = useLingui();
  const name = candidate.name ?? t`Unnamed candidate`;
  const fields = candidate.latestSource?.report?.fields ?? [];
  const match = ["Match tier", "Grade", "Match score", "Score"]
    .map((label) => fields.find((field) => field.label === label && field.value !== null))
    .find(Boolean);
  const summary = ["Fit reasons", "Recommendation", "Match judgment"]
    .map((label) => fields.find((field) => field.label === label && field.value))
    .find(Boolean);
  const employer = fields.find((field) =>
    ["Company context", "Employer context", "Employer description", "Company description"].includes(
      field.label,
    ),
  );
  const { quick } = quickOutput(fields);
  return (
    <article className="hire-candidate-card" data-selected={selected || undefined}>
      <div className="hire-card-top">
        <Checkbox
          aria-label={t`Shortlist ${name}`}
          checked={candidate.shortlisted}
          disabled={shortlistPending}
          onCheckedChange={onShortlist}
        />
        <button
          type="button"
          ref={triggerRef}
          className="hire-candidate-identity"
          data-candidate-name
          aria-haspopup="dialog"
          aria-pressed={selected}
          onClick={(event) => onOpen(event.currentTarget)}
        >
          <span className="hire-avatar" aria-hidden>
            {name
              .split(/\s+/u)
              .slice(0, 2)
              .map((part) => Array.from(part)[0])
              .join("")}
          </span>
          <span>
            <strong>{name}</strong>
            <small>
              <MapPin size={12} aria-hidden />
              {candidate.location ?? t`Location not returned`}
            </small>
          </span>
        </button>
        {match ? (
          <span className="hire-match-score">
            {match.label}: {match.value}
          </span>
        ) : null}
      </div>
      <div className="hire-card-history">
        <span>
          <BriefcaseBusiness size={16} aria-hidden />
          <strong>
            {[candidate.title, candidate.company].filter(Boolean).join(" · ") ||
              t`Current role not returned`}
          </strong>
        </span>
      </div>
      {quick.headline ? (
        <div className="hire-card-evidence">
          <Sparkles size={14} aria-hidden />
          <div>
            <p>{quick.headline}</p>
            {quick.highlights.length ? (
              <ul className="flex flex-wrap gap-1">
                {quick.highlights.slice(0, 4).map((tag) => (
                  <li key={tag}>
                    <Badge variant="secondary">{tag}</Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : summary ? (
        <div className="hire-card-evidence">
          <Sparkles size={14} aria-hidden />
          <div>
            <p>{recruitingMatchSummaryText(summary.value!)}</p>
            {summary.sourceUrls
              .filter((url) => !isVendorUrl(url))
              .map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  {new URL(url).hostname}
                </a>
              ))}
          </div>
        </div>
      ) : null}
      {employer ? (
        <div className="hire-peer-evidence">
          <Building2 size={14} aria-hidden />
          <div>
            <strong>{employer.label}</strong>
            <p>{employer.value ?? t`Unknown`}</p>
            {employer.sourceUrls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                {new URL(url).hostname}
              </a>
            ))}
          </div>
        </div>
      ) : null}
      <CandidateProfile candidate={candidate} />
      {shortlistFailed ? (
        <p role="alert" className="text-destructive">
          <Trans>Could not save shortlist</Trans>
        </p>
      ) : null}
      <div className="hire-card-actions">
        <button
          type="button"
          disabled={shortlistPending}
          onClick={onShortlist}
          aria-label={
            candidate.shortlisted ? t`Remove ${name} from shortlist` : t`Add ${name} to shortlist`
          }
        >
          <Bookmark size={16} aria-hidden fill={candidate.shortlisted ? "currentColor" : "none"} />
          {candidate.shortlisted ? <Trans>Shortlisted</Trans> : <Trans>Shortlist</Trans>}
        </button>
        {onEmailDraft ? (
          <button type="button" onClick={onEmailDraft}>
            <Mail size={15} aria-hidden />
            <Trans>Email draft</Trans>
          </button>
        ) : null}
        <button
          type="button"
          aria-label={t`View ${name}`}
          data-candidate-name
          aria-haspopup="dialog"
          onClick={(event) => onOpen(event.currentTarget)}
        >
          <ArrowRight size={16} aria-hidden />
        </button>
      </div>
    </article>
  );
}

export function CandidateAssessment({ candidate }: { candidate: RecruitingCandidate }) {
  const assessment = candidate.latestAssessment;
  return assessment ? (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        <Trans>Internal assessment</Trans> · <Trans>Version {assessment.version}</Trans> ·{" "}
        {assessment.isCurrent ? <Trans>Current</Trans> : <Trans>Outdated</Trans>}
      </span>
      <VerdictLabel verdict={assessment.hardGate} />
    </div>
  ) : null;
}

export function ResearchActionStatus({ action }: { action: RecruitingResearchAction }) {
  return (
    <>
      {action.kind === "create" ? <Trans>New search</Trans> : <Trans>Search follow-up</Trans>}
      {" · "}
      {action.deliveryState === "prepared" ? (
        <Trans>Prepared</Trans>
      ) : action.deliveryState === "sending" ? (
        <Trans>Submitting</Trans>
      ) : action.deliveryState === "accepted" ? (
        <Trans>Submitted</Trans>
      ) : action.deliveryState === "rejected" ? (
        <Trans>Not accepted</Trans>
      ) : action.deliveryState === "superseded" ? (
        <Trans>Replaced</Trans>
      ) : (
        <Trans>Outcome unknown</Trans>
      )}
    </>
  );
}

export function CrmStatus({ sync }: { sync: RecruitingCrmCandidateSync | null }) {
  if (!sync) return <Trans>Sync not confirmed</Trans>;
  switch (sync.status) {
    case "pending":
      return <Trans>Pending approval</Trans>;
    case "approved":
      return <Trans>Approved</Trans>;
    case "syncing":
      return <Trans>Syncing</Trans>;
    case "synced":
      return sync.receipt ? <Trans>Synced</Trans> : <Trans>Outcome unknown</Trans>;
    case "unknown":
      return <Trans>Outcome unknown</Trans>;
    case "denied":
      return <Trans>Denied</Trans>;
    case "stopped":
      return <Trans>Stopped</Trans>;
  }
}

export function CrmDetails({
  sync,
  target,
  showDiagnostics = false,
}: {
  sync: RecruitingCrmCandidateSync | null;
  target: RecruitingCrmTarget;
  showDiagnostics?: boolean;
}) {
  return (
    <div className="space-y-1 text-xs">
      <p className="text-muted-foreground">
        {target.clientLabel} · {target.roleLabel}
      </p>
      <p>
        <Trans>Pipeline</Trans> · <CrmStatus sync={sync} />
      </p>
      {showDiagnostics && sync?.status === "synced" && sync.receipt ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            <Trans>CRM receipt</Trans>
          </summary>
          <pre className="whitespace-pre-wrap break-words">
            {JSON.stringify(sync.receipt, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export function CandidateReport({
  report,
  showDiagnostics = false,
  condensed = false,
}: {
  report: RecruitingCandidateReport;
  showDiagnostics?: boolean;
  condensed?: boolean;
}) {
  const fieldUrls = new Set(report.fields.flatMap((field) => field.sourceUrls));
  const fields = condensed
    ? report.fields.toSorted((a, b) => Number(!!b.providerStatus) - Number(!!a.providerStatus))
    : report.fields;
  const FieldList = condensed ? "div" : "dl";
  return (
    <div
      className={`hire-candidate-report space-y-3 break-words font-sans ${condensed ? "text-xs leading-normal" : "text-base leading-relaxed"}`}
    >
      <FieldList className="space-y-3">
        {fields.map((field, index) => {
          const content = (
            <div key={index} className="space-y-1">
              {!condensed || !field.providerStatus ? (
                <CandidateReportValue
                  label={field.label}
                  value={field.value}
                  providerStatus={field.providerStatus}
                  showDiagnostics={showDiagnostics}
                />
              ) : null}
              {field.evidence ? (
                <p className="whitespace-pre-wrap text-muted-foreground">{field.evidence}</p>
              ) : null}
              {field.reasoning ? (
                <p className="whitespace-pre-wrap text-muted-foreground">{field.reasoning}</p>
              ) : null}
              {field.sourceUrls.map((url) => (
                <a
                  key={url}
                  className="block break-all underline"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {new URL(url).hostname}
                </a>
              ))}
            </div>
          );
          return condensed ? (
            <details key={index} className="hire-candidate-finding">
              <summary className="cursor-pointer">
                <span className="hire-candidate-finding-heading">
                  <span className="font-medium">{field.label}</span>
                  {field.providerStatus ? (
                    <CandidateReportValue
                      label={field.label}
                      value={field.value}
                      providerStatus={field.providerStatus}
                    />
                  ) : null}
                </span>
              </summary>
              {content}
            </details>
          ) : (
            <div key={index}>
              <dt className="font-medium">{field.label}</dt>
              <dd>{content}</dd>
            </div>
          );
        })}
      </FieldList>
      {report.sourceUrls
        .filter((url) => !fieldUrls.has(url))
        .map((url) => (
          <a
            key={url}
            className="block break-all underline"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {new URL(url).hostname}
          </a>
        ))}
    </div>
  );
}

export const CONTACT_STATUS_LABELS = [
  "email status",
  "email verification",
  "email verification status",
  "contact status",
  "verification status",
];

/** Autumn's own per-criterion states with their raw evidence and sources, never re-judged. */
export function CandidateCriteria({ candidate }: { candidate: RecruitingCandidate }) {
  const fields = candidate.latestSource?.report?.fields.filter((field) => field.providerStatus);
  return fields?.length ? (
    <CandidateReport condensed report={{ fields, sourceUrls: [] }} />
  ) : (
    <span className="text-muted-foreground">
      <Trans>Not returned</Trans>
    </span>
  );
}

/** The saved search round that last returned this person, named like the round filter. */
export function CandidateSourceRound({
  candidate,
  research,
}: {
  candidate: RecruitingCandidate;
  research?: Snapshot["research"];
}) {
  const source = candidate.latestSource;
  if (source && source.providerTaskId === null) return <Trans>Imported list</Trans>;
  const index = source?.actionId
    ? (research?.actions.findIndex((action) => action.id === source.actionId) ?? -1)
    : -1;
  if (index >= 0) return <Trans>Search update {index + 1}</Trans>;
  const observation = research?.observations.find((item) => item.effectId === source?.effectId);
  return observation ? (
    <>
      <Trans>Saved results</Trans>
      {" · "}
      {new Date(observation.observedAt).toLocaleString(undefined, {
        timeZone: "America/Los_Angeles",
        timeZoneName: "short",
      })}
    </>
  ) : (
    "—"
  );
}

export function CandidateContactFields({
  candidate,
  labels,
  contacts,
  kind,
}: {
  candidate: RecruitingCandidate;
  labels: readonly string[];
  contacts: RecruitingCorrespondence["contacts"];
  kind: "email" | "phone" | "status";
}) {
  const { t } = useLingui();
  const matched = contacts.filter((contact) => contact.candidateKey === candidate.candidateKey);
  const originalFields =
    candidate.latestSource?.report?.fields.filter((field) =>
      labels.includes(field.label.toLowerCase()),
    ) ?? [];
  const fields = matched.length
    ? matched.flatMap((contact) =>
        kind === "phone"
          ? contact.phones.map((phone) => ({
              label: phone.type ?? t`Phone`,
              value: phone.number,
              sourceUrls: [],
            }))
          : contact.emails.map((email) => ({
              label: kind === "email" ? t`Email` : email.address,
              value:
                kind === "email"
                  ? email.address
                  : email.status === "HIGH_PROBABILITY"
                    ? t`High probability`
                    : email.status,
              sourceUrls: [],
            })),
      )
    : originalFields;
  return (
    <>
      {fields.length ? (
        <CandidateReport report={{ fields, sourceUrls: [] }} />
      ) : (
        <span className="text-muted-foreground">
          <Trans>Not returned</Trans>
        </span>
      )}
      {matched.length && originalFields.length ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            <Trans>Original source</Trans>
          </summary>
          <CandidateReport report={{ fields: originalFields, sourceUrls: [] }} />
        </details>
      ) : null}
      {kind === "status"
        ? matched.map((contact) => (
            <p
              className="mt-2 text-xs text-muted-foreground"
              key={`${contact.source}:${contact.checkedAt}`}
            >
              {contact.source} ·{" "}
              <time dateTime={contact.checkedAt}>
                {new Date(contact.checkedAt).toLocaleString()}
              </time>
            </p>
          ))
        : null}
    </>
  );
}
