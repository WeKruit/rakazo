import type { Skill } from "@earendil-works/pi-agent-core";
import { formatSkillInvocation, formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import type { RecruitingAgentScope, SkillCatalogEntry, SkillRecord } from "@rakazo/core";
import { expandSkillReferencesInPrompt, parseSkillMd } from "@rakazo/core";

/**
 * Skills reach the model through Pi's own Agent Skills support (pi-agent-core harness/skills.js,
 * harness/system-prompt.js): the agentskills.io listing of name, description and location, and
 * `formatSkillInvocation` for a skill the user invokes. Pi's listing says to read the skill file at
 * its location, so the conventional `skills/<name>/SKILL.md` is served by read_file from the
 * stored skill (skillFileFromTool), as a written SKILL.md is saved as one; skill_read loads it by
 * name too.
 */
const SKILLS_DIR = "skills/";
const SKILL_FILE = "/SKILL.md";
const skillLocation = (name: string) => `${SKILLS_DIR}${name}${SKILL_FILE}`;

/** The skill name a listed location names (`skills/<name>/SKILL.md`), else undefined. */
export function skillNameAtLocation(path: string): string | undefined {
  let relative = path.trim();
  while (relative.startsWith("./") || relative.startsWith("/"))
    relative = relative.slice(relative.startsWith("/") ? 1 : 2);
  if (!relative.startsWith(SKILLS_DIR) || !relative.endsWith(SKILL_FILE)) return undefined;
  const name = relative.slice(SKILLS_DIR.length, -SKILL_FILE.length);
  return name && !name.includes("/") ? name : undefined;
}

function piSkill(skill: Pick<SkillRecord, "name" | "description" | "content">): Skill {
  const parsed = parseSkillMd(skill.content);
  return {
    name: skill.name,
    description: skill.description,
    content: "error" in parsed ? skill.content : parsed.body.trim(),
    filePath: skillLocation(skill.name),
  };
}

/** Pi's skill listing for this run, or undefined when no skill is listed. */
export function formatAgentSkillsListing(
  entries: readonly Pick<SkillCatalogEntry, "name" | "description" | "unavailable">[],
): string | undefined {
  const listing = formatSkillsForSystemPrompt(
    entries.map((entry) => ({
      name: entry.name,
      description: entry.unavailable
        ? `${entry.description} (Unavailable here: ${entry.unavailable}.)`
        : entry.description,
      content: "",
      filePath: skillLocation(entry.name),
    })),
  );
  return listing || undefined;
}

/**
 * The skills an agent is listed: the user's own skills, and of the maintained ones only those in
 * the agent's `skills` list. A bot with no scope is listed every skill.
 */
export function skillsForAgent<T extends Pick<SkillRecord, "name" | "source">>(
  skills: readonly T[],
  scope: RecruitingAgentScope | undefined,
): T[] {
  if (!scope) return [...skills];
  const own = new Set(scope.skills.map((name) => name.trim().toLowerCase()));
  return skills.filter(
    (skill) => skill.source === "user" || own.has(skill.name.trim().toLowerCase()),
  );
}

const invoke = (skill: SkillRecord, rest?: string) => formatSkillInvocation(piSkill(skill), rest);

/** A forced `/Name` at the start of a turn's prompt, as Pi's explicit skill invocation. */
export function expandForcedSkill(prompt: string, skills: readonly SkillRecord[]): string {
  return expandSkillReferencesInPrompt(prompt, skills, invoke);
}

/** A routine's prompt when it fires: a forced `/Name` and its `@Name` mentions of known skills. */
export function expandRoutineSkills(prompt: string, skills: readonly SkillRecord[]): string {
  return expandSkillReferencesInPrompt(prompt, skills, invoke, { mentions: true });
}
