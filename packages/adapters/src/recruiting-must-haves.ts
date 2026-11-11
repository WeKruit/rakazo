/**
 * The must-haves a recruiter's message states in so many words ("必须会说普通话", "must have
 * 5+ years"), each kept as the recruiter wrote it. The role is saved with them as hard criteria
 * when it opens, so a stated must-have holds from the first question on, whether or not the
 * model saves it.
 */
export function statedMustHaves(text: string): string[] {
  const must = /必须|必需|硬性|务必|\bmust\b|\brequired\b|\bmandatory\b/i;
  const optional =
    /不必须|非必须|不是硬性|非硬性|不强求|\bnot required\b|\bnice to have\b|\bmust not\b/i;
  const clauses = text
    .split(/[。；;！!？?\n]|[,，](?=\s*(?:必须|必需|务必|must\b))|\.(?:\s|$)/i)
    .map((clause) => clause.replace(/^[\s,，、:：\-*•\d.)]+/, "").trim())
    .filter((clause) => clause && must.test(clause) && !optional.test(clause));
  return [...new Set(clauses)].slice(0, 8).map((clause) => clause.slice(0, 300));
}

/** The stated must-haves of the recruiter's message, as hard criteria citing it. */
export function statedMustHaveCriteria(message: Record<string, unknown> | undefined) {
  if (!message || typeof message.quote !== "string") return [];
  return statedMustHaves(message.quote).map((statement, index) => ({
    id: `stated-must-${index + 1}`,
    priority: "hard" as const,
    expression: { kind: "atom" as const, id: `stated-must-${index + 1}`, statement },
    sourceRefs: [message],
    definitionQuestions: [],
  }));
}
