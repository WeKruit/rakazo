import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingRoleCampaign,
  RecruitingSequenceInput,
  RecruitingSequenceOutput,
} from "@rakazo/contracts";
import { hideVendorNames } from "@rakazo/core";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import {
  ArrowDownWideNarrow,
  ArrowLeft,
  Copy,
  Ellipsis,
  FileText,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { CampaignObservedDetails } from "./CampaignObservedDetails";
import { useRecruitingDetail } from "./detail";
import { SequenceEditor } from "./SequenceEditor";
import { SequenceOverview } from "./SequenceOverview";
import type { SequenceRunFilter } from "./SequenceRuns";
import { SequenceRuns } from "./SequenceRuns";
import { clearSequenceDraftNonce, sequenceDraftNonce } from "./sequenceDraftNonce";
import type { RecruitingTabProps } from "./shared";
import {
  CrmGate,
  formatDate,
  LoadMore,
  statusText,
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

/** Campaign names may carry an internal "[role <id>]" tag; it is not for people. */
export const campaignName = (name: string) =>
  hideVendorNames(name.replace(/\s*\[role [^\]]*\]\s*/gi, " ").trim() || name);

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
export function useRoleCampaign(
  { conversation, refreshSignal, ...cache }: CampaignScope,
  selection?: {
    campaignId?: string;
    campaignOffset?: number;
    serverId?: string;
    leadCursor?: string;
  },
  selectionScope?: string,
) {
  const target = conversation
    ? "groupId" in conversation
      ? { groupId: conversation.groupId }
      : { botId: conversation.botId }
    : null;
  return useKeyedRead<RecruitingRoleCampaign>(
    target ? JSON.stringify([target, selectionScope, selection, refreshSignal]) : null,
    async () => rpc.recruiting.roleCampaign({ ...target!, ...selection }),
    target ? tabCacheSlot(cache, ["roleCampaign", target, selectionScope, selection]) : {},
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

/** Stored outreach state for the role: campaigns and per-candidate status. */
export function SequenceTab(
  props: RecruitingTabProps & {
    onAskChat?: (message: string) => void;
    onViewAnalytics?: (roleId?: string) => void;
  },
) {
  const { t } = useLingui();
  const detail = useRecruitingDetail();
  const crm = useRoleCrm(props);
  const groupId =
    props.conversation && "groupId" in props.conversation ? props.conversation.groupId : undefined;
  const botId =
    props.conversation && "botId" in props.conversation ? props.conversation.botId : undefined;
  const executeDraft = useCallback(
    (command: RecruitingSequenceInput) => {
      if (!groupId && !botId) return Promise.reject(new Error("No role conversation"));
      return rpc.recruiting.sequenceDraft({
        ...(groupId ? { groupId } : { botId: botId! }),
        command,
      });
    },
    [groupId, botId],
  );

  const instantly = useInstantlyStatus();
  const [candidateId, setCandidateId] = useState<string>();
  const [page, setPage] = useState<"overview" | "detail">("overview");
  const [editing, setEditing] = useState<{ serverId: string; campaignId?: string }>();
  const [newOpen, setNewOpen] = useState(false);
  const [cloneSource, setCloneSource] = useState<{
    id: string;
    name: string;
    nonceScope: string;
    clientNonce: string;
  }>();
  const [cloneName, setCloneName] = useState("");
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneFailed, setCloneFailed] = useState(false);
  const [period, setPeriod] = useState<"all" | "30" | "90">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"name" | "synced">("name");
  const [runFilter, setRunFilter] = useState<SequenceRunFilter>("all");
  const [contentTab, setContentTab] = useState<"email" | "job">("email");
  const [reload, setReload] = useState(0);
  const ready = crm.status === "ready" ? crm.target : null;
  const campaigns = useCrmPages(
    crm,
    "roleCampaigns",
    ready ? { crmRoleId: ready.crmRoleId } : null,
    props,
  );
  const campaignScope = JSON.stringify([props.spaceId, props.roleId, props.conversation, ready]);
  const [chosenCampaign, setChosenCampaign] = useState<{
    scope: string;
    campaignId: string;
    campaignOffset?: number;
    serverId?: string;
  }>();
  useEffect(() => {
    setChosenCampaign(undefined);
    setCandidateId(undefined);
    setPage("overview");
    setEditing(undefined);
    setNewOpen(false);
    setCloneSource(undefined);
    setSearch("");
    setRunFilter("all");
  }, [campaignScope]);
  const selection =
    chosenCampaign?.scope === campaignScope
      ? {
          campaignId: chosenCampaign.campaignId,
          ...(chosenCampaign.campaignOffset !== undefined
            ? { campaignOffset: chosenCampaign.campaignOffset }
            : {}),
          ...(chosenCampaign.serverId ? { serverId: chosenCampaign.serverId } : {}),
        }
      : undefined;
  const roleCampaign = useRoleCampaign(
    { ...props, refreshSignal: (props.refreshSignal ?? 0) + reload },
    selection,
    campaignScope,
  );
  const draftServerId = roleCampaign.data?.serverId;
  const nativeDrafts = useKeyedRead<RecruitingSequenceOutput>(
    draftServerId && (groupId || botId)
      ? JSON.stringify([campaignScope, draftServerId, reload])
      : null,
    async () => executeDraft({ operation: "read", roleId: props.roleId, serverId: draftServerId! }),
  );
  const runScope = JSON.stringify([campaignScope, selection, props.refreshSignal, reload]);
  const runScopeRef = useRef(runScope);
  runScopeRef.current = runScope;
  const [moreLeads, setMoreLeads] = useState<{
    scope: string;
    rows: RecruitingRoleCampaign["leads"];
    nextCursor: string | null;
    loading?: boolean;
    failed?: boolean;
  }>();
  const campaign =
    roleCampaign.data && moreLeads?.scope === runScope
      ? { ...roleCampaign.data, leads: moreLeads.rows, nextLeadCursor: moreLeads.nextCursor }
      : roleCampaign.data;
  const loadMoreLeads = async () => {
    const cursor = campaign?.nextLeadCursor;
    if (!cursor || moreLeads?.loading || !campaign?.campaign) return;
    const scope = runScope;
    const id = campaign.campaign.id;
    setMoreLeads({ scope, rows: campaign.leads, nextCursor: cursor, loading: true });
    try {
      const next = await rpc.recruiting.roleCampaign({
        ...(groupId ? { groupId } : { botId: botId! }),
        ...selection,
        campaignId: id,
        ...(campaign.serverId ? { serverId: campaign.serverId } : {}),
        leadCursor: cursor,
      });
      if (runScopeRef.current !== scope) return;
      if (next.status !== "ready" || next.campaign?.id !== id) throw new Error("Sequence changed");
      setMoreLeads({
        scope,
        rows: [
          ...new Map(
            [...campaign.leads, ...next.leads].map((lead) => [lead.email.toLowerCase(), lead]),
          ).values(),
        ],
        nextCursor: next.nextLeadCursor ?? null,
      });
    } catch {
      if (runScopeRef.current === scope)
        setMoreLeads({ scope, rows: campaign.leads, nextCursor: cursor, failed: true });
    }
  };
  const leadStatus = new Map(
    (roleCampaign.data?.leads ?? []).map((lead) => [
      lead.email.toLowerCase(),
      statusLabel(instantly.lead, lead.status),
    ]),
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
  const roleLeadCampaigns =
    ready && details.data && details.data.candidateId === candidateId
      ? details.data.campaignAssociations.leadCampaigns.filter(
          ({ campaign }) =>
            campaign?.crmRoleId === ready.crmRoleId && campaign.clientId === ready.crmClientId,
        )
      : [];

  const live = campaign?.status === "ready" ? campaign.campaign : null;
  const currentRows = campaigns.data?.items ?? [];
  const sequenceRows = [
    ...currentRows,
    ...(nativeDrafts.data?.campaigns ?? [])
      .filter((item) => !currentRows.some((row) => row.id === item.id))
      .map((item) => ({
        ...item,
        status:
          nativeDrafts.data?.campaign?.id === item.id ? nativeDrafts.data.campaign.status : null,
        syncedAt: null,
      })),
    ...(live &&
    !currentRows.some((row) => row.id === live.id) &&
    !(nativeDrafts.data?.campaigns ?? []).some((row) => row.id === live.id)
      ? [{ id: live.id, name: live.name, status: live.status, syncedAt: null }]
      : []),
  ]
    .filter(
      (row) =>
        !search.trim() ||
        campaignName(row.name).toLowerCase().includes(search.trim().toLowerCase()),
    )
    .sort((left, right) =>
      sort === "name"
        ? left.name.localeCompare(right.name)
        : (right.syncedAt ?? "").localeCompare(left.syncedAt ?? ""),
    );
  const choose = (id: string) => {
    const offset = campaigns.itemOffsets.get(id);
    const native = nativeDrafts.data?.campaigns?.some((row) => row.id === id);
    setChosenCampaign(
      native && draftServerId
        ? { scope: campaignScope, campaignId: id, serverId: draftServerId }
        : offset !== undefined
          ? { scope: campaignScope, campaignId: id, campaignOffset: offset }
          : undefined,
    );
    setPage("detail");
    setRunFilter("all");
  };
  const startClone = (id: string, name: string) => {
    const nonceScope = JSON.stringify([props.roleId, draftServerId, "clone", id]);
    setCloneSource({ id, name, nonceScope, clientNonce: sequenceDraftNonce(nonceScope) });
    setCloneName(`${name.slice(0, 190)} (copy)`);
    setCloneFailed(false);
    setNewOpen(false);
  };
  const clone = async () => {
    if (!cloneSource || !cloneName.trim() || !draftServerId || cloneBusy) return;
    const scope = runScope;
    setCloneBusy(true);
    setCloneFailed(false);
    try {
      const result = await executeDraft({
        operation: "clone",
        roleId: props.roleId,
        serverId: draftServerId,
        campaignId: cloneSource.id,
        name: cloneName.trim(),
        clientNonce: cloneSource.clientNonce,
      });
      if (runScopeRef.current !== scope) return;
      if (!result.campaign) throw new Error("No cloned sequence returned");
      clearSequenceDraftNonce(cloneSource.nonceScope, cloneSource.clientNonce);
      setCloneSource(undefined);
      setChosenCampaign({
        scope: campaignScope,
        campaignId: result.campaign.id,
        serverId: draftServerId,
      });
      setEditing({ serverId: draftServerId, campaignId: result.campaign.id });
      setPage("detail");
    } catch {
      if (runScopeRef.current === scope) setCloneFailed(true);
    } finally {
      if (runScopeRef.current === scope) {
        setCloneBusy(false);
        setReload((value) => value + 1);
      }
    }
  };
  const openEditor = (campaignId?: string) => {
    const serverId = roleCampaign.data?.serverId;
    if (serverId) setEditing({ serverId, ...(campaignId ? { campaignId } : {}) });
  };
  if (editing)
    return (
      <SequenceEditor
        key={`${props.roleId}:${editing.campaignId ?? "new"}`}
        roleId={props.roleId}
        serverId={editing.serverId}
        expectedCampaignId={editing.campaignId}
        mode={editing.campaignId ? "edit" : "new"}
        observedDetails={live?.id === editing.campaignId ? live?.observedDetails : undefined}
        execute={executeDraft}
        onAskAgent={props.onAskChat}
        onDone={() => {
          setEditing(undefined);
          setReload((value) => value + 1);
        }}
      />
    );
  const analyticsHref = `/app?view=analytics&role=${encodeURIComponent(props.roleId)}`;
  return (
    <section aria-label={t`Sequence`} className="min-w-0 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {page === "detail" ? (
            <Button
              variant="link"
              className="mb-1 h-auto p-0 text-xs text-muted-foreground"
              onClick={() => setPage("overview")}
            >
              <ArrowLeft size={12} aria-hidden />
              <Trans>Sequences</Trans>
            </Button>
          ) : (
            <p className="mb-1 text-xs text-muted-foreground">
              <Trans>Sequences</Trans>
            </p>
          )}
          <h2 className="truncate text-xl font-semibold leading-snug" title={live?.name}>
            {page === "detail"
              ? live
                ? campaignName(live.name)
                : t`Sequence details`
              : t`Overview`}
          </h2>
          {ready?.roleLabel ? (
            <p className="mt-1 text-xs text-muted-foreground">{ready.roleLabel}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label={t`Sequence date range`}
            value={period}
            onChange={(event) => setPeriod(event.target.value as typeof period)}
          >
            <NativeSelectOption value="all">{t`All time`}</NativeSelectOption>
            <NativeSelectOption value="30">{t`Last 30 days`}</NativeSelectOption>
            <NativeSelectOption value="90">{t`Last 90 days`}</NativeSelectOption>
          </NativeSelect>
          {props.onViewAnalytics ? (
            <Button variant="outline" onClick={() => props.onViewAnalytics?.(props.roleId)}>
              <Trans>View analytics</Trans>
            </Button>
          ) : (
            <Button variant="outline" nativeButton={false} render={<a href={analyticsHref} />}>
              <Trans>View analytics</Trans>
            </Button>
          )}
          {page === "overview" ? (
            <Button
              onClick={() => setNewOpen(true)}
              disabled={
                !roleCampaign.data?.serverId || Boolean(nativeDrafts.data?.unconfirmedDrafts)
              }
            >
              <Plus size={14} aria-hidden />
              <Trans>New sequence</Trans>
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={!live || !roleCampaign.data?.serverId}
                onClick={() => openEditor(live?.id)}
              >
                <Trans>View sequence</Trans>
              </Button>
              {props.onAskChat ? (
                <Button
                  disabled={!live}
                  onClick={() =>
                    props.onAskChat?.(
                      t`Prepare adding contacts to the saved sequence "${live?.name}" in this role. Show the exact recipients and saved emails before any send. If this sequence cannot be identified uniquely, ask me to select it. Do not substitute another sequence.`,
                    )
                  }
                >
                  <Plus size={14} aria-hidden />
                  <Trans>Add contacts</Trans>
                </Button>
              ) : null}
            </>
          )}
        </div>
      </header>
      <CrmGate crm={crm} />
      {nativeDrafts.data?.unconfirmedDrafts ? (
        <p role="alert" className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
          <Trans>
            A draft creation request could not be confirmed. Review the saved sequences before
            starting another copy.
          </Trans>
        </p>
      ) : null}
      {roleCampaign.loading ? <TabLoading /> : null}
      {roleCampaign.failed ||
      (roleCampaign.data?.status === "unavailable" && !roleCampaign.data.selectionRequired) ? (
        <TabNotice alert>
          <Trans>Could not read this sequence. Try refreshing.</Trans>
        </TabNotice>
      ) : null}
      {currentRows.length || nativeDrafts.data?.campaigns?.length ? (
        <label className="flex max-w-sm items-center gap-3 text-xs">
          <span className="shrink-0">
            <Trans>Selected sequence</Trans>
          </span>
          <select
            aria-label={t`Campaign`}
            className="min-w-0 flex-1 rounded-md border bg-background p-2 text-foreground"
            value={selection?.campaignId ?? live?.id ?? ""}
            onChange={(event) => {
              const campaignId = event.target.value;
              const campaignOffset = campaigns.itemOffsets.get(campaignId);
              const native = nativeDrafts.data?.campaigns?.some((row) => row.id === campaignId);
              setChosenCampaign(
                native && draftServerId
                  ? { scope: campaignScope, campaignId, serverId: draftServerId }
                  : campaignId && campaignOffset !== undefined
                    ? { scope: campaignScope, campaignId, campaignOffset }
                    : undefined,
              );
            }}
          >
            <option value="">{t`Select a sequence`}</option>
            {sequenceRows.map((row) => (
              <option
                key={row.id}
                value={row.id}
                disabled={
                  !campaigns.itemOffsets.has(row.id) &&
                  !nativeDrafts.data?.campaigns?.some((item) => item.id === row.id)
                }
              >
                {campaignName(row.name)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {roleCampaign.data?.selectionRequired ? (
        <TabNotice>
          <Trans>Select a sequence to view its metrics and contacts.</Trans>
        </TabNotice>
      ) : null}
      <SequenceOverview
        campaign={campaign}
        replied={campaign?.stats?.replied ?? null}
        period={period}
        detail={page === "detail"}
        onMetric={page === "detail" ? setRunFilter : undefined}
        sendDates={null}
      />
      {page === "overview" ? (
        <section
          aria-label={t`Role campaigns`}
          className="min-w-0 overflow-hidden rounded-xl border bg-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <div className="relative min-w-40 flex-1">
                <Search
                  size={14}
                  aria-hidden
                  className="absolute start-3 top-2.5 text-muted-foreground"
                />
                <Input
                  className="ps-9"
                  name="sequence-search"
                  autoComplete="off"
                  aria-label={t`Search sequences`}
                  placeholder={t`Search sequences…`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead className="border-b bg-muted/20 text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="min-w-60 px-4 py-3 font-medium">
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => setSort("name")}
                    >
                      <Trans>Sequence name</Trans>
                      <ArrowDownWideNarrow size={12} aria-hidden />
                    </button>
                  </th>
                  {[
                    t`Status`,
                    t`Privacy`,
                    t`Total`,
                    t`Active`,
                    t`Opened`,
                    t`Clicked`,
                    t`Replied`,
                    t`Interested`,
                    t`Bounced`,
                    t`Created`,
                  ].map((label) => (
                    <th key={label} scope="col" className="px-3 py-3 text-right font-medium">
                      {label}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-3 text-right font-medium">
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={() => setSort("synced")}
                    >
                      <Trans>Last synced</Trans>
                      <ArrowDownWideNarrow size={12} aria-hidden />
                    </button>
                  </th>
                  <th scope="col" className="w-10 px-3">
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sequenceRows.map((row) => {
                  const observed = live?.id === row.id ? campaign : undefined;
                  const complete = observed?.leadsComplete === true;
                  const leadCount = observed ? observed.leads.length : null;
                  const active = observed?.leads.filter((lead) => lead.status === 1).length ?? null;
                  const interested =
                    observed?.leads.filter(
                      (lead) =>
                        lead.interestStatus !== null && [1, 2, 3, 4].includes(lead.interestStatus),
                    ).length ?? null;
                  const bounced =
                    observed?.leads.filter((lead) => lead.status === -1).length ?? null;
                  const stepCount =
                    observed?.campaign?.observedDetails?.sequences?.[0]?.steps?.length;
                  const shown = (value: number | null, partial = false) =>
                    value === null || (partial && !value)
                      ? "—"
                      : `${partial ? "≥ " : ""}${value.toLocaleString()}`;
                  return (
                    <tr key={row.id} className="border-b last:border-0 hover:bg-muted/20">
                      <th scope="row" className="max-w-72 px-4 py-3 font-normal">
                        <button
                          type="button"
                          className="block max-w-full truncate text-left font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                          title={campaignName(row.name)}
                          disabled={
                            !campaigns.itemOffsets.has(row.id) &&
                            live?.id !== row.id &&
                            !nativeDrafts.data?.campaigns?.some((item) => item.id === row.id)
                          }
                          onClick={() => choose(row.id)}
                        >
                          {campaignName(row.name)}
                        </button>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {stepCount === undefined
                            ? t`Steps not reported`
                            : t`${stepCount} email steps`}
                        </p>
                      </th>
                      <td className="px-3 text-right text-xs">
                        {live?.id === row.id
                          ? (statusLabel(instantly.campaign, live.status) ?? "—")
                          : campaignStatus(row.status)}
                      </td>
                      <td
                        className="px-3 text-right text-xs text-muted-foreground"
                        title={t`Sharing is not reported`}
                      >
                        —
                      </td>
                      <td className="px-3 text-right text-xs tabular-nums">
                        {shown(leadCount, !complete)}
                      </td>
                      <td className="px-3 text-right text-xs tabular-nums">
                        {shown(active, !complete)}
                      </td>
                      <td className="px-3 text-right text-xs tabular-nums">
                        {shown(observed?.stats?.opened ?? null)}
                      </td>
                      <td className="px-3 text-right text-xs">—</td>
                      <td className="px-3 text-right text-xs tabular-nums">
                        {shown(observed?.stats?.replied ?? null)}
                      </td>
                      <td className="px-3 text-right text-xs tabular-nums">
                        {shown(interested, !complete)}
                      </td>
                      <td className="px-3 text-right text-xs tabular-nums">
                        {shown(bounced, !complete)}
                      </td>
                      <td className="px-3 text-right text-xs text-muted-foreground">—</td>
                      <td className="whitespace-nowrap px-3 text-right text-xs text-muted-foreground">
                        {row.syncedAt ? formatDate(row.syncedAt) : "—"}
                      </td>
                      <td className="px-3">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t`Actions for ${campaignName(row.name)}`}
                              />
                            }
                          >
                            <Ellipsis size={14} aria-hidden />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            <DropdownMenuItem
                              disabled={!roleCampaign.data?.serverId}
                              onClick={() => {
                                choose(row.id);
                                openEditor(row.id);
                              }}
                            >
                              <Trans>Edit</Trans>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!draftServerId}
                              onClick={() => startClone(row.id, campaignName(row.name))}
                            >
                              <Trans>Clone</Trans>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!sequenceRows.length && !campaigns.loading ? (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {search
                ? t`No loaded sequences match your search.`
                : t`No saved sequences for this role yet.`}
            </p>
          ) : null}
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t p-3 text-xs text-muted-foreground">
            <span>
              <Trans>Historical totals · — Not reported</Trans>
              {campaigns.hasMore ? (
                <>
                  {" "}
                  · <Trans>Search and sorting cover loaded sequences</Trans>
                </>
              ) : null}
            </span>
            <LoadMore pages={campaigns} />
          </footer>
        </section>
      ) : campaign?.status === "ready" && campaign.campaign ? (
        <>
          <div className="flex items-center gap-1 border-b">
            <Button
              variant={contentTab === "email" ? "secondary" : "ghost"}
              aria-pressed={contentTab === "email"}
              onClick={() => setContentTab("email")}
            >
              <Trans>Email</Trans>
            </Button>
            <Button
              variant={contentTab === "job" ? "secondary" : "ghost"}
              aria-pressed={contentTab === "job"}
              onClick={() => setContentTab("job")}
            >
              <Trans>Job Posting</Trans>
            </Button>
          </div>
          {contentTab === "email" ? (
            <CampaignObservedDetails
              details={campaign.campaign.observedDetails}
              sender={campaign.campaign.eaccount}
              stopOnReply={campaign.campaign.stopOnReply}
              status={campaign.campaign.status}
            />
          ) : (
            <section aria-label={t`Job posting`} className="rounded-xl border p-5">
              <h3 className="text-lg font-semibold">{ready?.roleLabel ?? t`Role brief`}</h3>
              {nativeDrafts.data?.roleBrief?.fields.some((field) => field.value !== null) ? (
                <dl className="mt-4 space-y-4">
                  {nativeDrafts.data.roleBrief.fields
                    .filter((field) => field.value !== null)
                    .map((field) => (
                      <div key={field.key}>
                        <dt className="text-xs text-muted-foreground">
                          {(
                            {
                              location: t`Location`,
                              title: t`Role`,
                              salary_range: t`Salary`,
                              employment_type: t`Employment`,
                              company: t`Company`,
                              responsibilities: t`Responsibilities`,
                              requirements: t`Requirements`,
                            } as Record<string, string>
                          )[field.key] ?? t`Role details`}
                        </dt>
                        <dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">
                          {field.value}
                        </dd>
                        {field.state !== "known" ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {field.state === "conflict" ? t`Conflicting information` : t`Unknown`}
                          </p>
                        ) : null}
                      </div>
                    ))}
                </dl>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">
                  <Trans>No saved job posting details were returned for this role.</Trans>
                </p>
              )}
              {props.onAskChat ? (
                <Button
                  className="mt-4"
                  variant="outline"
                  onClick={() =>
                    props.onAskChat?.(
                      t`Show this role's saved job posting and requirements for review. Do not publish or send it.`,
                    )
                  }
                >
                  <Trans>Review role brief</Trans>
                </Button>
              ) : null}
            </section>
          )}
          <SequenceRuns
            campaign={campaign}
            people={people.data?.items ?? []}
            onResponse={
              campaign.serverId && campaign.campaign
                ? async (email, response) => {
                    const scope = runScope;
                    const result = await executeDraft({
                      operation: "response",
                      roleId: props.roleId,
                      serverId: campaign.serverId!,
                      campaignId: campaign.campaign!.id,
                      email,
                      response,
                    });
                    if (runScopeRef.current !== scope) throw new Error("Sequence changed");
                    if (result.response?.state === "saved") setReload((value) => value + 1);
                    return result.response?.state ?? "pending";
                  }
                : undefined
            }
            filter={runFilter}
            onFilter={setRunFilter}
            onOpenContact={(person) => {
              if (detail)
                detail.open({
                  view: "thread",
                  person,
                  role: {
                    roleId: props.roleId,
                    spaceId: props.spaceId,
                    conversation: props.conversation,
                  },
                });
              else setCandidateId(person.candidateId);
            }}
            onLoadMore={campaign.nextLeadCursor ? () => void loadMoreLeads() : undefined}
            loadingMore={moreLeads?.scope === runScope && moreLeads.loading}
          />
          {moreLeads?.scope === runScope && moreLeads.failed ? (
            <TabNotice alert>
              <Trans>Could not load more sequence contacts. Try again.</Trans>
            </TabNotice>
          ) : null}
        </>
      ) : roleCampaign.loading ? null : (
        <TabNotice>
          <Trans>Select a saved sequence to view its contacts.</Trans>
        </TabNotice>
      )}
      {campaigns.loading || people.loading ? <TabLoading /> : null}
      {campaigns.failed || people.failed ? (
        <TabNotice alert>
          <Trans>Could not load candidate records. Try refreshing.</Trans>
        </TabNotice>
      ) : null}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <Trans>New sequence</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Choose how to prepare a draft for this role. Creating a draft does not add
                recipients or send email.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Button
              className="h-auto w-full justify-start whitespace-normal py-4 text-left"
              variant="outline"
              disabled={!props.onAskChat}
              onClick={() => {
                setNewOpen(false);
                props.onAskChat?.(
                  t`Draft an email sequence from this role's saved brief. Show all steps for review; do not add recipients or send.`,
                );
              }}
            >
              <Sparkles size={18} aria-hidden />
              <span>
                <Trans>Generate from this role</Trans>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {ready?.roleLabel ?? t`Current role`}
                </span>
              </span>
            </Button>
            <Button
              className="h-auto w-full justify-start py-4"
              variant="outline"
              disabled={!roleCampaign.data?.serverId}
              onClick={() => {
                setNewOpen(false);
                openEditor();
              }}
            >
              <FileText size={18} aria-hidden />
              <Trans>Build from scratch</Trans>
            </Button>
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Copy size={16} aria-hidden />
                <Trans>Clone existing sequence</Trans>
              </p>
              <NativeSelect
                aria-label={t`Clone a sequence`}
                value=""
                disabled={!sequenceRows.length || !draftServerId}
                onChange={(event) => {
                  const row = sequenceRows.find((item) => item.id === event.target.value);
                  if (row) startClone(row.id, campaignName(row.name));
                }}
              >
                <NativeSelectOption value="">{t`Choose a saved sequence`}</NativeSelectOption>
                {sequenceRows.map((row) => (
                  <NativeSelectOption key={row.id} value={row.id}>
                    {campaignName(row.name)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(cloneSource)}
        onOpenChange={(open) => {
          if (!open && !cloneBusy) setCloneSource(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Clone sequence</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Copies email steps and settings into a new draft. Contacts and history stay with the
                original sequence.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void clone();
            }}
          >
            <label className="block space-y-1 text-sm">
              <span>
                <Trans>New sequence name</Trans>
              </span>
              <input
                className="w-full rounded-md border bg-background p-2 text-foreground"
                name="clone-name"
                required
                maxLength={200}
                autoComplete="off"
                value={cloneName}
                disabled={cloneBusy}
                onChange={(event) => setCloneName(event.target.value)}
              />
            </label>
            {cloneFailed ? (
              <p role="alert" className="text-sm text-destructive">
                <Trans>
                  Could not verify the cloned draft. Refresh the sequence list before trying again.
                </Trans>
              </p>
            ) : null}
            <Button type="submit" disabled={cloneBusy || !cloneName.trim()}>
              {cloneBusy ? t`Cloning…` : t`Clone draft`}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      {people.data && page === "overview" ? (
        <details className="mt-6 rounded-xl border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            <Trans>Role contact status</Trans>
          </summary>
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
                  {roleLeadCampaigns.length ? (
                    <ul className="flex flex-wrap gap-2 text-xs">
                      {roleLeadCampaigns.map((lead) => (
                        <li key={lead.leadId}>
                          <Badge variant="secondary">
                            {lead.campaign?.name
                              ? campaignName(lead.campaign.name)
                              : t`Campaign not synced`}
                            {lead.campaign ? ` · ${campaignStatus(lead.campaign.status)}` : ""}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {details.data ? (
                    <TabNotice>
                      <Trans>Recruiter messages are unavailable for this role.</Trans>
                    </TabNotice>
                  ) : null}
                </section>
              ) : null}
            </div>
          </section>
        </details>
      ) : null}
    </section>
  );
}
