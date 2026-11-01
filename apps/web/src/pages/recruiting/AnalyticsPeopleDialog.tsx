import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingAnalyticsPeopleInput,
  RecruitingAnalyticsPeopleOutput,
} from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { profileImageUrl } from "./profileAssets";

export function AnalyticsPeopleDialog({
  input,
  onClose,
  load,
}: {
  input: Omit<RecruitingAnalyticsPeopleInput, "limit" | "cursor">;
  onClose: () => void;
  load?: (input: RecruitingAnalyticsPeopleInput) => Promise<RecruitingAnalyticsPeopleOutput>;
}) {
  const { t } = useLingui();
  const key = JSON.stringify(input);
  const [cursor, setCursor] = useState<{ key: string; value: string }>();
  const [result, setResult] = useState<{ key: string; value: RecruitingAnalyticsPeopleOutput }>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState(0);
  const value = result?.key === key ? result.value : undefined;
  const after = cursor?.key === key ? cursor.value : undefined;
  useEffect(() => {
    let active = true;
    setBusy(true);
    setFailed(false);
    void (load ?? rpc.recruiting.analyticsPeople)({
      ...input,
      limit: 50,
      ...(after ? { cursor: after } : {}),
    })
      .then((next) => {
        if (!active) return;
        setResult((previous) => ({
          key,
          value: {
            ...next,
            items:
              after && previous?.key === key
                ? [
                    ...new Map(
                      [...previous.value.items, ...next.items].map((person) => [
                        person.key,
                        person,
                      ]),
                    ).values(),
                  ]
                : next.items,
          },
        }));
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [key, after, retry, load]);
  const title =
    input.metric === "shortlisted"
      ? t`Shortlisted people`
      : input.metric === "replied"
        ? t`Observed replies`
        : t`Observed contacted people`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Partial saved-history coverage. Replies follow the original observed contact cohort.
          </Trans>
        </p>
        {value ? (
          <p className="text-sm">
            <Trans>{value.total} people</Trans>
          </p>
        ) : null}
        <ul className="divide-y">
          {value?.items.map((person) => (
            <li key={person.key} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm">{person.name ?? t`Unnamed candidate`}</strong>
                {profileImageUrl(person.linkedinUrl) ? (
                  <a
                    className="text-xs underline"
                    href={profileImageUrl(person.linkedinUrl)!}
                    target="_blank"
                    rel="noreferrer"
                  >
                    LinkedIn
                  </a>
                ) : null}
              </div>
              {person.email ? (
                <p className="text-sm text-muted-foreground">{person.email}</p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {person.roles.map((role) => role.title).join(" · ")}
              </p>
              <dl className="mt-2 grid gap-1 text-xs">
                {[
                  [t`Observed first contact`, person.contactedAt],
                  [t`Observed reply`, person.repliedAt],
                  [t`Shortlisted`, person.shortlistedAt],
                ].map(([label, date]) =>
                  date ? (
                    <div key={label} className="flex flex-wrap justify-between gap-2">
                      <dt>{label}</dt>
                      <dd>
                        <time dateTime={date}>
                          {new Date(date).toLocaleString(undefined, { timeZoneName: "short" })}
                        </time>
                      </dd>
                    </div>
                  ) : null,
                )}
              </dl>
            </li>
          ))}
        </ul>
        {!busy && !failed && !value?.items.length ? (
          <p>
            <Trans>No people in this cohort.</Trans>
          </p>
        ) : null}
        {busy ? (
          <p role="status">
            <Trans>Loading people…</Trans>
          </p>
        ) : null}
        {failed ? (
          <div role="alert">
            <Trans>Could not read this cohort.</Trans>
            <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
        {value?.nextCursor ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setCursor({ key, value: value.nextCursor! })}
          >
            <Trans>Load more</Trans>
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
