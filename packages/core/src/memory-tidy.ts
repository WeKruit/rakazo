/** Product-default nightly memory tidy: a built-in skill that an existing bot runs as a routine. */
export const MEMORY_TIDY_SKILL_NAME = "Tidy memory";

export const MEMORY_TIDY_SKILL = {
  name: MEMORY_TIDY_SKILL_NAME,
  description: "Merge duplicate memory, mark stale facts and clear forgotten topics.",
  body: `Tidy saved memory. Change only what these rules require; never add a fact, reword the user, or move a fact between your private memory and the user's shared memory.

1. Scope: your own bot memory documents and, only when this request says so, the user's shared memory documents. Use the durable memory in this run's context (path, revision and updated date); read_memory any document named as cut before editing it. Another bot's memory is its own.
2. Duplicates: keep one home per fact. When a fact appears more than once in scope, keep the best-sourced, most recent line in the most fitting document and remove the other copies. When copies disagree, keep what the user said, otherwise the newer one, and add "(was X)".
3. Stale facts: judge age by the date on the line, otherwise the document's updated date. Status and plans go stale after about 2 weeks; owners, who does what and how the team works after about 3 months; preferences the user stated after about 1 year. Append "(stale since YYYY-MM-DD; recheck before relying on it)" to a stale line once. Do not delete stale lines, and leave a line with a newer date or an existing stale mark alone.
4. Forgotten: for each topic under a "## Forgotten" heading, remove every remaining mention of it anywhere in scope, and reduce that entry to its topic and date. Never repeat forgotten content, including in your reply.
5. The user's words stay theirs: keep text the user stated exactly as written and attributed to them. When merging a user-stated copy with an inferred one, keep the user's wording. Never relabel an inferred fact as stated by the user.
6. Save each change with remember (bot memory) or save_shared_memory (shared memory) using edit:{find,replace} and the loaded expectedRevision. After a revision conflict, read the document again and redo only what is still needed; never overwrite newer text.
7. Log: reply with one line per change: the document, what changed (merged, marked stale, removed forgotten content) and why. If nothing needed changing, reply exactly NO_RESPONSE so nothing is posted. Do nothing else: no searches, messages, schedules or other tools.`,
};

export const MEMORY_TIDY_ROUTINE_NAME = "Nightly memory tidy";

/**
 * The lead also tidies the user's shared memory, so one run owns it and the other bots never race
 * it. The precondition line skips a night when nothing in scope changed and the last tidy is recent.
 */
export function memoryTidyRoutinePrompt(includeSharedMemory: boolean): string {
  return includeSharedMemory
    ? `/${MEMORY_TIDY_SKILL_NAME}\nTidy your own memory and the user's shared memory.\nprecondition: memory`
    : `/${MEMORY_TIDY_SKILL_NAME}\nTidy only your own memory; the lead tidies the shared memory.\nprecondition: bot_memory`;
}

/** Once a night in UTC, spread over the hour by account so tidies do not all start together. */
export function memoryTidyRoutineCron(seed: string): string {
  let minute = 0;
  for (const character of seed) minute = (minute * 31 + character.charCodeAt(0)) % 60;
  return `${minute} 8 * * *`;
}
