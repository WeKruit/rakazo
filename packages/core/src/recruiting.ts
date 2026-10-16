import type { RecruitingPreferenceFeedbackInput, Verdict } from "@rakazo/contracts";

export function applyRecruitingPreferenceEdit(
  content: string,
  preference: RecruitingPreferenceFeedbackInput,
): { content: string; anchor: { start: number; end: number; quote: string } | null } {
  if (preference.operation === "add") {
    const prefix = content ? `${content}\n\n` : "";
    return {
      content: prefix + preference.content,
      anchor: {
        start: prefix.length,
        end: prefix.length + preference.content.length,
        quote: preference.content,
      },
    };
  }
  const { start, end, quote } = preference.anchor;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > content.length ||
    content.slice(start, end) !== quote ||
    splitsSurrogatePair(content, start) ||
    splitsSurrogatePair(content, end)
  )
    throw new Error("Preference anchor does not match the loaded memory revision");
  const replacement = preference.operation === "replace" ? preference.content : "";
  return {
    content: content.slice(0, start) + replacement + content.slice(end),
    anchor: replacement ? { start, end: start + replacement.length, quote: replacement } : null,
  };
}

function splitsSurrogatePair(content: string, index: number): boolean {
  const before = content.charCodeAt(index - 1);
  const after = content.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function allOf(items: readonly Verdict[]): Verdict {
  if (items.includes("unmet")) return "unmet";
  return items.length > 0 && items.every((item) => item === "met") ? "met" : "unknown";
}

export function anyOf(items: readonly Verdict[]): Verdict {
  if (items.includes("met")) return "met";
  return items.length > 0 && items.every((item) => item === "unmet") ? "unmet" : "unknown";
}

export function not(value: Verdict): Verdict {
  return value === "unknown" ? "unknown" : value === "met" ? "unmet" : "met";
}

/** Callers supply only hard results, including unknown for unresolved definitions. */
export function hardGate(items: readonly Verdict[]): Verdict {
  return allOf(items);
}
