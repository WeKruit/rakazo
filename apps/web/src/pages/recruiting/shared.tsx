import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingCorrespondence,
  RecruitingCrmDataInput,
  RecruitingCrmDataOutput,
  RecruitingCrmTarget,
} from "@rakazo/contracts";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Shimmer } from "../../components/ai/primitives";
import { rpc } from "../../lib/rpc";

/**
 * Props shared by the role workbench tabs.
 * - `conversation`: the role conversation whose assigned CRM connection authorizes live reads.
 *   Without it, CRM-backed sections render an unavailable state instead of guessing a target.
 * - `refreshSignal`: bump to re-read (e.g. after an agent changed CRM records).
 */
export type RecruitingTabProps = {
  roleId: string;
  spaceId: string;
  conversation?: { groupId: string } | { botId: string };
  refreshSignal?: number;
};

type Read<T> = { key: string; data?: T; failed?: boolean };

/** One keyed async read; stale responses never overwrite a newer key. */
export function useKeyedRead<T>(key: string | null, load: () => Promise<T>) {
  const [read, setRead] = useState<Read<T>>();
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    setRead({ key });
    load()
      .then((data) => {
        if (!cancelled) setRead({ key, data });
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
  return {
    loading: key !== null && !current?.data && !current?.failed,
    failed: Boolean(current?.failed),
    data: current?.data,
  };
}

export type RoleCrm =
  | { status: "loading" | "failed" | "unbound" | "unavailable" }
  | {
      status: "ready";
      target: RecruitingCrmTarget;
      conversation: { groupId: string } | { botId: string };
    };

/** The role's verified CRM binding, read from the role's stored candidate page. */
export function useRoleCrm({
  roleId,
  spaceId,
  conversation,
  refreshSignal = 0,
}: RecruitingTabProps): RoleCrm {
  const read = useKeyedRead(JSON.stringify([spaceId, roleId, refreshSignal]), () =>
    rpc.recruiting.listCandidates({ roleId, limit: 1 }),
  );
  if (read.loading) return { status: "loading" };
  if (read.failed) return { status: "failed" };
  const target = read.data?.crmTarget?.target;
  if (!target) return { status: "unbound" };
  if (!conversation) return { status: "unavailable" };
  return { status: "ready", target, conversation };
}

type CrmOperation = Exclude<RecruitingCrmDataInput["operation"], "memberships">;
type CrmInput<O extends CrmOperation> = Omit<
  Extract<RecruitingCrmDataInput, { operation: O }>,
  "operation" | "serverId" | "serverRevision" | "organizationId"
>;

/** A live CRM read pinned to the role's bound source and organization. */
export function useCrmData<O extends CrmOperation>(
  crm: RoleCrm,
  operation: O,
  input: CrmInput<O> | null,
  scope: { spaceId: string; refreshSignal?: number; reload?: number },
) {
  const request =
    crm.status === "ready" && input
      ? ({
          ...crm.conversation,
          ...input,
          operation,
          serverId: crm.target.mcpServerId,
          serverRevision: crm.target.serverRevision,
          organizationId: crm.target.organizationId,
        } as Extract<RecruitingCrmDataInput, { operation: O }> & typeof crm.conversation)
      : null;
  return useKeyedRead(
    request ? JSON.stringify([scope.spaceId, request, scope.refreshSignal, scope.reload]) : null,
    async () => {
      const value = await rpc.recruiting.crmData(request!);
      if (
        value.operation !== operation ||
        ("source" in value &&
          (value.source.serverId !== request!.serverId ||
            value.source.organizationId !== request!.organizationId))
      )
        throw new Error("CRM scope changed");
      return value as Extract<RecruitingCrmDataOutput, { operation: O }>;
    },
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
      const value = await rpc.recruiting.correspondence({ ...conversation!, view });
      // A conversation bound to a different role must not leak into this role's tab.
      return value.roleId === null || value.roleId === roleId
        ? value
        : { ...value, emails: [], events: [], contacts: [], status: "empty" as const };
    },
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

export function TabLoading() {
  const { t } = useLingui();
  return (
    <p role="status" className="py-6 text-sm">
      <Shimmer>{t`Loading…`}</Shimmer>
    </p>
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
