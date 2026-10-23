import { Trans, useLingui } from "@lingui/react/macro";
import { Badge, Button, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useState } from "react";

/** What `recruiting.roleSetup` returns: whether the role can recruit end to end, and what is missing. */
export type RoleSetupStatus = {
  ready: boolean;
  items: RoleSetupItem[];
};
export type RoleSetupItem = {
  key: "campaign" | "sender" | "crm" | "leads";
  state: "ready" | "missing" | "unavailable";
  label?: string;
  action?: {
    kind: "ask_agent" | "connect" | "bind";
    prompt?: string;
    serverId?: string;
    options?: { orgId: string; roleLabel: string }[];
  };
};

type Props = {
  status: RoleSetupStatus | undefined;
  /** Sends the agent the exact prompt the backend chose. */
  onAsk: (prompt: string) => void;
  onConnect: (serverId: string) => void;
  onBind: (option: { orgId: string; roleLabel: string }) => Promise<void>;
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

function BindAction({
  options,
  onBind,
}: {
  options: { orgId: string; roleLabel: string }[];
  onBind: Props["onBind"];
}) {
  const { t } = useLingui();
  const [choice, setChoice] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const option = options[choice];
  return (
    <span className="flex flex-wrap items-center gap-2">
      {options.length > 1 ? (
        <NativeSelect
          aria-label={t`CRM role`}
          value={String(choice)}
          onChange={(event) => setChoice(Number(event.target.value))}
        >
          {options.map((item, index) => (
            <NativeSelectOption key={`${item.orgId}:${item.roleLabel}`} value={String(index)}>
              {item.roleLabel}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={!option || busy}
        onClick={() => {
          if (!option) return;
          setBusy(true);
          setFailed(false);
          onBind(option)
            .catch(() => setFailed(true))
            .finally(() => setBusy(false));
        }}
      >
        {options.length === 1 ? <Trans>Link {option?.roleLabel}</Trans> : <Trans>Link</Trans>}
      </Button>
      {failed ? (
        <span role="alert" className="text-xs text-destructive">
          <Trans>Could not link. Try again.</Trans>
        </span>
      ) : null}
    </span>
  );
}

/** A new role's setup gaps, each with its one-click fix; nothing once the role is ready. */
export function RoleSetup({ status, onAsk, onConnect, onBind }: Props) {
  const { t } = useLingui();
  const names = useItemNames();
  if (!status || status.ready) return null;
  return (
    <section aria-label={t`Role setup`} className="border-b border-border px-6 py-3 text-sm">
      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        {status.items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{names[item.key]}</span>
            {item.state === "ready" ? (
              <Badge variant="secondary" className="max-w-56 truncate" title={item.label}>
                {item.label ?? <Trans>Ready</Trans>}
              </Badge>
            ) : (
              <>
                <Badge variant="outline">
                  {item.state === "missing" ? <Trans>Missing</Trans> : <Trans>Not connected</Trans>}
                </Badge>
                {item.action?.kind === "ask_agent" && item.action.prompt ? (
                  <Button size="sm" variant="outline" onClick={() => onAsk(item.action!.prompt!)}>
                    <Trans>Set up</Trans>
                  </Button>
                ) : item.action?.kind === "connect" && item.action.serverId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onConnect(item.action!.serverId!)}
                  >
                    <Trans>Connect</Trans>
                  </Button>
                ) : item.action?.kind === "bind" && item.action.options?.length ? (
                  <BindAction options={item.action.options} onBind={onBind} />
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
