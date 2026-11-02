import { useLingui } from "@lingui/react/macro";
import type {
  RecruitingAccountViewInput,
  RecruitingAccountViewOutput,
  RecruitingRoleCampaign,
  RecruitingSequenceOutput,
} from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
} from "@rakazo/ui-web";
import { ArrowUpRight, MoreHorizontal, PanelLeftOpen, Plus, Search } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { DeferredPopover } from "../../components/DeferredPopover";
import { retryTransientRead } from "../../lib/read-retry";
import { rpc } from "../../lib/rpc";
import { SequenceOverview, sequenceObservations } from "./SequenceOverview";
import { campaignName } from "./SequenceTab";
import { RecruitingReadCacheContext } from "./shared";

type Role = RecruitingAccountViewOutput["roles"][number];
type Row = { role: Role; campaign: RecruitingRoleCampaign };
const load = (input: RecruitingAccountViewInput, signal: AbortSignal) =>
  rpc.recruiting.accountView(input, { signal });
export function sequenceDestination(role: Role, campaign?: RecruitingRoleCampaign) {
  const params = new URLSearchParams({ view: "sequence" });
  if (campaign?.campaign) {
    params.set("campaign", campaign.campaign.id);
    if (campaign.serverId && campaign.sourceKind !== "crm")
      params.set("campaignServer", campaign.serverId);
  }
  const path = role.groupId
    ? `/app/g/${encodeURIComponent(role.groupId)}`
    : role.botId
      ? `/app/${encodeURIComponent(role.botId)}`
      : "/app";
  if (path === "/app") params.set("role", role.id);
  return `${path}?${params}`;
}
function rowCount(
  row: Row,
  kind:
    | "total"
    | "contacted"
    | "active"
    | "interested"
    | "bounced"
    | "opened"
    | "clicked"
    | "replied",
) {
  const source = row.campaign;
  if (kind !== "clicked" && source.observations) return source.observations[kind];
  if (source.status !== "ready" || !source.campaign) return null;
  if (kind === "contacted") return null;
  if (kind === "opened" || kind === "replied") return source.stats?.[kind] ?? null;
  if (kind === "clicked")
    return source.leadsComplete && source.leads.every((lead) => lead.clickCount != null)
      ? source.leads.filter((lead) => lead.clickCount! > 0).length
      : null;
  if (kind === "active" || kind === "interested") return sequenceObservations(source)[kind];
  const count =
    kind === "total"
      ? source.leads.length
      : source.leads.filter((lead) => lead.status === -1).length;
  return source.leadsComplete ? count : count || null;
}
/** A saved campaign page renders independently of the number of recruiting roles. */
export function AccountSequences({
  accountKey,
  refreshSignal,
  onOpenNavigation,
  read = load,
  initialQuery = "",
}: {
  accountKey: string;
  refreshSignal: number;
  onOpenNavigation: () => void;
  read?: typeof load;
  initialQuery?: string;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const cache = useContext(RecruitingReadCacheContext);
  const [params, setParams] = useSearchParams();
  const role = params.get("role") ?? "all";
  const [data, setData] = useState<{
    key: string;
    accountKey: string;
    roles: Role[];
    rows: Row[];
    nextCursor: string | null;
    total: number;
    summary: RecruitingAccountViewOutput["sequenceSummary"];
    pending: boolean;
    changes: Row[];
  }>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(initialQuery);
  const [search, setSearch] = useState(initialQuery.trim());
  const [contactQuery, setContactQuery] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  useEffect(() => {
    const timeout = setTimeout(() => setContactSearch(contactQuery.trim()), 250);
    return () => clearTimeout(timeout);
  }, [contactQuery]);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
  useEffect(() => {
    const timeout = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timeout);
  }, [query]);
  const [actions, setActions] = useState<string>();
  const [status, setStatus] = useState("all");
  const [newOpen, setNewOpen] = useState(false);
  const [newRole, setNewRole] = useState("");
  const [sort, setSort] = useState<
    | "name"
    | "role"
    | "total"
    | "active"
    | "opened"
    | "replied"
    | "interested"
    | "bounced"
    | "created"
  >("name");
  const [, refreshObservations] = useState(0);
  const scopePrefix = accountKey.endsWith("]") ? `${accountKey.slice(0, -1)},` : undefined;
  useEffect(
    () =>
      cache?.client.getQueryCache().subscribe((event) => {
        const key = event.query.queryKey[1];
        if (
          scopePrefix &&
          typeof key === "string" &&
          key.startsWith(scopePrefix) &&
          key.includes(":sequence-observation:")
        )
          refreshObservations((value) => value + 1);
      }),
    [cache, scopePrefix],
  );
  const observations: {
    key: NonNullable<RecruitingAccountViewInput["sequenceObservations"]>[number];
    value: RecruitingSequenceOutput;
  }[] = [];
  if (cache && scopePrefix)
    for (const query of cache.client.getQueryCache().getAll()) {
      const key = query.queryKey[1];
      if (
        typeof key !== "string" ||
        !key.startsWith(scopePrefix) ||
        !key.includes(":sequence-observation:")
      )
        continue;
      try {
        const [roleId, serverId, campaignId] = JSON.parse(key.split(":sequence-observation:")[1]!);
        const value = query.state.data as RecruitingSequenceOutput | undefined;
        if (
          !value ||
          typeof roleId !== "string" ||
          typeof serverId !== "string" ||
          typeof campaignId !== "string" ||
          value.roleId !== roleId ||
          value.campaign?.id !== campaignId ||
          value.sourceRevision === undefined ||
          !value.observedAt ||
          (role !== "all" && role !== roleId)
        )
          continue;
        observations.push({
          key: {
            roleId,
            serverId,
            campaignId,
            sourceRevision: value.sourceRevision,
            observedAt: value.observedAt,
          },
          value,
        });
      } catch {
        /* An unrelated cache entry is not sequence evidence. */
      }
    }
  observations.sort((a, b) => b.key.observedAt.localeCompare(a.key.observedAt));
  observations.splice(50);
  const filterKey = JSON.stringify([
    accountKey,
    refreshSignal,
    contactSearch,
    search,
    role,
    status,
    sort,
    observations.map((entry) => entry.key),
  ]);
  const [pagination, setPagination] = useState<{ key: string; page: number }>();
  const pageIndex = pagination?.key === filterKey ? pagination.page : 0;
  const key = JSON.stringify([filterKey, pageIndex]);
  const current = data?.key === key ? data : undefined;
  const complete = Boolean(current);
  useEffect(() => {
    const abort = new AbortController();
    setFailed(false);
    void retryTransientRead(async () => {
      const page = await read(
        {
          view: "sequence",
          sequenceSummary: true,
          briefedOnly: true,
          limit: 25,
          ...(pageIndex ? { cursor: String(pageIndex * 25) } : {}),
          ...(role !== "all" ? { roleId: role } : {}),
          ...(search ? { sequenceQuery: search } : {}),
          ...(status !== "all" ? { sequenceStatus: Number(status) } : {}),
          sequenceSort: sort,
          ...(observations.length
            ? { sequenceObservations: observations.map((entry) => entry.key) }
            : {}),
          ...(contactSearch ? { sequenceContactQuery: contactSearch } : {}),
        },
        abort.signal,
      );
      if (abort.signal.aborted) return;
      const rows: Row[] = page.items.flatMap((item) => {
        const role = page.roles.find((role) => role.id === item.roleId);
        return role
          ? (item.campaigns ?? (item.campaign?.campaign ? [item.campaign] : [])).flatMap(
              (campaign) => (campaign.campaign ? [{ role, campaign }] : []),
            )
          : [];
      });
      const pendingKeys = page.sequencePendingObservations ?? [];
      const changes: Row[] = [];
      for (const pending of pendingKeys) {
        const observed = observations.find(
          (entry) =>
            entry.key.roleId === pending.roleId &&
            entry.key.serverId === pending.serverId &&
            entry.key.campaignId === pending.campaignId &&
            entry.key.sourceRevision === pending.sourceRevision &&
            entry.key.observedAt === pending.observedAt,
        )?.value;
        const role = page.roles.find((role) => role.id === pending.roleId);
        if (!observed?.campaign || !role) continue;
        const row: Row = {
          role,
          campaign: {
            status: "ready",
            sourceKind: "native",
            serverId: pending.serverId,
            sourceRevision: pending.sourceRevision,
            campaignObservedAt: pending.observedAt,
            campaign: { ...observed.campaign, stopOnReply: observed.campaign.stopOnReply ?? null },
            leads: [],
            leadsComplete: false,
          },
        };
        changes.push(row);
        const existing = rows.find(
          (item) =>
            item.role.id === role.id &&
            item.campaign.serverId === pending.serverId &&
            item.campaign.campaign?.id === pending.campaignId,
        );
        if (existing)
          existing.campaign = {
            ...existing.campaign,
            campaign: row.campaign.campaign,
            campaignObservedAt: pending.observedAt,
          };
        else if (!contactSearch) rows.push(row);
      }
      const visibleRows = pendingKeys.length
        ? rows.filter(
            (row) =>
              (status === "all" || row.campaign.campaign?.status === Number(status)) &&
              (!search ||
                [row.campaign.campaign!.name, row.role.title].some((value) =>
                  value.toLowerCase().includes(search.toLowerCase()),
                )),
          )
        : rows;
      setData({
        key,
        accountKey,
        roles: page.roles,
        rows: visibleRows,
        pending: pendingKeys.length > 0,
        changes,
        nextCursor: page.nextCursor,
        total: page.total ?? rows.length,
        summary: page.sequenceSummary,
      });
      if (pendingKeys.length) throw new Error("Saved sequence observations are updating");
    }, abort.signal).catch(() => {
      if (!abort.signal.aborted) setFailed(true);
    });
    return () => abort.abort();
  }, [key, read, retry]);
  const filtered = current?.rows ?? [];
  const roles = data?.accountKey === accountKey ? data.roles : [];
  const summary = current?.summary;
  const sentTotal = summary?.sent ?? null;
  const count = (value: number | null, partial = false) =>
    value === null ? "—" : `${partial ? "≥ " : ""}${value.toLocaleString()}`;
  return (
    <main
      className="recruiting-workspace-main rk-scroll min-w-0 flex-1 overflow-y-auto px-4 py-6 md:px-8"
      data-testid="account-sequences"
    >
      <header className="mb-7 flex flex-wrap items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Show navigation`}
          onClick={onOpenNavigation}
        >
          <PanelLeftOpen size={18} aria-hidden />
        </Button>
        <h1 className="flex-1 text-2xl font-semibold">{t`Sequence`}</h1>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to={`/app?${new URLSearchParams({ view: "analytics", role })}`} />}
        >
          {t`View analytics`}
          <ArrowUpRight size={14} aria-hidden />
        </Button>
        <Button onClick={() => setNewOpen(true)}>
          <Plus size={15} aria-hidden />
          {t`New sequence`}
        </Button>
      </header>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t`Overview`}</h2>
        <span className="text-xs text-muted-foreground">{t`All time`}</span>
      </div>
      {current && !current.pending ? (
        <SequenceOverview
          sendContext={sentTotal !== null ? t`Sent (all time): ${sentTotal}` : undefined}
          replied={summary?.replied ?? null}
          overviewCounts={{
            contacted: summary?.contacted ?? null,
            active: summary?.active ?? null,
            opened: summary?.opened ?? null,
            clicked: summary?.clicked ?? null,
            replied: summary?.replied ?? null,
            interested: summary?.interested ?? null,
          }}
          overviewPartial={summary?.partial ?? true}
        />
      ) : null}
      <section className="mt-7 min-w-0" aria-label={t`All sequences`}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-44 flex-1 sm:max-w-72">
            <Search
              aria-hidden
              className="absolute start-3 top-2.5 text-muted-foreground"
              size={15}
            />
            <Input
              className="ps-9"
              name="sequenceQuery"
              autoComplete="off"
              aria-label={t`Search sequences`}
              placeholder={t`Search sequences…`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Input
            className="min-w-40 sm:max-w-56"
            name="sequenceContactQuery"
            autoComplete="off"
            aria-label={t`Filter by saved contact`}
            placeholder={t`Filter by saved contact…`}
            maxLength={200}
            value={contactQuery}
            onChange={(event) => setContactQuery(event.target.value)}
          />
          <NativeSelect
            aria-label={t`Sequence role filter`}
            value={role}
            onChange={(event) =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set("role", event.target.value);
                return next;
              })
            }
          >
            <NativeSelectOption value="all">{t`All roles`}</NativeSelectOption>
            {roles.map((role) => (
              <NativeSelectOption key={role.id} value={role.id}>
                {role.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label={t`Sequence status filter`}
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <NativeSelectOption value="all">{t`All statuses`}</NativeSelectOption>
            <NativeSelectOption value="0">{t`Draft`}</NativeSelectOption>
            <NativeSelectOption value="1">{t`Active`}</NativeSelectOption>
            <NativeSelectOption value="2">{t`Paused`}</NativeSelectOption>
            <NativeSelectOption value="3">{t`Completed`}</NativeSelectOption>
          </NativeSelect>
          <NativeSelect
            aria-label={t`Sort sequences`}
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            <NativeSelectOption value="name">{t`Name`}</NativeSelectOption>
            <NativeSelectOption value="role">{t`Role`}</NativeSelectOption>
            <NativeSelectOption value="total">{t`Total`}</NativeSelectOption>
            <NativeSelectOption value="active">{t`Active`}</NativeSelectOption>
            <NativeSelectOption value="opened">{t`Opened`}</NativeSelectOption>
            <NativeSelectOption value="replied">{t`Replied`}</NativeSelectOption>
            <NativeSelectOption value="interested">{t`Interested`}</NativeSelectOption>
            <NativeSelectOption value="bounced">{t`Bounced`}</NativeSelectOption>
            <NativeSelectOption value="created">{t`Created`}</NativeSelectOption>
          </NativeSelect>
        </div>
        {current?.pending ? (
          <div role="status" className="mb-3 space-y-1 text-sm text-muted-foreground">
            <p>{t`Updating saved sequence records…`}</p>
            {current.changes.map((row) => (
              <Link
                className="block truncate underline"
                key={JSON.stringify([
                  row.role.id,
                  row.campaign.serverId,
                  row.campaign.campaign!.id,
                ])}
                to={sequenceDestination(row.role, row.campaign)}
              >
                {row.campaign.campaign!.name}
              </Link>
            ))}
          </div>
        ) : null}
        {!complete && !failed ? (
          <p
            role="status"
            className="mb-3 text-xs text-muted-foreground"
          >{t`Loading sequences…`}</p>
        ) : null}
        {failed ? (
          <div role="alert" className="mb-3 flex items-center gap-3 text-sm">
            {current?.pending
              ? t`Saved sequence updates are still pending. Retry.`
              : t`Some sequences could not be read. Results are incomplete.`}
            <Button
              variant="outline"
              onClick={() => setRetry((value) => value + 1)}
            >{t`Retry`}</Button>
          </div>
        ) : null}
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[1050px] text-left text-xs">
            <thead className="border-b bg-muted/30 text-muted-foreground">
              <tr>
                {[
                  t`Name`,
                  t`Privacy`,
                  t`Total`,
                  t`Active`,
                  t`Opened`,
                  t`Clicked`,
                  t`Replied`,
                  t`Interested`,
                  t`Bounced`,
                  t`Created`,
                  t`Actions`,
                ].map((label) => (
                  <th key={label} scope="col" className="px-4 py-3 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr
                  key={JSON.stringify([
                    row.role.id,
                    row.campaign.serverId,
                    row.campaign.campaign!.id,
                  ])}
                  className="border-b last:border-0 hover:bg-muted/20"
                >
                  <th scope="row" className="min-w-56 px-4 py-4 font-normal">
                    <Link
                      className="block font-semibold text-foreground hover:underline"
                      to={sequenceDestination(row.role, row.campaign)}
                    >
                      {campaignName(row.campaign.campaign!.name)}
                    </Link>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {row.role.title} ·{" "}
                      {row.campaign.campaign!.status === 0
                        ? t`Draft`
                        : row.campaign.campaign!.status === 1
                          ? t`Active`
                          : row.campaign.campaign!.status === 2
                            ? t`Paused`
                            : row.campaign.campaign!.status === 3
                              ? t`Completed`
                              : t`Status not reported`}
                    </span>
                  </th>
                  <td
                    className="px-4 text-muted-foreground"
                    title={t`Sequence privacy is not reported`}
                  >
                    —
                  </td>
                  {(
                    [
                      "total",
                      "active",
                      "opened",
                      "clicked",
                      "replied",
                      "interested",
                      "bounced",
                    ] as const
                  ).map((kind) => (
                    <td key={kind} className="px-4 tabular-nums">
                      {count(
                        rowCount(row, kind),
                        Boolean(row.campaign.observations) ||
                          (!row.campaign.leadsComplete &&
                            ["total", "active", "interested", "bounced"].includes(kind)),
                      )}
                    </td>
                  ))}
                  <td className="px-4 text-muted-foreground">
                    {row.campaign.campaign!.createdAt
                      ? new Date(row.campaign.campaign!.createdAt).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-4">
                    <DeferredPopover
                      open={
                        actions ===
                        JSON.stringify([
                          row.role.id,
                          row.campaign.serverId,
                          row.campaign.campaign!.id,
                        ])
                      }
                      onOpenChange={(open) =>
                        setActions(
                          open
                            ? JSON.stringify([
                                row.role.id,
                                row.campaign.serverId,
                                row.campaign.campaign!.id,
                              ])
                            : undefined,
                        )
                      }
                      label={t`Actions for ${campaignName(row.campaign.campaign!.name)}`}
                      trigger={<MoreHorizontal size={16} aria-hidden />}
                      triggerProps={{
                        className:
                          "inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent",
                      }}
                      side="bottom"
                      align="end"
                      className="w-44 p-1"
                    >
                      <Link
                        className="block rounded px-3 py-2 hover:bg-accent"
                        to={sequenceDestination(row.role, row.campaign)}
                        onClick={() => setActions(undefined)}
                      >{t`View sequence`}</Link>
                      <Link
                        className="block rounded px-3 py-2 hover:bg-accent"
                        to={`/app?${new URLSearchParams({ view: "analytics", role: row.role.id })}`}
                        onClick={() => setActions(undefined)}
                      >{t`View analytics`}</Link>
                    </DeferredPopover>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {complete && !failed && !current?.pending && !filtered.length ? (
            <p role="status" className="p-10 text-center text-sm text-muted-foreground">
              {contactSearch
                ? t`No matching saved contact memberships.`
                : query || role !== "all" || status !== "all"
                  ? t`No sequences match these filters.`
                  : t`No sequences yet. Create one for a role to get started.`}
            </p>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {current && !current.pending ? t`${current.total} sequences` : null}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              disabled={!pageIndex || !current}
              onClick={() => setPagination({ key: filterKey, page: pageIndex - 1 })}
            >{t`Previous`}</Button>
            <Button
              variant="outline"
              disabled={!current?.nextCursor || current.pending}
              onClick={() => setPagination({ key: filterKey, page: pageIndex + 1 })}
            >{t`Next`}</Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {contactSearch
            ? t`Saved contact membership only; coverage may be incomplete.`
            : t`≥ Saved minimum · — Not reported`}
        </p>
      </section>
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t`New sequence`}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t`Choose the role for this sequence.`}</p>
          <NativeSelect
            aria-label={t`Role for new sequence`}
            value={newRole}
            onChange={(event) => setNewRole(event.target.value)}
          >
            <NativeSelectOption value="">{t`Select a role`}</NativeSelectOption>
            {roles.map((role) => (
              <NativeSelectOption key={role.id} value={role.id}>
                {role.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button
            disabled={!newRole}
            onClick={() => {
              const selected = roles.find((role) => role.id === newRole);
              if (selected) navigate(`${sequenceDestination(selected)}&compose=new`);
            }}
          >{t`Continue`}</Button>
        </DialogContent>
      </Dialog>
    </main>
  );
}
