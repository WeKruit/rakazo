import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { Bookmark } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ListPager } from "../../components/ListPager";
import { readRecruitingPanelState } from "../../lib/right-panel-state";
import { AddToSequenceDialog } from "./AddToSequenceDialog";
import { CandidateDirectory } from "./CandidateDirectory";
import type { RecruitingDetailTarget } from "./detail";
import { pendingDetailTarget, useRecruitingDetail } from "./detail";
import { candidateSections } from "./profile";
import type { useRecruitingWorkspace } from "./useRecruitingWorkspace";
import type { RoleCandidate } from "./useRoleCandidates";

/** One saved pool powers table, cards, board, selection and the native review handoff. */
export function ShortlistDirectory({
  model,
}: {
  model: ReturnType<typeof useRecruitingWorkspace>;
}) {
  const { t } = useLingui();
  const detail = useRecruitingDetail();
  const { candidatePage, workspace, candidateFresh, shortlistPending, shortlistView, onAskChat } =
    model;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [enroll, setEnroll] = useState(false);
  const [review, setReview] = useState<"all" | "selected" | null>(null);
  const scope = JSON.stringify([workspace?.role.id, model.candidateFilters]);
  useEffect(() => {
    setSelected(new Set());
    setReview(null);
  }, [scope]);
  const rows = useMemo(
    () =>
      (candidatePage?.items ?? []).map(
        (candidate): RoleCandidate => ({
          key: candidate.candidateKey,
          name: candidate.name,
          title: candidate.title,
          location: candidate.location,
          linkedinUrl: candidate.linkedinUrl,
          email: candidateSections(candidate.latestSource?.report?.fields).email,
          autumn: candidate,
          crm: null,
        }),
      ),
    [candidatePage?.items],
  );
  function target(index: number): RecruitingDetailTarget | undefined {
    const row = rows[index];
    if (!row?.autumn || !workspace) return undefined;
    const candidate = row.autumn;
    return {
      view: "contact",
      collection: { label: shortlistView ? t`Shortlist` : t`Contacts`, index, total: rows.length },
      crm: false,
      candidate,
      criterionRevision: workspace.revision,
      role: {
        roleId: workspace.role.id,
        spaceId: workspace.role.spaceId,
        conversation: model.groupId
          ? { groupId: model.groupId }
          : model.botId
            ? { botId: model.botId }
            : undefined,
      },
      person: {
        candidateId: candidate.candidateKey,
        roles: [
          {
            id: workspace.role.id,
            title: workspace.role.title,
            shortlisted: candidate.shortlisted,
          },
        ],
        name: candidate.name ?? t`Unnamed candidate`,
        title: candidate.title,
        company: candidate.company,
        location: candidate.location,
        linkedinUrl: candidate.linkedinUrl,
      },
      actions: {
        shortlist: {
          shortlisted: candidate.shortlisted,
          disabled: !candidateFresh || shortlistPending !== null,
          set: (value) => void model.setShortlist(candidate, value),
        },
      },
      walk: (step) => target(index + step),
    };
  }
  useEffect(() => {
    if (!detail?.pending) return;
    for (let index = 0; index < rows.length; index++) {
      const candidate = target(index);
      const restored = candidate && pendingDetailTarget(candidate, detail.pending);
      if (restored) return detail.restore(restored);
    }
  }, [rows, detail?.pending]);
  if (!candidatePage || !workspace) return null;
  const chosen = rows.filter((row) => selected.has(row.key));
  const count = review === "all" ? candidatePage.counts.shortlisted : chosen.length;
  const names = chosen
    .map((row) => [row.name ?? t`Unnamed candidate`, row.linkedinUrl].filter(Boolean).join(" · "))
    .join("\n");
  const ask = (message: string) => onAskChat?.(`${workspace.role.title}\n${message}\n${names}`);
  const exportSelected = () => {
    const csv = [
      [t`Name`, t`Current role`, t`Company`, t`Location`, t`LinkedIn`],
      ...chosen.map((row) => [
        row.name,
        row.title,
        row.autumn?.company,
        row.location,
        row.linkedinUrl,
      ]),
    ]
      .map((line) =>
        line
          .map(
            (value) =>
              `"${(/^[\s]*[=+\-@]/.test(String(value ?? "")) ? `'${value}` : String(value ?? "")).replaceAll('"', '""')}"`,
          )
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "selected-candidates.csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section
      className="min-w-0 space-y-3"
      aria-label={shortlistView ? t`Shortlist` : t`Saved candidates`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm tabular-nums">
          <Trans>{candidatePage.total} candidates</Trans>
        </p>
        {shortlistView ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!onAskChat || !candidatePage.counts.shortlisted || !candidateFresh}
            onClick={() => setReview("all")}
          >
            <Trans>Request review</Trans>
          </Button>
        ) : null}
      </header>
      {chosen.length ? (
        <div
          role="toolbar"
          aria-label={t`Selected candidates`}
          className="sticky top-0 z-30 flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2"
        >
          <span className="text-sm">
            <Trans>{chosen.length} selected</Trans>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!onAskChat || !candidateFresh}
            onClick={() => setEnroll(true)}
          >
            <Trans>Add to sequence</Trans>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!onAskChat || !candidateFresh}
            onClick={() => setReview("selected")}
          >
            <Trans>Request review</Trans>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!onAskChat}
            onClick={() =>
              ask(
                t`Find people similar to these ${chosen.length} selected candidates for this role.`,
              )
            }
          >
            <Trans>Find similar</Trans>
          </Button>
          <Button size="sm" variant="ghost" onClick={exportSelected}>
            <Trans>Export selected</Trans>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!onAskChat}
            onClick={() =>
              ask(
                t`Help me change the status of only these ${chosen.length} selected candidates. Ask which status I want.`,
              )
            }
          >
            <Trans>Change status</Trans>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            <Trans>Clear selection</Trans>
          </Button>
        </div>
      ) : null}
      {!rows.length ? (
        <div className="space-y-3 py-8 text-sm text-muted-foreground">
          <p>
            {shortlistView ? (
              candidatePage.counts.shortlisted === 0 ? (
                <Trans>No shortlisted candidates yet.</Trans>
              ) : (
                <Trans>No shortlisted candidates match these filters.</Trans>
              )
            ) : (
              <Trans>No saved candidates</Trans>
            )}
          </p>
          {shortlistView && model.onBrowseCandidates ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                model.setCandidateFilters(() => readRecruitingPanelState(null).filters);
                model.onBrowseCandidates?.();
              }}
            >
              <Trans>Browse all candidates</Trans>
            </Button>
          ) : null}
        </div>
      ) : null}
      <CandidateDirectory
        rows={rows}
        ownerName={model.ownerName}
        criterionRevision={workspace.revision}
        board={shortlistView}
        selection={{ keys: selected, set: setSelected }}
        selectedKey={model.selection?.candidateKey}
        onOpen={(row, index, trigger) => {
          const next = target(index);
          if (detail && next) detail.open(next);
          else if (row.autumn) model.selectCandidate(row.autumn, trigger as HTMLButtonElement);
        }}
        renderActions={(row) => (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={row.autumn!.shortlisted}
            disabled={!candidateFresh || shortlistPending !== null}
            aria-label={
              row.autumn!.shortlisted
                ? t`Remove ${row.name} from shortlist`
                : t`Add ${row.name} to shortlist`
            }
            onClick={() => void model.setShortlist(row.autumn!, !row.autumn!.shortlisted)}
          >
            <Bookmark
              size={15}
              aria-hidden
              fill={row.autumn!.shortlisted ? "currentColor" : "none"}
            />
          </Button>
        )}
      />
      {model.shortlistFailed ? (
        <p role="alert">
          <Trans>Could not save shortlist</Trans>
        </p>
      ) : null}
      <footer className="sticky bottom-0 z-20 flex min-h-12 items-center justify-between gap-2 border-t bg-background py-2 text-sm">
        <ListPager
          page={model.candidatePageIndex}
          pageCount={Math.ceil(candidatePage.total / 30)}
          onPage={model.goToCandidatePage}
          disabled={model.candidateLoading}
        />
        <span className="tabular-nums text-muted-foreground">
          <Plural value={candidatePage.total} _1="# candidate" other="# candidates" />
        </span>
      </footer>
      <AddToSequenceDialog
        open={enroll}
        onOpenChange={setEnroll}
        roleId={workspace.role.id}
        people={chosen.map((row) => ({
          key: row.key,
          name: row.name ?? t`Unnamed candidate`,
          email: row.email,
          linkedinUrl: row.linkedinUrl,
        }))}
        onContinue={(message) => onAskChat?.(message)}
      />
      <Dialog open={review !== null} onOpenChange={(open) => !open && setReview(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Request review</Trans>
            </DialogTitle>
          </DialogHeader>
          <p className="break-words text-sm">
            {review === "all" ? (
              <Trans>
                Review all {count} shortlisted candidates for {workspace.role.title}?
              </Trans>
            ) : (
              <Trans>
                Review {count} selected candidates for {workspace.role.title}?
              </Trans>
            )}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              disabled={!onAskChat || !candidateFresh || count === 0}
              onClick={() => {
                onAskChat?.(
                  review === "all"
                    ? t`Ask the Reviewer to review all ${count} shortlisted candidates for ${workspace.role.title} using this role's saved criteria and evidence. Save the review results; do not send outreach or change approvals.`
                    : `${workspace.role.title}\n${t`Ask the Reviewer to review only these ${count} selected candidates using this role's saved criteria and evidence. Save the review results; do not send outreach or change approvals.`}\n${names}`,
                );
                setReview(null);
              }}
            >
              <Trans>Continue in chat</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
