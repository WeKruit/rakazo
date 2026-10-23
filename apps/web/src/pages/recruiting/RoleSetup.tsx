import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingRoleSetup } from "@rakazo/contracts";
import { Badge } from "@rakazo/ui-web";
import { rpc } from "../../lib/rpc";
import type { RecruitingTabProps } from "./shared";
import { tabCacheSlot, useKeyedRead } from "./shared";

/**
 * Where the role is in the playbook and what comes next. Setup the agent does on its own
 * (outreach, mailbox, records) is never shown; the agent asks in chat when the user must act.
 */
export function RoleSetup({ status }: { status: RecruitingRoleSetup | undefined }) {
  const { t } = useLingui();
  const stage = status?.playbookStage;
  if (!stage) return null;
  return (
    <section aria-label={t`Role stage`} className="border-b border-border px-6 py-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{stage.label}</Badge>
        {stage.nextStep ? (
          <span className="text-muted-foreground">
            <Trans>Next: {stage.nextStep}</Trans>
          </span>
        ) : null}
      </p>
    </section>
  );
}

type Scope = Pick<RecruitingTabProps, "readCache" | "readCacheScope"> & {
  conversation: { groupId: string } | { botId: string };
  refreshSignal?: number;
};

/** The role's live stage from `recruiting.roleSetup`. */
export function RoleSetupCard({ conversation, refreshSignal, ...cache }: Scope) {
  const target =
    "groupId" in conversation ? { groupId: conversation.groupId } : { botId: conversation.botId };
  const read = useKeyedRead<RecruitingRoleSetup>(
    JSON.stringify(["roleSetup", target, refreshSignal]),
    () => rpc.recruiting.roleSetup(target),
    tabCacheSlot(cache, ["roleSetup", target]),
  );
  return <RoleSetup status={read.data} />;
}
