import type {
  ConnectorCall,
  ConnectorEvent,
  ConnectorRoute,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { z } from "zod";

export const DIRECT_TOOL_LIMIT = 20;
export const TOOL_SEARCH_LIMIT = 10;
export const SELECTED_SCHEMA_MAX_BYTES = 100_000;
export const NAME_INDEX_MAX_NAMES = 200;
export const NAME_INDEX_MAX_BYTES = 2_048;
const MAX_QUERY_LENGTH = 200;
const MAX_GROUP_LENGTH = 200;
const MAX_TOOL_NAME_LENGTH = 200;
const MAX_TOOL_ID_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 500;
export const CATALOG_SEARCH = "__catalog_search";
export const CATALOG_LOAD = "__catalog_load";
export const CATALOG_EXECUTE = "__catalog_execute";

type CatalogEntry = { id: string; tool: ConnectorTool; group: string };

export type CatalogSearchHit = {
  id: string;
  name: string;
  description: string;
  readOnly: boolean;
};

export type CatalogSearchResult =
  | { tools: CatalogSearchHit[] }
  | { index: Array<{ group: string; names: string[] }> }
  | { groups: Array<{ group: string; count: number }>; hint: string }
  | { group: string; names: string[]; error?: string }
  | { group: string; count: number; hint: string };

/**
 * Build the three catalog wrapper tools (`<prefix>_search_tools`, `<prefix>_load_tool`,
 * `<prefix>_execute_tool`). Callers must not pass a prefix that yields names starting with
 * `mcp_`: Anthropic's Claude Code OAuth endpoint rejects such requests on every model with a
 * misleading "out of extra usage" error. `mcp__server__tool` (double underscore) is fine.
 */
export function lazyCatalogTools(
  prefix: string,
  connectorId: string,
  label: string,
  entries: CatalogEntry[] = [],
): ConnectorTool[] {
  const indexText = formatNameIndexText(groupedNames(entries));
  const embedIndex = indexText.length > 0 && fitsNameIndexBudget(groupedNames(entries));
  const searchDescription = embedIndex
    ? `Search connected ${label} tools. Empty query lists names by source. Pass group to expand one source. Search here before saying you lack a tool or access; say so only when search finds none.\n${indexText}`
    : `Search connected ${label} tools. Empty query lists sources. Pass group to list names in one source, or query to search. Search here before saying you lack a tool or access; say so only when search finds none.`;
  return [
    {
      name: `${prefix}_search_tools`,
      description: searchDescription,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            maxLength: MAX_QUERY_LENGTH,
            description: "Words describing the tool to find. Omit to list names by source.",
          },
          group: {
            type: "string",
            maxLength: MAX_GROUP_LENGTH,
            description: "Source name to list or search within",
          },
          limit: { type: "integer", minimum: 1, maximum: TOOL_SEARCH_LIMIT },
        },
      },
      readOnly: true,
      route: { connectorId, toolName: CATALOG_SEARCH },
    },
    {
      name: `${prefix}_load_tool`,
      description: `Load one ${label} tool's parameters using an exact ID or name returned by search. Copy it unchanged; never construct group.name. If a name is ambiguous, search with group and query to obtain its exact ID.`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: MAX_TOOL_ID_LENGTH,
            description:
              "Exact ID or unambiguous name returned by search, copied unchanged. Do not prefix it with the group.",
          },
        },
        required: ["id"],
      },
      readOnly: true,
      route: { connectorId, toolName: CATALOG_LOAD },
    },
    {
      name: `${prefix}_execute_tool`,
      description: `Run one ${label} tool using an exact ID or name returned by search or load. Copy it unchanged; never construct group.name.`,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            maxLength: MAX_TOOL_ID_LENGTH,
            description:
              "Exact ID or unambiguous name returned by search or load, copied unchanged. Do not prefix it with the group.",
          },
          arguments: { type: "object", description: "Arguments matching the loaded schema" },
        },
        required: ["id", "arguments"],
      },
      route: { connectorId, toolName: CATALOG_EXECUTE },
    },
  ];
}

export function isLazyCatalogControlRoute(route: ConnectorRoute | undefined): boolean {
  return Boolean(
    route &&
      !route.resourceId &&
      (route.toolName === CATALOG_SEARCH ||
        route.toolName === CATALOG_LOAD ||
        route.toolName === CATALOG_EXECUTE),
  );
}

export function catalogEntries(tools: ConnectorTool[]): CatalogEntry[] {
  return tools
    .map((tool) => ({ id: catalogEntryId(tool), tool, group: catalogGroupOf(tool) }))
    .filter(
      ({ id, tool }) =>
        id.length <= MAX_TOOL_ID_LENGTH &&
        tool.name.length > 0 &&
        tool.name.length <= MAX_TOOL_NAME_LENGTH,
    );
}

export function catalogGroupLabel(
  name: string | null | undefined,
  kind: string,
  id: string,
): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed.slice(0, MAX_GROUP_LENGTH);
  const shortId = id.slice(0, 8) || "unknown";
  return `${kind}-${shortId}`.slice(0, MAX_GROUP_LENGTH);
}

export function searchCatalog(
  entries: CatalogEntry[],
  args: Record<string, unknown>,
): CatalogSearchResult {
  const query = String(args.query ?? "")
    .slice(0, MAX_QUERY_LENGTH)
    .trim()
    .toLowerCase();
  const groupFilter = String(args.group ?? "")
    .slice(0, MAX_GROUP_LENGTH)
    .trim();
  const scoped = groupFilter ? entries.filter((entry) => entry.group === groupFilter) : entries;

  if (!query) {
    if (groupFilter) {
      if (scoped.length === 0) {
        return {
          group: groupFilter,
          names: [],
          error: "Unknown or empty group",
        };
      }
      const group = scoped[0]!.group;
      const names = listNames(scoped);
      if (!fitsNameIndexBudget([{ group, names }])) {
        return {
          group,
          count: names.length,
          hint: "Pass query to search within this source.",
        };
      }
      return { group, names };
    }
    const grouped = groupedNames(scoped);
    if (!fitsNameIndexBudget(grouped)) {
      return {
        groups: grouped.map(({ group, names }) => ({ group, count: names.length })),
        hint: "Pass group to list names in one source.",
      };
    }
    return { index: grouped };
  }

  const requested = Number(args.limit ?? TOOL_SEARCH_LIMIT);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(TOOL_SEARCH_LIMIT, Math.trunc(requested)))
    : TOOL_SEARCH_LIMIT;
  // The whole query first; only when nothing matches it, its words one by one.
  const score = scoped.some((entry) => termScore(entry, query) < 4) ? termScore : termsScore;
  return {
    tools: scoped
      .map((entry) => ({ entry, score: score(entry, query) }))
      .filter(({ score }) => score < 4)
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.entry.tool.name.localeCompare(right.entry.tool.name) ||
          left.entry.id.localeCompare(right.entry.id),
      )
      .slice(0, limit)
      .map(({ entry }) => ({
        id: entry.id,
        name: entry.tool.name,
        description: entry.tool.description.slice(0, MAX_DESCRIPTION_LENGTH),
        readOnly: entry.tool.readOnly === true,
      })),
  };
}

export function loadCatalogEntry(
  entries: CatalogEntry[],
  args: Record<string, unknown>,
): CatalogEntry {
  const id = String(args.id ?? "");
  const byId = entries.find((candidate) => candidate.id === id);
  if (byId) {
    assertSchemaSize(byId);
    return byId;
  }
  const byName = entries.filter((candidate) => candidate.tool.name === id);
  if (byName.length === 1) {
    assertSchemaSize(byName[0]!);
    return byName[0]!;
  }
  const byShort = entries.filter((candidate) => catalogShortName(candidate) === id);
  if (byShort.length === 1) {
    assertSchemaSize(byShort[0]!);
    return byShort[0]!;
  }
  throw new Error(
    "Unknown tool ID or name in this bot's current catalog. A lookup miss is not evidence that the account is unauthorized. Search again with group and query, then copy a returned ID or name unchanged; do not construct group.name.",
  );
}

function assertSchemaSize(entry: CatalogEntry): void {
  const schemaBytes = Buffer.byteLength(JSON.stringify(entry.tool.inputSchema), "utf8");
  if (schemaBytes > SELECTED_SCHEMA_MAX_BYTES) throw new Error("Tool schema is too large");
}

export function resolveCatalogCall(
  call: ConnectorCall,
  entries: CatalogEntry[],
): { call: ConnectorCall; tool: ConnectorTool } {
  const entry = loadCatalogEntry(entries, call.args);
  const args = call.args.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Tool arguments must be an object");
  }
  const parsed = parseConnectorToolArgs(entry.tool.inputSchema, args as Record<string, unknown>);
  return {
    tool: entry.tool,
    call: {
      ...call,
      tool: entry.tool.name,
      args: parsed,
      route: entry.tool.route,
    },
  };
}

export function parseConnectorToolArgs(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // Zod's fromJSONSchema currently builds loose records for patternProperties and
  // skips additionalProperties: false, so reject that combination instead of
  // letting non-matching keys reach connector execution.
  if (inputSchema.patternProperties != null && inputSchema.additionalProperties === false) {
    throw new Error(
      "Tool schema is unsupported: patternProperties with additionalProperties false",
    );
  }
  const schema = z.fromJSONSchema(inputSchema as never);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`Tool arguments are invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data as Record<string, unknown>;
}

export function assertConnectorToolArgs(
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): void {
  parseConnectorToolArgs(inputSchema, args);
}

export async function* executeLazyCatalogControl(
  call: ConnectorCall,
  entries: CatalogEntry[],
  executeResolved: (resolved: ConnectorCall) => AsyncIterable<ConnectorEvent>,
): AsyncIterable<ConnectorEvent> {
  if (call.route?.toolName === CATALOG_SEARCH) {
    yield { type: "result", data: searchCatalog(entries, call.args) };
    return;
  }
  if (call.route?.toolName === CATALOG_LOAD) {
    const entry = loadCatalogEntry(entries, call.args);
    yield {
      type: "result",
      data: {
        id: call.args.id,
        name: entry.tool.name,
        description: entry.tool.description.slice(0, MAX_DESCRIPTION_LENGTH),
        inputSchema: entry.tool.inputSchema,
        readOnly: entry.tool.readOnly === true,
      },
    };
    return;
  }
  const resolved = resolveCatalogCall(call, entries);
  yield* executeResolved(resolved.call);
}

export function uniquifyInstalledToolName(installId: string, toolName: string): string {
  return `installed__${installId}__${toolName}`;
}

/** Prefix only when the same exposed name appears on more than one install. */
export function disambiguateInstalledToolNames(tools: ConnectorTool[]): ConnectorTool[] {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  return tools.map((tool) => {
    const resourceId = tool.route?.resourceId;
    if (!resourceId || (counts.get(tool.name) ?? 0) < 2) return tool;
    return { ...tool, name: uniquifyInstalledToolName(resourceId, tool.name) };
  });
}

export function formatNameIndexText(groups: Array<{ group: string; names: string[] }>): string {
  return groups.map(({ group, names }) => `${group}:\n  ${names.join(", ")}`).join("\n");
}

export function fitsNameIndexBudget(groups: Array<{ group: string; names: string[] }>): boolean {
  const nameCount = groups.reduce((total, group) => total + group.names.length, 0);
  if (nameCount > NAME_INDEX_MAX_NAMES) return false;
  return Buffer.byteLength(formatNameIndexText(groups), "utf8") <= NAME_INDEX_MAX_BYTES;
}

function catalogEntryId(tool: ConnectorTool): string {
  const route = tool.route;
  if (!route?.resourceId) return tool.name;
  return `${route.resourceId}:${encodeURIComponent(route.toolName)}`;
}

function catalogGroupOf(tool: ConnectorTool): string {
  const labeled = tool.route?.catalogGroup?.trim();
  if (labeled) return labeled.slice(0, MAX_GROUP_LENGTH);
  return "other";
}

function catalogShortName(entry: CatalogEntry): string {
  const routeName = entry.tool.route?.toolName?.trim();
  if (routeName) return routeName;
  return entry.tool.name;
}

function groupedNames(entries: CatalogEntry[]): Array<{ group: string; names: string[] }> {
  const byGroup = new Map<string, string[]>();
  for (const entry of entries) {
    const names = byGroup.get(entry.group) ?? [];
    names.push(catalogShortName(entry));
    byGroup.set(entry.group, names);
  }
  return [...byGroup.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, names]) => ({
      group,
      names: [...new Set(names)].sort((left, right) => left.localeCompare(right)),
    }));
}

function listNames(entries: CatalogEntry[]): string[] {
  return [...new Set(entries.map(catalogShortName))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function termScore(entry: CatalogEntry, query: string): number {
  const name = entry.tool.name.toLowerCase();
  const shortName = catalogShortName(entry).toLowerCase();
  const description = entry.tool.description.toLowerCase();
  const group = entry.group.toLowerCase();
  if (name === query || shortName === query) return 0;
  if (name.startsWith(query) || shortName.startsWith(query)) return 1;
  if (name.includes(query) || shortName.includes(query) || group.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

/**
 * Its words or tool names one by one (agents list several in one query), ranked by how many
 * match and how well. 4 means no match.
 */
function termsScore(entry: CatalogEntry, query: string): number {
  const terms = [...new Set(query.split(/[\s,;|/]+/).filter((term) => term.length >= 3))];
  if (terms.length < 2) return 4;
  const scores = terms.map((term) => termScore(entry, term)).filter((score) => score < 4);
  if (!scores.length) return 4;
  return Math.min(3.9, Math.min(...scores) + (1 - scores.length / terms.length) * 0.9);
}

const ACTION_WORDS = new Set(
  "get list create update delete remove add send search read find fetch set make new save by for the a an of to from with tool tools api v1 v2 batch bulk all one many".split(
    " ",
  ),
);
/** The nouns of a tool's name ("create_draft" -> "draft"), singular. */
function nameNouns(name: string): string[] {
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !ACTION_WORDS.has(word))
    .map((word) => (word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word));
  return [...new Set(words)];
}

/**
 * Other tools that do the same kind of work as one tool, best first: those whose name or
 * description mentions its nouns, a core tool before others. Deterministic; no model call.
 */
export function relatedTools(
  tools: readonly ConnectorTool[],
  toolName: string,
  isCore: (tool: ConnectorTool) => boolean = () => false,
  limit = 3,
): ConnectorTool[] {
  const nouns = nameNouns(toolName);
  if (!nouns.length) return [];
  return tools
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      const score = nouns.reduce(
        (total, noun) => total + (name.includes(noun) ? 2 : description.includes(noun) ? 1 : 0),
        0,
      );
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(isCore(right.tool)) - Number(isCore(left.tool)) ||
        left.tool.name.localeCompare(right.tool.name),
    )
    .slice(0, limit)
    .map(({ tool }) => tool);
}
