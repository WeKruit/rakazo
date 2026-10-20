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
    const invalid = ids.find(
      (id) => sources.get(id)?.readState !== "read" || !sources.get(id)?.quote,
    );
    if (!ids.length || invalid !== undefined)
      throw new RecruitingPlaybookValidationError(
        `${location}: ${!ids.length ? "add at least one source ID" : `source ID ${JSON.stringify(invalid)} is missing, unread or has no quote`}. Cite a full read source reference with an exact quote; user_instruction must cite the actual human-message reference.`,
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
    (field) =>
      (field.consequential || ["salary_range", "location"].includes(field.key)) &&
      (field.state !== "known" || field.origin === "inferred"),
  );
  const questions = pending.map((field) => ({
    fieldKey: field.key,
    question:
      brief.questions.find(
        (question) => question.fieldKey === field.key && !question.answeredBySourceRefId,
      )?.question ??
      (field.key === "salary_range"
        ? "What salary range may be stated in outreach?"
        : field.key === "location"
          ? "What location or remote work scope applies?"
          : field.key === "company_deck"
            ? "Is a company deck available?"
            : "Please clarify the unresolved role detail."),
  }));
  if (!brief.fields.some((field) => field.key === "salary_range"))
    questions.unshift({
      fieldKey: "salary_range",
      question: "What salary range may be stated in outreach?",
    });
  else {
    const salary = brief.fields.find((field) => field.key === "salary_range")!;
    if (
      (salary.state !== "known" || salary.origin === "inferred") &&
      !questions.some((question) => question.fieldKey === salary.key)
    )
      questions.unshift({
        fieldKey: salary.key,
        question: "What salary range may be stated in outreach?",
      });
  }
  if (!brief.fields.some((field) => field.key === "location"))
    questions.push({
      fieldKey: "location",
      question: "What location or remote work scope applies?",
    });
  return questions;
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

export type RecruitingGate = "G0" | "G1" | "G2" | "G3" | "G4";
export const recruitingGateLabels = {
  G0: "Recruiting brief",
  G1: "Job description and company materials",
  G2: "Review of the ten candidates",
  G3: "Campaign and lead list",
  G4: "Individual message or scheduling action",
} as const satisfies Record<RecruitingGate, string>;
export type RecruitingGateReceipt = {
  gate: RecruitingGate;
  roleRevisionId: string;
  payloadHash: string;
  spaceId: string;
  approvedByUserId: string;
  approvedAt: string;
};
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
function evidenceLink(link: string): boolean {
  try {
    return ["https:", "http:"].includes(new URL(link).protocol);
  } catch {
    return false;
  }
}

/** Receipts come from trusted native approval storage, never model arguments or old policy text. */
export function requireRecruitingPlaybookGate(input: {
  gate: RecruitingGate;
  roleRevisionId: string;
  payloadHash: string;
  actor: { userId: string; spaceId: string };
  receipts: readonly RecruitingGateReceipt[];
  prerequisiteHashes: Partial<Record<RecruitingGate, string>>;
  calibration?: readonly { candidateKey: string; linkedinUrl: string; evidenceUrl: string }[];
}) {
  const required: RecruitingGate[] =
    input.gate === "G0"
      ? ["G0"]
      : input.gate === "G1"
        ? ["G0", "G1"]
        : input.gate === "G2"
          ? ["G0", "G1", "G2"]
          : input.gate === "G3"
            ? ["G0", "G1", "G2", "G3"]
            : ["G0", "G4"];
  for (const gate of required) {
    const hash = gate === input.gate ? input.payloadHash : input.prerequisiteHashes[gate];
    if (
      !hash ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !input.receipts.some(
        (receipt) =>
          receipt.gate === gate &&
          receipt.roleRevisionId === input.roleRevisionId &&
          receipt.payloadHash === hash &&
          receipt.approvedByUserId === input.actor.userId &&
          receipt.spaceId === input.actor.spaceId &&
          Number.isFinite(Date.parse(receipt.approvedAt)),
      )
    )
      throw new RecruitingPlaybookValidationError(
        `${recruitingGateLabels[gate]} requires approval for the exact current material.`,
      );
  }
  if (
    input.gate === "G2" &&
    (input.calibration?.length !== 10 ||
      new Set(input.calibration.map((profile) => profile.candidateKey)).size !== 10 ||
      new Set(
        input.calibration.map((profile) => recruitingCalibrationIdentity(profile.linkedinUrl)),
      ).size !== 10 ||
      input.calibration.some(
        (profile) =>
          !recruitingCalibrationIdentity(profile.linkedinUrl) || !evidenceLink(profile.evidenceUrl),
      ))
  )
    throw new RecruitingPlaybookValidationError(
      "Candidate review requires exactly ten distinct profiles with supporting evidence.",
    );
}

/** Blocking checks precede every exception, including a human's CRM note. */
export function recruitingOutboundDisposition(input: {
  suppressed: boolean;
  hold: boolean;
  pass: boolean;
  duplicate: boolean;
  checksComplete: boolean;
  scheduling: boolean;
  exactApproval: boolean;
  crmNote: boolean;
  approvedPolicy: boolean;
  allTopicsApproved: boolean;
  approvedFactsOnly: boolean;
}) {
  if (input.suppressed) return "blocked_suppression" as const;
  if (input.hold || input.pass) return "blocked_hold_pass" as const;
  if (input.duplicate) return "blocked_duplicate" as const;
  if (!input.checksComplete) return "draft" as const;
  if (input.scheduling) return input.exactApproval ? ("approved" as const) : ("draft" as const);
  if (input.exactApproval) return "approved" as const;
  if (input.crmNote || (input.approvedPolicy && input.allTopicsApproved && input.approvedFactsOnly))
    return "eligible_for_native_approval" as const;
  return "draft" as const;
}

/** H9 cannot override the actual recorded discovery source. */
export function recruitingDiscoveryAnswer(source: { label: string; verified: boolean } | null) {
  return source?.verified ? `I found your profile through ${source.label}.` : null;
}
