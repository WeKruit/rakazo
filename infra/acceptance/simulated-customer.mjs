#!/usr/bin/env node
// A simulated customer: a language model plays a recruiter from a persona and talks to Kruit on
// the test environment through a whole journey, choosing each next message from what Kruit
// actually said. A second model then judges the experience turn by turn, checking every claim
// Kruit made about sends against the role's campaign records, and writes a short report. The
// scripted conversations in real-user.mjs ask one thing each; this follows state that builds over
// a journey and a recruiter who pushes back. Journeys live in simulated-journeys.mjs.
//
// Usage (the deployment owner's sign-in creates the throwaway accounts):
//   RAKAZO_URL=<direct backend> RAKAZO_ORIGIN=<public origin> RAKAZO_EMAIL=… RAKAZO_PASSWORD=… \
//     node infra/acceptance/simulated-customer.mjs [--journeys a,b | --mechanism reference,language | --gate | --story "<test in plain words>" | --calibrate <gold dir>] [--paid] [--samples 1]
//       [--concurrency 6] [--out <dir>] [--bench <dir>] [--model sonnet] [--judge-model sonnet]
// Without --journeys it plays every journey that needs no paid search (with --paid, all of them),
// side by side, each on its own brand-new account, and writes one scoreboard, <out>/summary.md,
// with a report per journey beside it. Run it before saying a change to Kruit is done. --gate plays
// only the release gate's journeys.
// RAKAZO_SIM_RECIPIENTS lists the internal test inboxes a journey may email (comma separated). A
// send card is approved only when every address on it is in that list; any other card is denied,
// so the simulation never emails a real person. Journeys that send need it and an account with a
// sending mailbox: RAKAZO_MAILBOX_EMAIL/PASSWORD, as in real-user.mjs.
// The two models are called through RAKAZO_SIM_MODEL_COMMAND, a command that reads a prompt on
// stdin and prints the reply; by default the Claude Code CLI (`claude -p`).
// Exit code 0 when every journey passes, 1 when the product failed one, 2 when only the
// environment did.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  botText,
  cardAnswer,
  conversationChecks,
  PLACEHOLDER,
  recipientsOf,
} from "./real-user-checks.mjs";
import {
  activeGroupsOf,
  changeOrTimeout,
  client,
  groupsOf,
  InfraError,
  messagesOf,
  openCards,
  requestCount,
  retireRoutines,
  send,
  settle,
  sleep,
  stopAll,
  transcripts,
  unfollowAll,
  watchFrom,
} from "./real-user-session.mjs";
import {
  completionOutcome,
  completionSummary,
  overlapOf,
  overlapSummary,
  profilesIn,
  requestCompletion,
} from "./request-completion.mjs";
import { PERSONAS, JOURNEYS as WRITTEN } from "./simulated-journeys.mjs";

const BLOCKS = new Set(WRITTEN.filter((journey) => journey.blocks).map((journey) => journey.name));

import { closeBrowser, openUi, SEND_BUTTON, STANDING_BUTTON } from "./simulated-ui.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const { RAKAZO_EMAIL: OWNER_EMAIL, RAKAZO_PASSWORD: OWNER_PASSWORD } = process.env;
if (!BASE || !OWNER_EMAIL || !OWNER_PASSWORD)
  throw new Error("Set RAKAZO_URL, RAKAZO_EMAIL and RAKAZO_PASSWORD (the deployment owner)");
const RECIPIENTS = (process.env.RAKAZO_SIM_RECIPIENTS ?? "")
  .split(",")
  .map((address) => address.trim().toLowerCase())
  .filter(Boolean);
// Accounts with a sending mailbox: RAKAZO_MAILBOX_EMAIL/PASSWORD, then _2, _3 … Each plays one
// mailbox journey at a time, so up to that many send journeys run side by side.
const MAILBOXES = ["", ..."23456789".split("").map((n) => `_${n}`)]
  .map((suffix) => [
    process.env[`RAKAZO_MAILBOX_EMAIL${suffix}`],
    process.env[`RAKAZO_MAILBOX_PASSWORD${suffix}`],
  ])
  .filter((pair) => pair.every(Boolean));
// The staging copy of our own account (account: "batch"), whose every address was rewritten to a
// plus-alias of an internal test inbox, so a batch send from it reaches only our inbox.
const BATCH = [process.env.RAKAZO_BATCH_EMAIL, process.env.RAKAZO_BATCH_PASSWORD];
// A backend of its own (pnpm sim:branch) gives every mailbox play a new account with the next
// emulated mailbox ("sender{n}@…"), so no play reads another's roles or sends.
const FRESH_SENDER = process.env.RAKAZO_FRESH_SENDER;
/** An internal test inbox, or a plus-alias of one (admin1+p1a2b@… reaches admin1@…). */
const allowedRecipient = (address) =>
  RECIPIENTS.includes(address) || RECIPIENTS.includes(address.replace(/\+[^@]*@/, "@"));
/** What a journey needs that this run was not given. */
const missing = (journey) => [
  ...(journey.account === "mailbox" && !MAILBOXES.length && !FRESH_SENDER
    ? ["RAKAZO_MAILBOX_EMAIL", "RAKAZO_MAILBOX_PASSWORD"]
    : []),
  ...(journey.account === "batch" && !BATCH.every(Boolean)
    ? ["RAKAZO_BATCH_EMAIL", "RAKAZO_BATCH_PASSWORD"]
    : []),
  ...(journey.sends && !RECIPIENTS.length ? ["RAKAZO_SIM_RECIPIENTS"] : []),
];
// Journeys learned from earlier failures (--learn writes them; --learned <file> plays them too).
const LEARNED = option("--learned");
const learned =
  LEARNED && fs.existsSync(LEARNED)
    ? JSON.parse(fs.readFileSync(LEARNED, "utf8")).map((journey) => ({
        ...journey,
        persona: `${PERSONAS[journey.persona] ?? PERSONAS.AGENCY_RECRUITER} ${journey.situation ?? ""}`,
        facts: journey.facts ? () => journey.facts : undefined,
      }))
    : [];
// A test in plain words, no code: --story "新用户，要给一个候选人发邮件，发不出去就问怎么办"
// plays that story as our usual impatient customer, in the story's language, judged the same way.
const STORY = option("--story");
const story = STORY && {
  name: `story-${createHash("sha256").update(STORY).digest("hex").slice(0, 8)}`,
  title: STORY.slice(0, 60),
  area: "first message",
  source: "--story",
  chinese: /\p{Script=Han}/u.test(STORY),
  maxTurns: Number(option("--turns", "8")),
  persona: /\p{Script=Han}/u.test(STORY) ? PERSONAS.AGENCY_RECRUITER : PERSONAS.US_RECRUITER,
  goals: [STORY],
};
const JOURNEYS = [
  ...WRITTEN,
  ...learned.filter((j) => !WRITTEN.some((w) => w.name === j.name)),
  ...(story ? [story] : []),
];
const mechanisms = option("--mechanism")?.split(",");
const named = story
  ? [story.name]
  : (option("--journeys")?.split(",") ??
    mechanisms?.flatMap((mechanism) => {
      // A replay never spends money unless asked: paid journeys join only with --paid.
      const found = JOURNEYS.filter(
        (journey) =>
          journey.mechanisms?.includes(mechanism) && (!journey.paid || args.includes("--paid")),
      );
      if (!found.length) throw new Error(`no journey exercises ${mechanism}`);
      return found.map((journey) => journey.name);
    }));
for (const name of named ?? [])
  if (!JOURNEYS.some((journey) => journey.name === name))
    throw new Error(`no journey ${name}; journeys: ${JOURNEYS.map((j) => j.name).join(", ")}`);
const PAID = args.includes("--paid");
const UI = args.includes("--ui");
const ORIGIN = (process.env.RAKAZO_ORIGIN ?? BASE).replace(/\/$/, "");
const OUT = option("--out", `simulated-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(OUT, { recursive: true });
const started = Date.now();
const log = (text) =>
  process.stdout.write(
    `[${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s] ${text}\n`,
  );

// --- The two models ---------------------------------------------------------------------------
const usage = { calls: 0, usd: 0 };
function model(system, prompt, name) {
  const custom = process.env.RAKAZO_SIM_MODEL_COMMAND;
  const [command, commandArgs] = custom
    ? ["sh", ["-c", custom]]
    : [
        "claude",
        [
          "-p",
          "--model",
          name,
          "--system-prompt",
          system,
          "--tools",
          "",
          "--setting-sources",
          "",
          "--output-format",
          "json",
        ],
      ];
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["pipe", "pipe", "pipe"], cwd: OUT });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.stdin.end(custom ? `${system}\n\n${prompt}` : prompt);
    child.on("close", (code) => {
      usage.calls += 1;
      if (custom) return code === 0 ? resolve(out) : reject(new Error(err.slice(0, 300)));
      try {
        const result = JSON.parse(out);
        usage.usd += result.total_cost_usd ?? 0;
        resolve(result.result ?? "");
      } catch {
        reject(new Error(`model: ${(out || err).slice(0, 300)}`));
      }
    });
  });
}
/** A model's JSON answer. A malformed or empty reply (a stray quote, an empty error from the CLI)
 * is the test's own hiccup, not Kruit's, so it is asked again, up to three times. */
async function askJson(system, prompt, name) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
    try {
      return parse(await model(system, prompt, name));
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
/** The first JSON object in a model's reply. */
function parse(text) {
  const start = text.indexOf("{");
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
    // A model sometimes writes a multi-line email inside a JSON string without escaping its lines.
    try {
      return JSON.parse(candidate.replace(/\r?\n/g, "\\n"));
    } catch {}
  }
  throw new Error(`no JSON in the model's reply: ${text.slice(0, 200)}`);
}
const SIMULATOR = option("--model", "sonnet");
const JUDGE = option("--judge-model", "sonnet");

// --- What the recruiter sees and what is true ---------------------------------------------------
async function cardsOpen(rpc) {
  const open = [];
  // A connect card stays pressable after its wait ends, as the app shows it.
  for (const group of await activeGroupsOf(rpc))
    for (const message of await messagesOf(rpc, group.id))
      for (const block of [
        ...openCards(message),
        ...(message.blocks ?? []).filter(
          (block) => block.kind === "ask" && block.connection && block.status === "expired",
        ),
      ]) {
        if (!message.runId || block.input === "secret") continue;
        const text = [
          block.text,
          block.detail,
          // The page lists, above the reply box, what the candidate asked that the recruiter never said.
          block.mailReply?.openQuestions?.length
            ? `The candidate asked what you haven't told me. Answer it in the reply:\n${block.mailReply.openQuestions.map((question) => `- ${question}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        open.push({
          chat: group.name,
          groupId: group.id,
          runId: message.runId,
          messageId: message.id,
          send: Boolean(block.approvalEffectId),
          connect: Boolean(block.connection),
          text,
          options: (block.actions ?? []).map((action) => action.label),
          actions: block.actions ?? [],
          schema: block.requestedSchema,
          recipients: recipientsOf(block.text, block.detail ?? ""),
          mailReply: block.mailReply,
        });
      }
  return open;
}
// The send records Kruit's claims are checked against: the campaign of every chat this journey
// wrote in or got replies in, and of every role whose campaign changed since the journey began
// (a send confirmed in the Kruit chat goes into a role's campaign, new or existing). A reused
// fixture account's other roles are left out. A role can send from more than its bound campaign
// (a copy made for a new wave), so its other campaigns are read too, as its Sequence page lists them.
async function campaignOf(rpc, chat) {
  const campaign = await rpc("recruiting/roleCampaign", { groupId: chat.id }).catch((error) => ({
    error: error.message,
  }));
  const record = {
    chat: chat.name,
    status: campaign.status ?? campaign.error,
    ...campaignState(campaign),
  };
  if (!campaign.campaign) return record;
  const view = await rpc("recruiting/accountView", {
    view: "sequence",
    groupId: chat.id,
    limit: 1,
  }).catch(() => null);
  const others = (view?.items?.[0]?.campaigns ?? []).filter(
    (other) => other.campaign && other.campaign.id !== campaign.campaign.id,
  );
  return others.length ? { ...record, otherCampaigns: others.map(campaignState) } : record;
}
function campaignState(campaign) {
  return {
    campaign: campaign.campaign
      ? {
          name: campaign.campaign.name,
          status: campaign.campaign.status,
          mailbox: campaign.campaign.eaccount,
          createdAt: campaign.campaign.createdAt ?? null,
        }
      : null,
    sent: campaign.stats?.sent ?? null,
    queuedFirstEmail: campaign.queuedFirstEmail ?? null,
    people: (campaign.leads ?? []).map((lead) => ({
      email: lead.email,
      status: lead.status,
      contactedAt: lead.contactedAt ?? null,
    })),
  };
}
/** Every chat's campaign as it stands, by chat id. */
async function campaigns(rpc) {
  const all = new Map();
  for (const group of await activeGroupsOf(rpc)) all.set(group.id, await campaignOf(rpc, group));
  return all;
}
async function records(rpc, since, before) {
  const now = await campaigns(rpc);
  const roles = [];
  for (const group of await activeGroupsOf(rpc)) {
    const record = now.get(group.id);
    const touched = (await messagesOf(rpc, group.id)).some(
      (message) => Date.parse(message.createdAt) >= since,
    );
    // A role chat this play worked in also shows how many people it has saved, so a "found N"
    // claim is checked against what was stored, not only against sends.
    const results =
      touched && !group.id.startsWith("recruiting-global-") ? await resultsPage(rpc, group) : null;
    if (
      record?.campaign &&
      (touched || JSON.stringify(before.get(group.id)) !== JSON.stringify(record))
    )
      roles.push(results === null ? record : { ...record, ...results });
    else if (results !== null) roles.push({ chat: group.name, ...results });
  }
  return roles;
}
/**
 * A role chat's Results page as the recruiter sees it: how many people it holds and who it marks
 * Passed or On hold, by the page's own rule; null when unreadable. fosp x5 11-20: Kruit said the
 * turned-down people were marked and the judge, seeing only a count, could not check it.
 */
async function resultsPage(rpc, group) {
  const head = await rpc("threads/head", { groupId: group.id }).catch(() => null);
  const threadId = head?.threadId ?? group.threadId;
  if (!threadId) return null;
  const page = await rpc("recruiting/roleCandidates", {
    groupId: group.id,
    threadId,
    limit: 1,
  }).catch(() => null);
  if (!page) return null;
  const roleId = (await rpc("recruiting/getWorkspace", { threadId }).catch(() => null))?.role?.id;
  if (!roleId) return { saved: page.total };
  // grades: each graded person's tier, so a claim about named people is checked against them
  // (a person graded in an earlier round is already in fit and does not raise it again).
  const marked = { passed: [], onHold: [], fit: 0, grades: {} };
  // Overlapping searches: finds of people already in the role, and two rows for one LinkedIn.
  const linkedIn = new Set();
  let cursor;
  // The page's own read, 200 at a time; a play's role holds a few hundred people at most.
  for (let read = 0; read < 5; read++) {
    const list = await rpc("recruiting/listCandidates", {
      roleId,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    }).catch(() => null);
    if (!list) return { saved: page.total };
    marked.finds ??= list.counts.sourceRows;
    marked.foundAgain ??= list.counts.sourceRows - list.counts.candidates;
    for (const person of list.items) {
      const name = person.name ?? person.candidateKey;
      for (const handle of profilesIn(person.linkedinUrl ?? ""))
        if (linkedIn.has(handle)) marked.sameLinkedIn = (marked.sameLinkedIn ?? 0) + 1;
        else linkedIn.add(handle);
      if (["Strong", "Promising"].includes(person.match?.tier)) marked.fit += 1;
      if (person.match?.tier) marked.grades[name] = person.match.tier;
      if (person.decision === "hold") marked.onHold.push(name);
      else if (
        person.decision === "pass" ||
        (!person.decision && person.recruiterVerdict === "not_fit")
      )
        marked.passed.push(name);
    }
    cursor = list.nextCursor;
    if (!cursor) break;
  }
  return { saved: page.total, ...marked };
}
/**
 * Work still going in the chats this play used after its last wait: a run that is neither done
 * nor waiting for the recruiter is stuck or unfinished (a deadlock shows up here), with its age.
 */
async function runsLeft(rpc, since) {
  const left = [];
  for (const group of await activeGroupsOf(rpc)) {
    if (!(await messagesOf(rpc, group.id)).some((m) => Date.parse(m.createdAt) >= since)) continue;
    const snapshot = await rpc("threads/get", { groupId: group.id }).catch(() => null);
    for (const run of snapshot?.activeRuns ?? [])
      if (run.status !== "waiting_input")
        left.push({
          chat: group.name,
          status: run.status,
          minutes: Math.round((Date.now() - Date.parse(run.startedAt ?? run.createdAt)) / 60000),
        });
  }
  return left;
}
const CAMPAIGN_CODES =
  "saved: people the role chat has stored (its Results count); finds: times the searches returned a person; foundAgain: finds of a person the role already held; a person in a list is new when no earlier list showed them, so a round can show new people the role already held while saved and finds stay the same; sameLinkedIn: extra rows for a LinkedIn profile already listed; fit: how many of them the grader rated Strong or Promising; passed / onHold: the people its Results page marks Passed (不合适, not a fit) or On hold; otherCampaigns: the role's other campaigns besides its main one (such as a copy made for a new send), and a send can go out from any of them; campaign status: 0 draft, 1 active (sending), 2 paused, 3 completed; person status: 1 active, 2 paused, 3 completed, -1 bounced, -2 unsubscribed; contactedAt null = not emailed yet";

// What the recruiter can read: messages with text, in chats they wrote in or were answered in.
const visible = (chats) =>
  chats
    .map(({ group, messages }) => ({ group, messages: messages.filter((m) => m.text.trim()) }))
    .filter(({ messages }) => messages.some((m) => m.role === "user"));
function render(chats) {
  return visible(chats)
    .map(
      ({ group, messages }) =>
        `## ${group.name}\n${messages
          .map(
            (m) =>
              `[${m.at.slice(11, 19)}] ${m.role === "user" ? "Recruiter" : "Kruit"}${m.card ? " (card)" : ""}: ${m.text}${m.detail ? `\n${m.detail}` : ""}${m.controls ? `\n${m.controls}` : ""}`,
          )
          .join("\n")}`,
    )
    .join("\n\n");
}

// --- One journey --------------------------------------------------------------------------------
async function newestBotMessageAfter(rpc, since, latest = false) {
  let newest = null;
  for (const group of await activeGroupsOf(rpc))
    for (const message of await messagesOf(rpc, group.id))
      if (
        message.role !== "user" &&
        botText(message).trim() &&
        Date.parse(message.createdAt) > since
      )
        if (!newest || Date.parse(message.createdAt) < Date.parse(newest.createdAt) !== latest)
          newest = message;
  return newest;
}
/** Seconds to Kruit's first reply and until it went quiet; quick returns after the first reply. */
async function replyAfter(journey, rpc, since, quick = false) {
  let first = null;
  for (
    const until = Date.now() + 3 * 60_000;
    !first && Date.now() < until;
    await changeOrTimeout(rpc, 15_000)
  )
    first = await newestBotMessageAfter(rpc, since);
  const firstSeconds = first ? Math.round((Date.parse(first.createdAt) - since) / 1000) : null;
  if (quick) return { firstSeconds, doneSeconds: null };
  await settle(rpc, { quietMs: 25_000, limitMs: journey.waitMs ?? 6 * 60_000 });
  // Quiet for 25 s means the last reply came that long before the wait ended.
  const latest = await newestBotMessageAfter(rpc, since, true);
  const doneSeconds = latest ? Math.round((Date.parse(latest.createdAt) - since) / 1000) : null;
  return { firstSeconds, doneSeconds };
}

const SIMULATOR_RULES = `You play a recruiter using a recruiting assistant called Kruit, to test it the way a real customer would. Stay in character: write the way this person writes (language, length, tone), but make each message mean what your goal means: if a stranger could read it as a different question, reword it. Decide your next move from what Kruit actually said and showed, not from what it should have said. If Kruit did not answer what you asked, did not do what you asked, or said something you doubt, push back the way this person would. Never explain that you are testing. Answer with one JSON object and nothing else:
{"action": "say" | "answer_card" | "approve_send" | "deny_send" | "wait" | "done", "card": <index of the card for answer_card/approve_send/deny_send>, "text": "<your message, or your typed answer for answer_card; approve_send only presses the card's button, except on a reply draft, where a text is your edited reply as it should go out (the whole email); for deny_send, text is what you want changed and is sent as your message right after the button>", "chat": "<optional: the chat to write in, by name; Kruit by default>", "people": <how many new people this message asks Kruit to find or show now: "find 10" is 10, "swap these two" is 2, a first search with no number is 10, a later "more like these" with no number is 3; 0 when it asks for none>, "goal": "<which goal this move serves>", "feeling": "<one line: how this person feels about Kruit's last reply>"}
Use "wait" only when a goal tells you to wait or step away, and only as often as it says: you write nothing and come back when Kruit writes to you, or after a few minutes. Use "done" when every goal is met, or when you have pushed back twice on the same goal and got nowhere (say which goal in "goal").`;
// With --ui the recruiter works in the browser and can also open pages and press buttons.
const UI_RULES = `${SIMULATOR_RULES}
You are using the product in a browser and see the page described under "Your screen". Two more actions:
- {"action": "look", "page": "home" | "contacts" | "shortlist" | "sequence" | "inbox" | "interview" | "analytics" | "conversation" | "results" | "brief", "chat": "<a role chat's name, for that role's page; leave out for the whole account>"} opens that page, the way you would from the sidebar or a role's tabs.
- {"action": "click", "text": "<the exact name of a button or link on your screen>"} presses it.
Check things on the pages yourself the way a recruiter would: when Kruit says something was sent or saved, or tells you where to look, go and look. Approve or deny a send only with approve_send / deny_send.`;

/** What the recruiter is told about the open cards. */
const describeCards = (cards) =>
  cards.length
    ? cards
        .map(
          (card, i) =>
            `[${i}] in "${card.chat}"${card.send ? " SEND CONFIRMATION" : card.connect ? " ACCOUNT CONNECTION (a sign-in you cannot do here; say what you would do instead)" : ""}: ${card.text}${card.options.length ? `\n    options: ${card.options.join(" | ")}` : ""}${card.schema ? `\n    form fields: ${Object.keys(card.schema.properties ?? {}).join(", ")} (type your answer)` : ""}`,
        )
        .join("\n")
    : "(none)";

// Each play varies how the customer talks, so a fix cannot be tuned to one script: a mood, a way of
// writing, and freedom to reorder or combine asks the goals do not force into an order.
const MOODS = [
  "rushed: between calls, one-line messages",
  "irritated: had a bad week with tools that do not work",
  "friendly but vague: half-finished sentences, expects Kruit to fill gaps",
  "precise: numbers and names, wants exact answers",
  "distracted: sometimes asks two things at once or changes topic and comes back",
  "skeptical: double-checks what Kruit says against the pages",
];
function variationFor(seed) {
  const mood = MOODS[seed % MOODS.length];
  const combine = seed % 2 ? "You may combine two asks in one message." : "One ask per message.";
  return `Today you are ${mood}. ${combine} Say everything in your own words: never copy the wording of the goals, and do not follow them in the listed order where the order does not matter.`;
}

// Without this the customer reopened a page it had just seen and ran out of moves before its goals.
function looked(turns) {
  const pages = [
    ...new Set(
      turns
        .filter((turn) => turn.move?.action === "look")
        .map((turn) => turn.move.page + (turn.move.chat ? ` (${turn.move.chat})` : "")),
    ),
  ];
  return pages.length
    ? `\n\nPages you already looked at: ${pages.join(", ")}. Open one again only to check something that changed.`
    : "";
}

// Stepping away leaves no line in the conversation, so the recruiter is told it already did.
function awayNote(turns) {
  const away = turns.filter((turn) => turn.move.action === "wait" && !turn.invalid).length;
  const last = turns.at(-1);
  return `${away ? `\n\nYou already stepped away ${away === 1 ? "once" : `${away} times`} and are back now.` : ""}${last?.invalid ? `\nYour last move was not done: ${last.invalid}.` : ""}`;
}

async function simulate(journey, turns, view, cards, screen, tag, since) {
  // A reused account's pages still show earlier tests; only this session's messages count.
  const earlier =
    journey.account && screen
      ? `\n\nAnything on your screen from before ${new Date(since).toISOString().slice(11, 16)} UTC is an earlier session, not yours: your goals count only from the conversation above.${
          // The screen shows no times, so a similar earlier play there reads as this one's progress.
          turns.length
            ? ""
            : " This is your first move, so none of your goals is met yet: start from the first."
        }`
      : "";
  const signedUp = journey.account
    ? ""
    : `\nYou signed up for Kruit as ${ACCOUNT_NAME}; unless "What you know" gives you another name, that is your name.`;
  const prompt = `Who you are:\n${journey.persona}${signedUp}\n${journey.variation ?? ""}\n\nWhat you want, in order:\n${journey.goals.map((goal, i) => `${i + 1}. ${goal}`).join("\n")}\n\n${journey.facts ? `What you know:\n${journey.facts(RECIPIENTS, tag)}\n\n` : ""}The conversation so far (times are UTC):\n${view || "(nothing yet: you open the conversation)"}\n\nOpen cards you can act on:\n${describeCards(cards)}${
    screen
      ? `\n\nYour screen (${screen.url}):\n${screen.text}\n\nButtons and links on it: ${screen.buttons.join(" | ") || "(none)"}${screen.fields?.length ? `\nText boxes on it: ${screen.fields.join(" | ")}` : ""}`
      : ""
  }${earlier}${looked(turns)}${awayNote(turns)}\n\nYour moves so far: ${turns.length}. Your next move:`;
  return askJson(screen ? UI_RULES : SIMULATOR_RULES, prompt, SIMULATOR);
}

/** The send answer the harness allows: only the internal test inboxes are ever emailed. */
function guardSend(journey, card, answer, turn) {
  if (answer !== "allow") return "deny";
  if (!journey.sends) {
    turn.guard = "denied: this journey never sends";
    return "deny";
  }
  const outside = card.recipients.filter((address) => !allowedRecipient(address));
  if (card.recipients.length && !outside.length) return "allow";
  turn.guard = `denied: the card names ${outside.join(", ") || "no address"}`;
  return "deny";
}

// A copied account holds real people (names, companies), so a contact lookup there would find
// their real addresses and could put them in a campaign. Before playing on it, turn its lookup
// service off through the product's own settings, and refuse to play if one is still on.
const LOOKUP_ENDPOINTS = new Set(["https://mcp.fullenrich.com/mcp"]);
async function withoutContactLookups(rpc) {
  const lookups = (servers) =>
    servers.filter((server) => server.enabled && LOOKUP_ENDPOINTS.has(server.endpoint));
  for (const server of lookups(await rpc("mcp/servers/list", {})))
    await rpc("mcp/servers/update", {
      id: server.id,
      config: {
        slug: server.slug,
        name: server.name,
        description: server.description ?? "",
        enabled: false,
        transport: server.transport,
        endpoint: server.endpoint,
      },
    });
  const left = lookups(await rpc("mcp/servers/list", {}));
  if (left.length)
    throw new InfraError(
      `contact lookup still on for the copied account (${left.map((s) => s.slug)})`,
    );
}

// --- Simulated candidates -----------------------------------------------------------------------
// A journey's candidates are people too: each is a model given a persona that reads the outreach
// mail that actually reached them on a branch backend's emulated mail service and answers it in
// its own words, as someone replying from their own mail client. Nothing is scripted.
const CANDIDATE_RULES = `You play a job candidate who got an email from a recruiter. You get who you are and the whole email thread so far. Write your reply email body the way this person would: plain text, short, in English, signed with your first name, no subject line. Stay in character and keep to what you know; answer what the recruiter wrote and ask what you would want to know. When the thread needs no answer from you, or you would not answer, reply with null. Answer with one JSON object and nothing else: {"reply": "<email body>" | null}`;

/**
 * A journey that books (calendar: true) plays on an account whose recruiter connected their Google
 * Calendar, the way the app's Connect does: the calendar's row, its sign-in started by the
 * backend, consent given on the branch backend's emulated consent screen, the code handed back as
 * the callback page does, then sign-in setup gives the booking agents the calendar.
 */
async function connectCalendar(rpc) {
  const endpoint = "https://calendarmcp.googleapis.com/mcp/v1";
  const server =
    (await rpc("mcp/servers/list", {})).find((row) => row.endpoint === endpoint) ??
    (await rpc("mcp/servers/create", {
      slug: "google-calendar",
      name: "Google Calendar",
      transport: "streamable_http",
      endpoint,
    }));
  const started = await rpc("mcp/oauth/begin", {
    serverId: server.id,
    redirectUri: `${ORIGIN}/mcp/oauth/callback`,
  });
  if (started.status === "authorization_required") {
    const consent = await fetch(`${BASE}/__e2e/calendar`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorizationUrl: started.authorizationUrl }),
    });
    if (!consent.ok)
      throw new InfraError(
        `this environment has no emulated calendar (${consent.status}); booking journeys play on pnpm sim:branch`,
      );
    const back = new URL((await consent.json()).redirect);
    await rpc("mcp/oauth/complete", {
      sessionId: back.searchParams.get("state"),
      code: back.searchParams.get("code"),
      state: back.searchParams.get("state"),
    });
  }
  await rpc("bootstrap", {});
  // Sign-in setup grants the calendar in the background; the first turn needs it.
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(2_000))
    if (
      (await rpc("mcp/assignments/all", {})).some(
        (grant) => grant.serverId === server.id && grant.allowedTools.includes("create_event"),
      )
    )
      return;
  throw new InfraError("the connected calendar was not given to the booking agents");
}

async function outreachMail() {
  const response = await fetch(`${BASE}/__e2e/outreach`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new InfraError(
      `this environment has no emulated candidate mailbox (${response.status}); candidate journeys play on pnpm sim:branch`,
    );
  return response.json();
}

/** Each candidate answers the newest email that reached them since their own last word. */
async function candidatesAnswer(journey, tag, label) {
  const mail = await outreachMail();
  const answers = [];
  for (const candidate of journey.candidates(RECIPIENTS, tag)) {
    const address = candidate.address.toLowerCase();
    const thread = mail.filter((email) => String(email.lead).toLowerCase() === address);
    const last = thread.at(-1);
    // The newest email is the recruiter's (1 a campaign step, 3 a reply), so the candidate answers it.
    if (![1, 3].includes(last?.ue_type)) continue;
    const text = thread
      .map(
        (email) =>
          `${email.ue_type === 2 ? "You" : "Recruiter"} (${String(email.timestamp_created).slice(0, 16)} UTC), subject "${email.subject}":\n${email.body?.text ?? ""}`,
      )
      .join("\n\n");
    const { reply } = await askJson(
      CANDIDATE_RULES,
      `Who you are:\n${candidate.persona}\n\nThe email thread (oldest first):\n${text}`,
      SIMULATOR,
    );
    if (typeof reply !== "string" || !reply.trim()) continue;
    const posted = await fetch(`${BASE}/__e2e/outreach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ replyTo: last.id, text: reply }),
    });
    if (!posted.ok) throw new InfraError(`the candidate's reply was not filed (${posted.status})`);
    log(
      `${label}: candidate ${candidate.name} replied: ${reply.slice(0, 80).replace(/\s+/g, " ")}`,
    );
    answers.push({ name: candidate.name, at: new Date().toISOString(), text: reply });
  }
  return answers;
}

/** Whether the email Kruit was asked to send reached a candidate yet (sending starts ~2 min after a confirmed send). */
async function mailReached(journey, tag, limitMs) {
  const addresses = journey.candidates(RECIPIENTS, tag).map((c) => c.address.toLowerCase());
  for (const until = Date.now() + limitMs; Date.now() < until; await sleep(15_000))
    if (
      (await outreachMail()).some(
        (email) => email.ue_type === 1 && addresses.includes(String(email.lead).toLowerCase()),
      )
    )
      return true;
  return false;
}

// Real sign-ups carry the recruiter's own name, so a template Kruit signs can use it.
const ACCOUNT_NAME = "Alex Morgan";

async function play(journey, label, owner, mailbox, out) {
  const user = client();
  let credentials = mailbox;
  if (journey.account === "batch") credentials = BATCH;
  if (journey.account) {
    await user.auth(...credentials);
    if (journey.account === "batch") await withoutContactLookups(user.rpc);
  }
  // A reused account first goes quiet and loses what earlier plays left; a new one has nothing to clear.
  if (journey.account && !credentials.fresh) {
    // Waiting for a reused account to go quiet watches only its working chats, not every role.
    watchFrom(user.rpc, Date.now());
    await stopAll(user.rpc);
    await settle(user.rpc, { quietMs: 15_000, limitMs: 2 * 60_000 });
    await closeStaleCards(user.rpc, label);
    // Roles earlier plays of this journey left behind (idle an hour, so not a play running now).
    if (journey.leftover) {
      const old = (await groupsOf(user.rpc)).filter((group) =>
        journey.leftover.test(group.name ?? ""),
      );
      if (old.length)
        await archiveRoles(
          credentials,
          old.map((group) => group.id),
          label,
          { idleHours: 1 },
        );
    }
    if (journey.account === "mailbox") await forgetEarlierPlays(user.rpc, label);
  }
  if (!journey.account) {
    const email = `kruit-sim-${journey.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    const password = `Sim-${crypto.randomUUID()}`;
    await owner.rpc("deployment/createAccount", { email, name: ACCOUNT_NAME, password });
    await user.auth(email, password);
    credentials = [email, password];
  }
  const { rpc } = user;
  if (journey.calendar && credentials.fresh) await connectCalendar(rpc);
  const startedAt = Date.now();
  watchFrom(rpc, startedAt);
  const before = await campaigns(rpc);
  const groupsBefore = new Set((await groupsOf(rpc)).map((group) => group.id));
  // A per-play tag, so a journey on a reused account names a role and recipients of its own. Plays
  // of one journey start in the same minute, so the play number is part of it.
  const tag = `${new Date(startedAt).toISOString().slice(11, 16).replace(":", "")}${label.split("#")[1] ?? ""}`;
  // Plays of one journey started together still talk differently.
  const seed = [...label].reduce((sum, char) => sum + char.charCodeAt(0), Number(tag));
  journey = { ...journey, variation: variationFor(seed) };
  const kruit = (await groupsOf(rpc)).find((group) => group.id.startsWith("recruiting-global-"));
  if (!kruit) throw new Error("the account has no Kruit conversation");
  // A journey about pages can only be judged by looking at them, so it always uses the browser.
  const browser = UI || journey.mechanisms?.includes("pages");
  const ui = browser
    ? await openUi({
        origin: ORIGIN,
        email: credentials[0],
        password: credentials[1],
        cookie: user.cookie(),
        chinese: journey.chinese,
        out,
        mobile: Boolean(journey.mobile),
      })
    : null;
  if (ui) await ui.openChat(kruit.id);
  const turns = [];
  let waited = 0;
  const chatNamed = async (name) =>
    (await groupsOf(rpc)).find((group) => group.name === name) ?? kruit;
  try {
    for (let index = 0; index < journey.maxTurns; index += 1) {
      const chats = await transcripts(rpc, startedAt, journey.chinese);
      const cards = await cardsOpen(rpc);
      const screen = ui ? await ui.view() : null;
      // What the page showed after Kruit's reply to the last move, for the judge to check claims.
      const last = turns.at(-1);
      if (screen && last && !last.screen)
        last.screen = { ...screen, text: screen.text.slice(-2500) };
      // A journey about outages cuts the test environment's outbound network first; without the
      // switch the play cannot test anything, so it is "not run".
      if (journey.blip?.beforeTurn === index + 1) {
        log(`${label}: cutting outbound network for ${journey.blip.seconds} s`);
        await owner
          .rpc("deployment/networkBlip", { seconds: journey.blip.seconds })
          .catch((error) => {
            throw new InfraError(`no network switch on this environment (${error.message})`);
          });
        await new Promise((resolve) => setTimeout(resolve, journey.blip.seconds * 1000));
      }
      // Candidates answer what reached them before the recruiter's next move.
      if (journey.candidates && last) {
        last.candidateMail = [
          ...(last.candidateMail ?? []),
          ...(await candidatesAnswer(journey, tag, label)),
        ];
        if (last.candidateMail.length) await sleep(20_000);
      }
      const move = await simulate(journey, turns, render(chats), cards, screen, tag, startedAt);
      // The planner model sometimes nests its text ({"text": {"zh": "…"}}); the recruiter types a string.
      if (move.text != null && typeof move.text !== "string")
        move.text =
          Object.values(move.text).find((value) => typeof value === "string") ??
          JSON.stringify(move.text);
      const at = Date.now();
      const turn = { turn: index + 1, at: new Date(at).toISOString(), move };
      const problems = [];
      // Done before asking anything is the recruiter reading an earlier session, not a result.
      if (move.action === "done" && !turns.some((item) => !item.invalid)) {
        turn.invalid = "done before the recruiter asked anything";
        log(`${label}: recruiter tried to finish before asking anything; asking again`);
        turns.push(turn);
        continue;
      }
      if (move.action === "done") {
        log(`${label}: recruiter is done: ${move.goal ?? ""}`);
        turns.push(turn);
        break;
      }
      const card = cards[move.card];
      // A sign-in card takes no typed answer; the recruiter's words go to that chat as a message,
      // as a real recruiter would type them under the card.
      if (card?.connect && move.action === "answer_card" && move.text) {
        move.action = "say";
        move.chat = card.chat;
      }
      let waitForKruit = true;
      if (move.action === "wait" && waited >= 2) {
        turn.invalid = "you already stepped away twice: write to Kruit, or end with done";
        log(`${label}:   ${turn.invalid}`);
        turns.push(turn);
        continue;
      }
      if (move.action === "wait") {
        // The recruiter is away: candidates answer what reached them, and Kruit may write first.
        waitForKruit = false;
        log(`${label}: recruiter steps away`);
        turn.candidateMail = journey.candidates ? await candidatesAnswer(journey, tag, label) : [];
        // One real step away per play; a repeated wait is only a short pause, never 8 more minutes.
        const minutes = waited++ ? 1 : 8;
        const until = Date.now() + minutes * 60_000;
        while (Date.now() < until && !(await newestBotMessageAfter(rpc, at)))
          await changeOrTimeout(rpc, 30_000);
        const wrote = await newestBotMessageAfter(rpc, at);
        turn.firstReplySeconds = wrote
          ? Math.round((Date.parse(wrote.createdAt) - at) / 1000)
          : undefined;
        log(
          `${label}:   Kruit ${wrote ? `wrote first after ${turn.firstReplySeconds} s` : `said nothing in ${minutes} minutes`}`,
        );
      } else if (move.action === "say") {
        const chat = await chatNamed(move.chat);
        log(`${label}: recruiter: ${move.text}`);
        let typed = false;
        if (ui) {
          await ui.openChat(chat.id);
          typed = await ui.say(move.text);
          if (!typed)
            problems.push(`could not send "${move.text.slice(0, 40)}" from the chat composer`);
          // Taken by the page but never shown in the chat: report it, and never send it twice.
          else if (!(await landed(rpc, chat.id, move.text)))
            problems.push(`"${move.text.slice(0, 40)}" was sent but did not appear in the chat`);
        }
        if (!typed) await send(rpc, chat.id, move.text);
      } else if (ui && move.action === "look") {
        waitForKruit = false;
        const chat = move.chat ? await chatNamed(move.chat) : null;
        log(`${label}: recruiter opens ${move.page}${chat ? ` in ${chat.name}` : ""}`);
        await ui
          .openPage(move.page, chat && chat.id !== kruit.id ? chat.id : undefined)
          .catch((error) => problems.push(`could not open ${move.page}: ${error.message}`));
        turn.screen = await ui.view(2_500);
      } else if (ui && move.action === "click") {
        // A send goes through approve_send, where the harness checks the recipients first.
        if (SEND_BUTTON.test(move.text ?? "") || STANDING_BUTTON.test(move.text ?? "")) {
          turn.invalid = "send buttons are pressed only through approve_send";
          turns.push(turn);
          continue;
        }
        log(`${label}: recruiter presses "${move.text}"`);
        if (!(await ui.click(move.text)))
          problems.push(`no button or link "${move.text}" on the page`);
        await sleep(3_000);
        // Pressing a card's button or a page's control may start Kruit working; wait only then.
        waitForKruit = Boolean(await newestBotMessageAfter(rpc, at));
        turn.screen = await ui.view(2_500);
      } else if (card && ["answer_card", "approve_send", "deny_send"].includes(move.action)) {
        if (card.connect) {
          turn.invalid = "a sign-in card cannot be answered by the simulated recruiter";
          turns.push(turn);
          continue;
        }
        // A reply draft's only typed answer is its text box: an answer typed on it is the
        // recruiter's edited reply, sent with the card's Send, never a discard.
        const editedOnCard = card.mailReply && move.action === "answer_card" && move.text?.trim();
        let answer =
          move.action === "deny_send"
            ? "deny"
            : move.action === "approve_send" || editedOnCard
              ? "allow"
              : move.text;
        if (card.send) answer = guardSend(journey, card, answer, turn);
        turn.approvedSend = card.send && answer === "allow";
        // The email on a send card is what goes out: a fill-in left in it is a product failure.
        const fillIn = card.send && card.text.match(PLACEHOLDER);
        if (fillIn) turn.placeholder = fillIn[0];
        log(
          `${label}: recruiter ${answer === "allow" ? "approves" : answer === "deny" ? "denies" : `answers "${answer}" on`} "${card.text.slice(0, 60)}"${turn.guard ? ` (${turn.guard})` : ""}`,
        );
        // A reply draft's Send carries the draft as shown, or as the recruiter edited it in the
        // card's text box, as the page's Send button does.
        const edited = card.mailReply && answer === "allow" && !ui && move.text?.trim();
        if (edited) {
          turn.editedReply = true;
          log(`${label}: recruiter edits the reply before Send: ${edited.slice(0, 120)}`);
        }
        const value =
          card.mailReply && answer === "allow"
            ? { action: "send", body: edited || card.mailReply.body, cc: card.mailReply.cc ?? [] }
            : card.send
              ? answer
              : cardAnswer(card, answer);
        if (value === null) {
          log(`${label}: recruiter writes under the card: ${answer}`);
          if (ui) await ui.openChat(card.groupId);
          if (!(ui && (await ui.say(answer)))) await send(rpc, card.groupId, answer);
          turn.underCard = true;
        }
        let pressed = value === null;
        if (ui && !pressed) {
          await ui.openChat(card.groupId);
          const action = card.actions.find((item) => item.id === (card.mailReply ? answer : value));
          pressed = action
            ? await ui.clickLabel(action.label)
            : // A form card takes the typed text in its field; the API gets the parsed content.
              typeof answer === "string" &&
              (await ui.answerTyped(typeof value === "string" ? value : answer));
          if (pressed) pressed = await answered(rpc, card);
          if (!pressed)
            problems.push(
              `could not answer the card "${card.text.slice(0, 40)}" on the page${action ? ` (no "${action.label}" button)` : ""}`,
            );
        }
        if (!pressed)
          try {
            await rpc("threads/answer", {
              groupId: card.groupId,
              runId: card.runId,
              messageId: card.messageId,
              answer: value,
            });
          } catch (failure) {
            // A card that closed meanwhile or refused the answer is one lost move, not a lost journey.
            if (failure instanceof InfraError) throw failure;
            turn.invalid = `the card did not take the answer (${failure.message})`;
            log(`${label}:   ${turn.invalid}`);
            turns.push(turn);
            continue;
          }
        // A recruiter who denies says what to change right under the card, in the same move.
        if (move.action === "deny_send" && move.text?.trim()) {
          log(`${label}: recruiter: ${move.text}`);
          const typed = ui ? await ui.say(move.text) : false;
          if (ui && !typed)
            problems.push(`could not send "${move.text.slice(0, 40)}" from the chat composer`);
          if (!typed) await send(rpc, card.groupId, move.text);
        }
      } else {
        turn.invalid = `no card ${move.card} to ${move.action}`;
        turns.push(turn);
        continue;
      }
      if (problems.length) {
        turn.ui = problems;
        for (const problem of problems) log(`${label}:   UI: ${problem}`);
      }
      if (waitForKruit) {
        // An interrupting customer writes again as soon as Kruit starts on the first ask.
        const quick =
          journey.interrupt &&
          move.action === "say" &&
          !turns.some((item) => item.move.action === "say");
        const { firstSeconds, doneSeconds } = await replyAfter(journey, rpc, at, quick);
        turn.firstReplySeconds = firstSeconds;
        turn.doneSeconds = doneSeconds;
        log(
          `${label}:   Kruit's first reply after ${firstSeconds ?? "no reply"} s, last after ${doneSeconds ?? "-"} s`,
        );
      }
      // A candidate can only answer mail that went out: after a confirmed send, wait for it.
      if (journey.candidates && turn.approvedSend && !(await mailReached(journey, tag, 5 * 60_000)))
        turn.ui = [
          ...(turn.ui ?? []),
          "no email reached the candidates within 5 minutes of the confirmed send",
        ];
      turn.records = await records(rpc, startedAt, before);
      if (ui) turn.shot = await ui.shot(`turn-${turn.turn}-${move.action}`);
      turns.push(turn);
    }
    // The page after Kruit's last reply, so the judge can check the final claims too.
    const last = turns.at(-1);
    if (ui && last && !last.screen) {
      const seen = await ui.view();
      last.screen = { ...seen, text: seen.text.slice(-2500) };
    }
    return {
      turns,
      leftRunning: await runsLeft(rpc, startedAt),
      accountName: journey.account ? await user.name().catch(() => null) : ACCOUNT_NAME,
      chats: await transcripts(rpc, startedAt, journey.chinese),
      records: await records(rpc, startedAt, before),
      // Every email the candidates got and wrote, for the judge to check what Kruit said of replies.
      ...(journey.candidates ? { mail: await outreachMail() } : {}),
      variation: journey.variation,
    };
  } catch (error) {
    // Keep what was played so the report still shows the conversation up to the failure.
    error.partial = {
      turns,
      chats: await transcripts(rpc, startedAt, journey.chinese).catch(() => []),
    };
    throw error;
  } finally {
    await ui?.close();
    await stopAll(rpc).catch((error) => log(`${label}: stop failed: ${error.message}`));
    unfollowAll(rpc);
    // A reused account keeps every role a play opens, so the next play would start among them:
    // archive (restorable) the roles this play made, so plays stay independent. Only roles named
    // with this play's tag: another play on the same account may be running at the same time.
    if (journey.account) {
      const made = (await groupsOf(rpc).catch(() => []))
        .filter((group) => !groupsBefore.has(group.id) && group.name?.includes(tag))
        .map((group) => group.id);
      if (made.length) await archiveRoles(credentials, made, label);
    } else
      await retireRoutines(rpc).catch((error) =>
        log(`${label}: routines not stopped: ${error.message}`),
      );
  }
}
/**
 * Closes the cards earlier plays left waiting on a reused account (over an hour old), without
 * approving anything, so a play measures what Kruit does now: a pending card from before makes
 * Kruit rightly hold back a new one, and the play would grade that leftover.
 */
async function closeStaleCards(rpc, label) {
  const LATER = /(稍后|以后|先不|跳过|暂不|不用|取消|later|skip|not now|cancel)/i;
  let closed = 0;
  for (const group of await groupsOf(rpc)) {
    if (!group.needsInput && !group.id.startsWith("recruiting-global-")) continue;
    for (const message of await messagesOf(rpc, group.id)) {
      if (!message.runId || Date.now() - Date.parse(message.createdAt) < 60 * 60_000) continue;
      for (const block of openCards(message)) {
        const later = (block.actions ?? []).find((action) => LATER.test(action.label ?? ""));
        const answer = block.approvalEffectId
          ? "deny"
          : later
            ? later.id
            : block.requestedSchema
              ? { action: "decline" }
              : undefined;
        if (answer === undefined || block.input === "secret") continue;
        await rpc("threads/answer", {
          groupId: group.id,
          runId: message.runId,
          messageId: message.id,
          answer,
        })
          .then(() => (closed += 1))
          .catch(() => {});
      }
    }
  }
  if (closed) log(`${label}: closed ${closed} card(s) earlier plays left waiting`);
}
/**
 * Empties what earlier plays had Kruit remember on a reused mailbox account (one play holds it at
 * a time). A preference one play's recruiter stated, such as "send nothing before Monday", is
 * otherwise followed in the next play, which then grades a refusal its recruiter never caused.
 */
async function forgetEarlierPlays(rpc, label) {
  let emptied = 0;
  for (const scope of ["user", "bot"])
    for (const doc of await rpc("memory/list", { scope })) {
      if (!doc.content) continue;
      await rpc("memory/update", {
        documentId: doc.id,
        content: "",
        expectedRevision: doc.revision,
      });
      emptied += 1;
    }
  if (emptied) log(`${label}: emptied ${emptied} memory document(s) earlier plays left`);
}
/** Archives the roles one play opened on a reused account, through the shared archive script. */
function archiveRoles([email, password], groupIds, label, { idleHours = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(import.meta.dirname, "archive-test-copies.mjs"),
        "--idle-hours",
        String(idleHours),
        ...(idleHours ? [] : ["--stop"]),
        "--only",
        groupIds.join(","),
      ],
      {
        env: {
          ...process.env,
          RAKAZO_URL: BASE,
          RAKAZO_ORIGIN: ORIGIN,
          RAKAZO_EMAIL: email,
          RAKAZO_PASSWORD: password,
        },
        stdio: "ignore",
      },
    );
    child.on("exit", (code) => {
      if (code) log(`${label}: archiving its ${groupIds.length} role(s) exited ${code}`);
      resolve();
    });
  });
}
/** Whether a message typed in the browser reached the chat within 90 seconds. */
async function landed(rpc, groupId, text) {
  for (const until = Date.now() + 90_000; Date.now() < until; await changeOrTimeout(rpc, 10_000))
    if (
      (await messagesOf(rpc, groupId)).some(
        (message) => message.role === "user" && botText(message).includes(text.slice(0, 30)),
      )
    )
      return true;
  return false;
}
/** Whether a card pressed in the browser closed within 20 seconds. */
async function answered(rpc, card) {
  for (const until = Date.now() + 20_000; Date.now() < until; await changeOrTimeout(rpc, 5_000))
    if (!(await cardsOpen(rpc)).some((open) => open.messageId === card.messageId)) return true;
  return false;
}

// --- The judge ----------------------------------------------------------------------------------
const JUDGE_RULES = `You judge a recruiting assistant called Kruit from the customer's side. You get one simulated customer's whole conversation, the moves the customer made, how long Kruit took to reply, and the role's real send records after each move. Be strict and concrete; quote Kruit. For every customer move decide:
- answered: did Kruit's reply directly answer or do what the customer asked (not a deferral, not a different question)?
- truthful: "yes", "no" or "unknown" — does every claim Kruit made about state (sent, queued, scheduled, paused, how many) match the records? A count or status that contradicts the records is "no" (check a claim about named people's grades against the role's grades, not against how much fit changed: someone graded in an earlier step is already in fit), and so is saying people were found, added or saved for a role when its "saved" count after the reply is lower. The records are read after the step settles, while a search may still be adding and grading people: a progress count lower than the record (57 graded so far, the record later showing 73) does not contradict it; a count above the record, or a finished total the record does not reach, does. The records hold only the campaigns the test could read: when a claim is about a campaign, role or person missing from them, it is "unknown", never "no"; a candidate name you cannot find in the records is not "invented" (saved search results are not in the records). Instantly sends one email per mailbox about every 10 minutes, so a second person contacted minutes after the first is normal. The first email of a newly confirmed or activated send can take up to about 15 minutes to go out (a healthy mailbox started in about two on staging): within that time, "queued, not sent yet, out by about HH:MM" is truthful and a goal of getting the email sent counts as met if the records show it queued (the campaign active, the person added). A confirmed send fails only if the person is still not contacted after the time Kruit gave.
- issues: short labels for what went wrong, from: dead end, refused, lecture, repeat (Kruit says the same thing again unprompted or posts a message twice; answering a new or overlapping question with the same fact is not a repeat; a list posted once in the role's own chat and copied once into Kruit's chat, where the recruiter asked, is one showing, and only the same thing twice within one chat is a repeat), wrong language (Kruit's own words not in the recruiter's language; an email or template written for candidates is meant to be English and is never wrong language), false claim, internal jargon (anything in Kruit's own words a recruiter would not understand or should not see: a supplier or service name such as Exa, Instantly, FullEnrich, ContactOut, Modal or Supabase; an internal helper's name such as Sourcer, Reviewer, Main or a sub-agent; internal mechanics such as a handoff, queue, worker, session, retry, timeout, tool, task or record ID, or a gate code. Gmail, Calendar, LinkedIn, the app's own pages and the role's own chat by its role name are the recruiter's words, and quoted candidate profiles are not Kruit's own words), fake block (Kruit hands the work back or stalls without a result when it could act: "want me to…?"/"要不要我…？" about something the recruiter already asked for, "I couldn't check"/"我查不了" without saying what it tried, or "I've asked the team to check"/"已让团队核实" with no result later in the conversation; a confirmation before an outside send and a plain "cannot" for something it has no way to do are not fake blocks), slow (first reply over 10 s), slow result (an ordinary ask not finished within 2 minutes, or a long job with no progress line for 5 minutes), wordy (the answer is not in the first two lines, or Kruit lectures or explains what it will do instead of doing it), stopped midway (a job Kruit started ended without its result), broken email (an email or template Kruit offers as ready contains a question to the recruiter, a "[...]" fill-in or any {{...}} field other than the merge fields the sender fills for each person ({{firstName}}, {{lastName}}, {{companyName}}, {{personalization}}), or a sign-off with no name), did not act, asked again (only when Kruit actually asks a question or shows a card that asks about, or asks to confirm, something the recruiter's JD or messages already stated: location, work mode or commute when a city and mode are given, a stated number of years, including asking for a cap on it, or a language requirement when nothing implies a second language; a reply that asks nothing is never asked again; quote where the recruiter said it, and if you cannot, it is not asked again), screen wrong, missing control, confusing page, slow page (a page over 5 s to show), blank or stuck (a page or chat that shows nothing, a spinner, or an old state), button did nothing, other.
- gap: only for a move that asked for people and got fewer new people than asked (the move says both numbers): "said" when Kruit said how many are missing, or that none fit, and why, and asked what to change or whether to go on; else "not said". null for every other move.
- Check every move against the records and against what the page showed after Kruit's reply ("screen"): a claim the screen contradicts (a count, a status, "saved", "sent", a place to click that is not there) is truthful "no". Do not give the benefit of the doubt: an answer that is only "I'll check" or "on it" with nothing after it is "did not act".
A new role searches first (the product's order): its first people come straight from the JD as written, and at most one short question about something the recruiter left open comes beside them, never before them. Opening the role and saying its team is searching counts as answered when the role chat then shows that search; no question is expected, a question about something already said is "asked again", and a second question is "wordy". When the customer asks for something else (a template, an email), doing it is the right move and no role question is expected.
What goes out is what was on the card the customer approved and what the records show, never a card the customer denied: a denied card's email was not queued or sent, so a reply that describes the approved email truthfully is "yes" even when a denied card said otherwise. Two send cards with different emails shown at once is its own problem ("other"), not a false claim.
The simulated customer cannot complete an account sign-in (connecting Gmail or a calendar), so "I can't click that here" about a connection card is the test's limit, not Kruit's dead end. Judge whether Kruit showed the card, said in one step what connecting does, and kept the work for afterwards.
When the customer used the browser, a move may also show what a page displayed ("screen") and UI problems the test hit ("ui"). Check the screen against the records and against what Kruit said: a page that shows a different count or status from the records, or says nothing where Kruit said to look, is "screen wrong"; compare a number only with records of the same scope, so a total labelled for the account or all time is not wrong because one role shows less; a control the customer needed and could not find is "missing control". A "look" or "click" move has no Kruit reply: judge "answered" for it by whether the page gave the customer what they went there for. A "wait" move asks nothing: judge "answered" by whether Kruit told the customer, unasked, about what happened meanwhile (a candidate's reply); saying nothing after a reply arrived is "did not act".
Quote what each fault breaks. A correctness fault (false claim, asked again, broken email, did not act, a candidate who misses a requirement) needs, in the note, the exact sentence it breaks, quoted from these rules, the recruiter's messages or the JD; if you cannot quote one, it is not a fault and costs nothing. A candidate requirement is only something the JD or the recruiter says the person must have or be (skills, years, the place they must work from, a language). Terms the employer offers, such as the pay range, office days, benefits or the start date, are never candidate requirements: a person or list that does not show them misses nothing. Each fake block costs at least 3 points of the score.
Judge an email or template only against what the customer actually told Kruit in the conversation: a draft without details the customer never gave (a role they only named, a salary they never said) is the honest result, not a fault and not a lower score.
Then judge the whole journey: which of the customer's goals were met, a score from 0 to 10 for how a real recruiter would rate the experience, a one-sentence verdict, and the top problems. Write the verdict and problems in Chinese, in short plain sentences. Write each move's note first, then its verdicts: answered, truthful and issues must agree with the note, so a label the note says does not apply is left out. Answer with one JSON object and nothing else:
{"turns": [{"turn": n, "note": "<one line>", "answered": true|false, "truthful": "yes"|"no"|"unknown", "issues": ["..."], "gap": "said"|"not said"|null}], "goals": [{"goal": "...", "met": true|false, "why": "..."}], "score": 0-10, "verdict": "...", "problems": ["..."]}`;

/** What a move asked for and got, so the judge reads "gap" against the counts. */
const askedLine = (requests, turn) => {
  const request = requests.find((item) => item.turn === turn.turn);
  return request
    ? ` (asked for ${request.asked} new people; new people shown before the next move: ${request.shown})`
    : "";
};
async function judge(journey, result, requests = []) {
  const moves = result.turns
    .map(
      (turn) =>
        `Move ${turn.turn} at ${turn.at.slice(11, 19)}: ${turn.move.action}${turn.move.text ? ` "${turn.move.text}"` : ""}${askedLine(requests, turn)}${turn.guard ? ` (${turn.guard})` : ""}${turn.editedReply ? " (the recruiter rewrote the reply draft to this text and sent it: every fact in it is the recruiter's own)" : ""}${turn.invalid ? ` (not done: ${turn.invalid})` : ""}${turn.move.page ? ` page ${turn.move.page}${turn.move.chat ? ` of ${turn.move.chat}` : ""}` : ""}\n  first reply after: ${turn.firstReplySeconds ?? "none"} s${turn.doneSeconds ? `, last reply after ${turn.doneSeconds} s` : ""}\n  records after: ${JSON.stringify(turn.records ?? [])}${turn.ui ? `\n  ui: ${turn.ui.join("; ")}` : ""}${turn.candidateMail?.length ? `\n  candidates replied after this move: ${turn.candidateMail.map((m) => `${m.name} at ${m.at.slice(11, 19)}: "${m.text}"`).join(" | ")}` : ""}${turn.screen ? `\n  screen (${turn.screen.url}${turn.screen.loadSeconds ? `, took ${turn.screen.loadSeconds} s to show` : ""}):\n${turn.screen.text.replace(/^/gm, "    ")}${turn.screen.fields?.length ? `\n    text boxes: ${turn.screen.fields.join(" | ")}` : ""}` : ""}`,
    )
    .join("\n");
  const prompt = `Customer persona:\n${journey.persona}\n\nGoals:\n${journey.goals.map((goal, i) => `${i + 1}. ${goal}`).join("\n")}\n\n${journey.account ? `This account is a test fixture that earlier plays used too: on a page, roles, campaigns, totals and messages from those plays (older or same-named entries) are the test's leftovers, not Kruit's fault.${result.accountName ? ` The account's own name is "${result.accountName}": an email signed with it, or with the sending mailbox's name, is signed by the sender, not a placeholder.` : ""}\n\n` : `The customer signed up as ${ACCOUNT_NAME}, so Kruit has that name.\n\n`}Record codes: ${CAMPAIGN_CODES}\n\nConversation (UTC):\n${render(result.chats)}\n\nCustomer moves:\n${moves}${result.mail ? `\n\nEvery email between the role's mailbox and the candidates (the mail service's own record; ue_type 1 = sent to the candidate, 2 = the candidate's reply, 3 = the recruiter's reply to the candidate):\n${result.mail.map((email) => `${String(email.timestamp_created).slice(11, 19)} ${email.ue_type === 2 ? `from ${email.lead}` : `to ${email.lead}`}: "${email.subject}" ${String(email.body?.text ?? "").slice(0, 600)}`).join("\n")}\nThe candidates' replies are real mail the recruiter's inbox received: Kruit saying nobody replied after a reply arrived, or misquoting one, is a false claim.` : ""}`;
  // One reading flips on borderline moves, so three judges read the play and a finding stands
  // only when most of them give it (majority voting, as in self-consistency).
  const readings = (
    await Promise.all([0, 1, 2].map(() => askJson(JUDGE_RULES, prompt, JUDGE).catch(() => null)))
  ).filter(Boolean);
  if (!readings.length) throw new Error("the judge gave no reading");
  return majority(readings);
}
/** One verdict from several readings of a play: the median reading, with each finding by vote. */
function majority(readings) {
  const most = (count) => count * 2 > readings.length;
  const median = [...readings].sort((a, b) => a.score - b.score)[(readings.length - 1) >> 1];
  return {
    ...median,
    turns: (median.turns ?? []).map((turn) => {
      const all = readings.map((reading) => reading.turns?.find((item) => item.turn === turn.turn));
      const votes = (test) => most(all.filter((item) => item && test(item)).length);
      const issues = [...new Set(all.flatMap((item) => item?.issues ?? []))].filter((issue) =>
        votes((item) => item.issues?.includes(issue)),
      );
      const flagged = all.find((item) => issues.some((issue) => item?.issues?.includes(issue)));
      return {
        ...turn,
        note: (flagged ?? turn).note,
        answered: !votes((item) => item.answered === false),
        truthful: votes((item) => item.truthful === "no")
          ? "no"
          : turn.truthful === "no"
            ? "unknown"
            : turn.truthful,
        issues,
        gap: votes((item) => item.gap === "said") ? "said" : turn.gap ? "not said" : null,
      };
    }),
    goals: (median.goals ?? []).map((goal, index) => ({
      ...goal,
      met: !most(readings.filter((reading) => reading.goals?.[index]?.met === false).length),
    })),
  };
}

// --- Run, judge, report -------------------------------------------------------------------------
const SHA =
  option("--sha") ??
  (await fetch(`${BASE}/ready`)
    .then((response) => response.headers.get("x-rakazo-revision"))
    .catch(() => null)) ??
  "unknown";

// The bar a recruiter would agree with: 8/10 or better, every goal met, and none of these.
const PASS_SCORE = 8;
const BLOCKING = new Set([
  "false claim",
  "dead end",
  "repeat",
  "refused",
  "did not act",
  "asked again",
  "wrong language",
  "internal jargon",
  "screen wrong",
  "missing control",
  "blank or stuck",
  "button did nothing",
  "stopped midway",
  "broken email",
]);

/** Kruit's reply times over a play: median and slowest first reply, slowest finish. */
function latencyLine(turns) {
  const first = turns
    .map((turn) => turn.firstReplySeconds)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const done = turns.map((turn) => turn.doneSeconds).filter(Number.isFinite);
  if (!first.length) return "回复速度：没有回复";
  return `回复速度：首次回复中位 ${first[Math.floor(first.length / 2)]} s，最慢 ${first.at(-1)} s${done.length ? `，做完最慢 ${Math.max(...done)} s` : ""}`;
}

/** Plays one journey, has it judged, and writes its report; returns its scoreboard row. */
/** The strict bar: the play passes only with every goal, no false claim and no blocking issue. */
function strictBar(verdict, result) {
  // Rule checks the scripted conversations use apply here too.
  const recruiter = (result?.chats ?? []).flatMap(({ messages }) =>
    messages.filter((m) => m.role === "user"),
  );
  const checks = [
    ...visible(result?.chats ?? []).flatMap(({ group, messages }) =>
      conversationChecks(messages, { recruiter }).map((failure) => `${group.name}: ${failure}`),
    ),
    ...(result?.turns ?? [])
      .filter((turn) => turn.placeholder)
      .map((turn) => `send card email has an unfilled placeholder: ${turn.placeholder}`),
  ];
  const falseClaims = (verdict?.turns ?? []).filter((turn) => turn.truthful === "no").length;
  const missed = (verdict?.goals ?? []).filter((goal) => !goal.met);
  // One false claim, dead end, repeat or unanswered request fails the play, whatever the score.
  const blocking = (verdict?.turns ?? []).flatMap((turn) => {
    const move = result?.turns?.find((item) => item.turn === turn.turn)?.move;
    return [
      ...(turn.issues ?? []).filter((issue) => BLOCKING.has(issue)),
      ...(turn.answered === false && move?.action === "say" ? ["not answered"] : []),
    ].map((issue) => `step ${turn.turn}: ${issue} — ${turn.note ?? ""}`);
  });
  // A play the harness or the environment broke has no verdict: it is "not run", never a score.
  const notRun = !verdict;
  const pass =
    !notRun &&
    verdict.score >= PASS_SCORE &&
    !falseClaims &&
    !missed.length &&
    !checks.length &&
    !blocking.length;
  // A first reply over 30 s is felt as a hang. Report-only until it has passed twice (gate rule).
  const slowStart = (result?.turns ?? [])
    .filter((turn) => turn.firstReplySeconds > SLOW_START_SECONDS)
    .map((turn) => `step ${turn.turn}: first reply after ${turn.firstReplySeconds} s`);
  return { checks, falseClaims, missed, blocking, notRun, pass, slowStart };
}
const SLOW_START_SECONDS = 30;

async function runOne(journey, sample, owner, mailbox) {
  const label = `${journey.name}#${sample}`;
  const out = path.join(OUT, label);
  fs.mkdirSync(out, { recursive: true });
  const at = Date.now();
  let result;
  let verdict;
  let error;
  let requests = [];
  try {
    result = await play(journey, label, owner, mailbox, out);
    requests = requestCompletion(result.turns, result.chats);
    verdict = await judge(journey, result, requests);
  } catch (caught) {
    error = caught;
    result ??= caught.partial;
  }
  const { checks, falseClaims, missed, blocking, notRun, pass, slowStart } = strictBar(
    verdict,
    result,
  );
  // Each request for people, with whether its people came (request-completion.mjs).
  for (const request of requests)
    request.outcome = completionOutcome(
      request,
      verdict?.turns?.find((turn) => turn.turn === request.turn)?.gap,
    );
  const row = {
    suite: "simulated",
    scenario: journey.name,
    area: journey.area,
    source: journey.source,
    sample,
    pass,
    score: verdict ? verdict.score / 10 : 0,
    failures: error
      ? [`${error instanceof InfraError ? "infrastructure" : "error"}: ${error.message}`]
      : [
          ...(verdict.score < PASS_SCORE ? [`score ${verdict.score}/10: ${verdict.verdict}`] : []),
          ...(falseClaims ? [`${falseClaims} reply(ies) contradict the records or the page`] : []),
          ...blocking,
          ...missed.map((goal) => `goal not met: ${goal.goal}`),
          ...checks,
        ],
    sha: SHA,
    at: new Date(at).toISOString(),
    seconds: Math.round((Date.now() - at) / 1000),
    paid: Boolean(journey.paid),
    ...(verdict ? { verdict: verdict.verdict } : {}),
    ...(notRun ? { infra: true, notRun: true } : {}),
    ...(slowStart.length ? { slowStart } : {}),
    ...(requests.length && verdict ? { requests } : {}),
    ...(result?.leftRunning?.length ? { leftRunning: result.leftRunning } : {}),
    ...overlapOf(result?.records),
  };
  fs.writeFileSync(
    path.join(out, "journey.json"),
    JSON.stringify({ journey: journey.name, result, verdict, checks }, null, 1),
  );
  const report = [
    `# ${journey.title} — ${verdict ? `${verdict.score}/10 ${pass ? "PASS" : "FAIL"}` : "NOT RUN (harness or environment)"}`,
    "",
    ...(result?.variation ? [`客户这次：${result.variation}`, ""] : []),
    ...(blocking.length ? ["## 一票否决", ...blocking.map((b) => `- ${b}`), ""] : []),
    verdict?.verdict ?? `出错: ${error?.message}`,
    "",
    ...(verdict?.problems?.length ? ["## 问题", ...verdict.problems.map((p) => `- ${p}`), ""] : []),
    ...(verdict?.goals?.length
      ? ["## 目标", ...verdict.goals.map((g) => `- ${g.met ? "✓" : "✗"} ${g.goal}：${g.why}`), ""]
      : []),
    ...(checks.length ? ["## 规则检查", ...checks.map((c) => `- ${c}`), ""] : []),
    ...(row.leftRunning
      ? [
          `玩完还在跑：${row.leftRunning.map((r) => `${r.chat} ${r.status} ${r.minutes} 分钟`).join("；")}`,
          "",
        ]
      : []),
    ...(row.finds
      ? [`重复找到：${row.foundAgain}/${row.finds}，同一 LinkedIn 两行 ${row.sameLinkedIn} 次`, ""]
      : []),
    ...(slowStart.length
      ? [
          `## 首次回复超过 ${SLOW_START_SECONDS} 秒（暂不挡发布）`,
          ...slowStart.map((s) => `- ${s}`),
          "",
        ]
      : []),
    "## 每一步",
    "| # | 客户 | 首次回复 | 回答了 | 属实 | 问题 | 截图 |",
    "|---|---|---|---|---|---|---|",
    ...(result?.turns ?? []).map((turn) => {
      const judged = verdict?.turns?.find((item) => item.turn === turn.turn) ?? {};
      const said =
        turn.move.action === "look"
          ? `打开 ${turn.move.page}${turn.move.chat ? `（${turn.move.chat}）` : ""}`
          : (turn.move.text ?? turn.move.action);
      const issues = [
        ...(judged.issues ?? []),
        ...(turn.ui ?? []).map((problem) => `UI: ${problem}`),
      ];
      return `| ${turn.turn} | ${said.replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 60)}${turn.guard ? " (拦截)" : ""} | ${turn.firstReplySeconds ?? "-"} s | ${judged.answered === undefined ? "-" : judged.answered ? "是" : "否"} | ${judged.truthful ?? "-"} | ${issues.join(", ").replace(/\|/g, "/")} | ${turn.shot ? `[图](${turn.shot})` : ""} |`;
    }),
    "",
    "## 对话",
    render(result?.chats ?? []),
    "",
    `Staging ${SHA.slice(0, 8)} · ${row.seconds} s`,
    latencyLine(result?.turns ?? []),
  ].join("\n");
  fs.writeFileSync(path.join(out, "report.md"), `${report}\n`);
  log(`${label}: ${verdict ? `${verdict.score}/10 ${pass ? "PASS" : "FAIL"}` : "NOT RUN"}`);
  return row;
}

// --- Learning from failures ----------------------------------------------------------------------
// Every failed journey becomes (1) a failure note for the team that owns that part of Kruit, with
// the evidence quoted, and (2) when no journey covers it yet, a new permanent journey that
// reproduces it, so the suite grows from every failure. A model writes both from the report; the
// pass/fail itself stays with the records and rule checks above, not with this model.
const OWNERS = {
  sending: "sending and Send cards",
  search: "people search and the first ten",
  requirements: "role requirements and must-haves",
  "first message": "Kruit's replies (agent instructions)",
  ui: "web pages",
};
const LEARN_RULES = `You turn a failed test of a recruiting assistant (Kruit) into work for the team. You get the journey's report: score, problems, the per-step table and the whole conversation, plus the names and goals of the journeys that already exist. Answer with one JSON object and nothing else:
{"area": "sending" | "search" | "requirements" | "first message" | "ui", "problem": "<one sentence: what Kruit did wrong, in English>", "evidence": "<Kruit's exact words or the screen text that shows it, at most 200 characters>", "fix": "instructions" | "skill" | "code" | "test", "fixHint": "<one sentence: where the fix most likely belongs>", "newJourney": null | {"name": "<kebab-case, new>", "title": "<Chinese, short>", "area": "...", "source": "<the failed journey and date>", "persona": "AGENCY_RECRUITER" | "US_RECRUITER", "situation": "<one sentence the persona adds>", "chinese": true|false, "maxTurns": 4-8, "facts": "<what the recruiter knows, or empty>", "goals": ["..."], "mechanisms": ["<from: state-claims, reference, language, email-content, filler, long-task, latency, pages, guard-dead-end, honest-limits>"]}}
"fix": "test" means the test itself was wrong (the simulated customer or judge misread something); then newJourney is null. Propose newJourney only when the failure is a distinct behaviour that none of the existing journeys checks; it must need no paid people search and send no email.`;

async function learn(rows) {
  const failed = rows.filter((row) => !row.pass && !row.infra);
  if (!failed.length) return;
  const existing = JOURNEYS.map((j) => `- ${j.name}: ${j.goals.join(" / ")}`).join("\n");
  const notes = [];
  for (const row of failed) {
    const report = fs.readFileSync(
      path.join(OUT, `${row.scenario}#${row.sample}`, "report.md"),
      "utf8",
    );
    const note = await model(
      LEARN_RULES,
      `Existing journeys:\n${existing}\n\nFailed journey ${row.scenario}#${row.sample}:\n${report.slice(0, 30_000)}`,
      JUDGE,
    )
      .then(parse)
      .catch((error) => ({ area: row.area, problem: `could not summarise: ${error.message}` }));
    notes.push({ journey: `${row.scenario}#${row.sample}`, score: row.score, ...note });
  }
  fs.writeFileSync(path.join(OUT, "failures.json"), JSON.stringify(notes, null, 1));
  const byArea = Object.groupBy(notes, (note) => note.area ?? "other");
  fs.writeFileSync(
    path.join(OUT, "failures.md"),
    `${[
      `# 失败要交给谁 · staging ${SHA.slice(0, 8)}`,
      "",
      ...Object.entries(byArea).flatMap(([area, items]) => [
        `## ${OWNERS[area] ?? area}`,
        ...items.map(
          (note) =>
            `- **${note.journey}** (${Math.round(note.score * 10)}/10, fix: ${note.fix ?? "?"}) ${note.problem}\n  > ${String(note.evidence ?? "").replace(/\n/g, " ")}\n  ${note.fixHint ?? ""}`,
        ),
        "",
      ]),
    ].join("\n")}\n`,
  );
  // New permanent journeys go into the learned file the next runs play with --learned.
  const proposals = notes.map((note) => note.newJourney).filter((j) => j?.name && j.goals?.length);
  const target = LEARNED ?? path.join(OUT, "learned-journeys.json");
  const kept = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : [];
  for (const journey of proposals)
    if (
      !JOURNEYS.some((j) => j.name === journey.name) &&
      !kept.some((j) => j.name === journey.name)
    )
      kept.push({ ...journey, learnedAt: new Date().toISOString(), sha: SHA.slice(0, 8) });
  fs.writeFileSync(target, JSON.stringify(kept, null, 1));
  log(`learned: ${notes.length} failure notes, ${proposals.length} proposed journeys → ${target}`);
}

/** Marks journeys that passed in the baseline run and fail now: a regression blocks a release. */
function compareBaseline(rows) {
  const BASELINE = option("--baseline");
  if (!BASELINE || !fs.existsSync(BASELINE)) return;
  const file = fs.statSync(BASELINE).isDirectory()
    ? path.join(BASELINE, "results.jsonl")
    : BASELINE;
  const passedBefore = new Set(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row.pass)
      .map((row) => row.scenario),
  );
  const regressed = [
    ...new Set(
      rows
        .filter((r) => !r.pass && !r.infra && passedBefore.has(r.scenario))
        .map((r) => r.scenario),
    ),
  ];
  for (const row of rows) if (regressed.includes(row.scenario)) row.regressed = true;
  fs.appendFileSync(
    path.join(OUT, "summary.md"),
    `\n${regressed.length ? `退步（上次通过，这次不通过）: ${regressed.join(", ")}` : "没有退步"}\n`,
  );
}

// Each journey on a free account gets a brand-new account, so journeys run side by side. Journeys
// on the one mailbox fixture take turns, or they would read each other's chats.
// Judge calibration (--calibrate <dir>): each <dir>/*.json is {"label": "pass"|"fail", "why",
// "from": "<a play's journey.json>"} labelled by a person. The judge re-grades each play and its
// strict-bar verdict is compared with the label: agreement and Cohen's kappa, the usual check
// that an LLM judge matches people before its verdicts are trusted.
const CALIBRATE = option("--calibrate");
if (CALIBRATE) {
  const items = fs
    .readdirSync(CALIBRATE)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ file, ...JSON.parse(fs.readFileSync(path.join(CALIBRATE, file), "utf8")) }));
  const graded = [];
  for (const item of items) {
    const played = JSON.parse(fs.readFileSync(item.from, "utf8"));
    const journey = JOURNEYS.find((candidate) => candidate.name === played.journey);
    if (!journey || !played.result?.turns) {
      graded.push({ ...item, judge: "not run" });
      continue;
    }
    const verdict = await judge(journey, played.result).catch(() => null);
    const bar = strictBar(verdict, played.result);
    graded.push({
      ...item,
      judge: bar.notRun ? "not run" : bar.pass ? "pass" : "fail",
      blocking: bar.blocking ?? [],
      score: verdict?.score,
      other: [
        ...new Set(
          (verdict?.turns ?? [])
            .flatMap((turn) => turn.issues ?? [])
            .filter((issue) => !BLOCKING.has(issue)),
        ),
      ],
    });
    log(`${item.file}: label ${item.label}, judge ${graded.at(-1).judge}`);
  }
  const both = graded.filter((item) => item.judge !== "not run");
  const agree = both.filter((item) => item.judge === item.label).length;
  const share = (who, value) => both.filter((item) => item[who] === value).length / both.length;
  const chance =
    share("label", "pass") * share("judge", "pass") +
    share("label", "fail") * share("judge", "fail");
  const observed = agree / both.length;
  // With only one kind of label, kappa says nothing; report agreement (recall) alone.
  const oneClass = new Set(both.map((item) => item.label)).size < 2;
  const kappa = oneClass || chance === 1 ? null : (observed - chance) / (1 - chance);
  const kappaText =
    kappa === null ? "kappa n/a (all labels are one kind)" : `Cohen's kappa ${kappa.toFixed(2)}`;
  const report = [
    `# Judge calibration · ${new Date().toISOString().slice(0, 16)} · ${both.length} graded of ${graded.length}`,
    "",
    `Agreement ${Math.round(observed * 100)}% · ${kappaText} (target ≥ 0.6)`,
    "",
    "| Item | Person | Judge | Score | Why the person said so | Judge's vetoes | Other faults |",
    "|---|---|---|---|---|---|---|",
    ...graded.map(
      (item) =>
        `| ${item.file} | ${item.label} | ${item.judge} | ${item.score ?? "-"} | ${(item.why ?? "").replace(/\|/g, "/")} | ${(item.blocking ?? []).join("; ").replace(/\|/g, "/")} | ${(item.other ?? []).join(", ")} |`,
    ),
  ].join("\n");
  fs.writeFileSync(path.join(CALIBRATE, "calibration.md"), `${report}\n`);
  log(`agreement ${Math.round(observed * 100)}%, ${kappaText}`);
  process.exit(0);
}

const GATE = args.includes("--gate");
const selected = JOURNEYS.filter(
  (journey) =>
    (named ? named.includes(journey.name) : GATE ? journey.gate : !journey.paid || PAID) &&
    !missing(journey).length,
);
for (const journey of JOURNEYS.filter(
  (item) => (!named || named.includes(item.name)) && missing(item).length,
))
  log(`skipping ${journey.name}: set ${missing(journey).join(", ")}`);
const SAMPLES = Number(option("--samples", "2"));
const CONCURRENCY = Number(option("--concurrency", "6"));
// Mailbox samples take turns on the fixture; the batch copy plays once, since each play sends.
const plays = selected.flatMap((journey) =>
  Array.from({ length: journey.account === "batch" ? 1 : SAMPLES }, (_, index) => ({
    journey,
    sample: index + 1,
  })),
);
const owner = client();
await owner.auth(OWNER_EMAIL, OWNER_PASSWORD);
// A mailbox journey waits for a free mailbox account.
const freeMailboxes = [...MAILBOXES];
const waiting = [];
let senders = 0;
async function freshMailbox() {
  const email = `kruit-sim-sender-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  const password = `Sim-${crypto.randomUUID()}`;
  await owner.rpc("deployment/createAccount", { email, name: "Noah Reed", password });
  await owner.rpc("deployment/assignSendingMailbox", {
    accountEmail: email,
    mailbox: FRESH_SENDER.replace("{n}", String((senders += 1))),
    displayName: "Noah Reed",
  });
  return Object.assign([email, password], { fresh: true });
}
const takeMailbox = () =>
  FRESH_SENDER
    ? freshMailbox()
    : freeMailboxes.length
      ? Promise.resolve(freeMailboxes.pop())
      : new Promise((r) => waiting.push(r));
const giveBack = (mailbox) =>
  FRESH_SENDER
    ? undefined
    : waiting.length
      ? waiting.shift()(mailbox)
      : freeMailboxes.push(mailbox);
// The batch copy is one account with one main chat, so its journeys play one after another:
// side by side, each judge would read the other plays' replies.
let batchTurn = Promise.resolve();
const rows = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, plays.length) }, async () => {
    while (next < plays.length) {
      const { journey, sample } = plays[next++];
      if (journey.account === "batch") {
        const play = batchTurn.then(() => runOne(journey, sample, owner));
        batchTurn = play.catch(() => undefined);
        rows.push(await play);
        continue;
      }
      if (journey.account !== "mailbox") {
        rows.push(await runOne(journey, sample, owner));
        continue;
      }
      const mailbox = await takeMailbox();
      try {
        rows.push(await runOne(journey, sample, owner, mailbox));
      } finally {
        giveBack(mailbox);
      }
    }
  }),
);
rows.sort(
  (a, b) =>
    a.scenario.localeCompare(b.scenario) || String(a.sample).localeCompare(String(b.sample)),
);
fs.writeFileSync(
  path.join(OUT, "results.jsonl"),
  rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
);
const BENCH = option("--bench");
if (BENCH) {
  fs.mkdirSync(BENCH, { recursive: true });
  fs.appendFileSync(
    path.join(BENCH, `${new Date().toISOString().slice(0, 10)}-${SHA.slice(0, 8)}-simulated.jsonl`),
    rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  );
}
// One scoreboard for the whole run.
const passed = rows.filter((row) => row.pass).length;
// A journey passes only when every play ran and passed; a play that did not run never decides.
const journeyRows = Object.entries(Object.groupBy(rows, (row) => row.scenario)).map(
  ([name, plays]) => {
    const ran = plays.filter((row) => !row.infra);
    const status = !ran.length
      ? "没跑成"
      : ran.some((row) => !row.pass)
        ? "不通过"
        : ran.length < plays.length
          ? "部分没跑成"
          : "通过";
    const reasons = ran.filter((row) => !row.pass).flatMap((row) => row.failures.slice(0, 2));
    return { name, plays, status, reasons, blocks: BLOCKS.has(name) };
  },
);
const blocking = journeyRows.filter((row) => row.blocks && row.status === "不通过");
// pass@1: share of plays that ran and passed. pass^k: share of journeys whose every play passed,
// the reliability a customer feels (tau-bench); regression journeys gate releases, capability
// journeys track progress on what does not work yet.
const ranRows = rows.filter((row) => !row.infra);
const decided = journeyRows.filter((row) => row.status !== "没跑成");
const rate = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : "-");
const mechanismsOf = (name) => JOURNEYS.find((journey) => journey.name === name)?.mechanisms ?? [];
const passLine = (subset) =>
  `pass@1 ${rate(
    ranRows.filter((row) => row.pass && subset.some((item) => item.name === row.scenario)).length,
    ranRows.filter((row) => subset.some((item) => item.name === row.scenario)).length,
  )} · pass^k ${rate(subset.filter((row) => row.status === "通过").length, subset.length)}`;
const overlap = overlapSummary(ranRows);
// Requests for people that ended with the people, a shortfall said plainly, or nothing.
const completion = completionSummary(ranRows.flatMap((row) => row.requests ?? []));
const summary = [
  `blocking: ${blocking.length ? `yes (${blocking.map((row) => row.name).join(", ")})` : "no"}`,
  "",
  `回归集（卡发布）：${passLine(decided.filter((row) => row.blocks))}；能力集：${passLine(decided.filter((row) => !row.blocks))}`,
  "",
  ...(completion.requests
    ? [
        `要人完成率：${completion.requests} 次要人，给足 ${rate(completion.delivered, completion.requests)}，说明缺口 ${rate(completion.stated, completion.requests)}，没交付 ${rate(completion.notDelivered, completion.requests)}；出名单 p50 ${completion.p50 ?? "-"} 秒，p90 ${completion.p90 ?? "-"} 秒`,
        `重复和卡住：找到的人里重复找到 ${rate(overlap.foundAgain, overlap.finds)}，同一 LinkedIn 两行 ${overlap.sameLinkedIn} 次；玩完还在跑 ${overlap.leftRunning}/${overlap.plays} 次`,
        "",
      ]
    : []),
  `按机制：${[...new Set(JOURNEYS.flatMap((journey) => journey.mechanisms ?? []))]
    .map((mechanism) => [
      mechanism,
      decided.filter((row) => mechanismsOf(row.name).includes(mechanism)),
    ])
    .filter(([, subset]) => subset.length)
    .map(
      ([mechanism, subset]) =>
        `${mechanism} ${subset.filter((row) => row.status === "通过").length}/${subset.length}`,
    )
    .join(" · ")}`,
  "",
  "标准：每次 8 分以上、目标全部达成、没有假话/死路/重复/没回应等一票否决；旅程要每次都通过才算通过；环境出错算没跑成。",
  "",
  "| 旅程 | 结果 | 每次 | 不通过的原因 |",
  "|---|---|---|---|",
  ...journeyRows.map(
    (row) =>
      `| ${row.name}${row.blocks ? " (卡发布)" : ""} | ${row.status} | ${row.plays.map((play) => (play.infra ? "没跑成" : `${Math.round(play.score * 10)}/10`)).join(" · ")} | ${[...new Set(row.reasons)].join("; ").replace(/\|/g, "/").slice(0, 300)} |`,
  ),
  "",
  `# 模拟客户 ${passed}/${rows.length} 通过 · staging ${SHA.slice(0, 8)} · ${Math.round((Date.now() - started) / 60_000)} 分钟 · 模型 $${usage.usd.toFixed(2)}`,
  "",
  "| 旅程 | 分数 | 结果 | 一句话 |",
  "|---|---|---|---|",
  ...rows.map(
    (row) =>
      `| [${row.scenario}#${row.sample}](${encodeURIComponent(`${row.scenario}#${row.sample}`)}/report.md) | ${row.infra ? "-" : `${Math.round(row.score * 10)}/10`} | ${row.pass ? "通过" : row.infra ? "环境出错" : "不通过"} | ${(row.verdict ?? row.failures[0] ?? "").replace(/\|/g, "/")} |`,
  ),
].join("\n");
fs.writeFileSync(path.join(OUT, "summary.md"), `${summary}\n`);
log(
  `${passed}/${rows.length} journeys pass; ${requestCount()} API requests; scoreboard ${path.join(OUT, "summary.md")}`,
);
await closeBrowser();
if (args.includes("--learn")) await learn(rows);
compareBaseline(rows);
const productFailed = rows.some((row) => !row.pass && !row.infra);
process.exit(productFailed ? 1 : rows.some((row) => row.infra) ? 2 : 0);
