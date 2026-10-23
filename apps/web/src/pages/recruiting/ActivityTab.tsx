import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@rakazo/ui-web";
import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  CalendarClock,
  Clock,
  Flag,
  Mail,
  MailCheck,
  Reply,
  Send,
  Star,
} from "lucide-react";
import { useState } from "react";
import type { ActivityItem } from "./activity";
import { buildActivity, relativeTime } from "./activity";
import type { RecruitingDetailPerson } from "./detail";
import { RetryNotice } from "./RetryNotice";
import { campaignName, statusLabel, useInstantlyStatus, useRoleCampaign } from "./SequenceTab";
import type { RecruitingTabProps } from "./shared";
import {
  crmRoleKey,
  formatDate,
  statusText,
  TabLoading,
  TabNotice,
  useCrmData,
  useRoleCrm,
  useSavedCorrespondence,
} from "./shared";

const ICONS: Record<ActivityItem["kind"], LucideIcon> = {
  sent: Send,
  received: Reply,
  email: Mail,
  scheduled: CalendarClock,
  queued: Clock,
  failed: AlertCircle,
  status: Flag,
  highSignal: Star,
  review: MailCheck,
};

/**
 * One person's stored activity, newest first: emails, outbox, role status changes and review.
 * The current status and campaign state lead, since neither carries a change time.
 */
export function ActivityTab({
  person,
  crm: hasCrm = true,
  candidateKey,
  ...props
}: RecruitingTabProps & {
  person: RecruitingDetailPerson;
  /** False when the person has no CRM record; only saved mailbox reads and the campaign apply. */
  crm?: boolean;
  /** The person's search-result key, to find their campaign lead. */
  candidateKey?: string;
}) {
  const { t, i18n } = useLingui();
  const locale = i18n?.locale || "en";
  const [reload, setReload] = useState(0);
  const scope = { ...props, refreshSignal: (props.refreshSignal ?? 0) + reload };
  const roleCrm = useRoleCrm(scope);
  const ready = hasCrm && roleCrm.status === "ready" ? roleCrm.target : null;
  const mail = useCrmData(
    roleCrm,
    "mail",
    ready ? { candidateId: person.candidateId, crmRoleId: ready.crmRoleId, limit: 50 } : null,
    scope,
  );
  const details = useCrmData(
    roleCrm,
    "candidateDetails",
    ready ? { candidateId: person.candidateId } : null,
    scope,
  );
  const saved = useSavedCorrespondence(
    person.email ? scope : { ...scope, conversation: undefined },
    "inbox",
  );
  const campaign = useRoleCampaign(scope);
  const instantly = useInstantlyStatus();

  const roleKey = ready ? crmRoleKey(ready) : null;
  const items = buildActivity({
    email: person.email,
    mail: mail.data?.candidateId === person.candidateId ? mail.data : undefined,
    details: details.data?.candidateId === person.candidateId ? details.data : undefined,
    roleKey,
    crmRoleId: ready?.crmRoleId,
    saved: saved.data?.emails,
  });
  const reads = [mail, details, saved, campaign];
  const crmFailed = hasCrm && roleCrm.status === "failed";
  const loading = (hasCrm && roleCrm.status === "loading") || reads.some((read) => read.loading);
  const failed = crmFailed || reads.some((read) => read.failed);

  const email = person.email?.toLowerCase();
  const lead = campaign.data?.leads.find(
    (entry) =>
      (candidateKey && entry.candidateKey === candidateKey) ||
      (email && entry.email.toLowerCase() === email),
  );
  const interest = details.data?.roleInterests.find(
    (entry) => entry.roleKey === roleKey && entry.interest !== "unknown",
  );
  const status = [
    person.stage ? statusText(person.stage) : null,
    person.outreachStatus ? statusText(person.outreachStatus) : null,
    interest ? (interest.interest === "interested" ? t`Interested` : t`Not interested`) : null,
  ].filter((value): value is string => Boolean(value));
  const leadLabel = lead ? statusLabel(instantly.lead, lead.status) : null;
  const sequence =
    lead && campaign.data?.campaign
      ? [campaignName(campaign.data.campaign.name), leadLabel].filter(Boolean).join(" · ")
      : null;

  const workflow = {
    waiting_resume: t`Waiting for resume`,
    resume_ready: t`Resume ready`,
    introduced: t`Introduced`,
    needs_scheduling: t`Needs scheduling`,
    scheduled: t`Scheduled`,
    awaiting_feedback: t`Awaiting feedback`,
  };
  const sentence = (item: ActivityItem) => {
    switch (item.kind) {
      case "sent":
        return t`Email sent`;
      case "received": {
        const name = person.name;
        return t`${name} replied`;
      }
      case "email":
        return t`Email recorded`;
      case "scheduled":
        return t`Email scheduled`;
      case "queued":
        return t`Email queued`;
      case "failed":
        return t`Email failed to send`;
      case "status": {
        const label = workflow[item.status];
        return t`Status changed to “${label}”`;
      }
      case "highSignal":
        return t`Marked high signal`;
      case "review":
        return item.result === "approved"
          ? t`Approved in internal review`
          : item.result === "rejected"
            ? t`Rejected in internal review`
            : item.result === "pooled"
              ? t`Pooled in internal review`
              : t`Review note`;
    }
  };
  const detail = (item: ActivityItem) =>
    "subject" in item
      ? item.subject
      : "preview" in item
        ? item.preview
        : item.kind === "review"
          ? item.notes
          : null;

  return (
    <section aria-label={t`Activity`} className="space-y-4 text-sm">
      {status.length || sequence ? (
        <div className="flex flex-wrap gap-1.5">
          {status.map((value) => (
            <Badge key={value} variant="secondary">
              {value}
            </Badge>
          ))}
          {sequence ? <Badge variant="outline">{sequence}</Badge> : null}
        </div>
      ) : null}
      {failed ? (
        <RetryNotice onRetry={() => setReload((value) => value + 1)}>
          <Trans>Could not load all activity.</Trans>
        </RetryNotice>
      ) : null}
      {items.length ? (
        <ol className="relative space-y-3 before:absolute before:inset-y-2 before:start-4 before:w-px before:bg-border">
          {items.map((item) => {
            const Icon = ICONS[item.kind];
            const text = detail(item);
            return (
              <li key={item.id} className="relative flex gap-3">
                <span
                  aria-hidden
                  className={`relative grid size-8 shrink-0 place-items-center rounded-full border bg-background ${
                    item.kind === "failed" ? "text-destructive" : "text-muted-foreground"
                  }`}
                >
                  <Icon size={15} />
                </span>
                <div className="min-w-0 flex-1 rounded-lg border px-3 py-2">
                  <p className="flex items-start justify-between gap-2">
                    <span className="font-medium">{sentence(item)}</span>
                    {item.at ? (
                      <time
                        dateTime={item.at}
                        title={formatDate(item.at)}
                        className="shrink-0 text-xs text-muted-foreground"
                      >
                        {relativeTime(item.at, locale)}
                      </time>
                    ) : null}
                  </p>
                  {text ? (
                    <p className="mt-0.5 line-clamp-2 break-words whitespace-pre-wrap text-muted-foreground">
                      {text}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
      {loading ? <TabLoading /> : null}
      {!loading && !failed && !items.length ? (
        <TabNotice>
          <Trans>No activity yet.</Trans>
        </TabNotice>
      ) : null}
    </section>
  );
}
