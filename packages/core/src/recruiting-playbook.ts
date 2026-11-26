import type { RecruitingBriefDraft, RecruitingRoleRevision } from "@rakazo/contracts";

export class RecruitingPlaybookValidationError extends Error {}

/** Semantic extraction belongs to the agent; these guards consume sourced, typed fields. */
export function validateRecruitingBrief(
  brief: RecruitingBriefDraft,
  role: Pick<RecruitingRoleRevision, "criteria" | "sourceRefs">,
): void {
  const sources = new Map<string, (typeof role.sourceRefs)[number]>();
  for (const [location, references] of [
    ["sourceRefs", role.sourceRefs],
    ...role.criteria.map(
      (criterion, index) => [`criteria[${index}].sourceRefs`, criterion.sourceRefs] as const,
    ),
  ] as const)
    for (const [index, source] of references.entries()) {
      const previous = sources.get(source.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(source))
        throw new RecruitingPlaybookValidationError(
          `${location}[${index}]: source ID ${JSON.stringify(source.id)} already identifies a different reference. Reuse the full unchanged reference, or use a distinct source ID for a different quote and update its sourceRefIds.`,
        );
      sources.set(source.id, source);
    }
  const requireSources = (ids: readonly string[], location: string) => {
    // A read source without a quote still locates the fact (the server drops a quote it cannot
    // match rather than refusing the save), so it counts as a citation.
    const invalid = ids.find((id) => sources.get(id)?.readState !== "read");
    if (!ids.length || invalid !== undefined)
      throw new RecruitingPlaybookValidationError(
        `${location}: ${!ids.length ? "add at least one source ID" : `source ID ${JSON.stringify(invalid)} is missing or unread`}. Cite a read source reference; user_instruction must cite the actual human-message reference.`,
      );
  };
  if (
    new Set(brief.fields.map((field) => field.key)).size !== brief.fields.length ||
    new Set(brief.searchFilters.map((filter) => filter.id)).size !== brief.searchFilters.length ||
    new Set(brief.rules.map((rule) => rule.criterionId)).size !== brief.rules.length ||
    new Set(brief.questions.map((question) => question.id)).size !== brief.questions.length
  )
    throw new RecruitingPlaybookValidationError(
      "Brief field, filter, question and rule IDs must be unique.",
    );
  for (const [index, field] of brief.fields.entries()) {
    if (field.state === "known" && field.value === null)
      throw new RecruitingPlaybookValidationError("Known brief facts require a value.");
    if (field.sourceRefIds.length || (field.origin !== "inferred" && field.state === "known"))
      requireSources(field.sourceRefIds, `brief.fields[${index}].sourceRefIds`);
  }
  for (const [index, filter] of brief.searchFilters.entries()) {
    if (filter.sourceRefIds.length || filter.origin !== "inferred")
      requireSources(filter.sourceRefIds, `brief.searchFilters[${index}].sourceRefIds`);
    if (filter.origin === "inferred" && filter.mode !== "prefer")
      throw new RecruitingPlaybookValidationError("Inferred search filters must remain preferred.");
  }
  for (const [index, question] of brief.questions.entries()) {
    if (!brief.fields.some((field) => field.key === question.fieldKey))
      throw new RecruitingPlaybookValidationError("Brief question must target an existing field.");
    if (question.answeredBySourceRefId)
      requireSources(
        [question.answeredBySourceRefId],
        `brief.questions[${index}].answeredBySourceRefId`,
      );
  }
  for (const [index, rule] of brief.rules.entries()) {
    const criterion = role.criteria.find((item) => item.id === rule.criterionId);
    if (!criterion)
      throw new RecruitingPlaybookValidationError("Brief rule must target an existing criterion.");
    if (rule.sourceRefIds.length || rule.origin !== "inferred")
      requireSources(rule.sourceRefIds, `brief.rules[${index}].sourceRefIds`);
    if (rule.origin === "inferred" && rule.effect !== "flag")
      throw new RecruitingPlaybookValidationError("Inferred rules must remain flag-only.");
    if ((rule.origin === "inferred" || rule.effect === "flag") && criterion.priority === "hard")
      throw new RecruitingPlaybookValidationError(
        "Inferred or flag-only rules cannot reject candidates.",
      );
  }
  const missingRule = role.criteria.find(
    (criterion) => !brief.rules.some((rule) => rule.criterionId === criterion.id),
  );
  if (missingRule)
    throw new RecruitingPlaybookValidationError(
      `brief.rules: missing criterionId ${JSON.stringify(missingRule.id)}. Add its rule with origin, effect and sourceRefIds; every criterion needs a corresponding rule.`,
    );
}

/** No mandatory questionnaire. Reuse sourced answers and ask only about material uncertainty. */
export function recruitingBriefClarifications(brief: RecruitingBriefDraft) {
  const pending = brief.fields.filter(
    (field) => field.consequential && (field.state !== "known" || field.origin === "inferred"),
  );
  return pending.map((field) => ({
    fieldKey: field.key,
    question:
      brief.questions.find(
        (question) => question.fieldKey === field.key && !question.answeredBySourceRefId,
      )?.question ?? "Please clarify the unresolved role detail.",
  }));
}

export function requireRecruitingBriefConfirmation(
  role: Pick<RecruitingRoleRevision, "revision" | "brief">,
) {
  const brief = role.brief;
  if (
    !brief?.confirmation ||
    brief.confirmation.revision !== role.revision ||
    recruitingBriefClarifications(brief).length
  )
    throw new RecruitingPlaybookValidationError(
      "Confirm the current recruiting brief before continuing.",
    );
}

export function recruitingCalibrationIdentity(link: string): string | null {
  try {
    const url = new URL(link);
    if (
      url.protocol !== "https:" ||
      !["linkedin.com", "www.linkedin.com"].includes(url.hostname) ||
      !url.pathname.startsWith("/in/")
    )
      return null;
    const segments = url.pathname.replace(/\/$/, "").split("/");
    if (segments.length !== 3) return null;
    const profile = decodeURIComponent(segments[2]!);
    if (!profile.trim() || profile.includes("/")) return null;
    return `/in/${profile.toLowerCase()}`;
  } catch {
    return null;
  }
}
