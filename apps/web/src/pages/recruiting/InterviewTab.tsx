import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCrmDataOutput } from "@rakazo/contracts";
import type { RecruitingTabProps } from "./shared";
import {
  CrmGate,
  crmRoleKey,
  formatDate,
  TabHeader,
  TabLoading,
  TabNotice,
  useCrmData,
  useRoleCrm,
  useSavedCorrespondence,
} from "./shared";

type Tracked = Extract<RecruitingCrmDataOutput, { operation: "important" }>["items"][number];

/** Interview negotiation and booking state for the role as stored in the CRM and calendar reads. */
export function InterviewTab(props: RecruitingTabProps) {
  const { t } = useLingui();
  const crm = useRoleCrm(props);
  const ready = crm.status === "ready" ? crm.target : null;
  // The CRM filters interview workflow statuses organization-wide; rows are matched to this role below.
  const page = (status: "needs_scheduling" | "scheduled" | "awaiting_feedback") =>
    ready ? { status, limit: 50 } : null;
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
  const loading = reads.some(({ read }) => read.loading);
  const failed = reads.some(({ read }) => read.failed);
  const loaded = reads.every(({ read }) => read.data);
  const truncated = reads.some(({ read }) => read.data?.nextOffset != null);
  const rows = reads.flatMap(({ status, read }) =>
    forRole(read.data?.items ?? []).map((item) => ({ status, item })),
  );
  const events = calendar.data?.status === "ready" ? calendar.data.events : [];
  return (
    <section aria-label={t`Interview`}>
      <TabHeader title={<Trans>Interview</Trans>} />
      <CrmGate crm={crm} />
      {loading ? <TabLoading /> : null}
      {failed ? (
        <TabNotice alert>
          <Trans>Could not load CRM records. Try refreshing.</Trans>
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
                    {item.name}
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
      {truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <Trans>Showing the most recent CRM records.</Trans>
        </p>
      ) : null}
      {calendar.loading ? <TabLoading /> : null}
      {events.length ? (
        <section className="mt-6 space-y-3" aria-label={t`Calendar`}>
          <h3 className="text-sm font-semibold">
            <Trans>Calendar</Trans>
          </h3>
          {events.map((event) => (
            <article key={event.id} className="rounded-lg border border-border p-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <strong>
                  {event.kind === "availability"
                    ? t`Available time`
                    : event.title || t`Calendar event`}
                </strong>
                {event.status ? (
                  <span className="text-muted-foreground">{event.status}</span>
                ) : null}
              </div>
              <p>
                <time dateTime={event.start}>{formatDate(event.start)}</time>
                {event.end ? (
                  <>
                    {" – "}
                    <time dateTime={event.end}>{formatDate(event.end)}</time>
                  </>
                ) : null}
                {event.timeZone ? ` · ${event.timeZone}` : ""}
              </p>
              {event.attendees.length ? (
                <p className="mt-1 break-words text-muted-foreground">
                  {event.attendees.join(", ")}
                </p>
              ) : null}
              {event.url ? (
                <a
                  href={event.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block underline"
                >
                  <Trans>Open calendar event</Trans>
                </a>
              ) : null}
            </article>
          ))}
        </section>
      ) : null}
    </section>
  );
}
