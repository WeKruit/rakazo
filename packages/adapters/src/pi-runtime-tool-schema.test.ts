import type { ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { jsonSchemaParameters, parametersFor } from "./pi-runtime.js";

describe("jsonSchemaParameters", () => {
  it("preserves all five closed recruiting research inputs through the installed Pi validator", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_research");
    expect(tool).toBeDefined();
    expect(tool!.readOnly).not.toBe(true);
    const parameters = parametersFor(tool!);
    const wire = JSON.parse(JSON.stringify(parameters));
    const round = {
      expectedRoleRevision: 1,
      clientNonce: "round-nonce",
      instructions: "  Preserve the complete current role.\r\nKeep every hard gate.\n",
      output: "  Include original evidence columns.\n",
      recallScope: "  This round only.\r\n",
      intent: { basis: "direct", quote: "Search for this role" },
    };
    const inputs: ToolCall["arguments"][] = [
      { ...round, operation: "prepare", mcpServerId: "research-server" },
      { ...round, operation: "continue", taskId: "local-task", recallScope: null },
      { operation: "start", actionId: "prepared-action" },
      { operation: "status", taskId: "local-task" },
      { operation: "rows", taskId: "local-task", limit: 7, cursor: "  opaque+/=\r\n " },
    ];
    for (const input of inputs) {
      expect(parseConnectorToolArgs(tool!.inputSchema, input)).toEqual(input);
      expect(parseConnectorToolArgs(wire, input)).toEqual(input);
      expect(
        validateToolArguments(
          { name: tool!.name, description: tool!.description, parameters },
          { type: "toolCall", id: "synthetic-research-call", name: tool!.name, arguments: input },
        ),
      ).toEqual(input);
      expect(() =>
        parseConnectorToolArgs(tool!.inputSchema, { ...input, sourceMessageId: "forged" }),
      ).toThrow();
    }
    expect(wire.type).toBe("object");
    expect(wire).not.toHaveProperty("oneOf");
  });

  it("keeps the recruiting feedback guard in native memory tool parameters", () => {
    const schema = parametersFor(builtinAgentTools.find((tool) => tool.name === "remember")!);
    expect(schema.properties).toHaveProperty("recruitingFeedback");
    expect(schema.required).not.toContain("recruitingFeedback");
  });

  it("preserves recursive recruiting criteria through the native Pi tool schema", () => {
    const tool = builtinAgentTools.find((tool) => tool.name === "recruiting_role")!;
    const parameters = parametersFor(tool);
    const wire = JSON.parse(JSON.stringify(parameters));
    const input: ToolCall["arguments"] = {
      operation: "create",
      expectedRevision: 0,
      title: "Synthetic engineer",
      sourceRefs: [],
      criteria: [
        {
          id: "geometry",
          priority: "hard",
          sourceRefs: [],
          definitionQuestions: [],
          expression: {
            kind: "all",
            items: [
              { kind: "atom", id: "implementation", statement: "Personal implementation" },
              {
                kind: "not",
                item: { kind: "atom", id: "xml", statement: "Only XML configuration" },
              },
            ],
          },
        },
      ],
      preferences: [],
      definitionQuestions: [],
      intent: { basis: "direct", quote: "Require personal implementation" },
    };
    expect(parseConnectorToolArgs(tool.inputSchema, input)).toEqual(input);
    expect(parseConnectorToolArgs(wire, input)).toEqual(input);
    expect(
      validateToolArguments(
        { name: tool.name, description: tool.description, parameters },
        { type: "toolCall", id: "synthetic-role-call", name: tool.name, arguments: input },
      ),
    ).toEqual(input);
    expect(wire.type).toBe("object");
    expect(wire).not.toHaveProperty("oneOf");
  });

  it("exposes fields from a locally referenced allOf branch", () => {
    const tool = {
      name: "catalog_search",
      description: "Search a named catalog",
      inputSchema: {
        $defs: {
          "Base/filter": {
            type: "object",
            properties: { catalog: { type: "string", minLength: 1 } },
            required: ["catalog"],
          },
        },
        allOf: [
          { $ref: "#/$defs/Base~1filter" },
          { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        ],
      },
    };
    const original = JSON.stringify(tool.inputSchema);
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    expect(wire.properties).toEqual({
      catalog: { type: "string", minLength: 1 },
      query: { type: "string" },
    });
    expect(wire.required).toEqual(["catalog", "query"]);
    expect(wire).not.toHaveProperty("allOf");
    for (const schema of [tool.inputSchema, wire]) {
      expect(parseConnectorToolArgs(schema, { catalog: "books", query: "typescript" })).toEqual({
        catalog: "books",
        query: "typescript",
      });
      expect(() => parseConnectorToolArgs(schema, { query: "typescript" })).toThrow();
    }
    expect(JSON.stringify(tool.inputSchema)).toBe(original);
  });

  it("keeps root allOf fields and intersecting constraints through the Pi wire path", () => {
    const tool = {
      name: "catalog_page",
      description: "Read a bounded catalog page",
      inputSchema: {
        allOf: [
          {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1 } },
            required: ["limit"],
          },
          {
            type: "object",
            properties: { limit: { type: "integer", maximum: 10 } },
          },
        ],
      },
    };
    const original = JSON.stringify(tool.inputSchema);
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    expect(wire).toEqual({
      type: "object",
      properties: {
        limit: {
          allOf: [
            { type: "integer", minimum: 1 },
            { type: "integer", maximum: 10 },
          ],
        },
      },
      required: ["limit"],
    });
    expect(parseConnectorToolArgs(wire, { limit: 5 })).toEqual(
      parseConnectorToolArgs(tool.inputSchema, { limit: 5 }),
    );
    for (const args of [{}, { limit: 0 }, { limit: 11 }, { limit: 1.5 }]) {
      expect(() => parseConnectorToolArgs(tool.inputSchema, args)).toThrow();
      expect(() => parseConnectorToolArgs(wire, args)).toThrow();
    }
    expect(JSON.stringify(tool.inputSchema)).toBe(original);
  });

  it("keeps allOf branch fields alongside root properties and required fields", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "catalog_search",
          description: "Search a named catalog",
          inputSchema: {
            type: "object",
            properties: { catalog: { type: "string" } },
            required: ["catalog"],
            allOf: [
              {
                type: "object",
                properties: { query: { type: "string", minLength: 1 } },
                required: ["query"],
              },
            ],
          },
        }),
      ),
    );
    expect(wire).toEqual({
      type: "object",
      properties: { catalog: { type: "string" }, query: { type: "string", minLength: 1 } },
      required: ["catalog", "query"],
    });
  });

  it("preserves an allOf alternative before flattening an enclosing root union", () => {
    const wire = JSON.parse(
      JSON.stringify(
        parametersFor({
          name: "catalog_lookup",
          description: "Look up a catalog entry",
          inputSchema: {
            anyOf: [
              {
                allOf: [
                  { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
                  {
                    type: "object",
                    properties: { region: { type: "string" } },
                    required: ["region"],
                  },
                ],
              },
              { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            ],
          },
        }),
      ),
    );
    expect(wire).toEqual({
      type: "object",
      properties: { id: { type: "string" }, region: { type: "string" }, query: { type: "string" } },
    });
  });

  it("keeps model-facing nullable parameters compatible with connector validation", () => {
    const tool = {
      name: "catalog_lookup",
      description: "Look up catalog entries",
      inputSchema: {
        type: "object",
        properties: { enabled: { type: ["boolean", "null"] } },
        required: ["enabled"],
      },
    };
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    for (const enabled of [true, false, null]) {
      expect(parseConnectorToolArgs(wire, { enabled })).toEqual(
        parseConnectorToolArgs(tool.inputSchema, { enabled }),
      );
    }
    expect(() => parseConnectorToolArgs(wire, { enabled: "false" })).toThrow();
    expect(() => parseConnectorToolArgs(wire, {})).toThrow();
  });

  it("preserves nullable object fields instead of advertising strings", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: {
        filter: {
          type: ["object", "null"],
          properties: { enabled: { type: "boolean" } },
          required: ["enabled"],
          additionalProperties: false,
        },
      },
      required: ["filter"],
    });
    expect(JSON.parse(JSON.stringify(schema))).toEqual({
      type: "object",
      required: ["filter"],
      properties: {
        filter: {
          anyOf: [
            {
              type: "object",
              properties: { enabled: { type: "boolean" } },
              required: ["enabled"],
              additionalProperties: false,
            },
            { type: "null" },
          ],
        },
      },
    });
  });

  it("preserves null branches in anyOf", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: { cursor: { anyOf: [{ type: "string" }, { type: "null" }] } },
    });
    expect(JSON.parse(JSON.stringify(schema)).properties.cursor).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("preserves nullable array items and array constraints", () => {
    const schema = jsonSchemaParameters({
      type: "object",
      properties: {
        values: { type: "array", items: { type: ["boolean", "null"] }, minItems: 1 },
      },
    });
    expect(JSON.parse(JSON.stringify(schema)).properties.values).toEqual({
      type: "array",
      minItems: 1,
      items: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    });
  });

  it("keeps a string enum's allowed values, in order, as a plain enum", () => {
    // A literal union serialises as anyOf/const, which some gateways flatten to {} so the
    // model never sees the allowed values; {type: "string", enum} survives them.
    const schema = jsonSchemaParameters({
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", "slow"] } },
      required: ["mode"],
    }) as unknown as { properties: { mode: Record<string, unknown> } };
    const mode = JSON.parse(JSON.stringify(schema.properties.mode));
    expect(mode).toEqual({ type: "string", enum: ["fast", "slow"] });
  });

  it("accepts a nullable enum without throwing", () => {
    expect(() =>
      jsonSchemaParameters({
        type: "object",
        properties: { cursor: { type: ["string", "null"], enum: ["a", "b", null] } },
      }),
    ).not.toThrow();
  });

  it("accepts enums whose members are objects or arrays", () => {
    expect(() =>
      jsonSchemaParameters({
        type: "object",
        properties: { filter: { type: "object", enum: [{ kind: "all" }, ["x"]] } },
      }),
    ).not.toThrow();
  });
});

describe("update_bot parameters", () => {
  it("accepts notifyOnFinish as a boolean", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "update_bot");
    expect(tool).toBeTruthy();
    const schema = JSON.parse(JSON.stringify(parametersFor(tool!))) as Record<string, unknown>;
    expect(parseConnectorToolArgs(schema, { notifyOnFinish: false })).toEqual({
      notifyOnFinish: false,
    });
    expect(parseConnectorToolArgs(schema, { notifyOnFinish: true, name: "Scout" })).toEqual({
      notifyOnFinish: true,
      name: "Scout",
    });
    expect(() => parseConnectorToolArgs(schema, { notifyOnFinish: "false" })).toThrow();
  });

  it("still accepts avatar fields from the calling bot", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "update_bot");
    expect(tool).toBeTruthy();
    const schema = JSON.parse(JSON.stringify(parametersFor(tool!))) as Record<string, unknown>;
    expect(
      parseConnectorToolArgs(schema, {
        color: "#8B5CF6",
        artifact_id: "art-1",
        use_attached_image: true,
      }),
    ).toEqual({
      color: "#8B5CF6",
      artifact_id: "art-1",
      use_attached_image: true,
    });
  });
});
