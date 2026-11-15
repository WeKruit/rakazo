import { useLingui } from "@lingui/react/macro";
import type { RecruitingPlaybookNext, RecruitingRoleSetup } from "@rakazo/contracts";
import { Badge } from "@rakazo/ui-web";
import { rpc } from "../../lib/rpc";
import type { RecruitingTabProps } from "./shared";
import { tabCacheSlot, useKeyedRead } from "./shared";

type Stage = NonNullable<RecruitingRoleSetup["playbookStage"]>["stage"];

/**
 * Where the role is in the playbook and what comes next. Setup the agent does on its own
 * (outreach, mailbox, records) is never shown; the agent asks in chat when the user must act.
 */
export function RoleSetup({ status }: { status: RecruitingRoleSetup | undefined }) {
  const { t } = useLingui();
  const stage = status?.playbookStage;
  if (!stage) return null;
  const labels: Record<Stage, string> = {
    intake: t`Role setup`,
    calibration_10: t`First 10 people`,
    feedback: t`Your feedback`,
    scale: t`Wider search`,
    enrichment: t`Finding emails`,
    outreach: t`Outreach`,
    replies: t`Candidate replies`,
    screening: t`Screening`,
    submission: t`Submission`,
    interview: t`Interview`,
    closed: t`Closed`,
  };
  const nextLabel = ({ step, count = 0 }: RecruitingPlaybookNext) =>
    ({
      questions: t`Questions to confirm: ${count}`,
      brief: t`Complete the role details`,
      find_first_10:
        count < 10 ? t`Finding ${count} more of the first 10` : t`Find the first 10 people`,
      show_first_10: t`Show the first 10 people`,
      review_first_10: t`Review the first 10 people`,
      scale: t`Find more people`,
      enrichment: t`Find contact details`,
      outreach: t`Prepare outreach`,
      replies: t`Handle candidate replies`,
    })[step];
  const next = stage.next ? nextLabel(stage.next) : null;
  return (
    <section aria-label={t`Role stage`} className="hire-pane-header flex items-center px-6 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{labels[stage.stage]}</Badge>
        {next ? <span className="text-muted-foreground">{t`Next: ${next}`}</span> : null}
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
