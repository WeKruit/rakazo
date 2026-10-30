/**
 * The free first stage of sorting candidate replies. Plain rules settle the mail that is obvious
 * from its sender, subject or opening words (bounces, out-of-office and other automatic replies)
 * without a model call. Rules only ever say "can wait": a reply that matters (interest, a
 * question, a request to stop contact) shares no keywords, so everything else goes to the agent,
 * which sorts it and gives its reason.
 */
export type AutomaticReplyKind = "bounce" | "automatic_reply";

export type AutomaticReplyVerdict = {
  kind: AutomaticReplyKind;
  /** A reason a recruiter would accept, in plain words. */
  reason: string;
};

export type CandidateReplyText = {
  from?: string | null;
  subject?: string | null;
  body?: string | null;
};

const BOUNCE_SENDER = /^(?:[^<]*<)?\s*(?:mailer-daemon|postmaster)@/i;
const BOUNCE_SUBJECT =
  /\b(?:undeliverable|undelivered mail|delivery status notification|delivery (?:has )?failed|delivery failure|mail delivery (?:failed|subsystem)|returned mail|failure notice)\b|退信|无法投递/i;
const AUTO_SUBJECT =
  /^\s*(?:automatic reply|auto(?:matic)?[- ]?(?:reply|response)|autoreply|out of (?:the )?office|ooo)\b|^\s*auto:|自动回复/i;
// Only the opening of a short message counts: a real reply can mention a holiday and still matter.
const AUTO_OPENING =
  /^(?:(?:hi|hello|thanks?|thank you)[^.!\n]{0,40}[.!,\n]\s*)?(?:this is an automatic reply|this is an automated (?:reply|response|message)|i am (?:currently )?(?:out of (?:the )?office|away from (?:the |my )?office|on (?:annual |parental |maternity |paternity )?leave)|i'm (?:currently )?(?:out of (?:the )?office|away from (?:the |my )?office|on (?:annual |parental |maternity |paternity )?leave)|thank you for your (?:email|message)\. i am (?:currently )?(?:out|away))|^(?:您好[，,]?\s*)?(?:这是一封自动回复|我目前不在办公室|我正在休假)/i;
const SHORT_BODY_CHARS = 800;
const OPENING_CHARS = 300;

export function automaticReplyVerdict(reply: CandidateReplyText): AutomaticReplyVerdict | null {
  const subject = reply.subject?.trim() ?? "";
  const body = reply.body?.trim() ?? "";
  if (BOUNCE_SENDER.test(reply.from?.trim() ?? "") || BOUNCE_SUBJECT.test(subject))
    return { kind: "bounce", reason: "The email bounced, so it never reached them." };
  if (
    AUTO_SUBJECT.test(subject) ||
    (body.length <= SHORT_BODY_CHARS && AUTO_OPENING.test(body.slice(0, OPENING_CHARS)))
  )
    return { kind: "automatic_reply", reason: "An automatic reply, such as out of office." };
  return null;
}
