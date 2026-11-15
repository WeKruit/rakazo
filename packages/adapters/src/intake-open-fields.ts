import { COMMUTE_MILES, localRolePlace, namedPlace } from "./recruiting-location.js";

/**
 * The intake facts every brief needs (location with work mode, years, language), read from the
 * recruiter's own words before the first question, so the role's team asks only for what those
 * words leave open (form slot filling: fill slots from the message, ask only for empty ones).
 * Staging 11-15 gates 398accae and 95185659: a JD stating "Seattle, WA (hybrid, 3 days on site)"
 * and "6+ years" drew questions about the Seattle hybrid scope, a years cap and English.
 */

/** A JD that states no years leaves the range to ask; round 1 of the playtest skipped it. */
export function jobStatesYears(text: string): boolean {
  return /\d+\s*\+?\s*(?:(?:-|–|to)\s*\d+\s*\+?\s*)?(?:years?|yrs?)\b|\d+\s*年/i.test(text);
}

const WORK_MODE =
  /\b(on-?site|in[- ]office|hybrid|remote|days? (?:on site|in (?:the )?office))\b|现场|驻场|常驻|坐班|到岗|远程|混合办公|base\s*[一-鿿]/i;
const LANGUAGE =
  /\b(bilingual|mandarin|cantonese|chinese|japanese|korean|spanish|french|german|portuguese|vietnamese|arabic|hindi)\b|双语|普通话|粤语|中文|日语|韩语|英语|法语|德语|西班牙语/i;

// A requirement or preference word beside a named language settles how much it matters.
const LANGUAGE_WEIGHT =
  /\b(must|required|requires?|fluent|fluency|native|proficien\w*|preferred|a plus|nice to have)\b|必须|要求|需要|流利|母语|优先|加分/i;

export type IntakeField = "location" | "years" | "language";
export type IntakeFields = {
  settled: string[];
  open: string[];
  settledKeys: IntakeField[];
};

export function intakeFields(text: string): IntakeFields {
  const settled: string[] = [];
  const open: string[] = [];
  const settledKeys: IntakeField[] = [];
  if (WORK_MODE.test(text)) {
    const local = localRolePlace([text]);
    const place = local
      ? `${local.label}, within ${COMMUTE_MILES} miles`
      : namedPlace([text])?.label;
    settled.push(`location and work mode (${place ? `${place}, ` : ""}as the JD states)`);
    settledKeys.push("location");
  } else open.push("the location scope with the work mode (onsite, hybrid or remote)");
  if (jobStatesYears(text)) {
    settled.push("years of experience (as stated)");
    settledKeys.push("years");
  } else open.push("the years-of-experience range (offer two or three ranges that fit the pay)");
  if (!LANGUAGE.test(text)) {
    settled.push("language (the location's own; not a requirement)");
    settledKeys.push("language");
  } else if (LANGUAGE_WEIGHT.test(text)) {
    settled.push("language (as the recruiter states it, required or preferred)");
    settledKeys.push("language");
  } else open.push("whether the language it names is required or preferred");
  return { settled, open, settledKeys };
}

const ASKS: Record<IntakeField, RegExp> = {
  location:
    /\b(locations?|on-?site|hybrid|remote|commut\w*|radius|work mode|metro|relocat\w*)\b|地点|地区|工作范围|办公|通勤|远程|现场|驻场|常驻|都会区|搬迁/i,
  years:
    /\b(years?|yrs?|seniority range|experience range|upper (?:limit|range|bound))\b|年限|经验上限|经验范围|几年|年以上/i,
  language:
    /\b(language|english|mandarin|bilingual|chinese|cantonese|japanese|korean|spanish)\b|语言|英语|普通话|双语|中文|粤语|日语|韩语/i,
};

/** The settled intake fact a question asks about again, if any. */
export function settledFactAsked(question: string, recruiterText: string): IntakeField | undefined {
  const { settledKeys } = intakeFields(recruiterText);
  return settledKeys.find((key) => ASKS[key].test(question));
}

export const settledFactNote = (field: IntakeField) =>
  `Not asked: the recruiter's own words already settle the ${field === "years" ? "years of experience" : field === "location" ? "location and work mode" : "language requirement"}. Never ask about it, ask to confirm it${field === "years" ? ", or ask for a cap on stated years (propose one in the brief as a preference)" : ""}. Ask only about a fact still open that changes who is searched for; if none is, issue the calibration searches now with no question.`;

/** What the role's team is told before its first step about the facts its question may cover. */
export function intakeFieldsNote(text: string): string {
  const { settled, open } = intakeFields(text);
  const known = `Settled by the recruiter's words: ${settled.join("; ")}. Never ask about these, ask to confirm them, or ask for a cap on stated years (propose one in the brief as a preference).`;
  return open.length
    ? `${known} Still open: ${open.join("; ")}. Ask the first clarifying question now with ask_user, in the recruiter's language, with no role read or assessment first, about the open fact that most changes who is searched for.`
    : `${known} Nothing else needs a question unless the JD leaves out a fact that changes who is searched for: issue the calibration searches now, in this first step, with no question.`;
}
