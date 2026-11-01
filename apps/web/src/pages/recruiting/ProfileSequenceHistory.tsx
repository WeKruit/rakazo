import { Trans, useLingui } from "@lingui/react/macro";
import { hideVendorNames } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { RetryNotice } from "./RetryNotice";
import { statusLabel, useInstantlyStatus } from "./SequenceTab";
import type { RecruitingTabProps } from "./shared";
import { formatDate, useCrmData, useRoleCrm } from "./shared";

/** Saved per-person sequence associations; no enrollment or interest is inferred from a stage. */
export function ProfileSequenceHistory({
  role,
  candidateId,
  name,
  onAvailable,
  onAskChat,
  onReply,
}: {
  role: RecruitingTabProps;
  candidateId: string;
  name: string;
  onAvailable: (candidateId: string) => void;
  onAskChat?: (text: string) => void;
  onReply: () => void;
}) {
  const { t } = useLingui();
  const crm = useRoleCrm(role);
  const labels = useInstantlyStatus();
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState<{ candidateId: string; offset: number }>();
  const offset = page?.candidateId === candidateId ? page.offset : 0;
  const read = useCrmData(
    crm,
    "candidateDetails",
    crm.status === "ready" ? { candidateId, offset } : null,
    { ...role, refreshSignal: (role.refreshSignal ?? 0) + reload },
  );
  const data = read.data?.candidateId === candidateId ? read.data : undefined;
  const campaigns = data?.campaignAssociations;
  const records = [
    ...new Map(
      [
        ...(campaigns?.pipelineCampaign ? [campaigns.pipelineCampaign] : []),
        ...(campaigns?.leadCampaigns.flatMap((row) => (row.campaign ? [row.campaign] : [])) ?? []),
      ].map((record) => [record.id, record]),
    ).values(),
  ];
  useEffect(() => {
    if (records.length) onAvailable(JSON.stringify([role.spaceId, role.roleId, candidateId]));
  }, [candidateId, data]);
  if (!data || !records.length)
    return read.failed ? (
      <RetryNotice onRetry={() => setReload((value) => value + 1)}>
        <Trans>Could not load saved sequences</Trans>
      </RetryNotice>
    ) : null;
  return (
    <section aria-label={t`Saved sequences`} className="space-y-3 border-t py-4">
      <h3 className="font-semibold">
        <Trans>Sequences</Trans>
      </h3>
      <ul className="space-y-2">
        {records.map((record) => (
          <li key={record.id} className="space-y-1 rounded-lg border p-3">
            <p className="break-words font-medium">{hideVendorNames(record.name)}</p>
            {record.status !== null ? (
              <p className="text-xs">{statusLabel(labels.campaign, record.status)}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              <Trans>Last synced</Trans> · {formatDate(record.syncedAt)}
            </p>
            {onAskChat && crm.status === "ready" && record.crmRoleId === crm.target.crmRoleId ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onAskChat(
                    t`Review ${name}'s saved status in sequence ${hideVendorNames(record.name)} for this role. I want to mark this person as replied; verify the exact saved enrollment before changing it.`,
                  )
                }
              >
                <Trans>Mark as replied</Trans>
              </Button>
            ) : null}
            {crm.status === "ready" && record.crmRoleId === crm.target.crmRoleId ? (
              <Button size="sm" variant="ghost" onClick={onReply}>
                <Trans>Reply</Trans>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {campaigns?.nextOffset !== null && campaigns?.nextOffset !== undefined ? (
        <Button
          size="sm"
          variant="outline"
          disabled={read.loading}
          onClick={() => setPage({ candidateId, offset: campaigns.nextOffset! })}
        >
          <Trans>More sequences</Trans>
        </Button>
      ) : null}
      {offset > 0 ? (
        <Button size="sm" variant="ghost" onClick={() => setPage({ candidateId, offset: 0 })}>
          <Trans>First page</Trans>
        </Button>
      ) : null}
    </section>
  );
}
