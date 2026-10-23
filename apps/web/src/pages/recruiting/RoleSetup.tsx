import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingRoleSetup } from "@rakazo/contracts";
import { Badge, Button } from "@rakazo/ui-web";
import { rpc } from "../../lib/rpc";
import type { RecruitingTabProps } from "./shared";
import { tabCacheSlot, useKeyedRead } from "./shared";

type Props = {
  status: RecruitingRoleSetup | undefined;
  /** Sends the agent the exact prompt the backend chose. */
  onAsk: (prompt: string) => void;
  onConnect: (serverId: string) => void;
};

function useItemNames() {
  const { t } = useLingui();
  return {
    campaign: t`Campaign`,
    sender: t`Sender mailbox`,
    crm: t`CRM`,
    leads: t`Leads`,
  } as const;
}

/** A new role's setup gaps, each with its one-click fix; nothing once the role is ready. */
export function RoleSetup({ status, onAsk, onConnect }: Props) {
  const { t } = useLingui();
  const names = useItemNames();
  const stage = status?.playbookStage;
  const setup = status && !status.ready && status.items.length > 0;
  if (!stage && !setup) return null;
  return (
    <section
      aria-label={t`Role setup`}
      className="space-y-2 border-b border-border px-6 py-3 text-sm"
    >
      {stage ? (
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{stage.label}</Badge>
          {stage.nextStep ? (
            <span className="text-muted-foreground">
              <Trans>Next: {stage.nextStep}</Trans>
            </span>
          ) : null}
        </p>
      ) : null}
      {setup ? (
        <ul className="flex flex-wrap gap-x-6 gap-y-2">
          {status.items.map((item) => {
            const action = item.action;
            return (
              <li key={item.key} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{names[item.key]}</span>
                {item.state === "ready" ? (
                  <Badge variant="secondary" className="max-w-56 truncate" title={item.label}>
                    {item.label ?? <Trans>Ready</Trans>}
                  </Badge>
                ) : (
                  <>
                    <Badge variant="outline">
                      {item.state === "missing" ? (
                        <Trans>Missing</Trans>
                      ) : (
                        <Trans>Not connected</Trans>
                      )}
                    </Badge>
                    {action?.kind === "connect" && action.serverId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onConnect(action.serverId!)}
                      >
                        <Trans>Connect</Trans>
                      </Button>
                    ) : action?.prompt ? (
                      <Button size="sm" variant="outline" onClick={() => onAsk(action.prompt!)}>
                        <Trans>Set up</Trans>
                      </Button>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

type Scope = Pick<RecruitingTabProps, "readCache" | "readCacheScope"> & {
  conversation: { groupId: string } | { botId: string };
  refreshSignal?: number;
};

/** The role's live setup status from `recruiting.roleSetup`. */
export function RoleSetupCard({
  conversation,
  refreshSignal,
  onAsk,
  onConnect,
  ...cache
}: Scope & Omit<Props, "status">) {
  const target =
    "groupId" in conversation ? { groupId: conversation.groupId } : { botId: conversation.botId };
  const read = useKeyedRead<RecruitingRoleSetup>(
    JSON.stringify(["roleSetup", target, refreshSignal]),
    () => rpc.recruiting.roleSetup(target),
    tabCacheSlot(cache, ["roleSetup", target]),
  );
  return <RoleSetup status={read.data} onAsk={onAsk} onConnect={onConnect} />;
}
