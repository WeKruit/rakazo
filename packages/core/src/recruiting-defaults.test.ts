import { describe, expect, it } from "vitest";
import { RECRUITING_DEFAULT_BOTS, RECRUITING_DEFAULT_SKILLS } from "./recruiting-defaults.js";

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
      "Never name a vendor or tool (Instantly, Cal.com, Gmail, Google Calendar, HubSpot, MCP, API, REST) in chat replies, cards or emails",
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

  it("keeps feedback and recalibration on the same Autumn task", () => {
    const main = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "main")!;
    expect(main.instructions).toContain("Route candidate or search-direction feedback to Sourcer");
    const sourcing = RECRUITING_DEFAULT_SKILLS.find(
      (skill) => skill.name === "Recruitment sourcing continuation",
    )!;
    expect(sourcing.body).toContain("ask Autumn on the same task for fresh calibration");
  });

  it("gives Sourcer the find-people stage order and the no-polling continuation rule", () => {
    const sourcer = RECRUITING_DEFAULT_BOTS.find((bot) => bot.key === "sourcer")!;
    const order = [
      "saved JD",
      "decision-affecting gaps",
      "confirmed brief version",
      "Autumn research",
      "save every returned page",
      "ten-profile calibration",
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
});
