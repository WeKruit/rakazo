import type { ConnectorTool } from "@rakazo/adapter-kit";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set(["recall_memory", "save_memory", "forget_memory"]);

export function nativeMemorySaveError(args: Record<string, unknown>): string | undefined {
  if (typeof args.content !== "string") return "content must be a string";
  if (args.path !== undefined && (typeof args.path !== "string" || !args.path.trim())) {
    return "path is required";
  }
  if (!Number.isSafeInteger(args.expectedRevision) || (args.expectedRevision as number) < 0) {
    return "expectedRevision must be a nonnegative integer";
  }
  return undefined;
}

export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
): ConnectorTool[] {
  return semanticMemoryConfigured
    ? tools.filter((tool) => tool.name !== "remember")
    : tools.filter((tool) => !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name));
}
