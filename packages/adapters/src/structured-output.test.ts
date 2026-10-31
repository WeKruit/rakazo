import { describe, expect, it, vi } from "vitest";
import { checkStructuredOutput, outputSchema, structuredTurn } from "./structured-output.js";

const schema = {
  type: "object",
  properties: { name: { type: "string" }, years: { type: "number" } },
  required: ["name", "years"],
};

describe("structured helper output", () => {
  it("accepts matching JSON, also inside a fenced block", () => {
    const parsed = outputSchema(schema);
    if (!parsed || typeof parsed === "string") throw new Error("schema not built");
    expect(checkStructuredOutput('{"name":"Ada","years":7}', parsed)).toEqual({
      ok: true,
      json: '{"name":"Ada","years":7}',
    });
    expect(checkStructuredOutput('Here:\n```json\n{"name":"Ada","years":7}\n```', parsed).ok).toBe(
      true,
    );
  });

  it("says why a result does not match", () => {
    const parsed = outputSchema(schema);
    if (!parsed || typeof parsed === "string") throw new Error("schema not built");
    expect(checkStructuredOutput("Ada, seven years", parsed)).toEqual({
      ok: false,
      reason: "The reply is not JSON.",
    });
    const missing = checkStructuredOutput('{"name":"Ada"}', parsed);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.reason).toContain("years");
  });

  it("rejects a schema that is not an object", () => {
    expect(outputSchema("json")).toBe("output_schema must be a JSON Schema object.");
    expect(outputSchema(undefined)).toBeUndefined();
  });
});

describe("structured helper turns", () => {
  const built = () => {
    const parsed = outputSchema(schema);
    if (!parsed || typeof parsed === "string") throw new Error("schema not built");
    return parsed;
  };

  it("asks once for a correction, then returns the JSON", async () => {
    const turn = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockResolvedValueOnce("Ada has seven years.")
      .mockResolvedValueOnce('{"name":"Ada","years":7}');
    expect(await structuredTurn(turn, "Summarize Ada", schema, built())).toBe(
      '{"name":"Ada","years":7}',
    );
    expect(turn.mock.calls[0]?.[0]).toContain("JSON Schema");
    expect(turn.mock.calls[1]?.[0]).toContain("not JSON");
  });

  it("returns the text with the reason after a second miss, and passes failures through", async () => {
    const miss = vi.fn(async () => "still prose");
    expect(await structuredTurn(miss, "x", schema, built())).toContain(
      "does not match output_schema",
    );
    expect(miss).toHaveBeenCalledTimes(2);
    const failed = vi.fn(async () => "Subagent failed: model down");
    expect(await structuredTurn(failed, "x", schema, built())).toBe("Subagent failed: model down");
    expect(failed).toHaveBeenCalledOnce();
  });
});
