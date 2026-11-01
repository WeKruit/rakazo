import { useLingui } from "@lingui/react/macro";
import type {
  RecruitingAccountViewInput,
  RecruitingAccountViewOutput,
  RecruitingRoleCampaign,
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
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { DeferredPopover } from "../../components/DeferredPopover";
import { rpc } from "../../lib/rpc";
import { SequenceOverview, sequenceObservations } from "./SequenceOverview";
import { campaignName } from "./SequenceTab";

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
/** Exhaust server role cursors before describing account totals or a search as complete. */
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
  const [params, setParams] = useSearchParams();
  const role = params.get("role") ?? "all";
  const [data, setData] = useState<{
    key: string;
    roles: Role[];
    rows: Row[];
    complete: boolean;
    unreadable: number;
  }>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(initialQuery);
  const [contactQuery, setContactQuery] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  useEffect(() => {
    const timeout = setTimeout(() => setContactSearch(contactQuery.trim()), 250);
    return () => clearTimeout(timeout);
  }, [contactQuery]);
  useEffect(() => setQuery(initialQuery), [initialQuery]);
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
  const [metricPeriod, setMetricPeriod] = useState<"all" | "30" | "90">("all");
  const key = JSON.stringify([accountKey, refreshSignal, retry, contactSearch]);
  const current = data?.key === key ? data : undefined;
  const complete = current?.complete === true;
  useEffect(() => {
    const abort = new AbortController();
    setFailed(false);
    setData({ key, roles: [], rows: [], complete: false, unreadable: 0 });
    void (async () => {
      let cursor: string | undefined;
      const seen = new Set<string>();
      let roles: Role[] = [];
      let rows: Row[] = [];
      let unreadable = 0;
      do {
        const page = await read(
          {
            view: "sequence",
            sequenceSummary: true,
            briefedOnly: true,
            ...(contactSearch ? { sequenceContactQuery: contactSearch } : {}),
            limit: 5,
            ...(cursor ? { cursor } : {}),
          },
          abort.signal,
        );
        if (abort.signal.aborted) return;
        roles = [...new Map([...roles, ...page.roles].map((role) => [role.id, role])).values()];
        for (const item of page.items) {
          if (
            item.campaign?.status === "unavailable" ||
            item.campaigns?.some((source) => source.status === "unavailable")
          )
            unreadable++;
          const role = roles.find((role) => role.id === item.roleId);
          if (!role) continue;
          for (const campaign of item.campaigns ?? (item.campaign?.campaign ? [item.campaign] : []))
            if (campaign.campaign) rows.push({ role, campaign });
        }
        rows = [
          ...new Map(
            rows.map((row) => [
              JSON.stringify([row.role.id, row.campaign.serverId, row.campaign.campaign!.id]),
              row,
            ]),
          ).values(),
        ];
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error("Repeated sequence page");
        if (cursor) seen.add(cursor);
        setData({ key, roles: [...roles], rows: [...rows], complete: !cursor, unreadable });
      } while (cursor);
    })().catch(() => {
      if (!abort.signal.aborted) setFailed(true);
    });
    return () => abort.abort();
  }, [key, read]);
  const rows = current?.rows ?? [];
  const roles = current?.roles ?? [];
  const selected = rows.filter((row) => role === "all" || row.role.id === role);
  const unique = [
    ...new Map(
      selected.map((row) => [
        JSON.stringify([row.campaign.serverId, row.campaign.campaign!.id]),
        row,
      ]),
    ).values(),
  ];
  const total = (kind: Parameters<typeof rowCount>[1]) => {
    const values = unique.map((row) =>
      !["opened", "replied"].includes(kind) &&
      !row.campaign.leadsComplete &&
      !row.campaign.observations
        ? null
        : rowCount(row, kind),
    );
    return complete &&
      !current?.unreadable &&
      values.length > 0 &&
      values.every((value) => value !== null)
      ? values.reduce<number>((sum, value) => sum + value!, 0)
      : null;
  };
  const active = total("active"),
    interested = total("interested");
  const sourceSends = unique.map((row) => row.campaign.stats?.sent);
  const sentTotal =
    complete && sourceSends.length > 0 && sourceSends.every((value) => value != null)
      ? sourceSends.reduce<number>((sum, value) => sum + value!, 0)
      : null;
  const filtered = selected
    .filter(
      (row) =>
        (!query.trim() ||
          [row.campaign.campaign!.name, row.role.title].some((value) =>
            value.toLowerCase().includes(query.trim().toLowerCase()),
          )) &&
        (status === "all" || String(row.campaign.campaign!.status) === status),
    )
    .sort((a, b) => {
      const tie = () =>
        a.campaign.campaign!.name.localeCompare(b.campaign.campaign!.name) ||
        a.role.id.localeCompare(b.role.id) ||
        String(a.campaign.serverId).localeCompare(String(b.campaign.serverId)) ||
        a.campaign.campaign!.id.localeCompare(b.campaign.campaign!.id);
      if (sort === "role") return a.role.title.localeCompare(b.role.title) || tie();
      if (sort === "name") return tie();
      const value = (row: Row) =>
        sort === "created"
          ? row.campaign.campaign!.createdAt
            ? Date.parse(row.campaign.campaign!.createdAt)
            : null
          : rowCount(row, sort);
      const left = value(a),
        right = value(b);
      return left === null
        ? right === null
          ? tie()
          : 1
        : right === null
          ? -1
          : right - left || tie();
    });
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
          <PanelLeftOpen size={18} />
        </Button>
        <h1 className="flex-1 text-2xl font-semibold">{t`Sequence`}</h1>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to={`/app?${new URLSearchParams({ view: "analytics", role })}`} />}
        >
          {t`View analytics`}
          <ArrowUpRight size={14} />
        </Button>
        <Button onClick={() => setNewOpen(true)}>
          <Plus size={15} />
          {t`New sequence`}
        </Button>
      </header>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t`Overview`}</h2>
        <NativeSelect
          aria-label={t`Sequence date range`}
          value={metricPeriod}
          onChange={(event) => setMetricPeriod(event.target.value as "all" | "30" | "90")}
        >
          <NativeSelectOption value="all">{t`All time`}</NativeSelectOption>
          <NativeSelectOption value="30">{t`Last 30 days`}</NativeSelectOption>
          <NativeSelectOption value="90">{t`Last 90 days`}</NativeSelectOption>
        </NativeSelect>
      </div>
      <SequenceOverview
        sendContext={sentTotal !== null ? t`Sent (all time): ${sentTotal}` : undefined}
        period={metricPeriod}
        replied={total("replied")}
        overviewCounts={{
          contacted: total("contacted"),
          active,
          opened: total("opened"),
          clicked: total("clicked"),
          replied: total("replied"),
          interested,
        }}
        overviewPartial={unique.some((row) => Boolean(row.campaign.observations))}
      />
      <section className="mt-7 min-w-0" aria-label={t`All sequences`}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-44 flex-1 sm:max-w-72">
            <Search className="absolute start-3 top-2.5 text-muted-foreground" size={15} />
            <Input
              className="ps-9"
              aria-label={t`Search sequences`}
              placeholder={t`Search sequences…`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Input
            className="min-w-40 sm:max-w-56"
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
        {!complete && !failed ? (
          <p
            role="status"
            className="mb-3 text-xs text-muted-foreground"
          >{t`Loading sequences…`}</p>
        ) : null}
        {failed || current?.unreadable ? (
          <div role="alert" className="mb-3 flex items-center gap-3 text-sm">
            {current?.unreadable
              ? t`Could not read this campaign. Results are incomplete.`
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
          {complete && !failed && !current?.unreadable && !filtered.length ? (
            <p role="status" className="p-10 text-center text-sm text-muted-foreground">
              {contactSearch
                ? t`No matching saved contact memberships.`
                : query || role !== "all" || status !== "all"
                  ? t`No sequences match these filters.`
                  : t`No sequences yet. Create one for a role to get started.`}
            </p>
          ) : null}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {complete ? t`${filtered.length} sequences` : t`${filtered.length} sequences loaded`} ·{" "}
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
