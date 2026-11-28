/**
 * Agent Skills (agentskills.io SKILL.md recipes) stored per user. This file parses, builds and
 * checks them; the listing an agent sees and an explicit invocation are Pi's own
 * (`formatSkillsForSystemPrompt`, `formatSkillInvocation`, adapters/src/agent-skills.ts).
 * Distinct from taught skills (demo/record playbooks on a single bot).
 */

const FRONTMATTER_FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export type SkillSource = "user" | "builtin" | "plugin";

export type ParsedSkillMd = {
  name: string;
  description: string;
  /** Markdown body after the frontmatter fence. */
  body: string;
  /**
   * All frontmatter keys as parsed scalars/structures. Unknown keys are preserved
   * so Claude Agent Skills with extra fields round-trip safely.
   */
  frontmatter: Record<string, unknown>;
};

export type SkillCatalogEntry = {
  name: string;
  description: string;
  source: SkillSource;
  readOnly: boolean;
  /** Set when a declared requirement is missing for this run, e.g. "needs connection calendar". */
  unavailable?: string;
};

/**
 * What a skill declares it needs in its frontmatter, for example
 * `requires:` with nested `tools: [web_search]`, `mcp: [calendar]` and `secrets: [GITHUB_TOKEN]`.
 * A bare list (`requires: [web_search]`) names tools.
 */
export type SkillRequirements = { tools: string[]; mcp: string[]; secrets: string[] };

const SKILL_REQUIREMENT_KINDS = ["tools", "mcp", "secrets"] as const;

function requirementNames(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.replace(/^\[|\]$/g, "").split(",")
      : [];
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))].slice(0, 20);
}

export function skillRequirements(content: string): SkillRequirements {
  const parsed = parseSkillMd(content);
  const requires = "error" in parsed ? undefined : parsed.frontmatter.requires;
  if (!requires || typeof requires !== "object" || Array.isArray(requires))
    return { tools: requirementNames(requires), mcp: [], secrets: [] };
  const map = requires as Record<string, unknown>;
  return {
    tools: requirementNames(map.tools),
    mcp: requirementNames(map.mcp),
    secrets: requirementNames(map.secrets),
  };
}

/**
 * The first missing requirement as a short reason, or undefined when everything known is present.
 * A kind is only checked when its available set is given, so callers check what they can see.
 */
export function missingSkillRequirement(
  requirements: SkillRequirements,
  available: {
    tools?: ReadonlySet<string>;
    mcp?: ReadonlySet<string>;
    secrets?: ReadonlySet<string>;
  },
): string | undefined {
  for (const kind of SKILL_REQUIREMENT_KINDS) {
    const have = available[kind];
    if (!have) continue;
    const missing = requirements[kind].filter((name) => !have.has(name.toLowerCase()));
    if (missing.length > 0) {
      const label = kind === "tools" ? "tool" : kind === "mcp" ? "connection" : "secret";
      return `needs ${label}${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`;
    }
  }
  return undefined;
}

/** Lowercased names a run can satisfy from its tool list: full names and MCP server slugs. */
export function skillAvailabilityFromTools(toolNames: Iterable<string>): {
  tools: Set<string>;
  mcp: Set<string>;
} {
  const tools = new Set<string>();
  const mcp = new Set<string>();
  for (const raw of toolNames) {
    const name = raw.toLowerCase();
    tools.add(name);
    const parts = name.split("__");
    if (parts.length >= 3) {
      mcp.add(parts[1]!);
      tools.add(parts.slice(2).join("__"));
    }
  }
  return { tools, mcp };
}

export type SkillRecord = SkillCatalogEntry & {
  id?: string;
  content: string;
};

const FORCE_SKILL_PREFIX = /^(?:\/|use\s+skill:\s*)(.+?)(?:\n|$)/i;
/** A workspace path that holds one skill: `SKILL.md`, usually as `skills/<name>/SKILL.md`. */
export function isSkillFilePath(filePath: string): boolean {
  return /(^|\/)SKILL\.md$/.test(filePath.trim());
}

export function isSkillReadOnly(source: SkillSource): boolean {
  return source === "builtin" || source === "plugin";
}

/**
 * Parse a SKILL.md document. Requires YAML frontmatter with `name` and `description`.
 * Extra frontmatter keys are kept in `frontmatter`.
 */
export function parseSkillMd(content: string): ParsedSkillMd | { error: string } {
  const trimmed = content.replace(/^\uFEFF/, "");
  const match = FRONTMATTER_FENCE.exec(trimmed);
  if (!match) {
    return { error: "SKILL.md must start with YAML frontmatter (--- ... ---)." };
  }
  const frontmatterText = match[1] ?? "";
  const body = trimmed.slice(match[0].length).replace(/^\r?\n/, "");
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseSimpleYamlObject(frontmatterText);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid SKILL.md frontmatter.",
    };
  }
  const name = stringifyScalar(frontmatter.name).trim();
  const description = stringifyScalar(frontmatter.description).trim();
  if (!name) return { error: "SKILL.md frontmatter requires name." };
  if (!description) return { error: "SKILL.md frontmatter requires description." };
  if (name.length > 80) return { error: "Skill name must be at most 80 characters." };
  if (description.length > 2000) {
    return { error: "Skill description must be at most 2000 characters." };
  }
  return { name, description, body, frontmatter };
}

/** Build SKILL.md, preserving unknown frontmatter keys from a prior parse. */
export function buildSkillMd(input: {
  name: string;
  description: string;
  body: string;
  frontmatter?: Record<string, unknown>;
}): string {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!name) throw new Error("Skill name is required.");
  if (!description) throw new Error("Skill description is required.");
  if (name.length > 80) throw new Error("Skill name must be at most 80 characters.");
  if (description.length > 2000) {
    throw new Error("Skill description must be at most 2000 characters.");
  }
  const merged: Record<string, unknown> = { ...(input.frontmatter ?? {}) };
  merged.name = name;
  merged.description = description;
  // Stable order: name, description, then remaining keys alphabetically.
  const rank = (key: string) => (key === "name" ? 0 : key === "description" ? 1 : 2);
  const keys = Object.keys(merged).sort((a, b) => {
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });
  const lines = keys.map((key) => formatYamlLine(key, merged[key]));
  const body = input.body.replace(/^\r?\n/, "");
  return `---\n${lines.join("\n")}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}

/** Detect a composer-forced skill (`/Name` or `Use skill: Name`) at the start of a prompt. */
export function extractForcedSkillName(prompt: string): { name: string; rest: string } | null {
  const text = prompt.trimStart();
  const match = FORCE_SKILL_PREFIX.exec(text);
  if (!match) return null;
  const name = (match[1] ?? "").trim().replace(/^\/+/, "").trim();
  if (!name || name.length > 80) return null;
  // Avoid treating `/` settings actions as skills.
  if (/^(chat\s+settings|settings:)/i.test(name)) return null;
  const rest = text.slice(match[0].length).trimStart();
  return { name, rest };
}

/** Mentions like `@Daily standup` of the given skill names in a routine prompt, in order. */
export function extractRoutineSkillMentions(prompt: string, knownNames: string[]): string[] {
  const sorted = knownNames
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const found: string[] = [];
  const seen = new Set<string>();
  for (const name of sorted) {
    const re = new RegExp(`(?:^|[\\s(,])@${escapeRegExp(name)}(?=[\\s,.)]|$)`, "gi");
    if (!re.test(prompt)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(name);
  }
  return found;
}

/** Keep user-owned skills reachable when a later builtin claims the same name. */
export function mergeBuiltinSkills<T extends { name: string }>(
  builtins: readonly T[],
  userSkills: readonly T[],
): T[] {
  return [...builtins.filter((skill) => !findSkillByName(userSkills, skill.name)), ...userSkills];
}

export function findSkillByName<T extends { name: string }>(
  skills: readonly T[],
  name: string,
): T | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return skills.find((skill) => skill.name.trim().toLowerCase() === needle);
}

/** True when `rest` already begins with the skill body (prior expand pass). */
function restAlreadyIncludesSkillContent(rest: string, content: string): boolean {
  const trimmedRest = rest.trim();
  const trimmedContent = content.trim();
  if (!trimmedContent) return false;
  return (
    trimmedRest === trimmedContent ||
    trimmedRest.startsWith(`${trimmedContent}\n`) ||
    trimmedRest.startsWith(`${trimmedContent}\r\n`)
  );
}

/** How an explicitly invoked skill enters the prompt: Pi's `formatSkillInvocation` in the runtime. */
export type SkillInvocationFormat = (skill: SkillRecord, rest?: string) => string;

/**
 * Expand a forced `/Name` (or `Use skill: Name`) at the start of a prompt into that skill's
 * invocation; with `mentions`, also a routine's `@Name` of a known skill.
 */
export function expandSkillReferencesInPrompt(
  prompt: string,
  skills: readonly SkillRecord[],
  invoke: SkillInvocationFormat,
  options: { mentions?: boolean } = {},
): string {
  const forced = extractForcedSkillName(prompt);
  if (forced) {
    const skill = findSkillByName(skills, forced.name);
    if (skill) {
      // Routines expand at fire time; run time sees the expanded prompt again — stay idempotent.
      if (restAlreadyIncludesSkillContent(forced.rest, skill.content)) {
        return prompt.trimStart();
      }
      return invoke(skill, forced.rest.trim() || undefined);
    }
  }
  if (!options.mentions) return prompt;

  const mentions = extractRoutineSkillMentions(
    prompt,
    skills.map((skill) => skill.name),
  );
  if (mentions.length === 0) return prompt;

  const blocks: string[] = [];
  let remaining = prompt;
  for (const mention of mentions) {
    const skill = findSkillByName(skills, mention);
    if (!skill) continue;
    blocks.push(invoke(skill));
    // Strip the @mention token so the agent is not confused by a dangling pointer.
    remaining = remaining.replace(
      new RegExp(`(^|[\\s(,])@${escapeRegExp(mention)}(?=[\\s,.)]|$)`, "gi"),
      "$1",
    );
  }
  if (blocks.length === 0) return prompt;
  const rest = remaining.replace(/[ \t]{2,}/g, " ").trim();
  return [...blocks, rest].filter(Boolean).join("\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

type YamlBlockScalarHeader = {
  style: "|" | ">";
  chomp: "clip" | "strip" | "keep";
  indent: number | null;
};

function parseYamlBlockScalarHeader(raw: string): YamlBlockScalarHeader | null {
  const match = /^([>|])(?:([1-9]\d*)([+-]?)|([+-])([1-9]\d*)?)?$/.exec(raw);
  if (!match) return null;
  const style = match[1] as "|" | ">";
  const indentToken = match[2] ?? match[5] ?? "";
  const chompToken = match[3] || match[4] || "";
  const chomp = chompToken === "+" ? "keep" : chompToken === "-" ? "strip" : "clip";
  const indent = indentToken ? Number(indentToken) : null;
  return { style, chomp, indent };
}

function leadingSpaces(line: string): number {
  const match = /^( *)/.exec(line);
  return match?.[1]?.length ?? 0;
}

function decodeYamlBlockScalar(rawLines: string[], header: YamlBlockScalarHeader): string {
  let indent = header.indent;
  if (indent == null) {
    indent = 0;
    for (const line of rawLines) {
      if (line.trim() === "") continue;
      const spaces = leadingSpaces(line);
      if (indent === 0 || spaces < indent) indent = spaces;
    }
  }

  const contentLines = rawLines.map((line) => {
    if (line.trim() === "") return "";
    if (leadingSpaces(line) < indent!) return line.trimStart();
    return line.slice(indent!);
  });

  // Count trailing blank lines before they are folded away for chomp=keep.
  let trailingBlanks = 0;
  for (let i = contentLines.length - 1; i >= 0; i -= 1) {
    if (contentLines[i] !== "") break;
    trailingBlanks += 1;
  }

  let text: string;
  if (header.style === "|") {
    text = contentLines.join("\n");
  } else {
    // Folded (YAML 1.2 §8.1.3): same-indent lines join with spaces; empty source
    // lines become paragraph breaks; more-indented lines stay literal. Parts are
    // always joined with "\n" so folded paragraphs and indented fragments keep
    // line-break separation (never concatenated into one folded run).
    const parts: string[] = [];
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length === 0) return;
      parts.push(paragraph.join(" "));
      paragraph = [];
    };
    for (const line of contentLines) {
      if (line === "") {
        flush();
        parts.push("");
        continue;
      }
      if (/^ /.test(line)) {
        flush();
        parts.push(line);
        continue;
      }
      paragraph.push(line);
    }
    flush();
    text = parts.join("\n");
  }

  if (header.chomp === "strip") {
    return text.replace(/\n+$/, "");
  }
  if (header.chomp === "keep") {
    if (trailingBlanks === 0) return text.endsWith("\n") ? text : `${text}\n`;
    const stripped = text.replace(/\n+$/, "");
    return `${stripped}\n${"\n".repeat(trailingBlanks)}`;
  }
  // clip: exactly one trailing newline when the block had content.
  const stripped = text.replace(/\n+$/, "");
  return stripped === "" ? "" : `${stripped}\n`;
}

/**
 * Minimal YAML object parser for SKILL.md frontmatter.
 * Supports scalars, folded/literal block scalars (`>`, `|`, `>-`, `|+`, `|2`, …),
 * inline arrays, and nested maps one level deep.
 * Unrecognized lines are kept as string values under their key when possible.
 */
function parseSimpleYamlObject(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i += 1;
      continue;
    }
    if (/^\s/.test(line)) {
      throw new Error("Unexpected indented frontmatter line without a key.");
    }
    const keyed = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!keyed) {
      throw new Error(`Invalid frontmatter line: ${line}`);
    }
    const key = keyed[1]!;
    const raw = keyed[2] ?? "";
    const blockHeader = parseYamlBlockScalarHeader(raw);
    if (blockHeader) {
      const blockLines: string[] = [];
      i += 1;
      while (i < lines.length && (/^\s+/.test(lines[i] ?? "") || (lines[i] ?? "").trim() === "")) {
        blockLines.push(lines[i] ?? "");
        i += 1;
      }
      result[key] = decodeYamlBlockScalar(blockLines, blockHeader);
      continue;
    }
    if (raw === "") {
      // Nested map or list on following indented lines.
      const nested: Record<string, unknown> = {};
      const list: unknown[] = [];
      let mode: "empty" | "map" | "list" = "empty";
      i += 1;
      while (i < lines.length && /^\s+/.test(lines[i] ?? "")) {
        const nestedLine = (lines[i] ?? "").replace(/^\s+/, "");
        const listItem = /^-\s+(.*)$/.exec(nestedLine);
        if (listItem) {
          mode = "list";
          list.push(parseYamlScalar(listItem[1] ?? ""));
          i += 1;
          continue;
        }
        const nestedKey = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(nestedLine);
        if (nestedKey) {
          mode = "map";
          nested[nestedKey[1]!] = parseYamlScalar(nestedKey[2] ?? "");
          i += 1;
          continue;
        }
        break;
      }
      result[key] = mode === "list" ? list : mode === "map" ? nested : "";
      continue;
    }
    if (raw.startsWith("[") && raw.endsWith("]")) {
      result[key] = raw
        .slice(1, -1)
        .split(",")
        .map((part) => parseYamlScalar(part.trim()))
        .filter((part) => part !== "");
      i += 1;
      continue;
    }
    result[key] = parseYamlScalar(raw);
    i += 1;
  }
  return result;
}

function parseYamlScalar(raw: string): string | number | boolean {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function formatYamlBlockScalar(key: string, value: string): string {
  // Choose chomp so decodeYamlBlockScalar round-trips trailing newlines:
  // strip (0), clip (1), keep (2+). Folded (`>`) style is not preserved — only the string value.
  const trailing = /\n*$/.exec(value)?.[0].length ?? 0;
  let indicator = "|";
  let lines: string[];
  if (trailing === 0) {
    indicator = "|-";
    lines = value.split("\n");
  } else if (trailing === 1) {
    indicator = "|";
    lines = value.slice(0, -1).split("\n");
  } else {
    indicator = "|+";
    const core = value.slice(0, -trailing);
    // keep decoder yields 1 + trailingBlanks newlines; emit trailingBlanks blank lines.
    lines = [core, ...Array.from({ length: trailing - 1 }, () => "")];
  }
  const indented = lines.map((line) => `  ${line}`).join("\n");
  return `${key}: ${indicator}\n${indented}`;
}

function formatYamlLine(key: string, value: unknown): string {
  if (value === null || value === undefined) return `${key}:`;
  if (typeof value === "string") {
    if (value.includes("\n") || value.includes(": ")) {
      return formatYamlBlockScalar(key, value);
    }
    if (value === "" || /[#{}[\],&*?|>!%@`]/.test(value) || value !== value.trim()) {
      return `${key}: ${JSON.stringify(value)}`;
    }
    return `${key}: ${value}`;
  }
  if (typeof value === "number" || typeof value === "boolean") return `${key}: ${value}`;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string" || typeof item === "number")) {
      return `${key}: [${value.map((item) => JSON.stringify(String(item))).join(", ")}]`;
    }
    const items = value
      .map((item) => `  - ${typeof item === "string" ? item : JSON.stringify(item)}`)
      .join("\n");
    return `${key}:\n${items}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${key}:`;
    const nested = entries
      .map(([nestedKey, nestedValue]) => `  ${formatYamlLine(nestedKey, nestedValue)}`)
      .join("\n");
    return `${key}:\n${nested}`;
  }
  return `${key}: ${JSON.stringify(String(value))}`;
}
