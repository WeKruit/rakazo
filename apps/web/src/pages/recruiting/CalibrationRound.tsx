import { Trans, useLingui } from "@lingui/react/macro";
import type { RecruitingCalibrationRound } from "@rakazo/contracts";
import { Button, Input, Textarea, Toggle } from "@rakazo/ui-web";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import type { RecruitingTabProps } from "./shared";
import { tabCacheSlot, useKeyedRead } from "./shared";

type Vote = "up" | "down";
type Draft = { votes: Record<string, Vote>; notes: Record<string, string>; direction: string };
const emptyDraft: Draft = { votes: {}, notes: {}, direction: "" };

/**
 * One calibration round: the ten people it showed. Feedback on any of them, or only on the
 * direction, goes out as a single message; accepting the round moves the role on to finding more
 * people. Autumn does the matching, so nothing here scores or ranks anyone.
 */
export function CalibrationRoundView({
  round,
  onSendFeedback,
  onApprove,
}: {
  round: RecruitingCalibrationRound;
  onSendFeedback: (text: string) => Promise<boolean>;
  onApprove: (approvalText: string) => Promise<boolean>;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [pending, setPending] = useState<"feedback" | "approve" | null>(null);
  const [failed, setFailed] = useState(false);
  const [sent, setSent] = useState(false);
  // A new round starts a fresh draft.
  useEffect(() => {
    setDraft(emptyDraft);
    setSent(false);
    setFailed(false);
  }, [round.round]);
  const approved = round.approvedAt !== null;
  const lines = round.candidates.flatMap((candidate) => {
    const vote = draft.votes[candidate.candidateKey];
    const note = draft.notes[candidate.candidateKey]?.trim();
    if (!vote && !note) return [];
    const name = candidate.name ?? candidate.linkedinUrl ?? t`Unnamed candidate`;
    const mark = vote === "up" ? "👍" : vote === "down" ? "👎" : "•";
    return [`${mark} ${name}${note ? `: ${note}` : ""}`];
  });
  const direction = draft.direction.trim();
  const canSend = !approved && pending === null && (lines.length > 0 || direction.length > 0);

  async function run(kind: "feedback" | "approve", action: () => Promise<boolean>) {
    setPending(kind);
    setFailed(false);
    try {
      const ok = await action();
      if (!ok) setFailed(true);
      else if (kind === "feedback") {
        setDraft(emptyDraft);
        setSent(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-label={t`Calibration round`} className="space-y-3 text-sm">
      <h2 className="text-base font-medium">
        <Trans>
          Round {round.round} · {round.candidates.length} people
        </Trans>
      </h2>
      {approved ? (
        <p role="status" className="text-muted-foreground">
          <Trans>Accepted. Finding more people.</Trans>
        </p>
      ) : null}
      <ol className="divide-y divide-border">
        {round.candidates.map((candidate) => {
          const key = candidate.candidateKey;
          const vote = draft.votes[key];
          const name = candidate.name ?? t`Unnamed candidate`;
          const detail = [candidate.title, candidate.company].filter(Boolean).join(" · ");
          const setVote = (next: Vote, pressed: boolean) =>
            setDraft((current) => {
              const votes = { ...current.votes };
              if (pressed) votes[key] = next;
              else delete votes[key];
              return { ...current, votes };
            });
          return (
            <li key={key} className="space-y-2 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {candidate.linkedinUrl ? (
                    <a
                      href={candidate.linkedinUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {name}
                    </a>
                  ) : (
                    <span className="font-medium">{name}</span>
                  )}
                  {detail ? <p className="truncate text-muted-foreground">{detail}</p> : null}
                </div>
                {approved ? null : (
                  <div className="flex shrink-0 gap-1">
                    <Toggle
                      size="sm"
                      aria-label={t`Good example: ${name}`}
                      pressed={vote === "up"}
                      onPressedChange={(pressed) => setVote("up", pressed)}
                    >
                      <ThumbsUp aria-hidden />
                    </Toggle>
                    <Toggle
                      size="sm"
                      aria-label={t`Not a fit: ${name}`}
                      pressed={vote === "down"}
                      onPressedChange={(pressed) => setVote("down", pressed)}
                    >
                      <ThumbsDown aria-hidden />
                    </Toggle>
                  </div>
                )}
              </div>
              {vote ? (
                <Input
                  className="text-base md:text-sm"
                  aria-label={t`Reason: ${name}`}
                  placeholder={t`Reason`}
                  value={draft.notes[key] ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      notes: { ...current.notes, [key]: event.target.value },
                    }))
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {approved ? null : (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSend) return;
            const text = [
              t`Round ${round.round} feedback:`,
              ...lines,
              ...(direction ? [t`Overall: ${direction}`] : []),
            ].join("\n");
            void run("feedback", () => onSendFeedback(text));
          }}
        >
          <Textarea
            className="text-base md:text-sm"
            aria-label={t`Overall direction`}
            placeholder={t`Overall direction`}
            value={draft.direction}
            onChange={(event) =>
              setDraft((current) => ({ ...current, direction: event.target.value }))
            }
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending !== null}
              onClick={() =>
                void run("approve", () =>
                  onApprove(t`Round ${round.round} looks good. Start finding more people.`),
                )
              }
            >
              {pending === "approve" ? (
                <Trans>Sending…</Trans>
              ) : (
                <Trans>Looks good, find more</Trans>
              )}
            </Button>
            <Button type="submit" disabled={!canSend}>
              {pending === "feedback" ? <Trans>Sending…</Trans> : <Trans>Send feedback</Trans>}
            </Button>
          </div>
          {failed ? (
            <p role="alert">
              <Trans>Could not confirm feedback. Try again.</Trans>
            </p>
          ) : sent ? (
            <p role="status" className="text-muted-foreground">
              <Trans>Feedback sent</Trans>
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}

type Scope = Pick<RecruitingTabProps, "readCache" | "readCacheScope"> & {
  conversation: { groupId: string } | { botId: string };
  refreshSignal?: number;
  /** Sends the recruiter's text to the role conversation, like typing it in chat. */
  onSend: (text: string) => Promise<boolean>;
};

/** The role's latest calibration round from `recruiting.calibrationRound`; nothing before one exists. */
export function CalibrationRoundCard({ conversation, refreshSignal, onSend, ...cache }: Scope) {
  const target =
    "groupId" in conversation ? { groupId: conversation.groupId } : { botId: conversation.botId };
  const [approvals, setApprovals] = useState(0);
  const read = useKeyedRead(
    JSON.stringify(["calibrationRound", target, refreshSignal, approvals]),
    () => rpc.recruiting.calibrationRound(target),
    tabCacheSlot(cache, ["calibrationRound", target]),
  );
  const round = read.data?.round;
  if (!round) return null;
  return (
    <CalibrationRoundView
      round={round}
      onSendFeedback={onSend}
      onApprove={async (text) => {
        await rpc.recruiting.approveCalibrationRound({ ...target, round: round.round });
        setApprovals((value) => value + 1);
        return onSend(text);
      }}
    />
  );
}
