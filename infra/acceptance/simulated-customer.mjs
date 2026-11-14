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
//     node infra/acceptance/simulated-customer.mjs [--journeys a,b | --gate | --story "<test in plain words>"] [--paid] [--samples 1]
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
  send,
  settle,
  sleep,
  stopAll,
  transcripts,
  unfollowAll,
  watchFrom,
} from "./real-user-session.mjs";
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
/** An internal test inbox, or a plus-alias of one (admin1+p1a2b@… reaches admin1@…). */
const allowedRecipient = (address) =>
  RECIPIENTS.includes(address) || RECIPIENTS.includes(address.replace(/\+[^@]*@/, "@"));
/** What a journey needs that this run was not given. */
const missing = (journey) => [
  ...(journey.account === "mailbox" && !MAILBOXES.length
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
const named = story ? [story.name] : option("--journeys")?.split(",");
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
/** The first JSON object in a model's reply. */
function parse(text) {
  const start = text.indexOf("{");
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  throw new Error(`no JSON in the model's reply: ${text.slice(0, 200)}`);
}
const SIMULATOR = option("--model", "sonnet");
const JUDGE = option("--judge-model", "sonnet");

// --- What the recruiter sees and what is true ---------------------------------------------------
async function cardsOpen(rpc) {
  const open = [];
  for (const group of await activeGroupsOf(rpc))
    for (const message of await messagesOf(rpc, group.id))
      // A connect card stays pressable after its wait ends, as the app shows it.
      for (const block of [
        ...openCards(message),
        ...(message.blocks ?? []).filter(
          (block) => block.kind === "ask" && block.connection && block.status === "expired",
        ),
      ]) {
        if (!message.runId || block.input === "secret") continue;
        const text = [block.text, block.detail].filter(Boolean).join("\n");
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
        });
      }
  return open;
}
// The send records Kruit's claims are checked against: the campaign of every chat this journey
// wrote in or got replies in, and of every role whose campaign changed since the journey began
// (a send confirmed in the Kruit chat goes into a role's campaign, new or existing). A reused
// fixture account's other roles are left out.
async function campaignOf(rpc, chat) {
  const campaign = await rpc("recruiting/roleCampaign", { groupId: chat.id }).catch((error) => ({
    error: error.message,
  }));
  return {
    chat: chat.name,
    status: campaign.status ?? campaign.error,
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
    if (!record?.campaign) continue;
    const touched = (await messagesOf(rpc, group.id)).some(
      (message) => Date.parse(message.createdAt) >= since,
    );
    if (touched || JSON.stringify(before.get(group.id)) !== JSON.stringify(record))
      roles.push(record);
  }
  return roles;
}
const CAMPAIGN_CODES =
  "campaign status: 0 draft, 1 active (sending), 2 paused, 3 completed; person status: 1 active, 2 paused, 3 completed, -1 bounced, -2 unsubscribed; contactedAt null = not emailed yet";

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
              `[${m.at.slice(11, 19)}] ${m.role === "user" ? "Recruiter" : "Kruit"}${m.card ? " (card)" : ""}: ${m.text}`,
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

const SIMULATOR_RULES = `You play a recruiter using a recruiting assistant called Kruit, to test it the way a real customer would. Stay in character: write the way this person writes (language, length, tone). Decide your next move from what Kruit actually said and showed, not from what it should have said. If Kruit did not answer what you asked, did not do what you asked, or said something you doubt, push back the way this person would. Never explain that you are testing. Answer with one JSON object and nothing else:
{"action": "say" | "answer_card" | "approve_send" | "deny_send" | "done", "card": <index of the card for answer_card/approve_send/deny_send>, "text": "<your message, or your typed answer for answer_card>", "chat": "<optional: the chat to write in, by name; Kruit by default>", "goal": "<which goal this move serves>", "feeling": "<one line: how this person feels about Kruit's last reply>"}
Use "done" when every goal is met, or when you have pushed back twice on the same goal and got nowhere (say which goal in "goal").`;
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

async function simulate(journey, turns, view, cards, screen, tag, since) {
  // A reused account's pages still show earlier tests; only this session's messages count.
  const earlier =
    journey.account && screen
      ? `\n\nAnything on your screen from before ${new Date(since).toISOString().slice(11, 16)} UTC is an earlier session, not yours: your goals count only from the conversation above.`
      : "";
  const prompt = `Who you are:\n${journey.persona}\n${journey.variation ?? ""}\n\nWhat you want, in order:\n${journey.goals.map((goal, i) => `${i + 1}. ${goal}`).join("\n")}\n\n${journey.facts ? `What you know:\n${journey.facts(RECIPIENTS, tag)}\n\n` : ""}The conversation so far (times are UTC):\n${view || "(nothing yet: you open the conversation)"}\n\nOpen cards you can act on:\n${describeCards(cards)}${
    screen
      ? `\n\nYour screen (${screen.url}):\n${screen.text}\n\nButtons and links on it: ${screen.buttons.join(" | ") || "(none)"}`
      : ""
  }${earlier}\n\nYour moves so far: ${turns.length}. Your next move:`;
  return parse(await model(screen ? UI_RULES : SIMULATOR_RULES, prompt, SIMULATOR));
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

async function play(journey, label, owner, mailbox, out) {
  const user = client();
  let credentials = mailbox;
  if (journey.account === "batch") credentials = BATCH;
  if (journey.account) {
    await user.auth(...credentials);
    // Waiting for a reused account to go quiet watches only its working chats, not every role.
    watchFrom(user.rpc, Date.now());
    await stopAll(user.rpc);
    await settle(user.rpc, { quietMs: 15_000, limitMs: 2 * 60_000 });
  } else {
    const email = `kruit-sim-${journey.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
    const password = `Sim-${crypto.randomUUID()}`;
    await owner.rpc("deployment/createAccount", { email, name: "Simulated Recruiter", password });
    await user.auth(email, password);
    credentials = [email, password];
  }
  const { rpc } = user;
  const startedAt = Date.now();
  watchFrom(rpc, startedAt);
  const before = await campaigns(rpc);
  // A per-play tag, so a journey on a reused account names a role of its own.
  const tag = new Date(startedAt).toISOString().slice(11, 16).replace(":", "");
  // Plays of one journey started together still talk differently.
  const seed = [...label].reduce((sum, char) => sum + char.charCodeAt(0), Number(tag));
  journey = { ...journey, variation: variationFor(seed) };
  const kruit = (await groupsOf(rpc)).find((group) => group.id.startsWith("recruiting-global-"));
  if (!kruit) throw new Error("the account has no Kruit conversation");
  const ui = UI
    ? await openUi({
        origin: ORIGIN,
        email: credentials[0],
        password: credentials[1],
        chinese: journey.chinese,
        out,
        mobile: Boolean(journey.mobile),
      })
    : null;
  if (ui) await ui.openChat(kruit.id);
  const turns = [];
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
      const move = await simulate(journey, turns, render(chats), cards, screen, tag, startedAt);
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
      let waitForKruit = true;
      if (move.action === "say") {
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
        let answer =
          move.action === "deny_send"
            ? "deny"
            : move.action === "approve_send"
              ? "allow"
              : move.text;
        if (card.send) answer = guardSend(journey, card, answer, turn);
        // The email on a send card is what goes out: a fill-in left in it is a product failure.
        const fillIn = card.send && card.text.match(PLACEHOLDER);
        if (fillIn) turn.placeholder = fillIn[0];
        log(
          `${label}: recruiter ${answer === "allow" ? "approves" : answer === "deny" ? "denies" : `answers "${answer}" on`} "${card.text.slice(0, 60)}"${turn.guard ? ` (${turn.guard})` : ""}`,
        );
        const value = card.send ? answer : cardAnswer(card, answer);
        let pressed = false;
        if (ui) {
          await ui.openChat(card.groupId);
          const action = card.actions.find((item) => item.id === value);
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
      chats: await transcripts(rpc, startedAt, journey.chinese),
      records: await records(rpc, startedAt, before),
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
  }
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
- truthful: "yes", "no" or "unknown" — does every claim Kruit made about state (sent, queued, scheduled, paused, how many) match the records? A count or status that contradicts the records is "no". The records hold only the campaigns the test could read: when a claim is about a campaign or person missing from them, it is "unknown", never "no". Instantly sends one email per mailbox about every 10 minutes, so a second person contacted minutes after the first is normal. The first email of a newly confirmed or activated send takes 45–60 minutes to go out: within that time, "queued, not sent yet, out by about HH:MM" is truthful and a goal of getting the email sent counts as met if the records show it queued (the campaign active, the person added). A confirmed send fails only if the person is still not contacted after the time Kruit gave.
- issues: short labels for what went wrong, from: dead end, refused, lecture, repeat, wrong language, false claim, internal jargon, slow (first reply over 10 s), slow result (an ordinary ask not finished within 2 minutes, or a long job with no progress line for 5 minutes), wordy (the answer is not in the first two lines, or Kruit lectures or explains what it will do instead of doing it), stopped midway (a job Kruit started ended without its result), did not act, asked again, screen wrong, missing control, confusing page, slow page (a page over 5 s to show), blank or stuck (a page or chat that shows nothing, a spinner, or an old state), button did nothing, other.
- Check every move against the records and against what the page showed after Kruit's reply ("screen"): a claim the screen contradicts (a count, a status, "saved", "sent", a place to click that is not there) is truthful "no". Do not give the benefit of the doubt: an answer that is only "I'll check" or "on it" with nothing after it is "did not act".
A new role must have its key requirement confirmed before the first search (the product's fixed order): one short, concrete question with choices, asked right away, is the right move and counts as answered; a second question, a question about something already said, or a bare "opened the role" with no question is not.
When the customer used the browser, a move may also show what a page displayed ("screen") and UI problems the test hit ("ui"). Check the screen against the records and against what Kruit said: a page that shows a different count or status from the records, or says nothing where Kruit said to look, is "screen wrong"; a control the customer needed and could not find is "missing control". A "look" or "click" move has no Kruit reply: judge "answered" for it by whether the page gave the customer what they went there for.
Then judge the whole journey: which of the customer's goals were met, a score from 0 to 10 for how a real recruiter would rate the experience, a one-sentence verdict, and the top problems. Write the verdict and problems in Chinese, in short plain sentences. Answer with one JSON object and nothing else:
{"turns": [{"turn": n, "answered": true|false, "truthful": "yes"|"no"|"unknown", "issues": ["..."], "note": "<one line>"}], "goals": [{"goal": "...", "met": true|false, "why": "..."}], "score": 0-10, "verdict": "...", "problems": ["..."]}`;

async function judge(journey, result) {
  const moves = result.turns
    .map(
      (turn) =>
        `Move ${turn.turn} at ${turn.at.slice(11, 19)}: ${turn.move.action}${turn.move.text ? ` "${turn.move.text}"` : ""}${turn.guard ? ` (${turn.guard})` : ""}${turn.invalid ? ` (not done: ${turn.invalid})` : ""}${turn.move.page ? ` page ${turn.move.page}${turn.move.chat ? ` of ${turn.move.chat}` : ""}` : ""}\n  first reply after: ${turn.firstReplySeconds ?? "none"} s${turn.doneSeconds ? `, last reply after ${turn.doneSeconds} s` : ""}\n  records after: ${JSON.stringify(turn.records ?? [])}${turn.ui ? `\n  ui: ${turn.ui.join("; ")}` : ""}${turn.screen ? `\n  screen (${turn.screen.url}${turn.screen.loadSeconds ? `, took ${turn.screen.loadSeconds} s to show` : ""}):\n${turn.screen.text.replace(/^/gm, "    ")}` : ""}`,
    )
    .join("\n");
  const prompt = `Customer persona:\n${journey.persona}\n\nGoals:\n${journey.goals.map((goal, i) => `${i + 1}. ${goal}`).join("\n")}\n\nRecord codes: ${CAMPAIGN_CODES}\n\nConversation (UTC):\n${render(result.chats)}\n\nCustomer moves:\n${moves}`;
  return parse(await model(JUDGE_RULES, prompt, JUDGE));
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
async function runOne(journey, sample, owner, mailbox) {
  const label = `${journey.name}#${sample}`;
  const out = path.join(OUT, label);
  fs.mkdirSync(out, { recursive: true });
  const at = Date.now();
  let result;
  let verdict;
  let error;
  try {
    result = await play(journey, label, owner, mailbox, out);
    verdict = await judge(journey, result);
  } catch (caught) {
    error = caught;
    result ??= caught.partial;
  }
  // Rule checks the scripted conversations use apply here too.
  const checks = [
    ...visible(result?.chats ?? []).flatMap(({ group, messages }) =>
      conversationChecks(messages).map((failure) => `${group.name}: ${failure}`),
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
{"area": "sending" | "search" | "requirements" | "first message" | "ui", "problem": "<one sentence: what Kruit did wrong, in English>", "evidence": "<Kruit's exact words or the screen text that shows it, at most 200 characters>", "fix": "instructions" | "skill" | "code" | "test", "fixHint": "<one sentence: where the fix most likely belongs>", "newJourney": null | {"name": "<kebab-case, new>", "title": "<Chinese, short>", "area": "...", "source": "<the failed journey and date>", "persona": "AGENCY_RECRUITER" | "US_RECRUITER", "situation": "<one sentence the persona adds>", "chinese": true|false, "maxTurns": 4-8, "facts": "<what the recruiter knows, or empty>", "goals": ["..."]}}
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
const takeMailbox = () =>
  freeMailboxes.length ? Promise.resolve(freeMailboxes.pop()) : new Promise((r) => waiting.push(r));
const giveBack = (mailbox) =>
  waiting.length ? waiting.shift()(mailbox) : freeMailboxes.push(mailbox);
const rows = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, plays.length) }, async () => {
    while (next < plays.length) {
      const { journey, sample } = plays[next++];
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
const passLine = (subset) =>
  `pass@1 ${rate(
    ranRows.filter((row) => row.pass && subset.some((item) => item.name === row.scenario)).length,
    ranRows.filter((row) => subset.some((item) => item.name === row.scenario)).length,
  )} · pass^k ${rate(subset.filter((row) => row.status === "通过").length, subset.length)}`;
const summary = [
  `blocking: ${blocking.length ? `yes (${blocking.map((row) => row.name).join(", ")})` : "no"}`,
  "",
  `回归集（卡发布）：${passLine(decided.filter((row) => row.blocks))}；能力集：${passLine(decided.filter((row) => !row.blocks))}`,
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
