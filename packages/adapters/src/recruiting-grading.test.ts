import { describe, expect, it } from "vitest";
import {
  GRADE_TOOL_CALL_LIMIT,
  gradingToolRefusal,
  gradingTools,
  RECRUITING_GRADE_NONCE_PREFIX,
} from "./recruiting-grading.js";

describe("gradingToolRefusal", () => {
  const start = `${RECRUITING_GRADE_NONCE_PREFIX}thread:batch`;
  const save = "recruiting-research-wake:task:1";
  const never = [
    ["recruiting_role", { operation: "update" }],
    ["recruiting_research", { operation: "calibration_round" }],
    ["recruiting_feedback", { target: "round", operation: "approve" }],
    ["recruiting_shortlist", {}],
    ["ask_user", {}],
    ["message_user", {}],
    ["handoff_to_bot", {}],
    ["scratchpad_add", {}],
    ["mcp__research__reply", { task_id: "t" }],
    ["mcp__research__research", { task_id: "t" }],
    ["mcp__mail__send_email", {}],
    ["connectors_execute_tool", { id: "server-1:reply", arguments: { task_id: "t" } }],
    ["connectors_execute_tool", { id: "server-1:research", arguments: { task_id: "t" } }],
    ["connectors_execute_tool", { id: "server-2:send_email", arguments: {} }],
    ["connectors_execute_tool", { id: "mcp__mail__send_email", arguments: {} }],
  ] as const;
  const either = [
    ["recruiting_candidates", { operation: "list" }],
    ["skill_read", {}],
    ["connectors_search_tools", { query: "research" }],
    ["connectors_load_tool", { id: "server-1:research" }],
    // One status read after starting is harmless.
    ["mcp__research__get_task", { task_id: "t" }],
    // An agent run's grades are saved in the turn that ran it.
    ["recruiting_research", { operation: "save_results" }],
  ] as const;
  const reads = [
    ["mcp__research__get_rows", { task_id: "t" }],
    ["connectors_execute_tool", { id: "mcp__research__get_rows", arguments: { task_id: "t" } }],
  ] as const;
  const starts = [
    ["mcp__research__research", { query: "grade" }],
    ["connectors_execute_tool", { id: "server-1:research", arguments: { prompt: "grade" } }],
  ] as const;

  it("lets the request turn grade with an agent run and save it", () => {
    expect(
      gradingToolRefusal("mcp__people-search__agent_run", { query: "Grade" }, start),
    ).toBeUndefined();
    expect(
      gradingToolRefusal("recruiting_research", { operation: "save_results" }, start),
    ).toBeUndefined();
  });

  it("lets the quality check save its own grades and open no page", () => {
    expect(
      gradingToolRefusal("web_fetch", { url: "https://www.linkedin.com/in/a" }, start),
    ).toMatch(/saved profile/i);
    expect(
      gradingToolRefusal("recruiting_research", { operation: "save_grades" }, start),
    ).toBeUndefined();
    expect(gradingToolRefusal("web_search", { query: "a" }, start)).toMatch(/end the turn/i);
  });

  it("lets the request turn only start the research, then end", () => {
    for (const [name, args] of [...either, ...starts])
      expect(gradingToolRefusal(name, args, start)).toBeUndefined();
    for (const [name, args] of [...never, ...reads])
      expect(gradingToolRefusal(name, args, start)).toMatch(/end the turn/i);
  });

  it("lets the turn the research's finish wakes only read and save its rows", () => {
    for (const [name, args] of [...either, ...reads])
      expect(gradingToolRefusal(name, args, save)).toBeUndefined();
    for (const [name, args] of [...never, ...starts])
      expect(gradingToolRefusal(name, args, save)).toMatch(/only reads/);
  });

  it("tells a grading turn to end once it has used its tool calls", () => {
    expect(
      gradingToolRefusal(
        "mcp__research__get_rows",
        { task_id: "t" },
        save,
        GRADE_TOOL_CALL_LIMIT - 1,
      ),
    ).toBeUndefined();
    expect(
      gradingToolRefusal("mcp__research__get_rows", { task_id: "t" }, save, GRADE_TOOL_CALL_LIMIT),
    ).toMatch(/End the turn now/);
  });
});

describe("gradingTools", () => {
  const all = [
    "recruiting_candidates",
    "recruiting_research",
    "recruiting_role",
    "request_connection",
    "schedule_update",
    "connectors_search_tools",
    "connectors_execute_tool",
    "mcp__research__research",
    "mcp__research__get_task",
    "mcp__research__get_rows",
    "mcp__research__reply",
    "mcp__people-search__web_search_advanced_exa",
  ].map((name) => ({ name }));
  const names = (nonce: string) => gradingTools(all, nonce).map((tool) => tool.name);

  it("gives the request turn only what starting the grading needs", () => {
    expect(names(`${RECRUITING_GRADE_NONCE_PREFIX}thread:batch`)).toEqual([
      "recruiting_candidates",
      "recruiting_research",
      "mcp__research__research",
      "mcp__research__get_task",
    ]);
  });

  it("gives the save turn only the reads and the save", () => {
    expect(names("recruiting-research-wake:task:1")).toEqual([
      "recruiting_candidates",
      "recruiting_research",
      "mcp__research__get_task",
      "mcp__research__get_rows",
    ]);
  });

  it("keeps the connector catalog when the research service is not loaded directly", () => {
    const catalog = all.filter((tool) => !tool.name.startsWith("mcp__research__"));
    expect(
      gradingTools(catalog, `${RECRUITING_GRADE_NONCE_PREFIX}thread:batch`).map((t) => t.name),
    ).toEqual([
      "recruiting_candidates",
      "recruiting_research",
      "connectors_search_tools",
      "connectors_execute_tool",
    ]);
  });
});
