/**
 * Which saved role the recruiter's words are about. Kruit routed work by whichever role it had in
 * mind: send-at-night 11-14 sent "Ada现在就发" for ref 0303 to the role for 0153, handed a new
 * role's request to the only saved role, and mixed facts of two roles in one reply. One resolver
 * reads the recruiter's latest messages against the account's saved roles, and every path that
 * picks a role (handing work to a role, opening one) checks its choice against it.
 *
 * Practice adopted: entity linking against a known catalog (exact id first, then distinctive
 * name tokens, ambiguous → no link), as dialogue state trackers resolve slot references.
 */
export type SavedRole = { id: string; title: string | null };

export type RoleReference =
  /** The recruiter's words name this saved role. */
  | { kind: "saved"; role: SavedRole; by: string }
  /** They open a new role by a ref no saved role has. */
  | { kind: "new"; ref: string };

// "Ref 0733", or in Chinese 「编号0733」「岗位编号 0733」.
const REF = /(?:\bref\.?|编号)\s*#?\s*([a-z0-9-]*\d[a-z0-9-]*)/i;
/** The ref a text gives ("Ref 0733", 「编号0733」), lowercased. */
export const roleRef = (text: string) => REF.exec(text)?.[1]?.toLowerCase();
const NEW_ROLE = /新(?:的)?\s*(?:岗位|职位|role)|\bnew (?:role|position|job|req)\b/i;

// Words in many role titles say nothing about which one is meant.
const GENERIC = new Set(
  "senior staff principal junior lead head chief engineer engineering engineers manager management developer director associate specialist analyst intern role position job team the and for with remote hybrid onsite full time part contract ref new sr jr ii iii".split(
    " ",
  ),
);

/** A title's distinctive words: names of companies, places and specialties. */
function distinctive(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(REF, " ")
        .split(/[^\p{L}\p{N}+#]+/u)
        .filter((word) => word.length >= 3 && !GENERIC.has(word) && !/^\d+$/.test(word)),
    ),
  ];
}

const mentions = (text: string, word: string) =>
  /\p{Script=Han}/u.test(word)
    ? text.includes(word)
    : new RegExp(
        `(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
        "iu",
      ).test(text);

/**
 * The role the recruiter's newest messages (newest first) refer to: a ref they wrote, else a
 * saved title whose distinctive words their message names (two of them, or its one word for a
 * one-word title). The newest message that names a role decides; two roles named equally → none.
 */
export function referredRole(
  newestFirst: readonly string[],
  roles: readonly SavedRole[],
): RoleReference | undefined {
  for (const text of newestFirst.slice(0, 4)) {
    const ref = REF.exec(text)?.[1]?.toLowerCase();
    if (ref) {
      const role =
        roles.find((saved) => saved.title && REF.exec(saved.title)?.[1]?.toLowerCase() === ref) ??
        roles.find((saved) => saved.title?.toLowerCase().includes(ref));
      if (role) return { kind: "saved", role, by: `ref ${ref}` };
      if (NEW_ROLE.test(text)) return { kind: "new", ref };
      continue;
    }
    const scored = roles
      .map((role) => {
        const words = distinctive(role.title ?? "");
        const hits = words.filter((word) => mentions(text, word));
        return { role, hits, enough: hits.length >= Math.min(2, words.length) && hits.length > 0 };
      })
      .filter((entry) => entry.enough)
      .sort((a, b) => b.hits.length - a.hits.length);
    const [best, next] = scored;
    if (best && (!next || next.hits.length < best.hits.length))
      return { kind: "saved", role: best.role, by: best.hits.join(" ") };
    if (best) return undefined;
  }
  return undefined;
}

/** Model-facing: work handed to a role other than the one the recruiter named. */
export const otherRoleNote = (reference: Extract<RoleReference, { kind: "saved" }>) =>
  `Not handed over: the recruiter's messages are about the role "${reference.role.title}" (roleId ${reference.role.id}, by ${reference.by}), not this one. Hand it to that role now, and say nothing about the other role.`;

/** Model-facing: work handed to a saved role when the recruiter opens a new one. */
export const newRoleNote = (ref: string) =>
  `Not handed over: the recruiter's message opens a new role (ref ${ref}), not this one. Open it with start_role now, carrying their whole request (including any people and emails to send); never put its people or emails in another role.`;

/** Model-facing: start_role for a role that is already saved. */
export const savedRoleNote = (reference: Extract<RoleReference, { kind: "saved" }>) =>
  `Not opened: the recruiter means the saved role "${reference.role.title}" (roleId ${reference.role.id}, by ${reference.by}). Hand the request to it with delegate_to_role, and use what is already saved there instead of asking for the job description again.`;
