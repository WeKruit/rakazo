import { describe, expect, it } from "vitest";
import {
  RECRUITING_DEFAULT_BOTS,
  RECRUITING_DEFAULT_SKILLS,
  RECRUITING_SEARCH_BRIEF_TEMPLATE,
} from "./recruiting-defaults.js";

describe("maintained recruiting defaults", () => {
  it.each(RECRUITING_DEFAULT_BOTS)(
    "$name asks only consequential questions and keeps preferences retractable",
    (bot) => {
      expect(bot.instructions).toContain("Never send a fixed questionnaire");
      expect(bot.instructions).toContain("Never ask a recruiter to confirm G0, G1 or G2");
      expect(bot.instructions).toContain("recalled preferences before asking");
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
    expect(bot.instructions).toContain(
      "keep IDs, tool names, gate codes, cursors and JSON internal",
    );
  });

  it.each(RECRUITING_DEFAULT_BOTS)("$name never names a vendor to the recruiter", (bot) => {
    expect(bot.instructions).toContain(
      "Never name a vendor or tool (Autumn, Coresignal, FullEnrich, ContactOut, LeadMagic, Instantly, Composio, Cal.com, Gmail, Google Calendar, HubSpot, MCP, API, REST) in chat replies, cards, progress lines, questions or emails",
    );
    expect(bot.instructions).toContain(
      "the only exception is a connect-request card, which names the provider to connect",
    );
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
      "Ask clarifying questions one at a time: the single most decision-affecting question first",
    );
  });

  it("runs calibration rounds as quick searches and keeps Autumn for scale", () => {
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain(
      "Round feedback before the calibration is accepted goes into your next quick search",
    );
    expect(main.instructions).toContain("load the Calibration quick search skill");
    expect(main.instructions).toContain("Use Autumn only to scale after a round is accepted");
    // The procedure ships as a shared skill, so accounts with customized bot text still get it.
    const quick = RECRUITING_DEFAULT_SKILLS.find(
      (skill) => skill.name === "Calibration quick search",
    )!;
    expect(quick.body).toContain("recruiting_research save_search");
    expect(quick.body).toContain('"category:people"');
    expect(quick.body).toContain("never request a connection for it");
    expect(quick.body).toContain("not just a matching title");
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
    expect(intake).toContain("Always settle the language requirement");
    expect(intake).toContain("stays a preference, never a reject rule");
    expect(intake).toContain("Calibration quick search skill");
    const sourcer = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "sourcer")!;
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain("Calibration quick search");
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
        "Give a zoned ETA only for background work that keeps running after this turn",
      );
      expect(bot.instructions).toContain("you do now and never promise for a later time");
      expect(bot.instructions).toContain(
        "A turn never ends on a bare save or acknowledgement: after saving an answer, in the same turn ask the next single most decision-affecting question, or when none is missing present the brief for confirmation and say what happens next.",
      );
      expect(bot.instructions).toContain("Main runs the quick search for exactly 10 profiles");
      expect(bot.instructions).toContain("no process narration");
    },
  );

  it("Main runs the first round itself once the brief is confirmed", () => {
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain(
      "the moment it is confirmed, run the calibration quick search yourself in the same turn and present the 10 profiles",
    );
    expect(main.instructions).not.toContain("hand off to Sourcer in the same turn");
  });

  it.each(RECRUITING_DEFAULT_BOTS)("$name never exposes CRM, campaign or lead setup", (bot) => {
    expect(bot.instructions).toContain(
      'never say CRM, campaign, leads, lead list, mailbox or sending-account binding, mapping or "setup" to the recruiter',
    );
    expect(bot.instructions).toContain(
      "do that setup silently and speak only in recruiter language",
    );
    expect(bot.instructions).not.toContain("no CRM role is linked");
    expect(bot.instructions).not.toContain("set up a campaign, pick a mailbox");
  });
});
