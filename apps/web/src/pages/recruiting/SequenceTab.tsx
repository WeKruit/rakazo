import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@rakazo/ui-web";
import { useState } from "react";
import type { RecruitingTabProps } from "./shared";
import {
  CrmGate,
  formatDate,
  LoadMore,
  statusText,
  TabHeader,
  TabLoading,
  TabNotice,
  useCrmData,
  useCrmPages,
  useRoleCrm,
} from "./shared";

// The CRM mirrors the provider's integer campaign status without defining its meaning; show it as stored.
const campaignStatus = (status: number | null) => (status === null ? "—" : String(status));

function useOutboxStatus() {
  const { t } = useLingui();
  return {
    pending: t`Queued`,
    processing: t`Sending`,
    sent: t`Sent`,
    failed: t`Failed`,
  } as const;
}

/** Stored outreach state for the role: campaigns, per-candidate status and queued/sent messages. */
export function SequenceTab(props: RecruitingTabProps) {
  const { t } = useLingui();
  const crm = useRoleCrm(props);
  const outboxStatus = useOutboxStatus();
  const [candidateId, setCandidateId] = useState<string>();
  const ready = crm.status === "ready" ? crm.target : null;
  const campaigns = useCrmPages(
    crm,
    "roleCampaigns",
    ready ? { crmRoleId: ready.crmRoleId } : null,
    props,
  );
  const people = useCrmPages(
    crm,
    "candidates",
    ready ? { crmRoleId: ready.crmRoleId } : null,
    props,
  );
  const details = useCrmData(crm, "candidateDetails", candidateId ? { candidateId } : null, props);
  const counts = new Map<string, number>();
  for (const person of people.data?.items ?? [])
    counts.set(person.outreachStatus, (counts.get(person.outreachStatus) ?? 0) + 1);
  const selected = people.data?.items.find((person) => person.candidateId === candidateId);
  return (
    <section aria-label={t`Sequence`}>
      <TabHeader title={<Trans>Sequence</Trans>} />
      <CrmGate crm={crm} />
      {campaigns.loading || people.loading ? <TabLoading /> : null}
      {campaigns.failed || people.failed ? (
        <TabNotice alert>
          <Trans>Could not load CRM records. Try refreshing.</Trans>
        </TabNotice>
      ) : null}
      {campaigns.data ? (
        <section className="mb-6" aria-label={t`Role campaigns`}>
          <h3 className="mb-2 text-sm font-semibold">
            <Trans>Role campaigns</Trans>
          </h3>
          {campaigns.data.items.length ? (
            <div className="hire-table-wrap overflow-x-auto">
              <table className="hire-table w-full text-left text-sm">
                <thead>
                  <tr>
                    {[t`Campaign`, t`Provider status code`, t`Last synced`].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {campaigns.data.items.map((campaign) => (
                    <tr key={campaign.id}>
                      <th scope="row">{campaign.name}</th>
                      <td>{campaignStatus(campaign.status)}</td>
                      <td>{formatDate(campaign.syncedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <TabNotice>
              <Trans>No stored campaign associations were returned for this role.</Trans>
            </TabNotice>
          )}
          <LoadMore pages={campaigns} />
        </section>
      ) : null}
      {people.data ? (
        <section aria-label={t`Outreach status`}>
          <h3 className="mb-2 text-sm font-semibold">
            <Trans>Outreach status</Trans>
          </h3>
          {counts.size ? (
            <ul className="mb-3 flex flex-wrap gap-2">
              {[...counts].map(([status, count]) => (
                <li key={status}>
                  <Badge variant="outline">
                    {statusText(status)} · {count}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <TabNotice>
              <Trans>No CRM contacts for this role yet.</Trans>
            </TabNotice>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <ul className="divide-y divide-border rounded-lg border border-border">
              {people.data.items.map((person) => (
                <li key={person.candidateId}>
                  <button
                    type="button"
                    aria-pressed={candidateId === person.candidateId}
                    className="flex w-full items-center justify-between gap-2 p-3 text-start text-sm hover:bg-muted aria-pressed:bg-muted"
                    onClick={() => setCandidateId(person.candidateId)}
                  >
                    <span className="truncate font-medium" title={person.name}>
                      {person.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {statusText(person.outreachStatus)}
                    </span>
                  </button>
                </li>
              ))}
              {people.hasMore ? (
                <li className="px-3 pb-3">
                  <LoadMore pages={people} />
                </li>
              ) : null}
            </ul>
            {selected ? (
              <section aria-label={t`Messages`} className="space-y-3">
                <h4 className="font-semibold">{selected.name}</h4>
                {details.loading ? <TabLoading /> : null}
                {details.failed ? (
                  <TabNotice alert>
                    <Trans>Could not load CRM records. Try refreshing.</Trans>
                  </TabNotice>
                ) : null}
                {details.data?.campaignAssociations.leadCampaigns.length ? (
                  <ul className="flex flex-wrap gap-2 text-xs">
                    {details.data.campaignAssociations.leadCampaigns.map((lead) => (
                      <li key={lead.leadId}>
                        <Badge variant="secondary">
                          {lead.campaign?.name ?? t`Campaign not synced`}
                          {lead.campaign ? ` · ${campaignStatus(lead.campaign.status)}` : ""}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {details.data && !details.data.outbox.length ? (
                  <TabNotice>
                    <Trans>No stored messages for this candidate.</Trans>
                  </TabNotice>
                ) : null}
                {details.data?.outbox.map((entry) => (
                  <article key={entry.id} className="rounded-lg border border-border p-3 text-sm">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <Badge variant={entry.status === "failed" ? "destructive" : "outline"}>
                        {outboxStatus[entry.status]}
                      </Badge>
                      <time
                        className="text-xs text-muted-foreground"
                        dateTime={entry.sentAt ?? entry.createdAt}
                      >
                        {formatDate(entry.sentAt ?? entry.createdAt)}
                      </time>
                    </div>
                    <p className="whitespace-pre-wrap break-words">
                      {entry.polishedBody ?? entry.body}
                    </p>
                    {entry.error ? (
                      <p className="mt-2 text-xs text-destructive">{entry.error}</p>
                    ) : null}
                  </article>
                ))}
              </section>
            ) : null}
          </div>
        </section>
      ) : null}
    </section>
  );
}
