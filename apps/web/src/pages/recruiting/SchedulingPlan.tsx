import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingCorrespondenceReference,
  RecruitingSchedulingPlan,
  RecruitingSchedulingPlanInput,
} from "@rakazo/contracts";
import { RecruitingSchedulingPlanInputSchema, SchedulingTimeZoneSchema } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { InterviewCalendar } from "./InterviewCalendar";
import { statusText, useKeyedRead } from "./shared";

export type SchedulingPlanHandoff = {
  plan: RecruitingSchedulingPlan;
  text: string;
};
export type SchedulingCandidate = {
  candidateKey: string;
  name: string;
  email: string;
};

function localTime(start: string, zone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "longOffset",
  }).format(new Date(start));
}

function PlanTimes({ plan }: { plan: RecruitingSchedulingPlanInput }) {
  return (
    <dl className="space-y-2 text-sm">
      <div>
        <dt className="sr-only">
          <Trans>Duration</Trans>
        </dt>
        <dd>
          <Trans>{plan.calendar.lengthInMinutes} minutes</Trans>
        </dd>
      </div>
      <div>
        <dt className="font-medium">
          {plan.candidate.name} · {plan.candidate.email}
        </dt>
        <dd>
          {localTime(plan.calendar.start, plan.candidate.timeZone)} –{" "}
          {localTime(plan.calendar.end, plan.candidate.timeZone)} · {plan.candidate.timeZone}
        </dd>
      </div>
      <div>
        <dt className="font-medium">
          {plan.interviewer.name} · {plan.interviewer.email}
        </dt>
        <dd>
          {localTime(plan.calendar.start, plan.interviewer.timeZone)} –{" "}
          {localTime(plan.calendar.end, plan.interviewer.timeZone)} · {plan.interviewer.timeZone}
        </dd>
      </div>
      {plan.requests?.guests.length ? (
        <div>
          <dt className="font-medium">
            <Trans>Requested guests</Trans>
          </dt>
          <dd className="break-words">{plan.requests.guests.join(", ")}</dd>
        </div>
      ) : null}
      {plan.requests?.notes ? (
        <div>
          <dt className="font-medium">
            <Trans>Notes</Trans>
          </dt>
          <dd className="whitespace-pre-wrap break-words">{plan.requests.notes}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function ReviewPlanButton({
  plan,
  onReview,
}: {
  plan: RecruitingSchedulingPlan;
  onReview?: (handoff: SchedulingPlanHandoff) => void;
}) {
  const { t } = useLingui();
  const uncertain = plan.bookingStatus === "uncertain" || plan.confirmationStatus === "uncertain";
  const pending = plan.bookingStatus === "pending" || plan.confirmationStatus === "pending";
  const instruction = uncertain
    ? t`Check and reconcile the recorded booking and confirmation outcomes. Do not rebook or resend.`
    : pending
      ? t`Review the existing pending approval and recorded attempt. Do not start a fresh booking or send.`
      : plan.confirmationStatus === "completed"
        ? t`Check the existing booking and confirmation records. Do not rebook or resend.`
        : plan.bookingStatus === "completed"
          ? t`Review only the confirmation in the original mailbox thread for the completed booking. Do not create another booking. Sending requires approval.`
          : plan.bookingStatus === "failed" || plan.confirmationStatus === "failed"
            ? t`Review the recorded failure before proposing another action. Do not rebook or resend without a new explicit approval.`
            : t`Recheck current availability and prepare the exact booking for approval. Do not book or send before approval.`;
  return onReview ? (
    <Button
      onClick={() =>
        onReview({
          plan,
          text: t`Review the saved interview plan for ${plan.candidate.name} (${plan.candidate.email}) with ${plan.interviewer.name} (${plan.interviewer.email}). Candidate time: ${localTime(plan.calendar.start, plan.candidate.timeZone)} (${plan.candidate.timeZone}); interviewer time: ${localTime(plan.calendar.start, plan.interviewer.timeZone)} (${plan.interviewer.timeZone}). ${plan.requests?.guests.length ? t`After a verified booking, prepare separate native guest-addition actions for these requested guests: ${plan.requests.guests.join(", ")}. Show their exact scope for approval. Do not add them to the initial booking or email reply recipients.` : ""} ${plan.requests?.notes ? t`Include these notes verbatim in the plain-text confirmation draft: ${plan.requests.notes}` : ""} ${instruction}`,
        })
      }
    >
      {uncertain ? <Trans>Check outcome</Trans> : <Trans>Review in role chat</Trans>}
    </Button>
  ) : null;
}

export function SchedulingPlanHistory({
  threadId,
  roleId,
  refreshSignal,
  onReview,
  snapshot,
}: {
  snapshot?: Awaited<ReturnType<typeof rpc.recruiting.schedulingPlans>>;
  threadId: string;
  roleId: string;
  refreshSignal?: number;
  onReview?: (handoff: SchedulingPlanHandoff) => void;
}) {
  const { t } = useLingui();
  const read = useKeyedRead(
    snapshot ? null : JSON.stringify(["scheduling-plans", threadId, roleId, refreshSignal]),
    () => rpc.recruiting.schedulingPlans({ threadId }),
  );
  const data = snapshot ?? read.data;
  const plans =
    data?.plans.filter((plan) => plan.roleId === roleId && plan.threadId === threadId) ?? [];
  if (!read.failed && !plans.length && !data?.partial) return null;
  return (
    <section aria-label={t`Saved interview plans`} className="mt-6 space-y-3">
      <h3 className="font-medium">
        <Trans>Saved interview plans</Trans>
      </h3>
      {data?.partial ? (
        <p className="text-xs text-muted-foreground">
          <Trans>Only recent saved records are shown. Earlier plans may be missing.</Trans>
        </p>
      ) : null}
      {read.failed ? (
        <p role="alert">
          <Trans>Could not load interview plans.</Trans>
        </p>
      ) : (
        plans.map((plan) => (
          <article className="space-y-3 rounded-lg border p-3" key={plan.id}>
            <p className="text-sm font-medium">
              {plan.roleTitle} · {plan.originalEmail.subject}
            </p>
            <p className="text-xs text-muted-foreground">
              {plan.originalEmail.eaccount ?? t`Mailbox not recorded`}
            </p>
            <PlanTimes plan={plan} />
            <p className="text-xs text-muted-foreground">
              {plan.bookingStatus ? (
                <>
                  <Trans>Booking</Trans> · {statusText(plan.bookingStatus)}
                </>
              ) : (
                <Trans>Saved plan · not an approval</Trans>
              )}
              {plan.confirmationStatus ? (
                <>
                  {" "}
                  ·{" "}
                  {plan.confirmationStatus === "completed" ? (
                    <Trans>Confirmation sent</Trans>
                  ) : (
                    <>
                      <Trans>Confirmation</Trans> · {statusText(plan.confirmationStatus)}
                    </>
                  )}
                </>
              ) : null}
            </p>
            <ReviewPlanButton plan={plan} onReview={onReview} />
          </article>
        ))
      )}
    </section>
  );
}

/** Saves an exact reviewed plan; only the native action approval can authorize booking or mail. */
export function SchedulingPlanForm({
  originalEmail,
  roleRevision,
  candidate: knownCandidate,
  onReview,
  onCheck,
  onProposeTimes,
  onClose,
}: {
  originalEmail: RecruitingCorrespondenceReference;
  roleRevision: number;
  candidate?: SchedulingCandidate;
  onReview?: (handoff: SchedulingPlanHandoff) => void;
  onCheck: (text: string) => void;
  onProposeTimes?: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const formId = useId();
  const [query, setQuery] = useState("");
  const [candidateKey, setCandidateKey] = useState(knownCandidate?.candidateKey ?? "");
  const [candidateZone, setCandidateZone] = useState("");
  const [interviewerZone, setInterviewerZone] = useState("");
  const [interviewerName, setInterviewerName] = useState("");
  const [interviewerEmail, setInterviewerEmail] = useState("");
  const [slotKey, setSlotKey] = useState("");
  const [proposing, setProposing] = useState(false);
  const [proposalKeys, setProposalKeys] = useState<string[]>([]);
  const [guests, setGuests] = useState("");
  const [location, setLocation] = useState("");
  const [locationMode, setLocationMode] = useState("online");
  const [duration, setDuration] = useState("");
  const [minimumNotice, setMinimumNotice] = useState("0");
  const [noticeUnit, setNoticeUnit] = useState("hours");
  const [notes, setNotes] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [timingChanged, setTimingChanged] = useState(false);
  const [saved, setSaved] = useState<RecruitingSchedulingPlan>();
  const alive = useRef(true);
  const saving = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const proof = Boolean(
    (originalEmail.savedRead || originalEmail.crm) &&
      originalEmail.eaccount &&
      originalEmail.providerThreadId,
  );
  const read = useKeyedRead(
    proof ? JSON.stringify(["plan-options", originalEmail, roleRevision]) : null,
    () => rpc.recruiting.schedulingPlans({ threadId: originalEmail.threadId }),
  );
  const candidates = useKeyedRead(
    proof && !knownCandidate
      ? JSON.stringify(["plan-candidates", originalEmail.threadId, originalEmail.roleId, query])
      : null,
    () =>
      rpc.recruiting.roleCandidates({
        threadId: originalEmail.threadId,
        limit: 100,
        ...(query.trim() ? { query: query.trim() } : {}),
      }),
  );
  const choices = (candidates.data?.items ?? []).flatMap((person) =>
    person.autumn && person.name && person.email
      ? [
          {
            candidateKey: person.autumn.candidateKey,
            name: person.name,
            email: person.email,
          },
        ]
      : [],
  );
  const candidate =
    knownCandidate ?? choices.find((person) => person.candidateKey === candidateKey);
  const zonesValid =
    SchedulingTimeZoneSchema.safeParse(candidateZone).success &&
    SchedulingTimeZoneSchema.safeParse(interviewerZone).success;
  const notice = Number(minimumNotice);
  const noticeValid =
    minimumNotice.trim() !== "" &&
    Number.isFinite(notice) &&
    notice >= 0 &&
    Number.isInteger(notice);
  const allSlots = (read.data?.slots ?? []).filter(
    (slot) => Date.parse(slot.start) > Date.now() && Date.parse(slot.end) > Date.parse(slot.start),
  );
  const slots = allSlots.filter(
    (value) =>
      !proposing ||
      ((!duration || value.lengthInMinutes === Number(duration)) &&
        noticeValid &&
        Date.parse(value.start) >=
          Date.now() + notice * (noticeUnit === "hours" ? 3_600_000 : 60_000)),
  );
  const slot = slots.find((value) => JSON.stringify(value) === slotKey);
  const calendar = slot
    ? {
        sourceId: slot.sourceId,
        sourceRevision: slot.sourceRevision,
        eventTypeId: slot.eventTypeId,
        availabilityEffectId: slot.availabilityEffectId,
        start: slot.start,
        end: slot.end,
        lengthInMinutes: slot.lengthInMinutes,
      }
    : undefined;
  const baseInput = {
    threadId: originalEmail.threadId,
    roleId: originalEmail.roleId,
    expectedRoleRevision: roleRevision,
    originalEmail,
    candidate: candidate && { ...candidate, timeZone: candidateZone },
    interviewer: {
      name: interviewerName,
      email: interviewerEmail,
      timeZone: interviewerZone,
    },
    calendar,
  };
  const selection = RecruitingSchedulingPlanInputSchema.safeParse(baseInput);
  const input = RecruitingSchedulingPlanInputSchema.safeParse({
    ...baseInput,
    ...(guests.trim() || notes
      ? {
          requests: {
            guests: guests
              .split(/[,;\n]/)
              .map((value) => value.trim())
              .filter(Boolean),
            notes,
          },
        }
      : {}),
  });
  const proposedSlots = slots.filter((value) => proposalKeys.includes(JSON.stringify(value)));
  const proposalValid =
    candidate &&
    zonesValid &&
    interviewerName.trim() &&
    interviewerEmail.trim() &&
    RecruitingSchedulingPlanInputSchema.shape.interviewer.safeParse({
      name: interviewerName,
      email: interviewerEmail,
      timeZone: interviewerZone,
    }).success &&
    proposedSlots.length > 0;
  const guestAddresses = guests
    .split(/[,;\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const customizationValid =
    RecruitingSchedulingPlanInputSchema.shape.requests.safeParse({ guests: guestAddresses, notes })
      .success &&
    (!proposing ||
      !location.trim() ||
      locationMode === "in_person" ||
      (URL.canParse(location) && ["https:", "http:"].includes(new URL(location).protocol)));
  const dirty = Boolean(
    duration ||
      minimumNotice !== "0" ||
      noticeUnit !== "hours" ||
      locationMode !== "online" ||
      candidateZone ||
      interviewerZone ||
      interviewerName ||
      interviewerEmail ||
      slotKey ||
      proposalKeys.length ||
      guests ||
      location ||
      notes,
  );
  const requestClose = () => {
    if (pending) return;
    if (dirty && !saved) setDiscarding(true);
    else onClose();
  };
  useEffect(() => {
    if (!dirty || saved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saved]);
  const proposalText = proposalValid
    ? [
        t`Draft a proposed-times email for review in the selected original conversation. Read the original conversation first and preserve its exact reply recipients, mailbox, candidate and role. Save the draft through the existing correspondence draft workflow. Do not send, book or create calendar events. These are alternatives for one interview, not confirmed bookings.`,
        t`Candidate: ${candidate.name} · ${candidate.email} · ${candidateZone}`,
        t`Requested interviewer: ${interviewerName} · ${interviewerEmail} · ${interviewerZone}`,
        ...proposedSlots.map(
          (value, index) =>
            `${index + 1}. ${value.start} – ${value.end} (${value.lengthInMinutes} min)\n${localTime(value.start, candidateZone)} – ${localTime(value.end, candidateZone)} · ${candidateZone}\n${localTime(value.start, interviewerZone)} – ${localTime(value.end, interviewerZone)} · ${interviewerZone}`,
        ),
        ...(guests ? [t`Requested guests (do not add to email recipients):\n${guests}`] : []),
        ...(location
          ? [
              t`Requested location (${locationMode === "online" ? "Online" : "In person"}):\n${location}`,
              t`Treat this as a location request in the draft. Verify the selected event type supports it before proposing a booking; do not override its configured location.`,
            ]
          : []),
        ...(notes
          ? [t`Include these notes verbatim in the draft and any later confirmation:\n${notes}`]
          : []),
        t`Recheck availability before booking. Any later booking, guest addition or sending requires review of the exact participants, selected time, location and message.`,
      ].join("\n\n")
    : "";
  function draftProposal() {
    if (
      proposedSlots.some(
        (value) =>
          Date.parse(value.start) <
          Date.now() + notice * (noticeUnit === "hours" ? 3_600_000 : 60_000),
      )
    ) {
      setTimingChanged(true);
      setReviewing(false);
      setCustomizing(false);
      return;
    }
    setTimingChanged(false);
    onProposeTimes?.(proposalText);
    onClose();
  }
  async function save() {
    if (!input.success || !proof || saving.current || read.failed) return;
    saving.current = true;
    setPending(true);
    setFailed(false);
    try {
      const result = await rpc.recruiting.saveSchedulingPlan(input.data);
      if (alive.current) setSaved(result);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      saving.current = false;
      if (alive.current) setPending(false);
    }
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="top-0 right-0 left-auto h-dvh w-full max-w-full translate-x-0 translate-y-0 rounded-none p-0 sm:max-w-[72rem]"
        >
          <section aria-label={t`Interview plan`} className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between gap-3 border-b p-4">
              <DialogTitle>
                <Trans>Schedule interview</Trans>
              </DialogTitle>
              <Button variant="ghost" disabled={pending} onClick={requestClose}>
                <Trans>Close</Trans>
              </Button>
            </div>
            <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]">
              <aside
                aria-label={t`Recorded availability`}
                className="hidden min-h-0 min-w-0 overflow-y-auto overscroll-contain border-r p-4 lg:block"
              >
                {slots.length ? (
                  <InterviewCalendar
                    showActivity={false}
                    timeZone={
                      SchedulingTimeZoneSchema.safeParse(interviewerZone).success
                        ? interviewerZone
                        : "UTC"
                    }
                    initialDate={new Date((slot ?? proposedSlots[0] ?? slots[0])!.start)}
                    events={slots.map((value) => ({
                      id: JSON.stringify(value),
                      kind: "availability",
                      title: t`${value.lengthInMinutes} minutes`,
                      start: value.start,
                      end: value.end,
                      timeZone: interviewerZone || "UTC",
                      attendees: [],
                      status: null,
                      location: null,
                      url: null,
                    }))}
                    highlightedEventIds={proposing ? proposalKeys : [slotKey]}
                    onSelectEvent={
                      reviewing || pending || !zonesValid
                        ? undefined
                        : (event) => {
                            if (proposing)
                              setProposalKeys((keys) =>
                                keys.includes(event.id)
                                  ? keys.filter((key) => key !== event.id)
                                  : [...keys, event.id],
                              );
                            else setSlotKey(event.id);
                          }
                    }
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {allSlots.length ? (
                      <Trans>No recorded times match these filters.</Trans>
                    ) : (
                      <Trans>No recorded availability.</Trans>
                    )}
                  </p>
                )}
              </aside>
              <div className="flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain scroll-pb-20 p-4">
                <p className="text-sm">{originalEmail.subject}</p>
                <p className="text-xs text-muted-foreground">
                  <Trans>Reply mailbox</Trans> · {originalEmail.eaccount ?? t`Not recorded`}
                </p>
                {saved ? (
                  <>
                    <PlanTimes plan={saved} />
                    <p className="text-sm">
                      <Trans>Plan saved. Booking and sending still require approval.</Trans>
                    </p>
                    <ReviewPlanButton
                      plan={saved}
                      onReview={
                        onReview
                          ? (handoff) => {
                              onReview(handoff);
                              onClose();
                            }
                          : undefined
                      }
                    />
                  </>
                ) : !proof ? (
                  <>
                    <p className="text-sm">
                      <Trans>Read the original mailbox conversation before preparing a plan.</Trans>
                    </p>
                    <Button
                      onClick={() =>
                        onCheck(
                          t`Read the selected original email and its actual mailbox conversation for interview planning. Preserve the candidate, mailbox and thread. Do not send or book anything.`,
                        )
                      }
                    >
                      <Trans>Read original conversation</Trans>
                    </Button>
                  </>
                ) : (
                  <>
                    {read.loading ? (
                      <p role="status">
                        <Trans>Loading saved availability…</Trans>
                      </p>
                    ) : null}
                    {read.failed ? (
                      <p role="alert">
                        <Trans>
                          Could not load saved availability. Check the calendar in role chat.
                        </Trans>
                      </p>
                    ) : null}
                    <p className="text-xs font-medium text-muted-foreground">
                      {reviewing ? (
                        <Trans>Review</Trans>
                      ) : customizing ? (
                        <Trans>Step 2 · Customize invite</Trans>
                      ) : (
                        <Trans>Step 1 · Select times</Trans>
                      )}
                    </p>
                    <fieldset disabled={reviewing || pending} className="space-y-3">
                      <div className={customizing || reviewing ? "hidden" : "space-y-3"}>
                        <fieldset
                          className="grid grid-cols-2 gap-2"
                          aria-label={t`Scheduling mode`}
                        >
                          <label
                            className={`flex cursor-pointer items-start justify-between gap-2 rounded-lg border p-3 text-sm ${!proposing ? "border-primary bg-muted" : ""}`}
                          >
                            <span>
                              <strong className="block">
                                <Trans>Single time</Trans>
                              </strong>
                              <span className="text-xs text-muted-foreground">
                                <Trans>Plan one booking</Trans>
                              </span>
                            </span>
                            <input
                              type="radio"
                              name={`${formId}-mode`}
                              checked={!proposing}
                              onChange={() => setProposing(false)}
                              aria-label={t`Single time`}
                            />
                          </label>
                          {onProposeTimes ? (
                            <label
                              className={`flex cursor-pointer items-start justify-between gap-2 rounded-lg border p-3 text-sm ${proposing ? "border-primary bg-muted" : ""}`}
                            >
                              <span>
                                <strong className="block">
                                  <Trans>Multiple options</Trans>
                                </strong>
                                <span className="text-xs text-muted-foreground">
                                  <Trans>Propose times by email</Trans>
                                </span>
                              </span>
                              <input
                                type="radio"
                                name={`${formId}-mode`}
                                checked={proposing}
                                onChange={() => setProposing(true)}
                                aria-label={t`Multiple options`}
                              />
                            </label>
                          ) : null}
                        </fieldset>
                        {knownCandidate ? (
                          <p>
                            {knownCandidate.name} · {knownCandidate.email}
                          </p>
                        ) : (
                          <label className="block text-sm" htmlFor={`${formId}-candidate`}>
                            <Input
                              aria-label={t`Search candidate records`}
                              value={query}
                              onChange={(event) => setQuery(event.target.value)}
                            />
                            <Trans>Candidate record</Trans>
                            <NativeSelect
                              id={`${formId}-candidate`}
                              aria-label={t`Candidate record`}
                              value={candidateKey}
                              onChange={(event) => setCandidateKey(event.target.value)}
                            >
                              <NativeSelectOption value="">{t`Choose a candidate`}</NativeSelectOption>
                              {choices.map((person) => (
                                <NativeSelectOption
                                  key={person.candidateKey}
                                  value={person.candidateKey}
                                >
                                  {person.name} · {person.email}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                            {candidates.data?.nextCursor ? (
                              <span className="text-xs text-muted-foreground">
                                <Trans>Only loaded candidate records are shown.</Trans>
                              </span>
                            ) : null}
                          </label>
                        )}
                        <label className="block text-sm" htmlFor={`${formId}-candidate-zone`}>
                          <Trans>Candidate time zone</Trans>
                          <Input
                            id={`${formId}-candidate-zone`}
                            name="candidate-zone"
                            autoComplete="off"
                            aria-label={t`Candidate time zone`}
                            placeholder="America/New_York"
                            value={candidateZone}
                            onChange={(event) => setCandidateZone(event.target.value)}
                          />
                        </label>
                        <label className="block text-sm" htmlFor={`${formId}-interviewer-name`}>
                          <Trans>Requested interviewer name</Trans>
                          <Input
                            id={`${formId}-interviewer-name`}
                            name="interviewer-name"
                            autoComplete="off"
                            aria-label={t`Requested interviewer name`}
                            value={interviewerName}
                            onChange={(event) => setInterviewerName(event.target.value)}
                          />
                        </label>
                        <label className="block text-sm" htmlFor={`${formId}-interviewer-email`}>
                          <Trans>Requested interviewer email</Trans>
                          <Input
                            type="email"
                            id={`${formId}-interviewer-email`}
                            name="interviewer-email"
                            autoComplete="off"
                            spellCheck={false}
                            aria-label={t`Requested interviewer email`}
                            value={interviewerEmail}
                            onChange={(event) => setInterviewerEmail(event.target.value)}
                          />
                        </label>
                        <label className="block text-sm" htmlFor={`${formId}-interviewer-zone`}>
                          <Trans>Interviewer time zone</Trans>
                          <Input
                            id={`${formId}-interviewer-zone`}
                            name="interviewer-zone"
                            autoComplete="off"
                            aria-label={t`Interviewer time zone`}
                            placeholder="Europe/London"
                            value={interviewerZone}
                            onChange={(event) => setInterviewerZone(event.target.value)}
                          />
                        </label>
                        {!zonesValid && (candidateZone || interviewerZone) ? (
                          <p className="text-xs text-muted-foreground">
                            <Trans>
                              Enter both named IANA timezones, such as America/New_York and
                              Europe/London.
                            </Trans>
                          </p>
                        ) : null}
                        {proposing ? (
                          <div className="space-y-2">
                            <label htmlFor={`${formId}-duration`} className="block text-sm">
                              <Trans>Duration</Trans>
                              <NativeSelect
                                id={`${formId}-duration`}
                                aria-label={t`Duration`}
                                value={duration}
                                onChange={(event) => setDuration(event.target.value)}
                              >
                                <NativeSelectOption value="">{t`All recorded durations`}</NativeSelectOption>
                                {[...new Set(allSlots.map((value) => value.lengthInMinutes))].map(
                                  (value) => (
                                    <NativeSelectOption
                                      key={value}
                                      value={String(value)}
                                    >{t`${value} minutes`}</NativeSelectOption>
                                  ),
                                )}
                              </NativeSelect>
                            </label>
                            <details className="rounded-lg border p-3 text-sm">
                              <summary className="cursor-pointer">
                                <Trans>Advanced</Trans>
                              </summary>
                              <div className="mt-3 space-y-2">
                                <label htmlFor={`${formId}-notice`}>
                                  <Trans>Minimum notice</Trans>
                                </label>
                                <div className="flex gap-2">
                                  <Input
                                    id={`${formId}-notice`}
                                    aria-label={t`Minimum notice`}
                                    type="number"
                                    min={0}
                                    step={1}
                                    value={minimumNotice}
                                    onChange={(event) => setMinimumNotice(event.target.value)}
                                  />
                                  <NativeSelect
                                    aria-label={t`Notice unit`}
                                    value={noticeUnit}
                                    onChange={(event) => setNoticeUnit(event.target.value)}
                                  >
                                    <NativeSelectOption value="hours">{t`Hours`}</NativeSelectOption>
                                    <NativeSelectOption value="minutes">{t`Minutes`}</NativeSelectOption>
                                  </NativeSelect>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  <Trans>
                                    Only recorded slots after this notice are proposed. Availability
                                    is rechecked before booking.
                                  </Trans>
                                </p>
                              </div>
                            </details>
                          </div>
                        ) : null}
                        <fieldset
                          className="space-y-2"
                          aria-label={t`Observed availability intervals`}
                        >
                          <legend className="mb-2 text-sm font-medium">
                            <Trans>Recorded times</Trans>
                          </legend>
                          {slots.map((value) => (
                            <label
                              key={JSON.stringify(value)}
                              className="flex items-start gap-2 rounded-lg border p-3 text-sm"
                            >
                              <input
                                type={proposing ? "checkbox" : "radio"}
                                name={`${formId}-scheduling-slot`}
                                value={JSON.stringify(value)}
                                checked={
                                  proposing
                                    ? proposalKeys.includes(JSON.stringify(value))
                                    : slotKey === JSON.stringify(value)
                                }
                                disabled={!zonesValid}
                                onChange={() => {
                                  const key = JSON.stringify(value);
                                  if (proposing) {
                                    setProposalKeys((keys) =>
                                      keys.includes(key)
                                        ? keys.filter((item) => item !== key)
                                        : [...keys, key],
                                    );
                                  } else setSlotKey(key);
                                }}
                              />
                              <span>
                                {zonesValid ? (
                                  <>
                                    <span className="block">
                                      {localTime(value.start, candidateZone)} –{" "}
                                      {localTime(value.end, candidateZone)} · {candidateZone}
                                    </span>
                                    <span className="block">
                                      {localTime(value.start, interviewerZone)} –{" "}
                                      {localTime(value.end, interviewerZone)} · {interviewerZone}
                                    </span>
                                  </>
                                ) : (
                                  <span>
                                    {value.start} – {value.end}
                                  </span>
                                )}
                                <span className="block text-xs text-muted-foreground">
                                  <Trans>Observed at</Trans> ·{" "}
                                  {new Date(value.observedAt).toLocaleString()}
                                </span>
                              </span>
                            </label>
                          ))}
                        </fieldset>
                      </div>
                      {customizing && !reviewing ? (
                        <>
                          <div className="flex flex-wrap gap-2 text-xs">
                            <span className="rounded-md bg-muted px-2 py-1">
                              {candidate?.name} · {candidate?.email}
                            </span>
                            <span className="rounded-md bg-muted px-2 py-1">
                              {interviewerName} · {interviewerEmail}
                            </span>
                          </div>
                          <label className="block text-sm" htmlFor={`${formId}-guests`}>
                            <Trans>Requested guests</Trans>
                            <Input
                              id={`${formId}-guests`}
                              name="requested-guests"
                              autoComplete="off"
                              aria-label={t`Requested guests`}
                              value={guests}
                              onChange={(event) => setGuests(event.target.value)}
                            />
                          </label>
                          {proposing ? (
                            <div className="space-y-2">
                              <fieldset aria-label={t`Location type`} className="flex gap-2">
                                <Button
                                  size="sm"
                                  variant={locationMode === "online" ? "secondary" : "ghost"}
                                  aria-pressed={locationMode === "online"}
                                  onClick={() => {
                                    setLocationMode("online");
                                    setLocation("");
                                  }}
                                >
                                  <Trans>Online</Trans>
                                </Button>
                                <Button
                                  size="sm"
                                  variant={locationMode === "in_person" ? "secondary" : "ghost"}
                                  aria-pressed={locationMode === "in_person"}
                                  onClick={() => {
                                    setLocationMode("in_person");
                                    setLocation("");
                                  }}
                                >
                                  <Trans>In person</Trans>
                                </Button>
                              </fieldset>
                              <label className="block text-sm" htmlFor={`${formId}-location`}>
                                <Trans>Requested location</Trans>
                                <Input
                                  id={`${formId}-location`}
                                  type={locationMode === "online" ? "url" : "text"}
                                  placeholder={
                                    locationMode === "online"
                                      ? "https://example.test/meeting"
                                      : t`Meeting location`
                                  }
                                  name="requested-location"
                                  autoComplete="off"
                                  aria-label={t`Requested location`}
                                  value={location}
                                  onChange={(event) => setLocation(event.target.value)}
                                />
                              </label>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              <Trans>
                                The selected calendar event type supplies the location. Guest
                                additions require a separate review after booking.
                              </Trans>
                            </p>
                          )}
                          <label className="block text-sm" htmlFor={`${formId}-notes`}>
                            <Trans>Notes for the email</Trans>
                            <Textarea
                              id={`${formId}-notes`}
                              name="proposal-notes"
                              autoComplete="off"
                              aria-label={t`Notes for the email`}
                              value={notes}
                              maxLength={1000}
                              onChange={(event) => setNotes(event.target.value)}
                            />
                          </label>
                          <p className="text-xs text-muted-foreground">{notes.length}/1000</p>
                          {!customizationValid ? (
                            <p role="alert" className="text-xs text-destructive">
                              <Trans>
                                Use unique guest email addresses, a valid meeting link, and notes up
                                to 1000 characters.
                              </Trans>
                            </p>
                          ) : null}
                          <p className="text-xs text-muted-foreground">
                            <Trans>
                              Guests and location are requests in the draft. Email recipients stay
                              unchanged. No time is booked.
                            </Trans>
                          </p>
                        </>
                      ) : null}
                    </fieldset>
                    {read.data?.partial ? (
                      <p className="text-xs text-muted-foreground">
                        <Trans>Only part of the saved availability is available.</Trans>
                      </p>
                    ) : null}
                    {!read.loading && !slots.length ? (
                      <p className="text-sm">
                        {allSlots.length ? (
                          <Trans>No recorded times match these filters.</Trans>
                        ) : (
                          <Trans>
                            No supported future interval is recorded. Check availability before
                            choosing a time.
                          </Trans>
                        )}
                      </p>
                    ) : null}
                    <Button
                      variant="outline"
                      onClick={() =>
                        onCheck(
                          t`Check actual supported calendar availability for the selected candidate and requested interviewer. Keep the existing candidate, mailbox and thread context. Record exact intervals and event type. Do not book or send anything.`,
                        )
                      }
                    >
                      <Trans>Check availability in role chat</Trans>
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      <Trans>
                        These are requested participant timezones, not verified calendar-host
                        identity. Availability is rechecked before booking.
                      </Trans>
                    </p>
                    <div className={!customizing && !reviewing ? "hidden" : ""}>
                      {proposing ? (
                        reviewing && proposalValid ? (
                          <div className="space-y-3 border-t pt-3">
                            <h4 className="font-medium">
                              <Trans>Review proposed times</Trans>
                            </h4>
                            <p className="break-words text-sm">
                              {candidate?.name} · {candidate?.email}
                            </p>
                            <p className="break-words text-sm">
                              {interviewerName} · {interviewerEmail}
                            </p>
                            <ul className="space-y-2 text-sm">
                              {proposedSlots.map((value) => (
                                <li key={JSON.stringify(value)} className="break-words">
                                  <p>
                                    {localTime(value.start, candidateZone)} –{" "}
                                    {localTime(value.end, candidateZone)} · {candidateZone}
                                  </p>
                                  <p>
                                    {localTime(value.start, interviewerZone)} –{" "}
                                    {localTime(value.end, interviewerZone)} · {interviewerZone}
                                  </p>
                                </li>
                              ))}
                            </ul>
                            {guests ? (
                              <p className="whitespace-pre-wrap break-words text-sm">
                                <Trans>Requested guests</Trans> · {guests}
                              </p>
                            ) : null}
                            {location ? (
                              <p className="whitespace-pre-wrap break-words text-sm">
                                <Trans>Requested location</Trans> · {location}
                              </p>
                            ) : null}
                            {notes ? (
                              <p className="whitespace-pre-wrap break-words text-sm">{notes}</p>
                            ) : null}
                            <p className="text-sm">
                              <Trans>Email draft only. No time is booked.</Trans>
                            </p>
                          </div>
                        ) : null
                      ) : reviewing && input.success ? (
                        <div className="space-y-3 border-t pt-3">
                          <h4 className="font-medium">
                            <Trans>Review plan</Trans>
                          </h4>
                          <PlanTimes plan={input.data} />
                          <p className="text-sm">
                            <Trans>Saving this plan does not approve a booking or message.</Trans>
                          </p>
                        </div>
                      ) : null}
                    </div>
                    {timingChanged ? (
                      <p role="alert" className="text-sm text-destructive">
                        <Trans>
                          Some selected times no longer meet minimum notice. Review recorded times.
                        </Trans>
                      </p>
                    ) : null}
                    <footer className="sticky bottom-0 mt-auto flex shrink-0 flex-wrap justify-end gap-2 border-t bg-card pt-3">
                      {!customizing && !reviewing ? (
                        <Button
                          disabled={
                            !(proposing ? proposalValid : selection.success) ||
                            read.failed ||
                            !proof
                          }
                          onClick={() => setCustomizing(true)}
                        >
                          <Trans>Next</Trans>
                        </Button>
                      ) : reviewing ? (
                        <>
                          <Button
                            variant="outline"
                            disabled={pending}
                            onClick={() => setReviewing(false)}
                          >
                            <Trans>Edit</Trans>
                          </Button>
                          {proposing ? (
                            <Button
                              disabled={!proposalValid || !customizationValid}
                              onClick={draftProposal}
                            >
                              <Trans>Draft in role chat</Trans>
                            </Button>
                          ) : (
                            <Button
                              disabled={pending || !input.success}
                              onClick={() => void save()}
                            >
                              {pending ? <Trans>Saving…</Trans> : <Trans>Save plan</Trans>}
                            </Button>
                          )}
                        </>
                      ) : (
                        <>
                          <Button variant="outline" onClick={() => setCustomizing(false)}>
                            <Trans>Back</Trans>
                          </Button>
                          <Button
                            disabled={
                              !(proposing ? proposalValid : input.success) ||
                              !customizationValid ||
                              read.failed ||
                              !proof
                            }
                            onClick={() => setReviewing(true)}
                          >
                            {proposing ? (
                              <Trans>Review proposed times</Trans>
                            ) : (
                              <Trans>Review plan</Trans>
                            )}
                          </Button>
                        </>
                      )}
                    </footer>
                    {failed ? (
                      <p role="alert">
                        <Trans>
                          Could not save this plan. Refresh the original conversation and
                          availability, then try again.
                        </Trans>
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </section>
        </DialogContent>
      </Dialog>
      <AlertDialog open={discarding} onOpenChange={setDiscarding}>
        <AlertDialogContent>
          <AlertDialogTitle>
            <Trans>Exit editing this interview?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>Your unsaved changes will be lost.</Trans>
          </AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel>
              <Trans>Back to edit</Trans>
            </AlertDialogCancel>
            <AlertDialogAction onClick={onClose}>
              <Trans>Exit</Trans>
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
