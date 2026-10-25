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
  intake: "岗位录入",
  calibration_10: "校准搜寻（10 人）",
  feedback: "校准反馈",
  scale: "规模化搜寻",
  enrichment: "联系方式补全",
  outreach: "外联",
  replies: "候选人回复",
  screening: "初筛",
  submission: "推荐提交",
  interview: "面试",
  closed: "已关闭",
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
};

const CALIBRATION_TARGET = 10;

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
      label: `还有 ${open} 个待确认问题`,
      prompt:
        "把剩余的待确认问题一次性列出来向用户提问（一张卡片），不要只保存答案就结束。问题没问完不能停。",
    };
  switch (stage) {
    case "intake":
      return facts.hasBrief && facts.title
        ? {
            stage,
            label: "开始校准搜寻",
            prompt: `岗位已保存。立即在本轮用人才数据搜索做校准快速搜寻（people search → recruiting_research save_search → 选 ${CALIBRATION_TARGET} 人 → calibration_round），直接列出名单，不要先发进度消息。`,
          }
        : {
            stage,
            label: "完成岗位信息",
            prompt: "从已有材料整理岗位标题与 brief 并保存；缺少的关键信息一次性问清。",
          };
    case "calibration_10": {
      const remaining = Math.max(0, CALIBRATION_TARGET - facts.savedCandidates);
      return {
        stage,
        label: remaining ? `校准搜寻（还差 ${remaining} 人）` : "展示 10 人校准名单",
        prompt: remaining
          ? `用人才数据搜索做校准快速搜寻直到保存 ${CALIBRATION_TARGET} 人（当前 ${facts.savedCandidates}），完成后直接列出名单。`
          : "把这 10 位校准候选人记录为本轮（recruiting_research calibration_round），通过 Results 校准面板展示名单并收集本轮反馈；面板已提供反馈入口，不要重复创建问题卡。允许用户针对任何人、任意子集或整体方向给一次反馈，不要求逐人评分。",
      };
    }
    case "feedback":
      return {
        stage,
        label: "收集校准反馈",
        prompt:
          "通过已记录的 Results 校准面板展示本轮 10 人名单并收集一次反馈，不要重复创建问题卡；允许针对个人、子集或整体方向反馈，不要求逐人评分。本轮反馈到了就把全部意见合进下一次快速搜索（同一 brief 加上反馈，排除这个岗位已返回过的所有人），save_search 保存后选 10 位全新的人记录为下一轮并说明变化。用户明确接受某一轮及规则修改之后才进入规模化搜寻，不能把已保存名单或普通反馈当作批准；没有新反馈时不要重复追问。",
      };
    case "scale":
      return {
        stage,
        label: "规模化搜寻",
        prompt: "按确认后的标准启动规模化搜寻；开始前告知用户，完成后汇总数量与亮点。",
      };
    case "enrichment":
      return {
        stage,
        label: "补全候选人联系方式",
        prompt: "为入围候选人补全联系方式；完成后汇报可触达人数。",
      };
    case "outreach":
      return {
        stage,
        label: "准备外联",
        prompt: "准备外联序列与名单，向用户请求发送确认。",
      };
    case "replies":
      return {
        stage,
        label: "处理候选人回复",
        prompt: "汇总新回复并给出建议的下一步（约面/跟进/关闭）。",
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
  if ((events.savedRows ?? 0) >= (events.deliverableRows ?? 1)) return "deliverable";
  const requiresSavedRows = (events.deliverableRows ?? 1) > 1;
  if (!requiresSavedRows && blocks.some((block) => DELIVERABLE_BLOCKS.has(block.kind)))
    return "deliverable";
  const text = blocks
    .filter((block) => block.kind === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  if (!text) return "none";
  if (QUESTION_RE.test(text)) return "question";
  if (!requiresSavedRows && (text.match(LIST_ROW_RE)?.length ?? 0) >= 3) return "deliverable";
  return "none";
}
