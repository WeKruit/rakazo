import { describe, expect, it } from "vitest";
import {
  RECRUITER_LANGUAGE,
  RECRUITING_CALIBRATION_QUICK_SEARCH,
  RECRUITING_DEFAULT_BOTS,
  RECRUITING_DEFAULT_SKILLS,
  RECRUITING_INTAKE_FLOW,
  RECRUITING_PDF_RENDERING,
  RECRUITING_ROUND_NEXT_STEP,
  RECRUITING_SCALE_START,
  RECRUITING_SEARCH_BRIEF_TEMPLATE,
  RECRUITING_SEARCH_SAVED_NEXT_STEP,
  recruiterQuestionNotInEnglish,
  recruitingBriefConfirmedNextStep,
} from "./recruiting-defaults.js";

describe("calibration fast path", () => {
  it("hands the new revision on with the confirmed brief", () => {
    expect(recruitingBriefConfirmedNextStep(5)).toContain("expectedRoleRevision 5");
  });

  it("keeps the pick off files and shell", () => {
    expect(RECRUITING_SEARCH_SAVED_NEXT_STEP).toContain("calibration_round");
    expect(RECRUITING_SEARCH_SAVED_NEXT_STEP).toContain("no files, shell");
  });
});

describe("maintained recruiting defaults", () => {
  it.each(RECRUITING_DEFAULT_BOTS)(
    "$name asks only consequential questions and keeps preferences retractable",
    (bot) => {
      expect(bot.instructions).toContain("Never send a fixed questionnaire");
      expect(bot.instructions).toContain("Never ask a recruiter to confirm G0, G1 or G2");
      expect(bot.instructions).toContain("recalled preferences before asking");
      expect(bot.instructions).toContain("list the choice you recommend first");
      expect(bot.instructions).toContain("never hold finished results until all work is done");
      expect(bot.instructions).toContain(
        "withdraws or contradicts a preference, update or forget it",
      );
      expect(bot.instructions).toContain("only after the human confirms it");
    },
  );

  it.each(RECRUITING_DEFAULT_BOTS)("$name works ahead, reports once and offers routines", (bot) => {
    expect(bot.instructions).toContain(
      "Never make the recruiter wait or poll: start the work and answer with where it stands.",
    );
    expect(bot.instructions).toContain(
      "post one progress line in business language and nothing more until there is a result",
    );
    expect(bot.instructions).toContain("say what changed and stop; no filler");
    expect(bot.instructions).toContain(
      "If blocked, say exactly what is blocked and what would unblock it.",
    );
    expect(bot.instructions).toContain(
      "create it with schedule_create only after the recruiter says yes",
    );
  });

  it("never names a vendor or exposes setup to the recruiter", () => {
    for (const part of [
      "keep IDs, tool names, gate codes, cursors and JSON internal",
      "Never name a vendor or tool (Autumn, Coresignal, FullEnrich, ContactOut, LeadMagic, Instantly, Composio, Cal.com, Gmail, Google Calendar, HubSpot, MCP, API, REST) in chat replies, cards, progress lines, questions or emails",
      "the only exception is a connect-request card, which names the provider to connect",
      'never say CRM, campaign, leads, lead list, mailbox or sending-account binding, mapping or "setup" to the recruiter',
      "do that setup silently and speak only in recruiter language",
      "Give a zoned ETA only for background work that keeps running after this turn",
      "you do now and never promise for a later time",
    ])
      expect(RECRUITER_LANGUAGE).toContain(part);
  });

  // Each shared rule has one source: the executor adds recruiter language to every recruiting
  // run and the role context carries the calibration, scale and PDF rules.
  it.each([
    RECRUITER_LANGUAGE,
    RECRUITING_CALIBRATION_QUICK_SEARCH,
    RECRUITING_ROUND_NEXT_STEP,
    RECRUITING_SCALE_START,
    RECRUITING_PDF_RENDERING,
  ])("keeps a shared rule out of bot instructions and skills (%#)", (rule) => {
    for (const bot of RECRUITING_DEFAULT_BOTS) expect(bot.instructions).not.toContain(rule);
    for (const skill of RECRUITING_DEFAULT_SKILLS) expect(skill.body).not.toContain(rule);
  });

  it.each(["main", "outreach"])(
    "%s replies through the confirmation card, never refusing",
    (key) => {
      const bot = RECRUITING_DEFAULT_BOTS.find((entry) => entry.key === key)!;
      expect(bot.instructions).toContain(
        "call reply_to_email (or native_instantly_reply_to_email) with the original email id and the full reply text: like every send or create-event tool it shows the native confirmation card and nothing is sent until the human confirms",
      );
      expect(bot.instructions).toContain(
        "never refuse it, never send the text in chat instead, and never say there is no approval flow",
      );
    },
  );

  it.each(RECRUITING_DEFAULT_BOTS)("$name requests a missing connection in chat", (bot) => {
    expect(bot.instructions).toContain(
      "When the user names a service that is not connected, call request_connection with that provider before answering",
    );
    expect(bot.instructions).toContain(
      "when a connected service blocks the task, say so explicitly",
    );
  });

  it("Main asks clarifying questions one at a time", () => {
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain(
      "Ask clarifying questions one at a time and back-to-back before any brief work",
    );
  });

  it("runs calibration rounds as quick searches and keeps Autumn for scale", () => {
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain(
      "Round feedback before the calibration is accepted goes into your next quick search",
    );
    expect(RECRUITING_CALIBRATION_QUICK_SEARCH).toContain(
      "each search is saved to Results the moment it returns",
    );
    expect(main.instructions).not.toContain("Deep check, started in parallel");
    expect(RECRUITING_CALIBRATION_QUICK_SEARCH).toContain(
      "never for a calibration round except that top-up",
    );
    const sourcing = RECRUITING_DEFAULT_SKILLS.find(
      (skill) => skill.name === "Recruitment sourcing continuation",
    )!;
    expect(sourcing.body).toContain("Calibration rounds come from Main's quick searches");
    expect(sourcing.body).not.toContain("ask Autumn on the same task, in one reply per round");
  });

  it("sources on core-work evidence with the search brief template", () => {
    for (const part of [
      "A matching title alone is NOT enough",
      "{min}-{max} years",
      "never infer from names",
      "only when the brief sets a tenure rule",
      "never add a constraint it does not state",
      "never silently passed",
      "POSITIVE EXAMPLES",
      "Title-only matches are not returned",
      "current role start month",
    ])
      expect(RECRUITING_SEARCH_BRIEF_TEMPLATE).toContain(part);
    // Skills ship with the code, so accounts with customized bot text still get these rules.
    const skill = (name: string) => RECRUITING_DEFAULT_SKILLS.find((s) => s.name === name)!.body;
    expect(skill("Recruitment sourcing continuation")).toContain(RECRUITING_SEARCH_BRIEF_TEMPLATE);
    const intake = skill("Recruitment intake and handoff");
    expect(RECRUITING_CALIBRATION_QUICK_SEARCH).toContain(
      'web_search_advanced_exa call with category "people"',
    );
    expect(intake).toContain("Always settle the language requirement");
    expect(intake).toContain("stays a preference, never a reject rule");
    const sourcer = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "sourcer")!;
    expect(RECRUITING_CALIBRATION_QUICK_SEARCH).toContain("rather than just a matching title");
    expect(sourcer.instructions).toContain("show that person as needing a check");
    const draft = RECRUITING_DEFAULT_SKILLS.find(
      (skill) => skill.name === "Review recruiting draft",
    )!;
    expect(draft.body).toContain("never says BDR or SDR");
  });

  it("asks for one round of feedback without rating every person", () => {
    const sourcer = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "sourcer")!;
    expect(sourcer.instructions).toContain("Never ask for a rating of every person");
    expect(sourcer.instructions).toContain("recruiting_research calibration_round");
    expect(sourcer.instructions).toContain("recruiting_feedback target round operation approve");
    expect(sourcer.instructions).not.toContain("turn each comment into a rule");
  });

  it("gives Sourcer the scale stage order and the no-polling continuation rule", () => {
    const sourcer = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "sourcer")!;
    const order = [
      "accepted round and every round's feedback",
      "confirmed brief version",
      "Autumn research",
      "save every returned page",
      "feedback of any scope",
      "reply on the same Autumn task",
      "save the expanded pool",
    ].map((step) => sourcer.instructions.indexOf(step));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sourcer.instructions).toContain("providerTaskId from saved candidate sources");
    expect(sourcer.instructions).toContain(
      "make one status read, then stop; results arrive in this conversation automatically",
    );
    expect(sourcer.instructions).toContain("Never loop on status");
    expect(sourcer.instructions).toContain("Missing resume is unknown, never a rejection");
  });

  it("ends automated follow-ups on a candidate reply", () => {
    const outreach = RECRUITING_DEFAULT_BOTS.find((bot) => bot.name === "Outreach")!;
    expect(outreach.instructions).toContain("A candidate reply ends automated follow-ups");
    expect(outreach.instructions).toContain("the next step is a human-reviewed reply");
  });

  it.each(RECRUITING_DEFAULT_BOTS)(
    "$name acts now, continues the turn and follows the stage machine",
    (bot) => {
      expect(bot.instructions).not.toContain("with an honest zoned ETA for unfinished work");
      expect(bot.instructions).toContain(
        "A turn never ends on a bare save or acknowledgement: after an answer, ask the next clarifying question at once, or when none is missing run the calibration search in the same turn.",
      );
      expect(bot.instructions).toContain("Main runs the quick search for exactly 10 profiles");
      expect(bot.instructions).toContain("no process narration");
      expect(bot.instructions).toContain(
        "fix exactly what the error names and call it again at once",
      );
    },
  );

  it("Main runs the first round itself right after the last answer", () => {
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain(
      "issue the calibration quick searches yourself as your very next step, before any read or save",
    );
    expect(main.instructions).not.toContain("hand off to Sourcer in the same turn");
  });

  it.each(RECRUITING_DEFAULT_BOTS)("$name never exposes CRM, campaign or lead setup", (bot) => {
    expect(bot.instructions).not.toContain("no CRM role is linked");
    expect(bot.instructions).not.toContain("set up a campaign, pick a mailbox");
  });

  it("keeps role documents off the calibration path", () => {
    expect(RECRUITING_PDF_RENDERING).toContain("Noto Sans CJK SC");
    expect(RECRUITING_INTAKE_FLOW).toContain("Role documents never hold up the calibration search");
  });

  it("keeps calibration searches parallel and lets the recruiter decide a short round", () => {
    for (const part of [
      "issue four differently worded platform people searches together as parallel tool calls in one step",
      'highlightsQuery "concrete evidence of: "',
      "which lists them in chat with their profile passages",
      "never fill the round with people who fail a requirement",
      "a requirement is never relaxed to fill the ten",
      "offering to relax that named requirement or to keep searching with a deeper search",
      "request research on this role for only the missing number of people",
      "Never tell the recruiter about search quotas",
    ])
      expect(RECRUITING_CALIBRATION_QUICK_SEARCH).toContain(part);
  });

  it("offers the next step after every round and starts scale on the recruiter's request", () => {
    expect(RECRUITING_ROUND_NEXT_STEP).toContain("Find 100 similar people");
    expect(RECRUITING_ROUND_NEXT_STEP).toContain("ask_user");
    expect(RECRUITING_ROUND_NEXT_STEP).toContain("never list them again");
    for (const part of [
      "That request is the acceptance",
      "never ask them to confirm the round again",
      "Feedback about individual people alone is not acceptance",
      // "A and B don't fit, find more who led 50+" read as acceptance on a live run.
      "even when it also says to find more of a kind",
      "Acceptance carries no correction.",
      "waves of four differently worded web_search_advanced_exa people searches",
      "until the role holds the target or a wave adds fewer than five new people",
      "when the people search stopped short of the target",
      "everyone already returned excluded",
      // 2026-10-27: "find 50" with 124 people saved still started paid research and an email draft.
      "When Results already hold the target, there is no deeper search and no handoff.",
      "Draft outreach email only when the recruiter asks for it",
      // A handoff ends the coordinator's turn: the searches and the update come first.
      "tell the recruiter in two or three lines with message_user",
      "end the turn with exactly one handoff, last",
    ])
      expect(RECRUITING_SCALE_START).toContain(part);
    const sourcer = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "sourcer");
    expect(sourcer?.instructions).toContain(
      "Hand an email draft to Outreach only when the recruiter asked for one",
    );
    // Quick-search rounds leave no research task: the scale-out starts one without asking.
    expect(sourcer?.instructions).toContain(
      "as the role's first research request without asking anyone",
    );
    for (const part of ["That request is the acceptance"])
      expect(RECRUITING_SCALE_START).toContain(part);
    expect(RECRUITING_CALIBRATION_QUICK_SEARCH).toContain(
      "nobody already returned for this role is ever shown again",
    );
  });

  it("asks the first question before a full save and shows people before the brief is saved", () => {
    expect(RECRUITING_INTAKE_FLOW).toContain(
      "asks the first clarifying question (ask it first) together with one small recruiting_role create",
    );
    expect(RECRUITING_INTAKE_FLOW).toContain(
      "first issue the calibration people searches as your very next step, before any read or save",
    );
  });

  it("asks every clarifying question up front with no tool work between them", () => {
    expect(RECRUITING_INTAKE_FLOW).toContain(
      "Between an answer and the next question make no tool calls, saves or drafts",
    );
    expect(RECRUITING_INTAKE_FLOW).toContain(
      "never ask whether to proceed, save, confirm or search",
    );
    expect(RECRUITING_INTAKE_FLOW).not.toContain("together in one card");
  });

  it("runs the first round before documents and weighs location first", () => {
    expect(RECRUITING_INTAKE_FLOW).toContain(
      "run the first calibration round before preparing any JD",
    );
    for (const part of [
      "each with the brief's priority location (city and metro) and must-haves",
      "anyone outside it, or whose row shows no location, never makes the ten",
      "a row showing only a country or a state is no location",
      "not currently working at the hiring company itself",
      "meets every hard requirement",
    ])
      expect(RECRUITING_CALIBRATION_QUICK_SEARCH).toContain(part);
  });
});

describe("recruiterQuestionNotInEnglish", () => {
  const jd = { role: "user", blocks: [{ kind: "text", text: "新岗位：仓库运营经理（亚特兰大）" }] };

  it("flags a Chinese question for a Chinese JD", () => {
    expect(
      recruiterQuestionNotInEnglish("仓库运营经理职位的中文要求应如何设定？我建议设为加分项。", [
        jd,
      ]),
    ).toBe(true);
  });

  it("passes an English question that quotes a Chinese phrase", () => {
    expect(
      recruiterQuestionNotInEnglish("Should Chinese (中文) be required, preferred or not needed?", [
        jd,
      ]),
    ).toBe(false);
  });

  it("passes Chinese once the recruiter asked for it", () => {
    expect(
      recruiterQuestionNotInEnglish("中文要求怎么定？", [
        jd,
        { role: "user", blocks: [{ kind: "text", text: "请用中文回复我" }] },
      ]),
    ).toBe(false);
  });
});
