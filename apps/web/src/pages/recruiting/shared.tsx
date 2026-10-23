import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingCorrespondence,
  RecruitingCrmDataInput,
  RecruitingCrmDataOutput,
  RecruitingCrmTarget,
} from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Shimmer } from "../../components/ai/primitives";
import type { RecruitingReadCache } from "../../lib/recruiting-read-cache";
import { rememberRecruitingRead } from "../../lib/recruiting-read-cache";
import { rpc } from "../../lib/rpc";

/**
 * Props shared by the role workbench tabs.
 * - `conversation`: the role conversation whose assigned CRM connection authorizes live reads.
 *   Without it, CRM-backed sections render an unavailable state instead of guessing a target.
 * - `refreshSignal`: bump to re-read (e.g. after an agent changed CRM records).
 * - `crmTarget`: the role's CRM binding when the caller already read it (`null` = not bound);
 *   omitted, each tab reads the binding itself.
 * - `readCache`/`readCacheScope`: the Shell's display cache, so revisited tabs render their last
 *   rows at once while fresh reads replace them.
 */
export type RecruitingTabProps = {
  roleId: string;
  spaceId: string;
  conversation?: { groupId: string } | { botId: string };
  refreshSignal?: number;
  crmTarget?: RecruitingCrmTarget | null;
  readCache?: RecruitingReadCache;
  readCacheScope?: string;
};

type Read<T> = { key: string; data?: T; failed?: boolean };
type CacheSlot = { cache?: RecruitingReadCache; key?: string };

/** Display-cache slot for one tab read; empty without a Shell scope. */
export function tabCacheSlot(
  props: Pick<RecruitingTabProps, "readCache" | "readCacheScope">,
  identity: unknown,
): CacheSlot {
  return props.readCacheScope
    ? { cache: props.readCache, key: `${props.readCacheScope}:tab:${JSON.stringify(identity)}` }
    : {};
}

/**
 * One keyed async read; stale responses never overwrite a newer key. With a cache slot, the last
 * data renders at once and the fresh response replaces it; a response issued before the cache
 * was cleared (sign-out, lost access) is discarded.
 */
export function useKeyedRead<T>(key: string | null, load: () => Promise<T>, slot: CacheSlot = {}) {
  const [read, setRead] = useState<Read<T>>();
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const epoch = slot.cache?.epoch;
    setRead({ key });
    load()
      .then((data) => {
        if (cancelled) return;
        if (slot.cache && epoch !== slot.cache.epoch) return setRead({ key, failed: true });
        rememberRecruitingRead(slot.cache, slot.key, data, epoch);
        setRead({ key, data });
      })
      .catch(() => {
        if (!cancelled) setRead({ key, failed: true });
      });
    return () => {
      cancelled = true;
    };
    // `load` is derived from `key`; the key is the read's identity.
  }, [key]);
  const current = key !== null && read?.key === key ? read : undefined;
  const data =
    current?.data ??
    (key !== null && !current?.failed && slot.key
      ? (slot.cache?.entries.get(slot.key) as T | undefined)
      : undefined);
  return {
    loading: key !== null && !data && !current?.failed,
    failed: Boolean(current?.failed),
    data,
  };
}

export type RoleCrm =
  | { status: "loading" | "failed" | "unbound" | "unavailable" }
  | {
      status: "ready";
      target: RecruitingCrmTarget;
      conversation: { groupId: string } | { botId: string };
    };

/**
 * The role's verified CRM binding: the one the caller already holds, otherwise read from the
 * role's stored candidate page.
 */
export function useRoleCrm(props: RecruitingTabProps): RoleCrm {
  const { roleId, spaceId, conversation, refreshSignal = 0, crmTarget } = props;
  const known = crmTarget !== undefined;
  const read = useKeyedRead(known ? null : JSON.stringify([spaceId, roleId, refreshSignal]), () =>
    rpc.recruiting.listCandidates({ roleId, limit: 1 }),
  );
  if (!known && read.loading) return { status: "loading" };
  if (!known && read.failed) return { status: "failed" };
  const target = known ? crmTarget : read.data?.crmTarget?.target;
  if (!target) return { status: "unbound" };
  if (!conversation) return { status: "unavailable" };
  return { status: "ready", target, conversation };
}

type CrmOperation = Exclude<RecruitingCrmDataInput["operation"], "memberships">;
type CrmInput<O extends CrmOperation> = Omit<
  Extract<RecruitingCrmDataInput, { operation: O }>,
  "operation" | "serverId" | "serverRevision" | "organizationId"
>;
type CrmRequest<O extends CrmOperation> = Extract<RecruitingCrmDataInput, { operation: O }> &
  ({ groupId: string } | { botId: string });
type CrmScope = Pick<RecruitingTabProps, "spaceId" | "readCache" | "readCacheScope"> & {
  refreshSignal?: number;
  reload?: number;
};

function crmRequest<O extends CrmOperation>(
  crm: RoleCrm,
  operation: O,
  input: CrmInput<O> | null,
): CrmRequest<O> | null {
  return crm.status === "ready" && input
    ? ({
        ...crm.conversation,
        ...input,
        operation,
        serverId: crm.target.mcpServerId,
        serverRevision: crm.target.serverRevision,
        organizationId: crm.target.organizationId,
      } as CrmRequest<O>)
    : null;
}

async function readCrm<O extends CrmOperation>(pinned: CrmRequest<O>) {
  const request = pinned as CrmRequest<CrmOperation>;
  const value = await rpc.recruiting.crmData(request);
  if (
    value.operation !== request.operation ||
    ("source" in value &&
      (value.source.serverId !== request.serverId ||
        value.source.organizationId !== request.organizationId))
  )
    throw new Error("CRM scope changed");
  return value as Extract<RecruitingCrmDataOutput, { operation: O }>;
}

/** A live CRM read pinned to the role's bound source and organization. */
export function useCrmData<O extends CrmOperation>(
  crm: RoleCrm,
  operation: O,
  input: CrmInput<O> | null,
  scope: CrmScope,
) {
  const request = crmRequest(crm, operation, input);
  return useKeyedRead(
    request ? JSON.stringify([scope.spaceId, request, scope.refreshSignal, scope.reload]) : null,
    () => readCrm(request!),
    request ? tabCacheSlot(scope, ["crm", scope.spaceId, request]) : {},
  );
}

/** First page size of every paged workbench list; more rows load on request. */
export const FIRST_PAGE = 25;
type PagedOperation = "candidates" | "important" | "roleCampaigns" | "roleMail";
type PagedItem = { candidateId: string } | { id: string };
/** A cursor is preferred when the API returns one; older APIs page by offset only. */
type PagedPage = { items: PagedItem[]; nextOffset: number | null; nextCursor?: string | null };
type NextPage = { cursor: string } | { offset: number } | null;
const itemId = (item: PagedItem) => ("id" in item ? item.id : item.candidateId);
const nextPage = (page: PagedPage): NextPage =>
  page.nextCursor
    ? { cursor: page.nextCursor }
    : page.nextOffset !== null
      ? { offset: page.nextOffset }
      : null;

/**
 * A paged CRM list: the first small page renders (from cache when revisited) and `loadMore`
 * appends the next page through the API's cursor, or its limit/offset parameters without one.
 */
export function useCrmPages<O extends PagedOperation>(
  crm: RoleCrm,
  operation: O,
  input: Omit<CrmInput<O>, "limit" | "offset"> | null,
  scope: CrmScope,
) {
  type Page = Extract<RecruitingCrmDataOutput, { operation: O }>;
  const pageInput = input ? ({ ...input, limit: FIRST_PAGE } as CrmInput<O>) : null;
  const first = useCrmData(crm, operation, pageInput, scope);
  const request = crmRequest(crm, operation, pageInput);
  const identity = request
    ? JSON.stringify([scope.spaceId, request, scope.refreshSignal, scope.reload])
    : null;
  const [more, setMore] = useState<{
    identity: string;
    items: PagedItem[];
    next: NextPage;
    loading?: boolean;
    failed?: boolean;
  }>();
  const latest = useRef(identity);
  latest.current = identity;
  const extra = more && more.identity === identity ? more : undefined;
  const firstPage = first.data as PagedPage | undefined;
  const seen = new Set(firstPage?.items.map(itemId));
  const next = extra ? extra.next : firstPage ? nextPage(firstPage) : null;
  const merged = firstPage && {
    ...firstPage,
    items: extra
      ? [...firstPage.items, ...extra.items.filter((item) => !seen.has(itemId(item)))]
      : firstPage.items,
  };
  const loadMore = () => {
    if (!request || !identity || !next || extra?.loading) return;
    const base = { identity, items: extra?.items ?? [], next };
    setMore({ ...base, loading: true });
    readCrm({ ...request, ...next } as CrmRequest<O>)
      .then((value) => {
        if (latest.current !== identity) return;
        const page = value as unknown as PagedPage;
        setMore({ identity, items: [...base.items, ...page.items], next: nextPage(page) });
      })
      .catch(() => {
        if (latest.current === identity) setMore({ ...base, failed: true });
      });
  };
  return {
    ...first,
    data: merged as unknown as Page | undefined,
    hasMore: next !== null,
    loadMore,
    loadingMore: Boolean(extra?.loading),
    moreFailed: Boolean(extra?.failed),
  };
}

/** "Load more" for a paged list; nothing once every row is shown. */
export function LoadMore({
  pages,
}: {
  pages: {
    hasMore: boolean;
    loadMore: () => void;
    loadingMore: boolean;
    moreFailed: boolean;
  };
}) {
  if (!pages.hasMore) return null;
  return (
    <div className="mt-3 space-y-2">
      {pages.moreFailed ? (
        <TabNotice alert>
          <Trans>Could not load CRM records. Try refreshing.</Trans>
        </TabNotice>
      ) : null}
      <Button variant="outline" size="sm" disabled={pages.loadingMore} onClick={pages.loadMore}>
        <Trans>Load more</Trans>
      </Button>
    </div>
  );
}

/** Saved correspondence reads (mailbox, calendar, contact lookups) of the role conversation. */
export function useSavedCorrespondence(
  props: RecruitingTabProps,
  view: "inbox" | "interview" | "contacts",
) {
  const { conversation, spaceId, roleId, refreshSignal } = props;
  return useKeyedRead<RecruitingCorrespondence>(
    conversation ? JSON.stringify([spaceId, roleId, conversation, view, refreshSignal]) : null,
    async () => {
      // ponytail: pass `limit`/`cursor` here once the correspondence read accepts them (emails only).
      const value = await rpc.recruiting.correspondence({ ...conversation!, view });
      // A conversation bound to a different role must not leak into this role's tab.
      return value.roleId === null || value.roleId === roleId
        ? value
        : { ...value, emails: [], events: [], contacts: [], status: "empty" as const };
    },
    tabCacheSlot(props, ["correspondence", spaceId, roleId, conversation, view]),
  );
}

/** Same trim/default semantics as the CRM's role key, used to match tracking rows to the role. */
export function crmRoleKey(target: Pick<RecruitingCrmTarget, "clientLabel" | "roleLabel">) {
  const client = target.clientLabel.replace(/^ +| +$/g, "");
  const role = target.roleLabel.replace(/^ +| +$/g, "");
  return client && role ? `${role} (${client})` : role || client || "No role";
}

/** Stored CRM status strings are snake_case codes; show them as words without reinterpreting. */
export function statusText(value: string | null | undefined) {
  if (!value) return "—";
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "—";
}

export function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}

/** Skeleton rows while a tab's first read is in flight. */
export function TabLoading() {
  const { t } = useLingui();
  return (
    <div role="status" aria-label={t`Loading…`} className="space-y-2 py-4">
      {[0, 1, 2].map((row) => (
        <div key={row} className="h-9 rounded-md bg-muted motion-safe:animate-pulse" />
      ))}
      <p className="text-sm">
        <Shimmer>{t`Loading…`}</Shimmer>
      </p>
    </div>
  );
}

export function TabNotice({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <p
      role={alert ? "alert" : undefined}
      className={`py-6 text-sm ${alert ? "text-destructive" : "text-muted-foreground"}`}
    >
      {children}
    </p>
  );
}

/** The role-level CRM gate every CRM-backed tab shares. */
export function CrmGate({ crm }: { crm: RoleCrm }) {
  if (crm.status === "loading") return <TabLoading />;
  if (crm.status === "failed")
    return (
      <TabNotice alert>
        <Trans>Could not load CRM records. Try refreshing.</Trans>
      </TabNotice>
    );
  if (crm.status === "unavailable")
    return (
      <TabNotice>
        <Trans>Open the role conversation to read its CRM records.</Trans>
      </TabNotice>
    );
  if (crm.status === "unbound")
    return (
      <TabNotice>
        <Trans>This role is not linked to a CRM role yet.</Trans>
      </TabNotice>
    );
  return null;
}

export function TabHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </header>
  );
}
