import * as z from "zod";

/**
 * A helper asked for a result in a given JSON Schema ends with JSON that matches it (Workloop's
 * structured output). The result is checked here; one correction turn is allowed before the
 * caller gets the helper's text with the reason it does not match.
 */
export type StructuredCheck = { ok: true; json: string } | { ok: false; reason: string };

/** A usable output schema from tool arguments, or why it cannot be used. */
export function outputSchema(value: unknown): z.ZodType | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    return "output_schema must be a JSON Schema object.";
  try {
    return z.fromJSONSchema(value as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    return `output_schema is not a usable JSON Schema: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The JSON in a reply: the whole text, or its first fenced block. */
function jsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/i);
  return (fenced?.[1] ?? text).trim();
}

export function checkStructuredOutput(text: string, schema: z.ZodType): StructuredCheck {
  let value: unknown;
  try {
    value = JSON.parse(jsonText(text));
  } catch {
    return { ok: false, reason: "The reply is not JSON." };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    return {
      ok: false,
      reason: parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  return { ok: true, json: JSON.stringify(parsed.data) };
}

/** Model-facing: the correction turn sent to a helper whose result did not match. */
function structuredOutputRetry(reason: string): string {
  return `Your result does not match the required JSON Schema (${reason}). Reply with only the corrected JSON, no other text.`;
}

/** Model-facing: the helper's instruction when an output schema is set. */
function structuredOutputInstruction(schema: unknown): string {
  return `End with only a JSON value that matches this JSON Schema, no other text: ${JSON.stringify(schema)}`;
}

const ended = (result: string) => result === "stopped" || result.startsWith("Subagent failed:");

/** One helper turn whose result must match the caller's schema, with one correction turn. */
export async function structuredTurn(
  turn: (prompt: string) => Promise<string>,
  task: string,
  declared: unknown,
  schema: z.ZodType,
): Promise<string> {
  let result = await turn(`${task}\n\n${structuredOutputInstruction(declared)}`);
  if (ended(result)) return result;
  let check = checkStructuredOutput(result, schema);
  if (!check.ok) {
    result = await turn(structuredOutputRetry(check.reason));
    if (ended(result)) return result;
    check = checkStructuredOutput(result, schema);
  }
  return check.ok
    ? check.json
    : `${result}\n\n(This does not match output_schema: ${check.reason})`;
}
