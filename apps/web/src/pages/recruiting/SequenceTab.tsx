import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingRoleCampaign } from "@rakazo/contracts";
import { Badge, Button } from "@rakazo/ui-web";
import { useState } from "react";
import { rpc } from "../../lib/rpc";
import { useRecruitingDetail } from "./detail";
import { SequenceOverview } from "./SequenceOverview";
import type { RecruitingTabProps } from "./shared";
import {
  CrmGate,
  formatDate,
  LoadMore,
  statusText,
  TabHeader,
  TabLoading,
  TabNotice,
  tabCacheSlot,
  useCrmCandidateCounts,
  useCrmData,
  useCrmPages,
  useKeyedRead,
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

/** Campaign names may carry an internal "[role <id>]" tag; it is not for people. */
export const campaignName = (name: string) =>
  name.replace(/\s*\[role [^\]]*\]\s*/gi, " ").trim() || name;

/** Instantly's own integer statuses for a campaign and for a lead. */
export function useInstantlyStatus() {
  const { t } = useLingui();
  return {
    campaign: { 0: t`Draft`, 1: t`Active`, 2: t`Paused`, 3: t`Completed` } as Record<
      number,
      string
    >,
    lead: {
      1: t`Active`,
      2: t`Paused`,
      3: t`Completed`,
      [-1]: t`Bounced`,
      [-2]: t`Unsubscribed`,
    } as Record<number, string>,
  };
}
export const statusLabel = (labels: Record<number, string>, status: number | null) =>
  status === null ? null : (labels[status] ?? String(status));

type CampaignScope = Pick<
  RecruitingTabProps,
  "conversation" | "refreshSignal" | "readCache" | "readCacheScope"
>;

/** The role's bound Instantly campaign, read live through the conversation's connection. */
export function useRoleCampaign({ conversation, refreshSignal, ...cache }: CampaignScope) {
  const target = conversation
    ? "groupId" in conversation
      ? { groupId: conversation.groupId }
      : { botId: conversation.botId }
    : null;
  return useKeyedRead<RecruitingRoleCampaign>(
    target ? JSON.stringify([target, refreshSignal]) : null,
    async () => rpc.recruiting.roleCampaign(target!),
    target ? tabCacheSlot(cache, ["roleCampaign", target]) : {},
  );
}

/** The role's Instantly campaign and its leads; nothing when the role has none. */
export function RoleCampaignCard(props: CampaignScope) {
  const status = useInstantlyStatus();
  const read = useRoleCampaign(props);
  const campaign = read.data?.campaign;
  if (!campaign) return null;
  const label = statusLabel(status.campaign, campaign.status);
  const leads = read.data?.leads ?? [];
  return (
    <section className="mb-6 rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="truncate" title={campaignName(campaign.name)}>
          {campaignName(campaign.name)}
        </strong>
        {label ? (
          <Badge variant={campaign.status === 1 ? "default" : "outline"}>{label}</Badge>
        ) : null}
      </div>
      {read.data?.status === "unavailable" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <Trans>Could not read this campaign.</Trans>
        </p>
      ) : null}
      {campaign.stopOnReply === false ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          <Trans>Stop on reply is off, so follow-ups keep going after a candidate replies.</Trans>
        </p>
      ) : null}
      {leads.length ? (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {leads.map((lead) => (
            <li key={lead.email} className="flex justify-between gap-2">
              <span className="truncate">{lead.email}</span>
              <span className="shrink-0">{statusLabel(status.lead, lead.status) ?? "—"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Stored outreach state for the role: campaigns, per-candidate status and queued/sent messages. */
export function SequenceTab(props: RecruitingTabProps) {
  const { t } = useLingui();
  const detail = useRecruitingDetail();
  const crm = useRoleCrm(props);
  const roleCampaign = useRoleCampaign(props);
  const instantly = useInstantlyStatus();
  const leadStatus = new Map(
    (roleCampaign.data?.leads ?? []).map((lead) => [
      lead.email.toLowerCase(),
      statusLabel(instantly.lead, lead.status),
    ]),
  );
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
  const totals = useCrmCandidateCounts(
    crm,
    ready ? { crmRoleId: ready.crmRoleId } : null,
    props,
    (person) => person.outreachStatus,
  );
  // Until every page is totalled (or if that read fails), count the rows already loaded.
  const loadedCounts = new Map<string, number>();
  for (const person of people.data?.items ?? [])
    loadedCounts.set(person.outreachStatus, (loadedCounts.get(person.outreachStatus) ?? 0) + 1);
  const counts = totals.data?.counts ?? loadedCounts;
  const selected = people.data?.items.find((person) => person.candidateId === candidateId);
  return (
    <section aria-label={t`Sequence`}>
      <TabHeader title={<Trans>Sequence</Trans>} />
      <CrmGate crm={crm} />
      <SequenceOverview
        campaign={roleCampaign.data}
        replied={
          !totals.failed && totals.data?.complete ? (totals.data.counts.get("replied") ?? 0) : null
        }
        sendContext={selected?.name}
        sendDates={
          details.data && details.data.candidateId === candidateId
            ? details.data.outbox.flatMap((entry) =>
                entry.status === "sent" && entry.sentAt ? [entry.sentAt] : [],
              )
            : []
        }
      />
      {roleCampaign.failed || roleCampaign.data?.status === "unavailable" ? (
        <TabNotice alert>
          <Trans>Could not read this campaign.</Trans>
        </TabNotice>
      ) : null}
      {campaigns.loading || people.loading ? <TabLoading /> : null}
      {campaigns.failed || people.failed ? (
        <TabNotice alert>
          <Trans>Could not load candidate records. Try refreshing.</Trans>
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
                      <th scope="row">{campaignName(campaign.name)}</th>
                      <td>{campaignStatus(campaign.status)}</td>
                      <td>{formatDate(campaign.syncedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : roleCampaign.data?.campaign ? null : (
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
          ) : people.data.items.length ? null : (
            <TabNotice>
              <Trans>No contacts for this role yet.</Trans>
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
                      {person.email && leadStatus.get(person.email.toLowerCase())
                        ? ` · ${leadStatus.get(person.email.toLowerCase())}`
                        : ""}
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
                <h4 className="font-semibold">
                  {detail ? (
                    <Button
                      variant="link"
                      className="h-auto p-0 font-semibold"
                      onClick={() =>
                        detail.open({
                          view: "thread",
                          person: selected,
                          role: {
                            roleId: props.roleId,
                            spaceId: props.spaceId,
                            conversation: props.conversation,
                          },
                        })
                      }
                    >
                      {selected.name}
                    </Button>
                  ) : (
                    selected.name
                  )}
                </h4>
                {details.loading ? <TabLoading /> : null}
                {details.failed ? (
                  <TabNotice alert>
                    <Trans>Could not load candidate records. Try refreshing.</Trans>
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
                      {entry.status === "sent" ? (
                        entry.sentAt ? (
                          <time className="text-xs text-muted-foreground" dateTime={entry.sentAt}>
                            {formatDate(entry.sentAt)}
                          </time>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            <Trans>Time not recorded</Trans>
                          </span>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          <Trans>Queued</Trans> ·{" "}
                          <time dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time>
                        </span>
                      )}
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
