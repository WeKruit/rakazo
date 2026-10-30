/**
 * Pinned recruiting rules: one table of the prompt sentences that fixed a real, observed bug.
 *
 * Bot instructions have a 12,000-character budget, so prompts get shortened. Shortening must not
 * silently drop one of these rules: when it does, the old bug comes back (a refactor once dropped
 * Outreach's "reply_to_email is only for replies in an existing thread." and Outreach started
 * declining plain sends). This test fails with the rule's name and the bug it fixed.
 *
 * To change a rule on purpose, edit its entry here in the same commit (new phrase, new home, or
 * delete the entry) and say why in the commit message. Rewording a prompt is fine as long as the
 * pinned phrase, or a regex that still matches it, survives.
 */
import { describe, expect, it } from "vitest";
import {
  NAMED_EMAILS_NOTE,
  RECRUITER_LANGUAGE,
  RECRUITING_BRIEF_CHECKLIST,
  RECRUITING_CALIBRATION_QUICK_SEARCH,
  RECRUITING_DEFAULT_BOTS,
  RECRUITING_DEFAULT_SKILLS,
  RECRUITING_INTAKE_FLOW,
  RECRUITING_PDF_RENDERING,
  RECRUITING_ROUND_NEXT_STEP,
  RECRUITING_SCALE_START,
  RECRUITING_SEARCH_AUTOSAVED_NEXT_STEP,
  RECRUITING_SEARCH_BRIEF_TEMPLATE,
  RECRUITING_SEARCH_SAVED_NEXT_STEP,
  REPLY_IN_ENGLISH_NOTE,
  sendToNote,
} from "./recruiting-defaults.js";

const bot = (key: string) =>
  RECRUITING_DEFAULT_BOTS.find((entry) => entry.key === key)!.instructions;
const skill = (name: string) =>
  RECRUITING_DEFAULT_SKILLS.find((entry) => entry.name === name)!.body;

/** Where a rule can live: a bot's instructions, a shared constant, a turn note or a skill body. */
const TEXTS = {
  Main: bot("main"),
  Sourcer: bot("sourcer"),
  Outreach: bot("outreach"),
  Scheduling: bot("scheduling"),
  RECRUITER_LANGUAGE,
  RECRUITING_BRIEF_CHECKLIST,
  RECRUITING_CALIBRATION_QUICK_SEARCH,
  RECRUITING_INTAKE_FLOW,
  RECRUITING_PDF_RENDERING,
  RECRUITING_ROUND_NEXT_STEP,
  RECRUITING_SCALE_START,
  RECRUITING_SEARCH_AUTOSAVED_NEXT_STEP,
  RECRUITING_SEARCH_BRIEF_TEMPLATE,
  RECRUITING_SEARCH_SAVED_NEXT_STEP,
  REPLY_IN_ENGLISH_NOTE,
  NAMED_EMAILS_NOTE,
  sendToNote: sendToNote(20),
  "Recruitment intake and handoff skill": skill("Recruitment intake and handoff"),
  "Recruitment sourcing continuation skill": skill("Recruitment sourcing continuation"),
  "Candidate evidence and feedback skill": skill("Candidate evidence and feedback"),
  "Review recruiting draft skill": skill("Review recruiting draft"),
  "Coordinate interview skill": skill("Coordinate interview"),
};

type Target = keyof typeof TEXTS;
const EVERY_BOT: Target[] = ["Main", "Sourcer", "Outreach", "Scheduling"];

type PinnedRule = {
  /** Short name of the behavior, shown in the test title and the failure. */
  rule: string;
  /** Every text the rule must appear in. */
  in: Target | Target[];
  /** A phrase each text must contain, or a regex it must match. */
  phrase: string | RegExp;
  /** The bug it fixed. */
  why: string;
  /** A retired wording that brought a bug back: it must not appear. */
  absent?: true;
};

const PINNED_RECRUITING_RULES: PinnedRule[] = [
  // Clarifying and intake
  {
    rule: "one clarifying question at a time",
    in: "Main",
    phrase: "Ask clarifying questions one at a time and back-to-back before any brief work",
    why: "Main sent the clarifying questions as one questionnaire.",
  },
  {
    rule: "one clarifying question at a time (every stage list)",
    in: EVERY_BOT,
    phrase:
      "ask the clarifying questions back-to-back, one at a time, with no tool work between them",
    why: "Teammates batched clarifying questions or did tool work between them.",
  },
  {
    rule: "one question per card",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "back-to-back, one per card",
    why: "Clarifying questions arrived together in one card.",
  },
  {
    rule: "no questions bundled in one card",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "together in one card",
    absent: true,
    why: "The retired wording put every clarifying question in one card.",
  },
  {
    rule: "no tool work between answers and questions",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "Between an answer and the next question make no tool calls, saves or drafts",
    why: "Intake stalled on saves and drafts between clarifying questions.",
  },
  {
    rule: "never ask whether to proceed",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "never ask whether to proceed, save, confirm or search",
    why: "Intake asked the recruiter for permission to search after the last answer.",
  },
  {
    rule: "first question with a small role create",
    in: "RECRUITING_INTAKE_FLOW",
    phrase:
      "asks the first clarifying question (ask it first) together with one small recruiting_role create",
    why: "The first question waited behind a full role save.",
  },
  {
    rule: "settle years when the JD has none",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "when the JD states none, the years-of-experience range",
    why: "Rounds were picked without a years range the JD never stated.",
  },
  {
    rule: "stated must-haves are hard requirements",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "is a hard requirement that every one of the ten must meet",
    why: "Rounds were filled with people who missed a stated must-have.",
  },
  {
    rule: "English questions",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "Write every question and option in English.",
    why: "Clarifying questions followed a Chinese JD into Chinese.",
  },
  {
    rule: "no clarifying question after the ten",
    in: ["RECRUITING_INTAKE_FLOW", "RECRUITING_ROUND_NEXT_STEP"],
    phrase:
      /once the ten are shown, never ask a clarifying question|Never ask a clarifying question after the ten/,
    why: "A clarifying question after the round replaced the next-step card.",
  },
  {
    rule: "never fetch the JD again",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "never fetch its link again",
    why: "Intake refetched the saved JD and searched connectors before the people search.",
  },
  {
    rule: "never ask the same question twice",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "Never ask a question twice, never ask about something already stated",
    why: "Intake repeated questions the recruiter had already answered.",
  },
  {
    rule: "search first after the last answer",
    in: "RECRUITING_INTAKE_FLOW",
    phrase:
      "first issue the calibration people searches as your very next step, before any read or save",
    why: "Main read and saved the role before the first round and the recruiter waited.",
  },
  {
    rule: "Main runs the first round itself",
    in: "Main",
    phrase:
      "issue the calibration quick searches yourself as your very next step, before any read or save",
    why: "Main handed the first round to Sourcer and the round never ran in that turn.",
  },
  {
    rule: "Main does not hand the first round to Sourcer",
    in: "Main",
    phrase: "hand off to Sourcer in the same turn",
    absent: true,
    why: "The retired wording sent the first round to Sourcer instead of running it.",
  },
  {
    rule: "a failed save never repeats the search",
    in: ["RECRUITING_INTAKE_FLOW", "Main"],
    phrase:
      /A failed save never means searching again|when either is refused, carry on and never search again/,
    why: "A refused brief save sent Main back to search again.",
  },
  {
    rule: "never ask to confirm a brief",
    in: "Main",
    phrase: "Never ask the recruiter to confirm a brief, summary or plan.",
    why: "Main asked the recruiter to confirm a brief summary before searching.",
  },
  {
    rule: "read the intake skill once",
    in: "Main",
    phrase: "Read the intake skill at most once per conversation",
    why: "Main re-read the skill, role and history before each question.",
  },
  {
    rule: "documents never hold up calibration",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "Role documents never hold up the calibration search",
    why: "JD PDFs and decks were prepared before the first round.",
  },
  {
    rule: "first round before documents",
    in: "RECRUITING_INTAKE_FLOW",
    phrase: "run the first calibration round before preparing any JD",
    why: "JD PDFs and decks were prepared before the first round.",
  },
  {
    rule: "documents after the first round",
    in: "Recruitment intake and handoff skill",
    phrase: "Prepare them after the first calibration round is presented, never before it",
    why: "JD PDFs and decks were prepared before the first round.",
  },
  {
    rule: "settle the language requirement",
    in: ["Main", "Recruitment intake and handoff skill"],
    phrase: /always settle the language requirement/i,
    why: "Briefs left the language requirement open and rounds ignored it.",
  },
  {
    rule: "an unconfirmed limit stays a preference",
    in: ["RECRUITING_BRIEF_CHECKLIST", "Recruitment intake and handoff skill"],
    phrase: "stays a preference, never a reject rule",
    why: "A maximum the agent proposed was applied as a reject rule.",
  },
  {
    rule: "Chinese PDFs embed a CJK font",
    in: "RECRUITING_PDF_RENDERING",
    phrase: "Noto Sans CJK SC",
    why: "Chinese JD PDFs rendered with missing glyphs.",
  },

  // Calibration rounds
  {
    rule: "exactly ten calibration profiles",
    in: EVERY_BOT,
    phrase: "Main runs the quick search for exactly 10 profiles",
    why: "Calibration rounds were sent to paid research or came back short.",
  },
  {
    rule: "quick searches are platform people searches",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: 'web_search_advanced_exa call with category "people"',
    why: "Calibration rounds searched the open web instead of profiles.",
  },
  {
    rule: "each search carries the location and must-haves",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "each with the brief's priority location (city and metro) and must-haves",
    why: "Searches without the location returned out-of-area people.",
  },
  {
    rule: "every pick meets every hard requirement",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "meets every hard requirement the row can show",
    why: "The ten were filled with people who never held the required title or worked at a startup.",
  },
  {
    rule: "four parallel searches",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase:
      "issue four differently worded platform people searches together as parallel tool calls in one step",
    why: "One search per step made the first round slow.",
  },
  {
    rule: "rest of the ten from one agent run",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: 'one people-search agent run fills the rest: agent_run with effort "low"',
    why: "Quick-search rows alone left many of the ten unverified; the recruiter wants the first two to four fast and the rest checked.",
  },
  {
    rule: "evidence highlights",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: 'highlightsQuery "concrete evidence of: "',
    why: "Picks were made on titles with no evidence of the core work.",
  },
  {
    rule: "searches save themselves",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "each search is saved to Results the moment it returns",
    why: "People were lost when the turn ended before a separate save.",
  },
  {
    rule: "strict hard requirements",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "a requirement is never relaxed to fill the ten",
    why: "The ten were filled with people who never held the required title or worked at a startup.",
  },
  {
    rule: "never fill the round with failures",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "never fill the round with people who fail a requirement",
    why: "Short pools were padded with people who fail a hard requirement.",
  },
  {
    rule: "picks fail no hard requirement",
    in: ["RECRUITING_SEARCH_SAVED_NEXT_STEP", "RECRUITING_SEARCH_AUTOSAVED_NEXT_STEP"],
    phrase: "only people whose rows fail no hard requirement",
    why: "The pick note let people who fail a must-have into the ten.",
  },
  {
    rule: "unknown is not failed",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase:
      "is unknown, never failed: prefer people who visibly meet it, never hold the round to verify it",
    why: "Rounds stalled verifying requirements a profile cannot show.",
  },
  {
    rule: "location first",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "anyone outside it, or whose row shows no location, never makes the ten",
    why: "Out-of-area people made the ten.",
  },
  {
    rule: "country or state is no location",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "a row showing only a country or a state is no location",
    why: "Rows showing only a country were counted as local.",
  },
  {
    rule: "not at the hiring company",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "not currently working at the hiring company itself",
    why: "Current employees of the client were shown as candidates.",
  },
  {
    rule: "skip new, retired and ended roles",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase:
      /anyone retired or semi-retired, anyone whose passage shows the row's current role already ended, or anyone visibly in their current role under six months/,
    why: "Retired people, ended roles and people under six months in role were picked.",
  },
  {
    rule: "nobody shown twice",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "nobody already returned for this role is ever shown again",
    why: "Later rounds showed people from earlier rounds again.",
  },
  {
    rule: "each round shows only new people",
    in: EVERY_BOT,
    phrase: "Each round shows only new people.",
    why: "Later rounds showed people from earlier rounds again.",
  },
  {
    rule: "show only fitting people in a short pool",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "show only the people who fit, never anyone who fails a requirement",
    why: "A short pool was shown with people who fail a requirement.",
  },
  {
    rule: "a short pool goes to the recruiter",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "offering to relax that named requirement or to keep searching with a deeper search",
    why: "A hard-to-fill role silently relaxed a requirement or started paid research.",
  },
  {
    rule: "the deeper search says it costs more",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "whose option says it takes longer and costs more",
    why: "The recruiter picked the deeper search without knowing it is slower and paid.",
  },
  {
    rule: "top-up only the missing number",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "request research on this role for only the missing number of people",
    why: "The deeper search re-ran research for the whole round.",
  },
  {
    rule: "research only for the top-up",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "never for a calibration round except that top-up",
    why: "Calibration rounds started paid research tasks.",
  },
  {
    rule: "no quota talk",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "Never tell the recruiter about search quotas",
    why: "The recruiter was told about search quotas and limits.",
  },
  {
    rule: "the people search needs no connection",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "The people search is built in; never request a connection for it.",
    why: "Agents asked the recruiter to connect a people-search service that is built in.",
  },
  {
    rule: "round lists itself",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "which lists them in chat with their profile passages",
    why: "The ten were listed twice.",
  },
  {
    rule: "pick straight from the rows",
    in: "RECRUITING_SEARCH_SAVED_NEXT_STEP",
    phrase: "no files, shell",
    why: "The pick wrote scratch files and ran shell before recording the round.",
  },
  {
    rule: "round feedback goes into the next quick search",
    in: "Main",
    phrase: "Round feedback before the calibration is accepted goes into your next quick search",
    why: "Round feedback went to Autumn instead of shaping the next quick search.",
  },
  {
    rule: "no parallel deep check",
    in: "Main",
    phrase: "Deep check, started in parallel",
    absent: true,
    why: "The retired wording started paid research alongside every calibration round.",
  },
  {
    rule: "calibration comes from quick searches",
    in: "Recruitment sourcing continuation skill",
    phrase: "Calibration rounds come from Main's quick searches",
    why: "Sourcer ran calibration rounds as Autumn tasks.",
  },
  {
    rule: "rounds are recorded with calibration_round",
    in: EVERY_BOT,
    phrase: "records them as the round with recruiting_research calibration_round",
    why: "Rounds were presented without being recorded, so feedback and acceptance had no round.",
  },
  {
    rule: "no Autumn reply per round",
    in: "Recruitment sourcing continuation skill",
    phrase: "ask Autumn on the same task, in one reply per round",
    absent: true,
    why: "The retired wording sent every calibration round to Autumn.",
  },
  {
    rule: "save feedback before the next round",
    in: EVERY_BOT,
    phrase: "first save what the recruiter said with recruiting_feedback and their exact words",
    why: "The next round ran before the recruiter's feedback was saved.",
  },
  {
    rule: "feedback on any people, never every person",
    in: EVERY_BOT,
    phrase:
      "the recruiter may comment on any people or only the overall direction, never on every person",
    why: "Agents required a rating for every person before accepting feedback.",
  },
  {
    rule: "never ask for a rating of every person",
    in: "Sourcer",
    phrase: "Never ask for a rating of every person",
    why: "Sourcer required a rating for every person.",
  },
  {
    rule: "feedback is not turned into rules",
    in: "Sourcer",
    phrase: "turn each comment into a rule",
    absent: true,
    why: "The retired wording turned one comment into a global rule.",
  },
  {
    rule: "one rejection is not a global rule",
    in: "Candidate evidence and feedback skill",
    phrase: "One rejection does not create a global rule",
    why: "One person's rejection became a rule for the whole role.",
  },
  {
    rule: "unverified must-haves are named",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "name it for that person in calibration_round's unverified",
    why: "People whose profile is silent on a must-have were shown without a mark.",
  },

  // After the round and acceptance
  {
    rule: "never list the ten again",
    in: "RECRUITING_ROUND_NEXT_STEP",
    phrase: "never list them again",
    why: "The ten were listed twice.",
  },
  {
    rule: "the next-step card",
    in: "RECRUITING_ROUND_NEXT_STEP",
    phrase: "The step after it is only one native question card (ask_user) offering the next step",
    why: "Rounds ended on a bare list with no recommended next step.",
  },
  {
    rule: "the next step offers to find similar people",
    in: "RECRUITING_ROUND_NEXT_STEP",
    phrase: '"Find 150 similar people"',
    why: "Rounds ended with no recommended next step.",
  },
  {
    rule: "no generic any-feedback",
    in: "RECRUITING_ROUND_NEXT_STEP",
    phrase: 'Never end a round on a bare list or a generic "any feedback?"',
    why: "Rounds ended on a generic feedback question.",
  },
  {
    rule: "drafts are the whole sequence",
    in: "RECRUITING_ROUND_NEXT_STEP",
    phrase: '"Draft the outreach emails"',
    why: '"Draft the first email" was handed over as a single email instead of the sequence.',
  },
  {
    rule: "a scale request is the acceptance",
    in: "RECRUITING_SCALE_START",
    phrase: "That request is the acceptance",
    why: "Agents asked the recruiter to confirm a round they had just accepted.",
  },
  {
    rule: "never re-confirm an accepted round",
    in: "RECRUITING_SCALE_START",
    phrase: "never ask them to confirm the round again",
    why: "Agents asked the recruiter to confirm a round they had just accepted.",
  },
  {
    rule: "people feedback is not acceptance",
    in: "RECRUITING_SCALE_START",
    phrase: "Feedback about individual people alone is not acceptance",
    why: "Comments on people were recorded as acceptance and the role scaled.",
  },
  {
    rule: "turning people down is feedback even with find more",
    in: "RECRUITING_SCALE_START",
    phrase: "even when it also says to find more of a kind",
    why: '"A and B don\'t fit, find more who led 50+" was read as acceptance and scaled to 170.',
  },
  {
    rule: "acceptance carries no correction",
    in: "RECRUITING_SCALE_START",
    phrase: "Acceptance carries no correction.",
    why: "A correction was treated as acceptance.",
  },
  {
    rule: "scale with the people search first",
    in: "RECRUITING_SCALE_START",
    phrase: "waves of four differently worded web_search_advanced_exa people searches",
    why: "Scale went straight to paid research.",
  },
  {
    rule: "find N with N already saved means N more",
    in: "RECRUITING_SCALE_START",
    phrase:
      "means that many more, so the target is the current total plus it, unless they say total",
    why: '"lets find 50" with 69 saved was answered "the search has reached 50" instead of finding 50 more.',
  },
  {
    rule: "the scale stops at the target",
    in: "RECRUITING_SCALE_START",
    phrase:
      "until the role holds the target (each search returns peopleInResults, the role's total, already counting the people saved before this request)",
    why: "Scale kept searching after the role held the target.",
  },
  {
    rule: "no deeper search at the target",
    in: "RECRUITING_SCALE_START",
    phrase: "When Results already hold the target, there is no deeper search and no handoff.",
    why: '"find 50" with 124 people saved still started paid research.',
  },
  {
    rule: "no research at the target",
    in: "Recruitment sourcing continuation skill",
    phrase: "when Results already hold the target, start no research and report the count",
    why: '"find 50" with 124 people saved still started paid research.',
  },
  {
    rule: "hand off only the shortfall",
    in: "RECRUITING_SCALE_START",
    phrase: "only when the people search stopped short of the target",
    why: "The whole target was handed to paid research.",
  },
  {
    rule: "exclude everyone already returned",
    in: "RECRUITING_SCALE_START",
    phrase: "everyone already returned excluded",
    why: "Scale research returned people already in Results.",
  },
  {
    rule: "report the count before the handoff",
    in: "RECRUITING_SCALE_START",
    phrase: "tell the recruiter in two or three lines with message_user",
    why: "A handoff ended the turn before the recruiter heard the count.",
  },
  {
    rule: "handoff last",
    in: "RECRUITING_SCALE_START",
    phrase: "end the turn with exactly one handoff, last",
    why: "Calls after a handoff were refused and the scale stalled.",
  },
  {
    rule: "email drafts only on request (scale)",
    in: "RECRUITING_SCALE_START",
    phrase: "Draft outreach email only when the recruiter asks for it",
    why: "Scaling started an email draft nobody asked for.",
  },
  {
    rule: "email drafts only on request (stages)",
    in: EVERY_BOT,
    phrase: "an email draft only when the recruiter asks for one",
    why: "Scaling started an email draft nobody asked for.",
  },
  {
    rule: "email drafts only on request (Sourcer)",
    in: "Sourcer",
    phrase: "Hand an email draft to Outreach only when the recruiter asked for one",
    why: "Sourcer handed an unrequested email draft to Outreach.",
  },
  {
    rule: "start research without asking",
    in: "Sourcer",
    phrase: "as the role's first research request without asking anyone",
    why: "Sourcer asked whether to start fresh when quick-search rounds left no research task.",
  },
  {
    rule: "never ask whether to start fresh",
    in: "Recruitment sourcing continuation skill",
    phrase: "never ask whether to start fresh",
    why: "Sourcer asked whether to start fresh when quick-search rounds left no research task.",
  },
  {
    rule: "feedback on the same Autumn task",
    in: "Sourcer",
    phrase: "providerTaskId from saved candidate sources",
    why: "Feedback started a new research task instead of replying on the role's task.",
  },
  {
    rule: "no status polling",
    in: "Sourcer",
    phrase: "make one status read, then stop; results arrive in this conversation automatically",
    why: "Sourcer looped on research status.",
  },
  {
    rule: "never loop on status",
    in: "Sourcer",
    phrase: "Never loop on status",
    why: "Sourcer looped on research status.",
  },
  {
    rule: "missing resume is unknown",
    in: ["Sourcer", "RECRUITER_LANGUAGE"],
    phrase:
      /Missing resume is unknown, never a rejection|Missing resume evidence alone is not rejection/,
    why: "People without a resume were rejected.",
  },
  {
    rule: "a strong grade is a claim",
    in: "Sourcer",
    phrase: "show that person as needing a check",
    why: "A strong grade over a merely listed skill was relayed as verified.",
  },
  {
    rule: "record acceptance before scaling",
    in: "Sourcer",
    phrase: "recruiting_feedback target round operation approve",
    why: "Scale ran without the acceptance being recorded.",
  },
  {
    rule: "match scores out of 100",
    in: "Recruitment sourcing continuation skill",
    phrase: "Match scores are always on a 0–100 scale",
    why: "Scores were shown on mixed scales.",
  },

  // Search brief template
  {
    rule: "a title alone is not enough",
    in: "RECRUITING_SEARCH_BRIEF_TEMPLATE",
    phrase: "A matching title alone is NOT enough",
    why: "Research returned title-only matches.",
  },
  {
    rule: "title-only matches are not returned",
    in: "RECRUITING_SEARCH_BRIEF_TEMPLATE",
    phrase: "Title-only matches are not returned",
    why: "Research returned title-only matches.",
  },
  {
    rule: "never infer from names",
    in: ["RECRUITING_SEARCH_BRIEF_TEMPLATE", "Recruitment sourcing continuation skill"],
    phrase: "never infer",
    why: "Industry and traits were inferred from names.",
  },
  {
    rule: "no constraint the brief does not state",
    in: "RECRUITING_SEARCH_BRIEF_TEMPLATE",
    phrase: "never add a constraint it does not state",
    why: "Research requests added constraints the recruiter never set.",
  },
  {
    rule: "tenure rule only when set",
    in: "RECRUITING_SEARCH_BRIEF_TEMPLATE",
    phrase: "only when the brief sets a tenure rule",
    why: "A tenure rule was applied to roles that never set one.",
  },
  {
    rule: "years range slot",
    in: "RECRUITING_SEARCH_BRIEF_TEMPLATE",
    phrase: "{min}-{max} years",
    why: "Research requests had no years range.",
  },
  {
    rule: "nothing silently passed",
    in: "RECRUITING_SEARCH_BRIEF_TEMPLATE",
    phrase: "never silently passed",
    why: "Unchecked requirements were silently passed.",
  },
  {
    rule: "positive examples",
    in: "RECRUITING_SEARCH_BRIEF_TEMPLATE",
    phrase: "POSITIVE EXAMPLES",
    why: "Research ignored the accepted round.",
  },
  {
    rule: "current role start month",
    in: "RECRUITING_SEARCH_BRIEF_TEMPLATE",
    phrase: "current role start month",
    why: "People under six months in role could not be screened out.",
  },
  {
    rule: "core work over title",
    in: "RECRUITING_CALIBRATION_QUICK_SEARCH",
    phrase: "rather than just a matching title",
    why: "The ten were picked on titles alone.",
  },

  // Contacts and outreach
  {
    rule: "copy emails exactly",
    in: "Outreach",
    phrase: "Copy each email exactly from the lookup; never guess or think aloud about one.",
    why: "Outreach leaked self-talk spelling unusual addresses and cut them short.",
  },
  {
    rule: "never guess an email",
    in: EVERY_BOT,
    phrase: "never invent or guess an email",
    why: "Agents guessed addresses for named people.",
  },
  {
    rule: "look contacts up without asking",
    in: "Outreach",
    phrase: "look the people up yourself without asking",
    why: "Outreach asked which people to look up, or stopped finding no lookup service.",
  },
  {
    rule: "never re-look up someone",
    in: "Outreach",
    phrase: "skip anyone whose email is already saved",
    why: "Lookups paid again for people whose email was already saved.",
  },
  {
    rule: "reuse paid lookups",
    in: "Outreach",
    phrase: "Reuse existing paid lookup receipts",
    why: "Lookups paid again for the same identity.",
  },
  {
    rule: "never redo paid work",
    in: "RECRUITER_LANGUAGE",
    phrase: "show those results first and do only what is still missing, never redoing paid work",
    why: "Repeat requests redid contact lookups and drafts already done.",
  },
  {
    rule: "lookup up to the number asked",
    in: "Outreach",
    phrase: "never more without being asked",
    why: "Outreach looked up the whole pool, or asked which people.",
  },
  {
    rule: "find_emails first",
    in: "Outreach",
    phrase: "Only when find_emails is not listed, use enrich_bulk",
    why: "A contact request used the raw enrichment tool although the multi-source lookup was listed.",
  },
  {
    rule: "never end a turn on a lookup in progress",
    in: "Outreach",
    phrase: "never end a turn with a lookup in progress",
    why: "Outreach ended its turn saying the lookup was pending.",
  },
  {
    rule: "lookups never stop on low credits",
    in: "Review recruiting draft skill",
    phrase: "never check credits first or stop over a low balance",
    why: "Outreach checked one source's balance and stopped a follow-up lookup.",
  },
  {
    rule: "public emails only from the person's own page",
    in: "Outreach",
    phrase: "accept it only from their own profile page",
    why: "Public-web addresses risked coming from namesakes and report sites.",
  },
  {
    rule: "best found email without asking",
    in: "Outreach",
    phrase: "Use each person's best found email without asking",
    why: "Outreach stopped a send to ask whether work addresses were allowed.",
  },
  {
    rule: "a lookup service exists",
    in: "Outreach",
    phrase: "Never claim no lookup service before searching your tools.",
    why: "Outreach on older crews said there was no lookup service and stopped.",
  },
  {
    rule: "drafts are three emails in chat",
    in: "Outreach",
    phrase: "is three emails (days 0, 4, 9) in the chat reply",
    why: "Drafts came back as one email, or only as a file.",
  },
  {
    rule: "a draft however worded is the sequence",
    in: "Outreach",
    phrase: 'however worded (even "first email")',
    why: 'A handoff saying "first email draft" produced one email instead of the sequence.',
  },
  {
    rule: "drafts written out in the reply",
    in: "RECRUITER_LANGUAGE",
    phrase:
      "Emails and drafts the recruiter asks to see are written out in full in the reply text itself",
    why: "Requested drafts were only attached as files.",
  },
  {
    rule: "sequence drafts in chat first",
    in: "Review recruiting draft skill",
    phrase: "first write every email (subject and full body) in the chat reply",
    why: "A {{firstName}} template was saved as a file instead of emails in chat.",
  },
  {
    rule: "one named email per person",
    in: "Outreach",
    phrase: "write one first email per person (up to ten; never ask which)",
    why: 'A draft for "these people" came back as one generic email with [candidate name].',
  },
  {
    rule: "these people get named emails",
    in: "NAMED_EMAILS_NOTE",
    phrase: "never a placeholder such as [candidate name] or {{first_name}}",
    why: 'A draft for "these people" came back with placeholders.',
  },
  {
    rule: "no variables in a draft",
    in: "Outreach",
    phrase: "Never {{variables}} in a draft (only a send uses them)",
    why: "Drafts had {{variables}}; the unscoped rule also blocked the lead variables a send needs.",
  },
  {
    rule: "drafts need no contact check",
    in: "Outreach",
    phrase: "a draft needs no contact or mailbox check, and personalization is not a fit claim",
    why: "Drafts waited on contact lookups and stayed generic for an unassessed pool.",
  },
  {
    rule: "drafts need no approval or resume",
    in: "Review recruiting draft skill",
    phrase: "Internal drafts need no send approval or missing-resume prerequisite",
    why: "Drafts were held for approval or a resume.",
  },
  {
    rule: "send to N takes the first results",
    in: "Outreach",
    phrase: "else the role's first results up to that number (never ask which ones)",
    why: '"Send to 20" stopped to ask which 20.',
  },
  {
    rule: "missing emails never stop a send",
    in: "Outreach",
    phrase: "skip anyone still without one (name them after the card; never a reason to stop)",
    why: "A send stopped on people without an email.",
  },
  {
    rule: "personalization makes each email theirs",
    in: "Outreach",
    phrase: "their own opening line: that makes each email theirs, never write separate ones",
    why: "Outreach refused to send to 20 without writing 20 separate emails.",
  },
  {
    rule: "the send card is the one confirmation",
    in: "Outreach",
    phrase:
      "whose card lists every recipient and is the one confirmation, even when a handoff says only to prepare",
    why: "Outreach asked in text about recipients, or stopped when a handoff said only to prepare.",
  },
  {
    rule: "a send to named people goes only to them",
    in: "Outreach",
    phrase: "then call activate_campaign (recipients: the named people)",
    why: '"Send this email to him" was refused because the campaign held 15 other unsent people.',
  },
  {
    rule: "a one-person draft is sent as written",
    in: "Outreach",
    phrase:
      "save it with ensure_role_campaign steps (that one email) and recipients (them), then activate_campaign with them: they get exactly it",
    why: '"Send this email to them" was refused because the role\'s saved sequence was not the one-person draft shown.',
  },
  {
    rule: "a one-person draft is sent as written (skill)",
    in: "Review recruiting draft skill",
    phrase: 'so "send it" sends exactly that email to them while everyone else keeps the role\'s',
    why: '"Send this email to them" was refused because the role\'s saved sequence was not the one-person draft shown.',
  },
  {
    rule: "a send to named people goes only to them (Main)",
    in: "Main",
    phrase: "then activate_campaign with any people they named as recipients",
    why: '"Send this email to him" was refused because the campaign held 15 other unsent people.',
  },
  {
    rule: "the send card is the one confirmation (Main)",
    in: "Main",
    phrase: "its confirmation card is the one-time approval",
    why: "Main asked for approval in text before the campaign's send card.",
  },
  {
    rule: "send to N stays a send",
    in: "sendToNote",
    phrase: "Never turn it into separate unsent drafts or tell Outreach not to send",
    why: 'Main handed "send to 20" on as "prepare drafts, do not send" and no card appeared.',
  },
  {
    rule: "saved steps are reused or replaced",
    in: "Outreach",
    phrase: "Reuse saved steps unless blank or a change was asked; saving again replaces them.",
    why: "A requested copy change could not replace the draft campaign's steps.",
  },
  {
    rule: "role campaigns through ensure_role_campaign",
    in: ["Main", "Outreach"],
    phrase:
      "For a role's outreach campaign use ensure_role_campaign, never create_campaign directly.",
    why: "Agents created stray campaigns outside the role.",
  },
  {
    rule: "reply_to_email only in existing threads",
    in: ["Main", "Outreach"],
    phrase: "reply_to_email is only for replies in an existing thread.",
    why: "Outreach declined a plain send to one person as a reply with no original email.",
  },
  {
    rule: "replies go through the confirmation card",
    in: ["Main", "Outreach"],
    phrase:
      "so the call itself is the draft for review: call it rather than refusing or pasting the text in chat",
    why: "Agents refused to reply to a candidate, saying there was no approval flow.",
  },
  {
    rule: "a candidate reply ends follow-ups",
    in: "Outreach",
    phrase:
      "A candidate reply ends automated follow-ups: never queue more sequence steps for them, and the next step is a human-reviewed reply.",
    why: "Sequence steps kept going after a candidate replied.",
  },
  {
    rule: "turn on stop on reply",
    in: "Outreach",
    phrase: "tell the user to turn on stop on reply",
    why: "The mail service has no per-lead stop, so follow-ups continued after replies.",
  },
  {
    rule: "silent CRM binding",
    in: ["Main", "Outreach"],
    phrase: "bind it with recruiting_crm_target without asking (never before the first round)",
    why: "Agents asked the recruiter about CRM setup.",
  },
  {
    rule: "no CRM setup talk in bots",
    in: EVERY_BOT,
    phrase: "no CRM role is linked",
    absent: true,
    why: "The retired wording told the recruiter no CRM role was linked.",
  },
  {
    rule: "no campaign setup talk in bots",
    in: EVERY_BOT,
    phrase: "set up a campaign, pick a mailbox",
    absent: true,
    why: "The retired wording asked the recruiter to set up a campaign and mailbox.",
  },
  {
    rule: "who replied reads the mailbox",
    in: EVERY_BOT,
    phrase: "never claim no inbox while Instantly is assigned or answer from old history",
    why: "Reply questions were answered from old saved history or said there was no inbox.",
  },

  // Routing and handoffs
  {
    rule: "Main hands off first",
    in: "Main",
    phrase: "call handoff_to_bot as your very first step, with no text and no reads before it",
    why: "Main read for 13-40 s before handing off and the recruiter saw nothing.",
  },
  {
    rule: "contacts, drafts and sends go to Outreach",
    in: "Main",
    phrase:
      "Hand an email draft, a contact lookup or a send to named people or a number of people to Outreach as your last call, in the recruiter's words",
    why: 'Main refused "send to 20" and "find contacts" itself, and rewrote the request.',
  },
  {
    rule: "Main does not pick or judge the people",
    in: "Main",
    phrase: "never pick the people or call the saved results unready yourself",
    why: "Main declined outreach because the saved pool was unassessed.",
  },
  {
    rule: "scheduling goes to Scheduling",
    in: "Main",
    phrase:
      "Calendar availability, interview times, bookings and interview confirmations belong to Scheduling",
    why: "Main searched for a calendar itself or asked the recruiter to connect one.",
  },
  {
    rule: "never decline a request",
    in: "RECRUITER_LANGUAGE",
    phrase: "never decline a clear request or ask them to pick or review people first",
    why: "Agents declined clear requests or asked the recruiter to review people first.",
  },
  {
    rule: "an unclear request gets a best guess or one question",
    in: EVERY_BOT,
    phrase:
      "When a request is clear enough, act; when who, what or when is unclear, ask one question with options. Never decline work you or a teammate can do.",
    why: "Agents refused vague asks, or asked the recruiter to pick what they could pick.",
  },
  {
    rule: "honest handoffs",
    in: "RECRUITER_LANGUAGE",
    phrase: "a question they have not answered is still open, never an agreement",
    why: "Handoffs reported an unanswered question as agreed.",
  },
  {
    rule: "handoffs quote the recruiter",
    in: "RECRUITER_LANGUAGE",
    phrase: "quote the recruiter's own words",
    why: "Handoffs reworded the request and changed its meaning.",
  },

  // Scheduling
  {
    rule: "never decline bookings for unemailed people",
    in: "Scheduling",
    phrase:
      "Never refuse a booking because the person has not been emailed, has not replied or has not agreed yet",
    why: "Scheduling refused to book a candidate who had not been emailed or agreed yet.",
  },
  {
    rule: "offer a new booking when nothing exists to move",
    in: "Scheduling",
    phrase: "offer to book that new time instead with the real openings",
    why: "Scheduling refused to move an interview that did not exist.",
  },
  {
    rule: "the booking card is the one approval",
    in: "Scheduling",
    phrase:
      "its card is the one approval, so never ask them to confirm the time, booking, change or reply first",
    why: "Scheduling asked the recruiter to confirm a named time before the booking card.",
  },
  {
    rule: "no plain-text approval question",
    in: "Scheduling",
    phrase: 'or in plain text ("Approve me to send?")',
    why: "Scheduling asked for approval in plain text before the card.",
  },
  {
    rule: "the interview card is the decision (skill)",
    in: "Coordinate interview skill",
    phrase: "The action's own card is that decision",
    why: 'The skill had Scheduling ask "approve moving it?" before every booking change.',
  },
  {
    rule: "length only for multi-length events",
    in: "Scheduling",
    phrase:
      "Pass lengthInMinutes to create_booking only when the event type offers several lengths.",
    why: "A duration for a single-length event type was rejected by the calendar.",
  },
  {
    rule: "reschedule keeps the length",
    in: "Scheduling",
    phrase: "it keeps the booking's length",
    why: "Scheduling looped asking the recruiter to confirm a reschedule's duration.",
  },
  {
    rule: "an unanswered card is not a booking",
    in: "Scheduling",
    phrase: "An earlier card left unanswered is not a booking",
    why: "Scheduling refused to book because of an old unanswered card.",
  },
  {
    rule: "candidate mail is in the outreach mailbox",
    in: "Scheduling",
    phrase: "A candidate's outreach emails are in the role's Instantly mailbox",
    why: "Scheduling searched only the personal mailbox and never sent the confirmation.",
  },
  {
    rule: "use the assigned calendar",
    in: "Scheduling",
    phrase: "never ask to connect another calendar while it is assigned",
    why: "Scheduling asked to connect another calendar while one was assigned.",
  },

  // Recruiter language and every teammate
  {
    rule: "English first",
    in: "RECRUITER_LANGUAGE",
    phrase: "Write everything the recruiter sees in English",
    why: "Replies followed a Chinese JD or recruiter into Chinese.",
  },
  {
    rule: "another language only on request",
    in: "RECRUITER_LANGUAGE",
    phrase: "Use another language only when the recruiter explicitly asks for it.",
    why: "Replies followed a Chinese JD or recruiter into Chinese.",
  },
  {
    rule: "English turn note",
    in: "REPLY_IN_ENGLISH_NOTE",
    phrase: "write every reply, summary, question and card of this turn in English",
    why: "A recruiter writing Chinese still pulled replies into Chinese.",
  },
  {
    rule: "internals stay internal",
    in: "RECRUITER_LANGUAGE",
    phrase: "keep IDs, tool names, gate codes, cursors and JSON internal",
    why: "Recruiter chat showed IDs, tool names and JSON.",
  },
  {
    rule: "no vendor names",
    in: "RECRUITER_LANGUAGE",
    phrase:
      "Never name a vendor or tool (Autumn, Coresignal, FullEnrich, ContactOut, LeadMagic, Instantly, Composio, Cal.com, Gmail, Google Calendar, HubSpot, MCP, API, REST) in chat replies, cards, progress lines, questions or emails",
    why: "Recruiter chat named vendors and tools.",
  },
  {
    rule: "connect cards may name the provider",
    in: "RECRUITER_LANGUAGE",
    phrase: "the only exception is a connect-request card, which names the provider to connect",
    why: "Connect-request cards could not say what to connect.",
  },
  {
    rule: "no setup words",
    in: "RECRUITER_LANGUAGE",
    phrase:
      'never say CRM, campaign, leads, lead list, mailbox or sending-account binding, mapping or "setup" to the recruiter',
    why: "Recruiters were asked about campaign, mailbox and CRM setup.",
  },
  {
    rule: "silent setup",
    in: "RECRUITER_LANGUAGE",
    phrase: "do that setup silently and speak only in recruiter language",
    why: "Recruiters were asked about campaign, mailbox and CRM setup.",
  },
  {
    rule: "ETA only for background work",
    in: "RECRUITER_LANGUAGE",
    phrase: "Give a zoned ETA only for background work that keeps running after this turn",
    why: "Agents promised later work they could do in the same turn.",
  },
  {
    rule: "do now what can be done now",
    in: "RECRUITER_LANGUAGE",
    phrase: "you do now and never promise for a later time",
    why: "Agents promised later work they could do in the same turn.",
  },
  {
    rule: "no zoned ETA for unfinished work in bots",
    in: EVERY_BOT,
    phrase: "with an honest zoned ETA for unfinished work",
    absent: true,
    why: "The retired wording let turns end on an ETA instead of the work.",
  },
  {
    rule: "never narrate failed internal checks",
    in: "RECRUITER_LANGUAGE",
    phrase: "never report a failed internal check or save",
    why: "Outreach told the recruiter draft access was blocked although the send card was ready.",
  },
  {
    rule: "queued is not sent",
    in: "RECRUITER_LANGUAGE",
    phrase: "Never claim queued or approved means sent, saved or booked.",
    why: "Queued or approved actions were reported as done.",
  },
  {
    rule: "turns end on a deliverable",
    in: "RECRUITER_LANGUAGE",
    phrase:
      "End every turn on a result, one concrete question or card, a handoff, or background work",
    why: "Turns ended on promises and acknowledgements.",
  },
  {
    rule: "no bare save or acknowledgement",
    in: EVERY_BOT,
    phrase:
      "A turn never ends on a bare save or acknowledgement: after an answer, ask the next clarifying question at once, or when none is missing run the calibration search in the same turn.",
    why: "Turns ended after saving an answer, with nothing for the recruiter.",
  },
  {
    rule: "fix a rejected call at once",
    in: EVERY_BOT,
    phrase: "fix exactly what the error names and call it again at once",
    why: "Turns ended on a failed save or an apology.",
  },
  {
    rule: "no process narration",
    in: EVERY_BOT,
    phrase: "no process narration",
    why: "Replies narrated internal steps.",
  },
  {
    rule: "no fixed questionnaire",
    in: EVERY_BOT,
    phrase: "Never send a fixed questionnaire",
    why: "Recruiters got a generic questionnaire.",
  },
  {
    rule: "no gate codes",
    in: EVERY_BOT,
    phrase: "Never ask a recruiter to confirm G0, G1 or G2",
    why: "Recruiters were asked to confirm internal gate codes.",
  },
  {
    rule: "read before asking",
    in: EVERY_BOT,
    phrase: "recalled preferences before asking",
    why: "Agents asked for information already supplied.",
  },
  {
    rule: "recommend first",
    in: EVERY_BOT,
    phrase: "list the choice you recommend first",
    why: "Question cards offered choices with no recommendation.",
  },
  {
    rule: "results first",
    in: EVERY_BOT,
    phrase: "never hold finished results until all work is done",
    why: "Finished results waited behind the next search.",
  },
  {
    rule: "retractable preferences",
    in: EVERY_BOT,
    phrase: "withdraws or contradicts a preference, update or forget it",
    why: "Withdrawn preferences kept being applied.",
  },
  {
    rule: "confirmed preferences only",
    in: EVERY_BOT,
    phrase: "only after the human confirms it",
    why: "Inferred preferences were saved without confirmation.",
  },
  {
    rule: "no approval card for a round",
    in: [...EVERY_BOT, "Recruitment intake and handoff skill"],
    phrase:
      /A calibration round never uses an approval card|never request an approval card for a calibration round/,
    why: "Calibration rounds asked for a ten-profile approval card.",
  },
  {
    rule: "request a missing connection",
    in: EVERY_BOT,
    phrase:
      "When the user names a service that is not connected, call request_connection with that provider before answering",
    why: "Agents told the recruiter to open settings instead of showing a connect card.",
  },
  {
    rule: "say when a connected service blocks",
    in: EVERY_BOT,
    phrase: "when a connected service blocks the task, say so explicitly",
    why: "A blocked connected service was reported as done.",
  },
  {
    rule: "never make the recruiter wait",
    in: EVERY_BOT,
    phrase:
      "Never make the recruiter wait or poll: start the work and answer with where it stands.",
    why: "Recruiters waited or polled for progress.",
  },
  {
    rule: "one progress line",
    in: EVERY_BOT,
    phrase: "post one progress line in business language and nothing more until there is a result",
    why: "Long research filled the chat with progress messages.",
  },
  {
    rule: "no filler",
    in: EVERY_BOT,
    phrase: "say what changed and stop; no filler",
    why: "Finished work ended with filler and re-asking.",
  },
  {
    rule: "name the blocker",
    in: EVERY_BOT,
    phrase: "If blocked, say exactly what is blocked and what would unblock it.",
    why: "Blocked work was reported vaguely.",
  },
  {
    rule: "routines only after yes",
    in: EVERY_BOT,
    phrase: "create it with schedule_create only after the recruiter says yes",
    why: "Routines were created without the recruiter's yes.",
  },
  {
    rule: "AE outreach never says BDR or SDR",
    in: "Review recruiting draft skill",
    phrase: "never says BDR or SDR",
    why: "Outreach to Account Executives was titled for a junior role.",
  },
];

describe("pinned recruiting rules", () => {
  const cases = PINNED_RECRUITING_RULES.flatMap((pinned) =>
    (Array.isArray(pinned.in) ? pinned.in : [pinned.in]).map((target) => ({ ...pinned, target })),
  );

  it.each(cases)("$target: $rule", ({ rule, target, phrase, why, absent }) => {
    const text = TEXTS[target];
    const found = typeof phrase === "string" ? text.includes(phrase) : phrase.test(text);
    const message = absent
      ? `Retired wording for "${rule}" is back in ${target}. It caused: ${why}`
      : `Pinned rule "${rule}" is missing from ${target}. It fixed: ${why} To change it on purpose, edit recruiting-rules.test.ts in the same commit and say why.`;
    expect(found, message).toBe(!absent);
  });

  it("names each rule and target once", () => {
    const keys = cases.map((entry) => `${entry.target}: ${entry.rule}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
