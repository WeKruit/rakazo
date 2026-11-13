import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingRoleCampaign } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";

const ACTIVE = 1;
const PAUSED = 2;
const BOUNCED = -1;
const SHOWN = 5;

/**
 * Who the role's sending campaign has emailed and who is still waiting for their first email, with
 * when that goes out. Sending now or resuming goes through the role's chat, whose card confirms it.
 */
export function SendQueue(props: {
  campaign: RecruitingRoleCampaign | undefined;
  onAskChat?: (message: string) => void;
}) {
  const { t } = useLingui();
  const read = props.campaign;
  const campaign = read?.status === "ready" ? read.campaign : null;
  if (!read || !campaign) return null;
  // Only a read that reports contact times can tell waiting from emailed.
  if (read.leads.some((lead) => lead.contactedAt === undefined)) return null;
  const waiting = read.leads.filter((lead) => !lead.contactedAt && lead.status !== BOUNCED);
  const emailed = read.leads.filter((lead) => lead.contactedAt).length;
  const bounced = read.leads.filter((lead) => lead.status === BOUNCED).length;
  const paused = campaign.status === PAUSED;
  if (!waiting.length || (campaign.status !== ACTIVE && !paused)) return null;
  const when = read.queuedFirstEmail;
  const names = waiting.slice(0, SHOWN).map((lead) => lead.name || lead.email);
  const more = waiting.length - names.length;
  return (
    <section
      aria-label={t`Waiting to send`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 text-sm"
    >
      <div className="min-w-0 space-y-1">
        <p className="font-medium">
          {paused
            ? t`Sending is paused · ${waiting.length} not emailed yet`
            : when && when !== "now"
              ? t`${waiting.length} waiting for their first email · goes out ${when}`
              : t`${waiting.length} waiting for their first email`}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {names.join(", ")}
          {more > 0 ? t` and ${more} more` : ""}
          {emailed ? ` · ${t`${emailed} emailed`}` : ""}
          {bounced ? ` · ${t`${bounced} bounced`}` : ""}
        </p>
      </div>
      {props.onAskChat && (paused || (when && when !== "now")) ? (
        <Button
          onClick={() =>
            props.onAskChat?.(
              paused
                ? t`Resume sending this role's emails to everyone not emailed yet.`
                : t`Send the queued emails now.`,
            )
          }
        >
          {paused ? <Trans>Resume sending</Trans> : <Trans>Send now</Trans>}
        </Button>
      ) : null}
    </section>
  );
}
