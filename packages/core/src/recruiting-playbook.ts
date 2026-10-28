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
// The model names the work-location field freely (location, locations, work_location, …).
const isLocationKey = (key: string) => /location/i.test(key);

export function recruitingBriefClarifications(brief: RecruitingBriefDraft) {
  const pending = brief.fields.filter(
    (field) =>
      (field.consequential || isLocationKey(field.key)) &&
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
        : isLocationKey(field.key)
          ? "What location or remote work scope applies?"
          : field.key === "company_deck"
            ? "Is a company deck available?"
            : "Please clarify the unresolved role detail."),
  }));
  if (!brief.fields.some((field) => isLocationKey(field.key)))
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

// ---------------------------------------------------------------------------
// Role stage machine (playbook S1→S12) and the turn-end guard that keeps the
// agent moving instead of ending a turn with "saved, not started yet".
// ---------------------------------------------------------------------------

export const RECRUITING_PLAYBOOK_STAGES = [
  "intake",
  "calibration_10",
  "feedback",
  "scale",
  "enrichment",
  "outreach",
  "replies",
  "screening",
  "submission",
  "interview",
  "closed",
] as const;
export type RecruitingPlaybookStage = (typeof RECRUITING_PLAYBOOK_STAGES)[number];

export const recruitingPlaybookStageLabels = {
  intake: "Role intake",
  calibration_10: "Calibration search (10 people)",
  feedback: "Calibration feedback",
  scale: "Scaled search",
  enrichment: "Contact lookup",
  outreach: "Outreach",
  replies: "Candidate replies",
  screening: "Screening",
  submission: "Submission",
  interview: "Interview",
  closed: "Closed",
} as const satisfies Record<RecruitingPlaybookStage, string>;

export function isRecruitingPlaybookStage(value: unknown): value is RecruitingPlaybookStage {
  return (RECRUITING_PLAYBOOK_STAGES as readonly unknown[]).includes(value);
}

/** Stages only move forward; a stale writer never regresses a role. */
export function laterPlaybookStage(
  current: RecruitingPlaybookStage,
  next: RecruitingPlaybookStage,
): RecruitingPlaybookStage {
  return RECRUITING_PLAYBOOK_STAGES.indexOf(next) > RECRUITING_PLAYBOOK_STAGES.indexOf(current)
    ? next
    : current;
}

export type RecruitingPlaybookRoleFacts = {
  title?: string | null;
  hasBrief: boolean;
  /** Clarifications still open on the brief (see recruitingBriefClarifications). */
  openClarifications?: number;
  savedCandidates: number;
};

export type RecruitingPlaybookStep = {
  stage: RecruitingPlaybookStage;
  label: string;
  prompt: string;
  /** Set when the step exists only to ask the recruiter's open clarifications. */
  openClarifications?: number;
};

const CALIBRATION_TARGET = 10;
const NEXT_STEP_CARD =
  'After the list is shown, use one question card (ask_user) to offer the next step, for example "Find 100 similar people", "Draft the first email" or "Run another round". ';
const ONLY_OWN_LIST =
  "If the recruiter said not to look outside and to use only their own list, do not search: use only the imported people, state the actual count, and do not pad to 10.";

/**
 * What the agent should do next for a role in `stage`. Null means the stage has no
 * runtime-driven next step (the human owns the move, or the role is closed).
 */
export function nextPlaybookStep(
  stage: RecruitingPlaybookStage,
  facts: RecruitingPlaybookRoleFacts,
): RecruitingPlaybookStep | null {
  const open = facts.openClarifications ?? 0;
  if (open > 0 && (stage === "intake" || stage === "calibration_10"))
    return {
      stage,
      label: `${open} open ${open === 1 ? "question" : "questions"} to confirm`,
      prompt:
        "Ask the recruiter all remaining open questions at once on one card. Do not end after only saving answers. Do not stop until every question has been asked.",
      openClarifications: open,
    };
  switch (stage) {
    case "intake":
      return facts.hasBrief && facts.title
        ? {
            stage,
            label: "Start the calibration search",
            prompt: `The role is saved. In this turn, run the calibration quick search with the platform people search now (issue four web_search_advanced_exa people searches in the same step; each result is saved automatically → pick ${CALIBRATION_TARGET} people → calibration_round), and list them directly without a progress message first. ${ONLY_OWN_LIST}`,
          }
        : {
            stage,
            label: "Complete the role details",
            prompt:
              "If information that would change who to search for is still missing from the material, ask only the next question (one at a time). Otherwise, in the next step of this turn, issue the calibration people searches right away (each result appears in the results automatically), then pick 10 people and record the round. The system saves the brief after the list appears, so do not save or confirm it yourself. If people are already saved in the results, do not search again; pick from them.",
          };
    case "calibration_10": {
      const remaining = Math.max(0, CALIBRATION_TARGET - facts.savedCandidates);
      return {
        stage,
        label: remaining
          ? `Calibration search (${remaining} more needed)`
          : "Show the 10-person calibration list",
        prompt: remaining
          ? `Run the calibration quick search with people data search until ${CALIBRATION_TARGET} people are saved (now ${facts.savedCandidates}), then record the round (the list is posted in chat automatically). ${ONLY_OWN_LIST}`
          : `Pick 10 of the saved people and record them as this round (recruiting_research calibration_round), shown in the Results calibration panel. Search again only when fewer than ten saved people fit the role's hard requirements such as its location: then run four new, differently worded people searches together in one step and record the ten from all saved people; never ask the recruiter to relax a requirement before that search. The panel already has per-person feedback controls, so do not build a separate per-person rating card. ${NEXT_STEP_CARD}Let the recruiter give feedback once on anyone, any subset or the overall direction; do not require a rating for every person.`,
      };
    }
    case "feedback":
      return {
        stage,
        label: "Collect calibration feedback",
        prompt: `${facts.hasBrief ? "" : "The brief is not saved yet: first save the JD and the recruiter's answers as the brief with one recruiting_role update (if it fails, fix it once from the error and save again; do not search again). "}Read the recruiter's latest message first. If it asks to find more or similar people, widen the search or just start (for example "find 100", "just search", "no need to confirm", or picking find-more on the next-step card), that accepts this round: record it now with recruiting_feedback (target round, operation approve, quoting their words), then start scaling in this turn by the scale rules. Do not run another calibration round or ask for confirmation again. Otherwise, first record this round's feedback with recruiting_feedback, quoting their words (people they named go in candidate review with their keys; a changed search direction goes in round scope). Then fold all feedback into the next quick search (same brief plus the feedback, worded differently, excluding everyone already returned for this role), save_search, pick 10 new people, record them as the next round, and say what changed. ${NEXT_STEP_CARD}Comments on individual people are not acceptance. Rejecting some of this round's people or changing the search direction is feedback for the next round, not acceptance, even if they also say "find more people like …". When there is no new feedback, do not ask again.`,
      };
    case "scale":
      return {
        stage,
        label: "Scaled search",
        prompt:
          "This round is accepted, so widen the search. First scale up yourself with people search in batches: each batch runs 4 differently worded web_search_advanced_exa people searches in parallel in one step, then save_search in the next step. Do not read or rank people between batches. Continue until the target count (default 100) is reached or a batch adds fewer than 5 new people. Then use message_user to say in two or three sentences how many people are in the results and whether a deep search is still running. Only if people search cannot reach the target, hand off once at the end (a handoff ends your turn, and later tool calls are refused): give the sourcing colleague the remaining count for a deep search, with the confirmed brief and every round's feedback, excluding people already returned. If the target is reached, do not hand off and do not run a deep search. Do not draft emails or hand emails to the outreach colleague unless the recruiter asked.",
      };
    case "enrichment":
      return {
        stage,
        label: "Find candidate contact details",
        prompt:
          "Find contact details for the shortlisted candidates, then report how many can be reached.",
      };
    case "outreach":
      return {
        stage,
        label: "Prepare outreach",
        prompt:
          "Prepare the outreach sequence and recipient list, and ask the recruiter to confirm sending.",
      };
    case "replies":
      return {
        stage,
        label: "Handle candidate replies",
        prompt:
          "Summarize new replies and suggest the next step for each (schedule, follow up or close).",
      };
    case "screening":
    case "submission":
    case "interview":
    case "closed":
      return null;
  }
}

export type TurnEndClass = "deliverable" | "question" | "card" | "handoff" | "none";

type TurnEndBlock = { kind: string; text?: string; steps?: unknown; status?: string };

const DELIVERABLE_BLOCKS = new Set(["candidate", "report", "artifact", "chart", "assessment"]);
const CARD_BLOCKS = new Set(["approval", "mcp_approval", "connect", "app_connect", "choice"]);
const QUESTION_RE = /[?？]\s*$/;
// A list of ≥3 bullets or numbered rows reads as a delivered list, not a status note.
const LIST_ROW_RE = /^\s*(?:[-*•]|\d+[.)、])\s+\S/gm;
// Work promised for later in this chat: "我会…", "接下来…", "预计 3 点前…", "恢复后…", "I'll…".
const PROMISE_RE =
  /我(?:会|将|马上|这就|随后|稍后|再)|接下来|稍后|稍等|请稍候|预计.{0,40}?(?:前|内|完成|给出|展示|汇报)|\bETA\b[^。.]{0,24}\d|恢复后|\bI(?:'|’)ll\b|\bI will\b|\bI(?:'|’)m going to\b|\blet me\b|\bnext,? I\b/i;
// Work said to be under way: "已开始扩展搜索", "正在查找", "I've started the search".
const STARTED_RE =
  /已(?:经)?(?:开始|启动|发起)|正在(?:搜索|查找|寻找|扩展|扩大|检索)|\b(?:I(?:'|’)ve|I have) (?:started|kicked off|launched)\b|\bnow (?:searching|running)\b/i;
// The recruiter's own move ends the turn: "你确认后我会发送" waits on them, not on the agent.
const WAITS_ON_RECRUITER_RE =
  /(?:你|您)(?:确认|回复|同意|决定|选择|提供|补充|批准|点击)|请(?:你|您)?确认|确认后|取决于|once you|after you|when you|if you|depends on|after confirmation/i;
// "我会把薪资作为偏好" says how a requirement is treated, not work still to do.
const TREATMENT_RE = /我会把.{0,40}?(?:作为|当作|视为|按|列为|保留为)/;

/**
 * The final sentence when it promises more work in this chat, else undefined. A turn that ends
 * on a promise has not done the work; whether something is really still running (a search
 * whose wake brings results, a handoff) is for the caller to check.
 */
export function turnEndPromise(text: string): string | undefined {
  const sentences = text
    .trim()
    .split(/(?<=[。！!；;\n]|[.](?=\s|$))/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const last = sentences.at(-1);
  if (!last || QUESTION_RE.test(last)) return undefined;
  if (!PROMISE_RE.test(last) || WAITS_ON_RECRUITER_RE.test(last) || TREATMENT_RE.test(last))
    return undefined;
  return last;
}

/**
 * The sentence claiming work is under way ("已开始扩展搜索") in a turn that ends without a
 * question, else undefined. The caller checks whether anything really runs.
 */
export function turnEndStarted(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || QUESTION_RE.test(trimmed)) return undefined;
  return trimmed
    .split(/(?<=[。！!；;\n]|[.](?=\s|$))/)
    .map((sentence) => sentence.trim())
    .find((sentence) => STARTED_RE.test(sentence) && !WAITS_ON_RECRUITER_RE.test(sentence));
}

// A report that the work failed or is stuck: "抱歉，流程卡在…", "无法保存", "I couldn't…".
const STUCK_RE =
  /抱歉|卡在|卡住|失败|未成功|没成功|未能|没能|无法|不能继续|不可用|出错|故障|暂时不能|\bsorry\b|\bunable\b|\bfailed\b|\bcould(?:n['’]t| not)\b|\bcan(?:not|['’]t)\b|\bunavailable\b|\bstuck\b|\berror\b/i;

/**
 * The text when the turn ends by reporting a failure or blocker instead of a question or a
 * result, else undefined. Such an ending has not done the work.
 */
export function turnEndStuck(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || QUESTION_RE.test(trimmed) || !STUCK_RE.test(trimmed)) return undefined;
  return trimmed;
}

/** The final turn's prose, joined. */
export function turnEndText(blocks: readonly TurnEndBlock[]): string {
  return blocks
    .filter((block) => block.kind === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

/**
 * How the final assistant turn ended, from the persisted blocks plus what the run did.
 * Pure: the executor passes facts, no I/O here.
 */
export function classifyTurnEnd(
  message: { blocks: readonly TurnEndBlock[] },
  events: {
    handedOff?: boolean;
    pendingApproval?: boolean;
    savedRows?: number;
    /** Minimum saved rows that count as a deliverable (default 1). */
    deliverableRows?: number;
    /** A saved calibration pool still needs a real native feedback/approval card. */
    requireBlockingInput?: boolean;
  } = {},
): TurnEndClass {
  if (events.handedOff) return "handoff";
  if (events.pendingApproval) return "card";
  const blocks = message.blocks;
  if (
    blocks.some(
      (block) =>
        block.kind === "ask" &&
        (events.requireBlockingInput ? block.status === "pending" : block.status !== "answered"),
    )
  )
    return "question";
  if (blocks.some((block) => CARD_BLOCKS.has(block.kind))) return "card";
  if (events.requireBlockingInput) return "none";
  const text = turnEndText(blocks);
  // Ending on "I'll do it next" leaves the work undone, whatever else the turn saved.
  if (turnEndPromise(text)) return "none";
  if ((events.savedRows ?? 0) >= (events.deliverableRows ?? 1)) return "deliverable";
  const requiresSavedRows = (events.deliverableRows ?? 1) > 1;
  if (!requiresSavedRows && blocks.some((block) => DELIVERABLE_BLOCKS.has(block.kind)))
    return "deliverable";
  if (!text) return "none";
  if (QUESTION_RE.test(text)) return "question";
  if (!requiresSavedRows && (text.match(LIST_ROW_RE)?.length ?? 0) >= 3) return "deliverable";
  return "none";
}
