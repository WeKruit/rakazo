import {
  DisabledBuiltinToolsSchema,
  disabledBuiltinToolSet,
  RecruitingCandidatesToolInputSchema,
  RecruitingCrmImportInputSchema,
  RecruitingCrmTargetToolInputSchema,
  RecruitingReplyInputSchema,
  RecruitingShortlistToolInputSchema,
} from "@rakazo/contracts";
import {
  RECRUITING_DEFAULT_BOTS,
  RECRUITING_DEFAULT_SKILLS,
  RECRUITING_DISABLED_BUILTIN_TOOLS,
  recruitingAgentScope,
} from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { builtinAgentTools } from "./builtin-tools.js";
import { selectBuiltinToolsForRun } from "./executor.js";
import { normalizeOpenAiToolParameters } from "./openai-tool-parameters.js";

describe("native recruiting approval tool", () => {
  it("offers scoped saved candidate reads as a disableable read-only tool", () => {
    const tool = builtinAgentTools.find((entry) => entry.name === "recruiting_candidates");
    expect(tool).toBeDefined();
    expect(tool?.readOnly).toBe(true);
    expect(tool?.inputSchema).toEqual(
      z.toJSONSchema(RecruitingCandidatesToolInputSchema, { io: "input" }),
    );
    expect(DisabledBuiltinToolsSchema.parse(["recruiting_candidates"])).toEqual([
      "recruiting_candidates",
    ]);
    expect(tool?.description).toContain("artifact_read");
    expect(tool?.description).toContain("never choose the first match");
  });

  it("uses the shared CRM contracts and honors native tool disable settings", () => {
    const contracts = [
      ["recruiting_crm_target", RecruitingCrmTargetToolInputSchema],
      ["recruiting_crm_import", RecruitingCrmImportInputSchema],
      ["recruiting_reply", RecruitingReplyInputSchema],
      ["recruiting_shortlist", RecruitingShortlistToolInputSchema],
    ] as const;
    const names = contracts.map(([name]) => name);
    expect(DisabledBuiltinToolsSchema.parse(names)).toEqual(names);
    expect([...disabledBuiltinToolSet(names)]).toEqual(names);
    for (const [name, schema] of contracts) {
      const tool = builtinAgentTools.find((entry) => entry.name === name);
      expect(tool?.inputSchema).toEqual(z.toJSONSchema(schema, { io: "input" }));
      expect(tool?.readOnly).not.toBe(true);
    }
  });

  it("guides reusable preferences through one exact edit without confusing it with a full document", () => {
    const feedback = builtinAgentTools.find((tool) => tool.name === "recruiting_feedback");
    expect(feedback?.description).toContain(
      'prefer one recruiting_feedback call with target:"preference"',
    );
    expect(feedback?.description).toContain(
      'operation:"add" appends the full exact preference text',
    );
    expect(feedback?.description).toContain('operation:"replace" replaces only the anchored span');
    expect(feedback?.description).toContain('operation:"revoke" removes only that span');
    expect(feedback?.description).toContain("unknown write outcome");
    expect(feedback?.description).toContain("path preferences/recruiting-collaboration.md");
    expect(feedback?.description).toContain("never start another preference file");
    expect(feedback?.description).toContain(
      "A pasted job description or a new role is never a preference",
    );

    for (const name of ["remember", "save_shared_memory"]) {
      const tool = builtinAgentTools.find((entry) => entry.name === name)!;
      expect(tool.description).toContain("prefer edit:{find,replace}");
      expect(tool.inputSchema.required).not.toContain("content");
      expect((tool.inputSchema.properties as Record<string, unknown>).edit).toMatchObject({
        required: ["find", "replace"],
      });
    }
    const search = builtinAgentTools.find((entry) => entry.name === "search_history")!;
    expect(
      (search.inputSchema.properties as Record<string, { enum?: string[] }>).scope?.enum,
    ).toEqual(["conversation", "mine"]);
    expect(search.description).toContain("never other people's");
    for (const name of ["remember", "save_shared_memory", "save_memory"]) {
      const tool = builtinAgentTools.find((entry) => entry.name === name);
      expect(tool?.description).toContain(
        'prefer one recruiting_feedback call with target:"preference"',
      );
      // Preferences go through recruiting_feedback; the memory tools no longer carry its schema.
      expect(tool?.description).not.toContain("recruitingFeedback");
      expect(
        (tool!.inputSchema.properties as Record<string, unknown>).recruitingFeedback,
      ).toBeUndefined();
    }
  });
});

describe("recruiting tool budget", () => {
  // Every Kruit call carries these definitions: 40 tools, about 7.7 times its instructions on 11-16.
  // Workloop pins its prompt the same way (TestPrompt_FitsTheBudget). Lower it, never raise it:
  // move procedure into skills and rarely used tools behind tool search instead. Raised once on
  // 11-20 by the user's decision to give the base agent back skills, sub-agents and the scratchpad.
  it.each(RECRUITING_DEFAULT_BOTS)(
    "keeps the built-in tools a $name turn always carries within budget",
    (bot) => {
      const tools = selectBuiltinToolsForRun({
        graphicalToolsAllowed: false,
        groupId: "role-group",
        trigger: "user",
        semanticMemoryEnabled: true,
        messagingChannelRun: false,
        historyRetrievalEnabled: true,
        disabledBuiltinTools: RECRUITING_DISABLED_BUILTIN_TOOLS,
        allowedBuiltinTools: bot.tools,
      });
      const chars = tools.reduce(
        (total, tool) =>
          total +
          (tool.description?.length ?? 0) +
          JSON.stringify(normalizeOpenAiToolParameters(tool.inputSchema)).length,
        0,
      );
      // +100 (11-21): grades accept a degree given as an object instead of refusing the save.
      expect(chars).toBeLessThanOrEqual(96_600);
    },
  );
});

describe("recruiting agents' own tool lists", () => {
  const builtinNames = new Set(builtinAgentTools.map((tool) => tool.name));
  const scopes = [
    ...RECRUITING_DEFAULT_BOTS.map((bot) => ({ bot, groupId: "role-group" })),
    { bot: RECRUITING_DEFAULT_BOTS[0], groupId: "recruiting-global-abc" },
  ].map(({ bot, groupId }) => ({
    label: `${bot.name} in ${groupId}`,
    bot,
    scope: recruitingAgentScope({ spawnKey: `recruiting:u:${bot.key}` }, groupId)!,
  }));

  it.each(scopes)("$label lists only real built-in tools", ({ scope }) => {
    for (const name of scope.tools) expect(builtinNames, name).toContain(name);
  });

  // A skill or instruction that names a tool its agent is not offered sends the model looking
  // for it: each listed skill's builtin tools are in that agent's own list.
  it.each(scopes.filter(({ label }) => !label.includes("global")))(
    "$label is offered every built-in tool its instructions and skills name",
    ({ bot, scope }) => {
      const text = [
        bot.instructions,
        ...RECRUITING_DEFAULT_SKILLS.filter((skill) => scope.skills.includes(skill.name)).map(
          (skill) => skill.body,
        ),
      ].join("\n");
      for (const name of builtinNames)
        if (new RegExp(`\\b${name}\\b`).test(text)) expect(scope.tools, name).toContain(name);
    },
  );
});
