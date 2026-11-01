import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCrmDataOutput, RecruitingRoleCampaign } from "@rakazo/contracts";
import { Badge, Button, Checkbox, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { Download, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { downloadArtifactBytes } from "../../lib/artifact-open";

type Contact = Extract<RecruitingCrmDataOutput, { operation: "candidates" }>["items"][number];
export type SequenceRunFilter = "all" | "active" | "interested" | "bounced";

/** Campaign membership is observed; per-enrollment step, author and engagement are not reported. */
export function SequenceRuns({
  campaign,
  people,
  filter,
  onFilter,
  onOpenContact,
  onLoadMore,
  loadingMore,
  onResponse,
}: {
  campaign: RecruitingRoleCampaign;
  people: readonly Contact[];
  filter: SequenceRunFilter;
  onFilter: (filter: SequenceRunFilter) => void;
  onOpenContact?: (person: Contact) => void;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  onResponse?: (
    email: string,
    response: "none" | "interested" | "not_interested",
  ) => Promise<"saved" | "pending">;
}) {
  const { t } = useLingui();
  const [responseBusy, setResponseBusy] = useState<string>();
  const [responseNotice, setResponseNotice] = useState<string>();
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const campaignId = campaign.campaign?.id;
  useEffect(() => {
    setQuery("");
    setResponse("all");
    setSelected(new Set());
  }, [campaignId]);
  const byEmail = new Map(
    people.flatMap((person) =>
      person.email ? [[person.email.toLowerCase(), person] as const] : [],
    ),
  );
  const labels: Record<number, string> = {
    1: t`Active`,
    2: t`Paused`,
    3: t`Completed`,
    [-1]: t`Bounced`,
    [-2]: t`Unsubscribed`,
  };
  const responses: Record<number, string> = {
    0: t`Out of office`,
    1: t`Interested`,
    2: t`Meeting booked`,
    3: t`Meeting completed`,
    4: t`Won`,
    [-1]: t`Not interested`,
    [-2]: t`Wrong person`,
    [-3]: t`Lost`,
    [-4]: t`No show`,
  };
  const needle = query.trim().toLowerCase();
  const rows = campaign.leads.filter((lead) => {
    const person = byEmail.get(lead.email.toLowerCase());
    return (
      (!needle ||
        [lead.email, person?.name, lead.name, person?.title, person?.company, lead.company].some(
          (text) => text?.toLowerCase().includes(needle),
        )) &&
      (filter === "all" ||
        (filter === "active" && lead.status === 1) ||
        (filter === "interested" &&
          lead.interestStatus !== null &&
          [1, 2, 3, 4].includes(lead.interestStatus)) ||
        (filter === "bounced" && lead.status === -1)) &&
      (response === "all" || String(lead.interestStatus) === response)
    );
  });
  const allSelected = rows.length > 0 && rows.every((lead) => selected.has(lead.email));
  const someSelected = rows.some((lead) => selected.has(lead.email));
  const exportRows = (emails: ReadonlySet<string>) => {
    const cell = (value: string) =>
      `"${(/^[\s]*[=+@-]/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`;
    const lines = [
      ["Name", "Email", "Status", "Response", "Sequence"],
      ...campaign.leads
        .filter((lead) => emails.has(lead.email))
        .map((lead) => [
          byEmail.get(lead.email.toLowerCase())?.name ?? lead.name ?? "",
          lead.email,
          lead.status === null ? "" : (labels[lead.status] ?? String(lead.status)),
          lead.interestStatus === null
            ? ""
            : (responses[lead.interestStatus] ?? String(lead.interestStatus)),
          campaign.campaign?.name ?? "",
        ]),
    ];
    downloadArtifactBytes(
      "sequence-contacts.csv",
      "text/csv;charset=utf-8",
      new TextEncoder().encode(
        `\uFEFF${lines.map((line) => line.map(cell).join(",")).join("\r\n")}`,
      ),
    );
  };
  return (
    <section
      aria-label={t`Sequence contacts`}
      className="min-w-0 overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative min-w-40 flex-1">
          <Search
            size={14}
            aria-hidden
            className="absolute start-3 top-2.5 text-muted-foreground"
          />
          <Input
            className="ps-9"
            aria-label={t`Search sequence runs`}
            name="sequence-run-search"
            autoComplete="off"
            placeholder={t`Search sequence runs…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <NativeSelect
          aria-label={t`Sequence status filter`}
          value={filter}
          onChange={(event) => onFilter(event.target.value as SequenceRunFilter)}
        >
          <NativeSelectOption value="all">{t`All statuses`}</NativeSelectOption>
          <NativeSelectOption value="active">{t`Active`}</NativeSelectOption>
          <NativeSelectOption value="interested">{t`Interested`}</NativeSelectOption>
          <NativeSelectOption value="bounced">{t`Bounced`}</NativeSelectOption>
        </NativeSelect>
        <NativeSelect
          aria-label={t`Response status filter`}
          value={response}
          onChange={(event) => setResponse(event.target.value)}
        >
          <NativeSelectOption value="all">{t`All responses`}</NativeSelectOption>
          <NativeSelectOption value="1">{t`Interested`}</NativeSelectOption>
          <NativeSelectOption value="-1">{t`Not interested`}</NativeSelectOption>
        </NativeSelect>
        <Button variant="outline" disabled={!selected.size} onClick={() => exportRows(selected)}>
          <Download size={14} aria-hidden />
          <Trans>Export selected</Trans>
        </Button>
      </div>
      {responseNotice ? (
        <p role="status" className="border-b px-4 py-2 text-xs">
          {responseNotice}
        </p>
      ) : null}
      {selected.size ? (
        <div
          className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2 text-xs"
          role="status"
        >
          <span>
            <Trans>{selected.size} selected</Trans>
          </span>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            <Trans>Clear selection</Trans>
          </Button>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="w-10 p-3">
                <Checkbox
                  aria-label={t`Select loaded sequence contacts`}
                  checked={allSelected}
                  indeterminate={!allSelected && someSelected}
                  onCheckedChange={(checked) =>
                    setSelected((value) => {
                      const next = new Set(value);
                      for (const lead of rows)
                        if (checked) next.add(lead.email);
                        else next.delete(lead.email);
                      return next;
                    })
                  }
                />
              </th>
              {[
                t`Full name`,
                t`Step`,
                t`Status`,
                t`Response`,
                t`Engagement`,
                t`Added by`,
                t`Actions`,
              ].map((label) => (
                <th key={label} scope="col" className="px-3 py-3 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((lead) => {
              const person = byEmail.get(lead.email.toLowerCase());
              return (
                <tr key={lead.email} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="p-3">
                    <Checkbox
                      aria-label={t`Select ${person?.name ?? lead.name ?? lead.email}`}
                      checked={selected.has(lead.email)}
                      onCheckedChange={(checked) =>
                        setSelected((value) => {
                          const next = new Set(value);
                          if (checked) next.add(lead.email);
                          else next.delete(lead.email);
                          return next;
                        })
                      }
                    />
                  </td>
                  <th scope="row" className="max-w-64 px-3 py-3 font-normal">
                    <button
                      type="button"
                      disabled={!person || !onOpenContact}
                      onClick={() => person && onOpenContact?.(person)}
                      className="block max-w-full truncate text-left font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:no-underline"
                      title={person?.name ?? lead.name ?? lead.email}
                    >
                      {person?.name ?? lead.name ?? lead.email}
                    </button>
                    <p
                      className="mt-1 truncate text-xs text-muted-foreground"
                      title={[person?.title, person?.company ?? lead.company]
                        .filter(Boolean)
                        .join(" · ")}
                    >
                      {[person?.title, person?.company ?? lead.company]
                        .filter(Boolean)
                        .join(" · ") || lead.email}
                    </p>
                  </th>
                  <td
                    className="px-3 text-xs text-muted-foreground"
                    title={t`Execution progress is not reported`}
                  >
                    —
                  </td>
                  <td className="px-3">
                    <Badge variant="outline">
                      {lead.status === null
                        ? t`Not reported`
                        : (labels[lead.status] ?? t`Unknown status`)}
                    </Badge>
                  </td>
                  <td className="px-3 text-xs">
                    {onResponse ? (
                      <NativeSelect
                        aria-label={t`Response for ${lead.email}`}
                        disabled={Boolean(responseBusy)}
                        value={
                          lead.interestStatus === null
                            ? "none"
                            : lead.interestStatus === 1
                              ? "interested"
                              : lead.interestStatus === -1
                                ? "not_interested"
                                : "observed"
                        }
                        onChange={async (event) => {
                          const value = event.target.value as
                            | "none"
                            | "interested"
                            | "not_interested";
                          setResponseBusy(lead.email);
                          setResponseNotice(undefined);
                          try {
                            const state = await onResponse(lead.email, value);
                            setResponseNotice(
                              state === "saved"
                                ? t`Response saved.`
                                : t`Update pending. Refresh to check.`,
                            );
                          } catch {
                            setResponseNotice(
                              t`Could not confirm the response update. Refresh to check before trying again.`,
                            );
                          } finally {
                            setResponseBusy(undefined);
                          }
                        }}
                      >
                        {lead.interestStatus !== null && ![1, -1].includes(lead.interestStatus) ? (
                          <NativeSelectOption value="observed" disabled>
                            {responses[lead.interestStatus] ?? t`Unknown response`}
                          </NativeSelectOption>
                        ) : null}
                        <NativeSelectOption value="none">{t`Unclassified`}</NativeSelectOption>
                        <NativeSelectOption value="interested">{t`Interested`}</NativeSelectOption>
                        <NativeSelectOption value="not_interested">{t`Not interested`}</NativeSelectOption>
                      </NativeSelect>
                    ) : lead.interestStatus === null ? (
                      t`Unclassified`
                    ) : (
                      (responses[lead.interestStatus] ?? t`Unknown response`)
                    )}
                  </td>
                  <td className="px-3 text-xs text-muted-foreground">
                    {lead.openCount == null &&
                    lead.clickCount == null &&
                    lead.replyCount == null ? (
                      t`Not reported`
                    ) : (
                      <span>
                        {t`Opens`} {lead.openCount ?? "—"} · {t`Clicks`} {lead.clickCount ?? "—"} ·{" "}
                        {t`Replies`} {lead.replyCount ?? "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 text-xs text-muted-foreground">{t`Not reported`}</td>
                  <td className="px-3">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t`Export ${person?.name ?? lead.name ?? lead.email}'s sequence record`}
                      onClick={() => exportRows(new Set([lead.email]))}
                    >
                      <Download size={14} aria-hidden />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!rows.length ? (
        <p role="status" className="p-8 text-center text-sm text-muted-foreground">
          {campaign.leads.length ? (
            <Trans>No contacts match these filters.</Trans>
          ) : (
            <Trans>No contacts were returned for this sequence.</Trans>
          )}
        </p>
      ) : null}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs text-muted-foreground">
        <span>
          {campaign.leadsComplete
            ? t`${campaign.leads.length} sequence contacts`
            : t`${campaign.leads.length} contacts loaded · coverage incomplete`}
        </span>
        {onLoadMore ? (
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? t`Loading…` : t`Load more sequence contacts`}
          </Button>
        ) : null}
      </footer>
      <details className="border-t px-4 py-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          <Trans>Available record details</Trans>
        </summary>
        <p className="mt-2 leading-relaxed">
          <Trans>
            Step progress, enrollment author and re-enrollment are not available here. These rows
            show saved sequence contacts, not a complete execution history.
          </Trans>
        </p>
      </details>
    </section>
  );
}
