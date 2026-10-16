import type { Verdict } from "@rakazo/contracts";

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
