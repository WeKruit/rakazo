import type { ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  RecruitingCandidatesToolInputSchema,
  RecruitingRoleToolInputSchema,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { builtinAgentTools } from "./builtin-tools.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import { jsonSchemaParameters, parametersFor } from "./pi-runtime.js";

describe("jsonSchemaParameters", () => {
  it("preserves candidate list/source pagination and rejects model-selected scope", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_candidates")!;
    expect(tool).toBeDefined();
    const parameters = parametersFor(tool);
    const wire = JSON.parse(JSON.stringify(parameters));
    const inputs: ToolCall["arguments"][] = [
      { operation: "list" },
      { operation: "list", query: "Example Candidate", cursor: "opaque+/=", limit: 100 },
      { operation: "sources", candidateKey: "candidate", cursor: "unchanged", limit: 1 },
    ];
    for (const input of inputs) {
      expect(RecruitingCandidatesToolInputSchema.parse(input)).toEqual(input);
      expect(parseConnectorToolArgs(wire, input)).toEqual(input);
      expect(
        validateToolArguments(
          { name: tool.name, description: tool.description, parameters },
          { type: "toolCall", id: "synthetic-candidate-read", name: tool.name, arguments: input },
        ),
      ).toEqual(input);
      for (const override of [
        { actor: { userId: "foreign" } },
        { roleId: "foreign" },
        { spaceId: "foreign" },
        { threadId: "foreign" },
      ])
        expect(() => parseConnectorToolArgs(wire, { ...input, ...override })).toThrow();
    }
    for (const input of [
      { operation: "list", limit: 0 },
      { operation: "list", limit: 101 },
      { operation: "list", query: "x".repeat(241) },
      { operation: "sources" },
      { operation: "sources", candidateKey: "candidate", query: "Example" },
    ]) {
      expect(() => parseConnectorToolArgs(tool.inputSchema, input)).toThrow();
      expect(() => RecruitingCandidatesToolInputSchema.parse(input)).toThrow();
    }
  });

  it.each([
    "recruiting_role",
    "recruiting_research",
    "recruiting_feedback",
    "remember",
    "save_shared_memory",
  ])("preserves exact human quote guidance in the %s model schema", (name) => {
    const tool = builtinAgentTools.find((entry) => entry.name === name)!;
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    expect(JSON.stringify(wire)).toContain(
      "One exact contiguous substring from one actual current human text block, preserving whitespace; do not normalize whitespace or join blocks.",
    );
  });

  it("explains operation-specific role inputs without inventing source identifiers", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_role")!;
    for (const field of [
      "title",
      "sourceRefs:[]",
      "criteria",
      "preferences:[]",
      "definitionQuestions:[]",
      "intent",
    ])
      expect(tool.description).toContain(field);
    expect(tool.description).toContain("runtime attaches the verified current human message");
    expect(tool.description).toContain("Never invent message IDs, artifact IDs or read timestamps");
    expect(tool.description).not.toContain("expectedRevision:0");
    expect(tool.description).toContain("For JD URLs, call web_fetch before creating the role");
    expect(tool.description).toContain("sourceMaterial");
    expect(tool.description).toContain("before role creation");
    expect(tool.description).toContain("not complete JD coverage");
    for (const guidance of [
      'expression:{kind:"atom",id:',
      'anchor:{kind:"artifact",artifact:sourceMaterial.artifact,locator:',
      "readAt:sourceMaterial.readAt",
      "url:sourceMaterial.url",
      "Assign stable local criterion, atom and source IDs",
      "quote:<one exact contiguous excerpt of returned text>",
      "Never omit words or join separate passages within a quote; cite separate excerpts with separate sourceRefs.",
      "Correct deterministic schema rejections using the actual validator error and read receipt",
    ])
      expect(tool.description).toContain(guidance);
    expect(tool.description).toContain(
      "copy unchanged criteria, IDs, sourceRefs, preferences and definitionQuestions",
    );
    expect(tool.description).not.toContain(
      "For the current human JD URL, description or attachment request, send sourceRefs:[]",
    );
    const incomplete = {
      operation: "create",
      title: "Synthetic engineer",
      sourceRefs: [],
      criteria: [],
      definitionQuestions: [],
    };
    const parsed = RecruitingRoleToolInputSchema.safeParse(incomplete);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Incomplete role creation must not validate");
    expect(parsed.error.issues.map((issue) => issue.path.join("."))).toEqual([
      "preferences",
      "intent",
    ]);
    const complete = {
      ...incomplete,
      preferences: [],
      intent: { basis: "direct", quote: "Create a role for this job description" },
    };
    expect(RecruitingRoleToolInputSchema.parse(complete)).toEqual(complete);
    expect(parseConnectorToolArgs(tool.inputSchema, complete)).toEqual(complete);
    expect(
      parseConnectorToolArgs(JSON.parse(JSON.stringify(parametersFor(tool))), complete),
    ).toEqual(complete);
    expect(
      RecruitingRoleToolInputSchema.safeParse({ ...complete, expectedRevision: 0 }).success,
    ).toBe(false);
    const revise = { ...complete, operation: "revise", roleId: "role", expectedRevision: 2 };
    expect(parseConnectorToolArgs(tool.inputSchema, revise)).toEqual(revise);
    expect(() =>
      parseConnectorToolArgs(tool.inputSchema, {
        ...complete,
        operation: "revise",
        roleId: "role",
      }),
    ).toThrow();
    const source = {
      id: "jd-material",
      kind: "original_material",
      anchor: {
        kind: "artifact",
        artifact: { artifactId: "read-jd", sha256: "b".repeat(64) },
        locator: "text",
      },
      readState: "read",
      readAt: "2026-10-16T00:00:00.000Z",
      url: "https://example.test/job",
      quote: "Five years of engineering experience",
    };
    const sourced = {
      ...complete,
      sourceRefs: [source],
      criteria: [
        {
          id: "experience",
          priority: "hard",
          expression: { kind: "atom", id: "engineering", statement: source.quote },
          sourceRefs: [source],
          definitionQuestions: [],
        },
      ],
    };
    expect(RecruitingRoleToolInputSchema.parse(sourced)).toEqual(sourced);
    const wire = JSON.parse(JSON.stringify(parametersFor(tool)));
    expect(
      validateToolArguments(
        { name: tool.name, description: tool.description, parameters: wire },
        { type: "toolCall", id: "create-jd", name: tool.name, arguments: sourced },
      ),
    ).toEqual(sourced);
    const { readState: _state, ...withoutState } = source;
    const { readAt: _time, ...withoutTime } = source;
    const { locator: _locator, ...withoutLocator } = source.anchor;
    const invalid = [
      {
        ...sourced,
        criteria: [
          { ...sourced.criteria[0], expression: { kind: "atom", statement: source.quote } },
        ],
      },
      ...[
        withoutState,
        withoutTime,
        { ...source, anchor: withoutLocator, locator: "text" },
        { ...source, anchor: { kind: "artifact", ...source.anchor.artifact, locator: "text" } },
      ].map((badSource) => ({
        ...sourced,
        criteria: [{ ...sourced.criteria[0], sourceRefs: [badSource] }],
      })),
    ];
    for (const input of invalid) {
      expect(RecruitingRoleToolInputSchema.safeParse(input).success).toBe(false);
      expect(() =>
        validateToolArguments(
          { name: tool.name, description: tool.description, parameters: wire },
          { type: "toolCall", id: "invalid-create-jd", name: tool.name, arguments: input },
        ),
      ).toThrow();
    }
    expect(incomplete.sourceRefs).toEqual([]);
  });

  it("explains every required preparation field after root union normalization", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_research")!;
    for (const field of [
      "expectedRoleRevision",
      "clientNonce",
      "instructions",
      "output",
      "recallScope",
      "intent",
      "mcpServerId",
      "taskId",
    ])
      expect(tool.description).toContain(field);
    expect(tool.description).toContain("recallScope:null");
  });

  it("preserves all five closed recruiting research inputs through the installed Pi validator", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_research");
    expect(tool).toBeDefined();
    expect(tool!.readOnly).not.toBe(true);
    const parameters = parametersFor(tool!);
    const wire = JSON.parse(JSON.stringify(parameters));
    const round = {
      expectedRoleRevision: 1,
      purpose: "calibration",
      approvalEffectId: "documents-approval",
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

  it("explains full reassessment inputs and exact source preservation after validation errors", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_assess")!;
    for (const guidance of [
      "Reassess shape:",
      "questions:[]",
      "atomJudgments:[]",
      "employmentEvaluations:[]",
      "including quote, selection and readAt",
      "Correct a deterministic validation rejection",
    ])
      expect(tool.description).toContain(guidance);
  });

  it("preserves typed assessment sources, reassessment and original-card questions through the native Pi validator", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_assess")!;
    const parameters = parametersFor(tool);
    const wire = JSON.parse(JSON.stringify(parameters));
    const quote = "  Built geometry transforms.\r\n";
    const save = {
      operation: "save",
      roleId: "role-1",
      roleRevisionId: "role-revision-1",
      candidateKey: "candidate-1",
      expectedRevision: 0,
      facts: [
        {
          id: "fact-1",
          kind: "statement",
          statement: "Personally implemented transforms",
          sourceRefIds: ["source-1"],
        },
      ],
      questions: [],
      sourceRefs: [
        {
          id: "source-1",
          kind: "original_material",
          anchor: { kind: "message", messageId: "message-1", locator: "text" },
          readState: "read",
          readAt: "2026-10-16T00:00:00.000Z",
          quote,
          selection: { kind: "message_text", blockIndex: 0, start: 0, end: quote.length },
        },
      ],
      atomJudgments: [
        {
          atomId: "geometry",
          verdict: "met",
          factIds: ["fact-1"],
          evidence: ["source-1"],
          missing: [],
        },
      ],
      employmentEvaluations: [],
    };
    const inputs: ToolCall["arguments"][] = [
      save,
      { operation: "read", candidateKey: "candidate-1" },
      { ...save, operation: "reassess", expectedRevision: 1, atomJudgments: [] },
      {
        operation: "ask",
        roleId: save.roleId,
        roleRevisionId: save.roleRevisionId,
        target: {
          kind: "candidate",
          candidateKey: save.candidateKey,
          assessmentVersion: 1,
          criterionIds: ["geometry"],
        },
        question: "  What did you implement?  ",
        options: ["Code", "Library"],
      },
    ];
    for (const input of inputs) {
      for (const schema of [tool.inputSchema, wire]) {
        expect(parseConnectorToolArgs(schema, input)).toEqual(input);
        expect(() => parseConnectorToolArgs(schema, { ...input, hardGate: "met" })).toThrow();
      }
      expect(
        validateToolArguments(
          { name: tool.name, description: tool.description, parameters },
          { type: "toolCall", id: "assessment-call", name: tool.name, arguments: input },
        ),
      ).toEqual(input);
    }
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
