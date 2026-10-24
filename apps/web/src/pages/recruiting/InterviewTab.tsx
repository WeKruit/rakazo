import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCrmDataOutput } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useRecruitingDetail } from "./detail";
import { InterviewCalendar } from "./InterviewCalendar";
import type { SchedulingPlanHandoff } from "./SchedulingPlan";
import { SchedulingPlanHistory } from "./SchedulingPlan";
import type { RecruitingTabProps } from "./shared";
import {
  CrmGate,
  crmRoleKey,
  formatDate,
  LoadMore,
  statusText,
  TabHeader,
  TabLoading,
  TabNotice,
  useCrmData,
  useCrmPages,
  useRoleCrm,
  useSavedCorrespondence,
} from "./shared";

type Tracked = Extract<RecruitingCrmDataOutput, { operation: "important" }>["items"][number];
type Row = Extract<RecruitingCrmDataOutput, { operation: "candidates" }>["items"][number] &
  Partial<Pick<Tracked, "statusChangedAt" | "updatedAt">>;

/** Interview negotiation and booking state for the role as stored in the CRM and calendar reads. */
export function InterviewTab({
  candidateId,
  candidateEmail,
  threadId,
  onReviewSchedulingPlan,
  ...props
}: RecruitingTabProps & {
  /** Shows only this candidate's interview state and calendar events (the detail panel). */
  candidateId?: string;
  candidateEmail?: string | null;
  threadId?: string;
  onReviewSchedulingPlan?: (handoff: SchedulingPlanHandoff) => void;
}) {
  const { t } = useLingui();
  const detail = useRecruitingDetail();
  const crm = useRoleCrm(props);
  const ready = crm.status === "ready" ? crm.target : null;
  // The CRM's own Interview stage for this role; CRMs without the stage filter fall back to the
  // organization-wide interview workflow statuses, matched to this role below.
  const staged = useCrmPages(
    crm,
    "candidates",
    ready ? { crmRoleId: ready.crmRoleId, stage: "Interview" } : null,
    props,
  );
  const fallback = staged.failed;
  const page = (status: "needs_scheduling" | "scheduled" | "awaiting_feedback") =>
    ready && fallback ? { status, limit: 50 } : null;
  const reads = [
    {
      status: t`Needs scheduling`,
      read: useCrmData(crm, "important", page("needs_scheduling"), props),
    },
    { status: t`Scheduled`, read: useCrmData(crm, "important", page("scheduled"), props) },
    {
      status: t`Awaiting feedback`,
      read: useCrmData(crm, "important", page("awaiting_feedback"), props),
    },
  ];
  const calendar = useSavedCorrespondence(props, "interview");
  const roleKey = ready ? crmRoleKey(ready) : null;
  const forRole = (items: readonly Tracked[]) => items.filter((item) => item.roleKey === roleKey);
  const loading = staged.loading || (fallback && reads.some(({ read }) => read.loading));
  const failed = fallback && reads.some(({ read }) => read.failed);
  const loaded = fallback ? reads.every(({ read }) => read.data) : Boolean(staged.data);
  const truncated = fallback && reads.some(({ read }) => read.data?.nextOffset != null);
  const allRows: { status: string; item: Row }[] = fallback
    ? reads.flatMap(({ status, read }) =>
        forRole(read.data?.items ?? []).map((item) => ({ status, item })),
      )
    : (staged.data?.items ?? []).map((item) => ({ status: statusText(item.stage), item }));
  const rows = candidateId
    ? allRows.filter(({ item }) => item.candidateId === candidateId)
    : allRows;
  const email = candidateEmail?.trim().toLowerCase();
  const events = (calendar.data?.status === "ready" ? calendar.data.events : []).filter(
    (event) =>
      !candidateId ||
      Boolean(
        email &&
          event.attendees.some((attendee) => {
            // Calendar attendees are bare addresses or display-name <address> values.
            const address = attendee.trim().match(/^[^<>]*<([^<>]+)>$/)?.[1] ?? attendee;
            return address.trim().toLowerCase() === email;
          }),
      ),
  );
  return (
    <section aria-label={t`Interview`} className="pb-24 lg:pb-0">
      {candidateId ? null : <TabHeader title={<Trans>Interview</Trans>} />}
      {calendar.loading ? <TabLoading /> : null}
      {!props.conversation ? (
        <TabNotice>
          <Trans>Open the role conversation to see saved calendar records.</Trans>
        </TabNotice>
      ) : calendar.failed || calendar.data?.status === "failed" ? (
        <TabNotice alert>
          <Trans>Could not load saved calendar records. Try refreshing.</Trans>
        </TabNotice>
      ) : calendar.data?.status === "unsupported" ? (
        <TabNotice>
          <Trans>Saved calendar records are unavailable from this source.</Trans>
        </TabNotice>
      ) : calendar.data?.status === "not_checked" ? (
        <TabNotice>
          <Trans>Calendar records have not been checked yet.</Trans>
        </TabNotice>
      ) : null}
      {calendar.data?.partial ? (
        <TabNotice>
          <Trans>Some saved records could not be displayed.</Trans>
        </TabNotice>
      ) : null}
      {calendar.data?.connectionChanged ? (
        <TabNotice>
          <Trans>The calendar connection changed. These saved records may be out of date.</Trans>
        </TabNotice>
      ) : null}
      {calendar.data?.connections
        .filter((connection) => connection.status !== "configured" || connection.checkIssue)
        .map((connection, index) => (
          <p key={`${index}:${connection.name}`} className="text-sm text-muted-foreground">
            {connection.name} · {statusText(connection.status)}
            {connection.checkIssue ? ` · ${statusText(connection.checkIssue.status)}` : ""}
          </p>
        ))}
      {!calendar.failed &&
      (calendar.data?.status === "ready" || calendar.data?.status === "empty") ? (
        <div className="space-y-3">
          {candidateId && !events.length ? (
            <p className="text-sm text-muted-foreground">
              <Trans>No saved calendar records matched this candidate.</Trans>
            </p>
          ) : null}
          <InterviewCalendar
            events={events}
            contextLabel={ready ? `${ready.roleLabel} · ${ready.clientLabel}` : undefined}
          />
          {calendar.data.checkedAt ? (
            <p className="text-xs text-muted-foreground">
              <Trans>Calendar last checked</Trans> · {formatDate(calendar.data.checkedAt)}
            </p>
          ) : null}
        </div>
      ) : null}
      {!candidateId && threadId ? (
        <SchedulingPlanHistory
          threadId={threadId}
          roleId={props.roleId}
          refreshSignal={props.refreshSignal}
          onReview={onReviewSchedulingPlan}
        />
      ) : null}
      {!candidateId && !calendar.failed && calendar.data?.operations?.length ? (
        <section aria-label={t`Reply outcomes`} className="mt-6 space-y-2">
          <h3 className="text-sm font-medium">
            <Trans>Reply outcomes</Trans>
          </h3>
          <p className="text-xs text-muted-foreground">
            <Trans>These replies are not linked to a specific calendar event.</Trans>
          </p>
          <ul className="space-y-2">
            {calendar.data.operations.map((operation) => (
              <li key={operation.id} className="text-sm">
                <span>
                  {operation.outcome === "failed" ? (
                    <Trans>Reply failed</Trans>
                  ) : (
                    <Trans>Reply outcome unknown</Trans>
                  )}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  · {operation.sourceName} · {formatDate(operation.checkedAt)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <details aria-label={t`Candidate interview status`} className="mt-6">
        <summary>
          <Trans>Candidate status</Trans>
        </summary>
        <CrmGate crm={crm} />
        {loading ? <TabLoading /> : null}
        {failed ? (
          <TabNotice alert>
            <Trans>Could not load candidate records. Try refreshing.</Trans>
          </TabNotice>
        ) : null}
        {loaded && !rows.length ? (
          <TabNotice>
            <Trans>No interviews in progress for this role.</Trans>
          </TabNotice>
        ) : null}
        {rows.length ? (
          <div className="hire-table-wrap overflow-x-auto">
            <table className="hire-table w-full text-left text-sm">
              <thead>
                <tr>
                  {[t`Candidate`, t`Status`, t`Email`, t`Updated`].map((label) => (
                    <th scope="col" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ status, item }) => (
                  <tr key={item.candidateId}>
                    <th scope="row">
                      {detail && !candidateId ? (
                        <Button
                          variant="link"
                          className="h-auto p-0"
                          onClick={() =>
                            detail.open({
                              view: "interview",
                              person: item,
                              role: {
                                roleId: props.roleId,
                                spaceId: props.spaceId,
                                conversation: props.conversation,
                              },
                            })
                          }
                        >
                          {item.name}
                        </Button>
                      ) : (
                        item.name
                      )}
                      {item.title ? <small className="block">{item.title}</small> : null}
                    </th>
                    <td>{status}</td>
                    <td>{item.email ?? "—"}</td>
                    <td>{formatDate(item.statusChangedAt ?? item.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {fallback ? null : <LoadMore pages={staged} />}
        {truncated ? (
          <p className="mt-2 text-xs text-muted-foreground">
            <Trans>Showing the most recent records.</Trans>
          </p>
        ) : null}
      </details>
    </section>
  );
}
