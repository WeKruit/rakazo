/**
 * How a campaign whose first step reads each lead's own email looks to an agent. The provider
 * sequence then holds only variable names, which agents misread as a blank email and paused a
 * confirmed send to "fix". The agent sees each recipient's actual first email instead.
 */
const OPENING = 240;

const plain = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();

export const OWN_EMAIL_STEP =
  "(each recipient's own first email, saved on their lead; see firstEmails. Not blank.)";

/** The provider sequence with its variable-only first step named for what it is. */
export function ownEmailSequences(sequences: unknown): unknown {
  if (!Array.isArray(sequences)) return sequences;
  return sequences.map((sequence, index) => {
    const steps = (sequence as { steps?: unknown[] } | null)?.steps;
    if (index > 0 || !Array.isArray(steps) || !steps.length) return sequence;
    const [first, ...rest] = steps as Record<string, unknown>[];
    return {
      ...(sequence as object),
      steps: [{ ...first, variants: [{ subject: OWN_EMAIL_STEP, body: OWN_EMAIL_STEP }] }, ...rest],
    };
  });
}

/** Each recipient's first email: subject and opening, as the provider will send it. */
export function ownFirstEmails(
  people: { email: string; saved?: { rk_subject: string; rk_body: string } }[],
): Record<string, { subject: string; opening: string } | null> {
  return Object.fromEntries(
    people.map((person) => {
      if (!person.saved) return [person.email, null];
      const body = plain(person.saved.rk_body);
      return [
        person.email,
        {
          subject: person.saved.rk_subject,
          opening: body.length > OPENING ? `${body.slice(0, OPENING)}…` : body,
        },
      ];
    }),
  );
}
