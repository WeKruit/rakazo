import { RECRUITING_GRADE_NONCE_PREFIX } from "@rakazo/db";

export { RECRUITING_GRADE_NONCE_PREFIX };
/** Tools a grading turn may use: read the role's people, run the grading research, save its rows. */
const GRADING_BUILTIN_TOOLS = new Set([
  "artifact_read",
  "recruiting_candidates",
  "search_history",
  "read_history",
  "skill_read",
  "task_catalog",
]);
const GRADING_RESEARCH_OPERATIONS = new Set(["status", "rows", "save_results", "save_grades"]);
/** The request turn only starts research; the turn its finish wakes reads and saves the grades. */
// A people-search agent run grades the batch within the turn; a research request finishes later.
const START_PROVIDER_TOOLS = new Set(["research", "credits", "agent_run"]);
/** A status read after starting is harmless, so the request turn may make one. */
const START_READ_TOOLS = new Set(["get_task"]);
const SAVE_PROVIDER_TOOLS = new Set(["get_task", "get_rows"]);
/** Tool calls one grading turn may make; a batch needs far fewer, so more means it is looping. */
export const GRADE_TOOL_CALL_LIMIT = 60;
/** Past this many calls a grading turn that keeps calling after being told to end is stopped. */
export const GRADE_TOOL_CALL_STOP = 3 * GRADE_TOOL_CALL_LIMIT;
/** The connector catalog that lists and runs tools beyond the directly loaded ones. */
const CATALOG_READ_TOOLS = new Set(["connectors_search_tools", "connectors_load_tool"]);
const CATALOG_EXECUTE_TOOL = "connectors_execute_tool";

/** A research provider call this grading turn may make. */
function gradingProviderCall(tool: string, args: Record<string, unknown>, start: boolean): boolean {
  return start
    ? (START_PROVIDER_TOOLS.has(tool) && args.task_id === undefined) || START_READ_TOOLS.has(tool)
    : SAVE_PROVIDER_TOOLS.has(tool);
}

/**
 * The tools a grading turn is given, like a named agent's fixed tool list: only what its step
 * can use, so it never reaches for a search, a connection or a role change. The connector
 * catalog stays only when the research service is not loaded directly.
 */
export function gradingTools<T extends { name: string }>(
  tools: readonly T[],
  clientNonce: string | null,
): T[] {
  const start = Boolean(clientNonce?.startsWith(RECRUITING_GRADE_NONCE_PREFIX));
  const provider = (name: string) => {
    const tool = /^mcp__.+__([^_].*)$/.exec(name)?.[1];
    return tool !== undefined && gradingProviderCall(tool, {}, start);
  };
  const direct = tools.some((tool) => provider(tool.name));
  return tools.filter(
    (tool) =>
      GRADING_BUILTIN_TOOLS.has(tool.name) ||
      tool.name === "recruiting_research" ||
      provider(tool.name) ||
      (!direct && (CATALOG_READ_TOOLS.has(tool.name) || tool.name === CATALOG_EXECUTE_TOOL)),
  );
}

/** The provider tool name in a direct name (`mcp__server__tool`) or a catalog id (`server:tool`). */
function providerToolName(id: string): string | undefined {
  const direct = /^mcp__.+__([^_].*)$/.exec(id)?.[1];
  if (direct) return direct;
  const separator = id.lastIndexOf(":");
  if (separator < 0) return undefined;
  try {
    return decodeURIComponent(id.slice(separator + 1));
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Why a grading turn may not call this tool, or undefined when it may. A grading turn only grades
 * people already in Results: it never changes the role, its brief or stage, the people's status,
 * or messages anyone, whatever the model decides. The request turn (`clientNonce` with the grading
 * prefix) only starts the research; the background follow-up wakes another grading turn when it
 * finishes, and that turn only reads and saves its rows.
 */
export function gradingToolRefusal(
  name: string,
  args: Record<string, unknown>,
  clientNonce: string | null,
  calls = 0,
): string | undefined {
  if (calls >= GRADE_TOOL_CALL_LIMIT)
    return "Not run: this grading turn has used all its tool calls. End the turn now with an empty reply; anything left is picked up later.";
  const start = Boolean(clientNonce?.startsWith(RECRUITING_GRADE_NONCE_PREFIX));
  const direct = /^mcp__.+__([^_].*)$/.exec(name)?.[1];
  const executed =
    name === CATALOG_EXECUTE_TOOL ? providerToolName(String(args.id ?? "")) : undefined;
  const allowed =
    GRADING_BUILTIN_TOOLS.has(name) ||
    CATALOG_READ_TOOLS.has(name) ||
    (name === "recruiting_research" && GRADING_RESEARCH_OPERATIONS.has(String(args.operation))) ||
    (direct !== undefined && gradingProviderCall(direct, args, start)) ||
    (executed !== undefined && gradingProviderCall(executed, record(args.arguments), start));
  if (allowed) return undefined;
  return start
    ? "Not run: this turn only grades the batch: judge each listed person from the saved profile in the request and save your grades with recruiting_research save_grades (or the people-search agent run then save_results with its run id, or the research request, whose grades are saved when it finishes). End the turn with an empty reply."
    : "Not run: this turn only reads the grading research's rows and saves them with recruiting_research save_results; nothing else.";
}

/** Reply guidance for a grading turn, which nobody reads in the chat. */
export const GRADING_REPLY_GUIDANCE =
  "Grades are saved to Results, not reported in chat. Leave the final reply empty.";

/** Filter for research tasks a conversation's own turns started, leaving grading requests out. */
export const NOT_GRADING_TASK = {
  createdByRun: {
    OR: [
      { clientNonce: null },
      { NOT: { clientNonce: { startsWith: RECRUITING_GRADE_NONCE_PREFIX } } },
    ],
  },
};
