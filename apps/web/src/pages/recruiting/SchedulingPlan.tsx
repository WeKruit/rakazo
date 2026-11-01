import { Trans, useLingui } from "@lingui/react/macro";
import type {
  RecruitingCorrespondenceReference,
  RecruitingSchedulingPlan,
  RecruitingSchedulingPlanInput,
} from "@rakazo/contracts";
import { RecruitingSchedulingPlanInputSchema, SchedulingTimeZoneSchema } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, Textarea } from "@rakazo/ui-web";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
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
          text: t`Review the saved interview plan for ${plan.candidate.name} (${plan.candidate.email}) with ${plan.interviewer.name} (${plan.interviewer.email}). Candidate time: ${localTime(plan.calendar.start, plan.candidate.timeZone)} (${plan.candidate.timeZone}); interviewer time: ${localTime(plan.calendar.start, plan.interviewer.timeZone)} (${plan.interviewer.timeZone}). ${instruction}`,
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
  const [notes, setNotes] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
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
  const slots = (read.data?.slots ?? []).filter(
    (slot) => Date.parse(slot.start) > Date.now() && Date.parse(slot.end) > Date.parse(slot.start),
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
  const input = RecruitingSchedulingPlanInputSchema.safeParse({
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
              t`Requested location:\n${location}`,
              t`Treat this as a location request in the draft. Verify the selected event type supports it before proposing a booking; do not override its configured location.`,
            ]
          : []),
        ...(notes
          ? [t`Include these notes verbatim in the draft and any later confirmation:\n${notes}`]
          : []),
        t`Recheck availability before booking. Any later booking, guest addition or sending requires review of the exact participants, selected time, location and message.`,
      ].join("\n\n")
    : "";
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
    <section aria-label={t`Interview plan`} className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold">
          <Trans>Interview plan</Trans>
        </h3>
        <Button variant="ghost" onClick={onClose}>
          <Trans>Close</Trans>
        </Button>
      </div>
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
          <ReviewPlanButton plan={saved} onReview={onReview} />
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
              <Trans>Could not load saved availability. Check the calendar in role chat.</Trans>
            </p>
          ) : null}
          <fieldset disabled={reviewing || pending} className="space-y-3">
            {onProposeTimes ? (
              <label className="block text-sm" htmlFor={`${formId}-action`}>
                <Trans>Scheduling action</Trans>
                <NativeSelect
                  id={`${formId}-action`}
                  value={proposing ? "proposal" : "booking"}
                  onChange={(event) => setProposing(event.target.value === "proposal")}
                >
                  <NativeSelectOption value="booking">{t`Plan one booking`}</NativeSelectOption>
                  <NativeSelectOption value="proposal">{t`Propose times by email`}</NativeSelectOption>
                </NativeSelect>
              </label>
            ) : null}
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
                    <NativeSelectOption key={person.candidateKey} value={person.candidateKey}>
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
                aria-label={t`Requested interviewer email`}
                value={interviewerEmail}
                onChange={(event) => setInterviewerEmail(event.target.value)}
              />
            </label>
            <label className="block text-sm" htmlFor={`${formId}-interviewer-zone`}>
              <Trans>Interviewer time zone</Trans>
              <Input
                id={`${formId}-interviewer-zone`}
                aria-label={t`Interviewer time zone`}
                placeholder="Europe/London"
                value={interviewerZone}
                onChange={(event) => setInterviewerZone(event.target.value)}
              />
            </label>
            {!zonesValid && (candidateZone || interviewerZone) ? (
              <p className="text-xs text-muted-foreground">
                <Trans>
                  Enter both named IANA timezones, such as America/New_York and Europe/London.
                </Trans>
              </p>
            ) : null}
            <fieldset className="space-y-2" aria-label={t`Observed availability intervals`}>
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
                          keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key],
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
                      <Trans>Observed at</Trans> · {new Date(value.observedAt).toLocaleString()}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {proposing ? (
              <>
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
                <label className="block text-sm" htmlFor={`${formId}-location`}>
                  <Trans>Requested location</Trans>
                  <Input
                    id={`${formId}-location`}
                    name="requested-location"
                    autoComplete="off"
                    aria-label={t`Requested location`}
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                  />
                </label>
                <label className="block text-sm" htmlFor={`${formId}-notes`}>
                  <Trans>Notes for the email</Trans>
                  <Textarea
                    id={`${formId}-notes`}
                    name="proposal-notes"
                    autoComplete="off"
                    aria-label={t`Notes for the email`}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  <Trans>
                    Guests and location are requests in the draft. Email recipients stay unchanged.
                    No time is booked.
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
              <Trans>
                No supported future interval is recorded. Check availability before choosing a time.
              </Trans>
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
              These are requested participant timezones, not verified calendar-host identity.
              Availability is rechecked before booking.
            </Trans>
          </p>
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
                {notes ? <p className="whitespace-pre-wrap break-words text-sm">{notes}</p> : null}
                <p className="text-sm">
                  <Trans>Email draft only. No time is booked.</Trans>
                </p>
                <Button variant="outline" onClick={() => setReviewing(false)}>
                  <Trans>Edit</Trans>
                </Button>
                <Button onClick={() => onProposeTimes?.(proposalText)}>
                  <Trans>Draft in role chat</Trans>
                </Button>
              </div>
            ) : (
              <Button
                disabled={!proposalValid || read.failed || !proof}
                onClick={() => setReviewing(true)}
              >
                <Trans>Review proposed times</Trans>
              </Button>
            )
          ) : reviewing && input.success ? (
            <div className="space-y-3 border-t pt-3">
              <h4 className="font-medium">
                <Trans>Review plan</Trans>
              </h4>
              <PlanTimes plan={input.data} />
              <p className="text-sm">
                <Trans>Saving this plan does not approve a booking or message.</Trans>
              </p>
              <Button variant="outline" disabled={pending} onClick={() => setReviewing(false)}>
                <Trans>Edit</Trans>
              </Button>
              <Button disabled={pending} onClick={() => void save()}>
                {pending ? <Trans>Saving…</Trans> : <Trans>Save plan</Trans>}
              </Button>
            </div>
          ) : (
            <Button
              disabled={!input.success || read.failed || !proof}
              onClick={() => setReviewing(true)}
            >
              <Trans>Review plan</Trans>
            </Button>
          )}
          {failed ? (
            <p role="alert">
              <Trans>
                Could not save this plan. Refresh the original conversation and availability, then
                try again.
              </Trans>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
