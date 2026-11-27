/**
 * The text of recruiting_role, in the order the agent reads it. The account-wide conversation never
 * holds a role (start_role opens one, delegate_to_role hands work to it), so there the tool lists
 * no create and no select, in its options and in its text: an option the code always refuses is
 * not shown, as Anthropic's tool-writing guide advises (staging 11-26 and 11-27: Kruit chose the
 * create, then the select, that cannot work there, and told the recruiter no role was open).
 */
const ROLE_TOOL_TEXT: ReadonlyArray<readonly ["all" | "create" | "select", string]> = [
  [
    "create",
    ' A new JD, description or document creates an independent role; never merge roles by company or title. Create shape: {operation:"create",title,sourceRefs:[],criteria:[],preferences:[],definitionQuestions:[],intent:{basis:"direct",quote:"the human\'s words"}}. All arrays are required; use [] only when empty.',
  ],
  [
    "all",
    ' Each criterion needs id, priority (hard/preferred), expression, non-empty sourceRefs citing the relevant JD or actual human requirement, and definitionQuestions. Assign stable local criterion, atom and source IDs; use tool-returned real message/artifact IDs. Atom expression:{kind:"atom",id:<stable local atom ID>,statement:<requirement>}; all/any use items and not uses item.',
  ],
  ["create", " For JD URLs, call web_fetch before creating the role."],
  [
    "all",
    ' A file the recruiter attached or a page that was read is cited by its artifact reference: {id:<stable local source ID>,kind:"original_material",anchor:{kind:"artifact",artifact:sourceMaterial.artifact,locator:"text"},readState:"read",quote:<the passage as you copied it>}. The quote is your own copy of the passage and is not checked against the file; the runtime fills the file\'s fingerprint, url and read time. A missing detail about a file never stops a save. Role and criterion sourceRefs contain full objects, never ID strings. One source ID identifies the same full unchanged object across the entire definition. A receipt proves returned text, not complete JD coverage; retain unread sections in definitionQuestions.',
  ],
  [
    "create",
    " Do not create an empty placeholder role. For a pasted description, role-level sourceRefs:[] is valid; the runtime adds the verified human instruction only as role authorization.",
  ],
  [
    "all",
    ' Each criterion must explicitly cite the relevant original requirement, using the actual message or artifact anchor; a general instruction to read a JD is not criterion evidence. A requirement the recruiter wrote in a message is cited with anchor:{kind:"message",messageId,locator:"blocks[N].text"} and its local ID in sourceRefIds: take messageId from this turn\'s native message source reference; when you do not have one, write messageId:"latest" and the runtime cites the recruiter\'s latest message. A missing message ID never stops a save. Never invent artifact IDs or read timestamps. Read attachments before citing their real references.',
  ],
  ["create", " Create saves and binds the role; do not bind again after a saved workspace."],
  [
    "all",
    ' Read uses {operation:"read"}. To change an existing role, use update with only what changes: {operation:"update",roleId,expectedRevision:<loaded revision>,intent,...changed fields}. criteria:{upsert:[complete changed or new criteria],remove:[criterion IDs]}; title, brief, preferences and definitionQuestions replace the saved value only when supplied, and omitted fields keep the saved values. sourceRefs adds or replaces role sources by ID. Revise with the complete definition remains available for a full rewrite. Archive hides a duplicate or abandoned role without deleting it: {operation:"archive",roleId,expectedRevision,intent,force?}; a role with candidates or research is refused unless force:true. Unarchive restores it: {operation:"unarchive",roleId,expectedRevision,intent}.',
  ],
  ["select", ' Bind uses {operation:"bind",roleId:<returned ID or null>,intent}.'],
  [
    "all",
    " The optional top-level brief's known facts need exact read sourceRefIds; every criterion needs a brief.rules entry with criterionId, origin, effect and sourceRefIds. Use salary_range for compensation. Carry already-read published compensation into the draft with its exact saved source; do not ask the human to supply that known value again. Published compensation is a fact, not permission to disclose it in outreach or send a message. Filters guide finding people and never replace qualification criteria. Inferred search filters use prefer; inferred rules use flag and preferred criteria. Keep location scope separate from candidate willingness. Reuse known answers; ask only material missing or conflicting information. Direct current human wording authorizes changes; agent messages are context. Ask the recruiter with ask_user. Correct deterministic schema rejections using the actual validator error and read receipt, then resubmit corrected arguments. Inspect an unknown external result's original receipt before retrying.",
  ],
  [
    "select",
    " Current role results replace earlier snapshots; reading or selecting a role never starts a search.",
  ],
];

/** Operations the account-wide conversation never offers. */
export const ROLE_OPERATIONS_OUTSIDE_A_ROLE: ReadonlySet<string> = new Set(["create", "bind"]);

export function recruitingRoleToolDescription(accountWide: boolean): string {
  if (!accountWide)
    return `Read, create, revise or select the current recruiting role in this thread.${ROLE_TOOL_TEXT.map(([, text]) => text).join("")}`;
  const shared = ROLE_TOOL_TEXT.filter(([scope]) => scope === "all").map(([, text]) => text);
  return `Read or revise a saved recruiting role.${shared.join("")} Reading a role never starts a search. In this conversation a new role is opened with start_role, never here.`;
}
