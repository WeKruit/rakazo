/**
 * A candidate's question that nothing the recruiter said or saved answers is the recruiter's to
 * answer, not the agent's. The agent reads the candidate's words and lists those questions in a
 * structured field on its reply; code only carries that list to the reply card (AGENTS.md P9),
 * where the recruiter answers before pressing Send. It never blocks the reply.
 */
export const OPEN_QUESTIONS = "open_questions";

const DESCRIPTION =
  "Each question in the candidate's email that neither the recruiter's own words in this conversation nor the role's saved memory answers (pay beyond the saved range, relocation, visa, remote days, client name, start date, process, anything else), quoted in the candidate's words; [] when the reply answers every question from those. The reply card shows these to the recruiter so they can answer before sending: never answer one from a guess.";

/** The JSON schema property every reply-to-a-candidate tool lists, marked required. */
export function withOpenQuestions(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    ...schema,
    properties: {
      ...properties,
      [OPEN_QUESTIONS]: { type: "array", items: { type: "string" }, description: DESCRIPTION },
    },
    required: [...required.filter((name) => name !== OPEN_QUESTIONS), OPEN_QUESTIONS],
  };
}

/** Splits the list off a reply's arguments, so the mail service never sees it. */
export function takeOpenQuestions(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  open: string[];
} {
  if (!(OPEN_QUESTIONS in args)) return { args, open: [] };
  const { [OPEN_QUESTIONS]: value, ...rest } = args;
  const open = Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => item.trim().slice(0, 500))
        .slice(0, 20)
    : [];
  return { args: rest, open };
}

/** What the agent does after the recruiter sent a reply whose card listed open questions. */
export function openQuestionsAnsweredNote(open: readonly string[]): string {
  return `The recruiter answered the candidate's open questions (${open.map((question) => `"${question}"`).join("; ")}) in the reply they sent. Save each answer in the role's memory with save_group_memory (dated, from the recruiter's sent reply), so the next candidate who asks is answered from it.`;
}
