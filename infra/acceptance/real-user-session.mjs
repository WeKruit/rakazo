// The calls a recruiter's browser makes, shared by the real-user conversations (real-user.mjs)
// and the simulated customer (simulated-customer.mjs): sign in, send, answer cards, wait for
// replies, read what the recruiter saw, and stop open work at the end.
import fs from "node:fs";
import { AGENT_BRIEF, botText } from "./real-user-checks.mjs";

const BASE = (process.env.RAKAZO_URL ?? "").replace(/\/$/, "");
const ORIGIN = (process.env.RAKAZO_ORIGIN ?? BASE).replace(/\/$/, "");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The test environment, not the product, failed: a server error, an overload or a dropped
// connection. Reported apart from product failures, so it never reads as a bad reply.
export class InfraError extends Error {}
export const INFRA = [429, 500, 502, 503, 504];

export function client() {
  let cookie = "";
  const auth = async (email, password) => {
    // Sign-ins share one limit with every other test on the environment: wait as long as the
    // server asks, for up to about 15 minutes.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await fetch(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email, password }),
      }).catch(() => null);
      if (!response || INFRA.includes(response.status)) {
        const after = Number(response?.headers.get("retry-after"));
        await sleep(Math.min(after > 0 ? after * 1000 : 60_000, 180_000));
        continue;
      }
      if (!response.ok) throw new Error(`sign-in ${response.status}`);
      cookie = (response.headers.getSetCookie?.() ?? [])
        .map((line) => line.split(";")[0])
        .join("; ");
      return;
    }
    throw new InfraError("sign-in still refused after about 15 minutes");
  };
  const rpc = async (route, json) => {
    const read = /\/(get|messages|list|page|roleSetup|backgroundTasks)$/.test(route);
    let response;
    // Reads ride out a restart of the test environment (about two minutes); a write is sent once.
    for (let attempt = 0; ; attempt += 1) {
      response = await fetch(`${BASE}/rpc/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie },
        body: JSON.stringify({ json }),
      }).catch(() => null);
      // A read can also lose a short-lived conflict (409) while the account is busy; try it again.
      const retry = response && (INFRA.includes(response.status) || response.status === 409);
      if (!read || attempt >= 8 || (response && !retry)) break;
      // A rate limit lasts longer than a restart: honour Retry-After, else wait a minute.
      const after = Number(response?.headers.get("retry-after"));
      await sleep(
        response?.status === 429 ? (after > 0 ? Math.min(after, 300) * 1000 : 60_000) : 15_000,
      );
    }
    if (!response) throw new InfraError(`${route}: no response`);
    const body = await response.json().catch(() => ({}));
    if (INFRA.includes(response.status)) throw new InfraError(`${route} ${response.status}`);
    if (!response.ok) {
      const detail =
        body?.json?.message ?? body?.message ?? body?.error?.message ?? JSON.stringify(body);
      throw new Error(
        `${route} ${response.status}${detail ? `: ${String(detail).slice(0, 160)}` : ""}`,
      );
    }
    return body.json;
  };
  return { auth, rpc };
}

export const openCards = (message) =>
  (message.blocks ?? []).filter(
    (block) => block.kind === "ask" && (!block.status || block.status === "pending"),
  );

export async function groupsOf(rpc) {
  const groups = [];
  for (let offset = 0; offset !== null && offset !== undefined; ) {
    const page = await rpc("groups/page", { offset, archived: false });
    groups.push(...page.items);
    offset = page.nextOffset;
  }
  return groups;
}
export const messagesOf = async (rpc, groupId) =>
  (await rpc("threads/messages", { groupId, includePeerRuns: true }))?.messages ?? [];
export const working = async (rpc, groupId) =>
  ((await rpc("threads/get", { groupId }))?.activeRuns ?? []).some(
    (run) => run.status !== "waiting_input",
  );

/** Every chat of the account, until all are idle and quiet, or a card is open when wanted. */
export async function settle(
  rpc,
  { quietMs = 30_000, limitMs = 6 * 60_000, untilCard = false } = {},
) {
  const startedAt = Date.now();
  let seen = -1;
  let changed = Date.now();
  while (Date.now() - startedAt < limitMs) {
    await sleep(4_000);
    const groups = await groupsOf(rpc);
    const all = (
      await Promise.all(
        groups.map(async (group) =>
          (await messagesOf(rpc, group.id)).map((message) => ({ ...message, groupId: group.id })),
        ),
      )
    ).flat();
    if (untilCard) {
      const card = all.findLast(
        (message) =>
          message.role !== "user" &&
          message.runId &&
          openCards(message).some((block) => !block.approvalEffectId && !block.requestedSchema),
      );
      if (card) return card;
      continue;
    }
    if (all.length !== seen) {
      seen = all.length;
      changed = Date.now();
    }
    if (Date.now() - changed < quietMs) continue;
    const busy = await Promise.all(groups.map((group) => working(rpc, group.id)));
    if (!busy.some(Boolean)) return null;
  }
  return null;
}

/** What the recruiter saw in each chat, oldest first; the server records typed card answers. */
/** Only this play's messages: a reused fixture account keeps earlier runs' history. */
// A user-role row an agent wrote is a handoff, not the recruiter: it carries a bot id, or it is
// the brief one agent writes for another ("Goal: … Done when: …").
export const handoff = (message) =>
  message.role === "user" &&
  (Boolean(message.botId) ||
    (message.blocks ?? []).some((block) => block.kind === "bot_message_received") ||
    AGENT_BRIEF.test(botText(message)));
// Card titles the product writes in English are translated by the web app into the reader's UI
// language ("Confirm sending email" → "确认发送邮件"). A recruiter who writes Chinese is read as
// one with a Chinese UI, so the language check sees the title they see.
const ZH_UI = (() => {
  const file = new URL("../../apps/web/src/locales/zh-CN/messages.po", import.meta.url);
  const titles = new Map();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [, id, str] of text.matchAll(/^msgid "(.+)"\nmsgstr "(.+)"$/gm)) titles.set(id, str);
  return titles;
})();
const asSeen = (text, chinese) =>
  chinese
    ? text.replace(/^([^\n→]+?)(?= → |$)/gm, (title) => ZH_UI.get(title.trim()) ?? title)
    : text;
export async function transcripts(rpc, since, chinese = false) {
  const chats = [];
  for (const group of await groupsOf(rpc)) {
    const messages = (await messagesOf(rpc, group.id))
      .filter(
        (message) =>
          !message.internal && !handoff(message) && Date.parse(message.createdAt) >= since,
      )
      .map((message) => ({
        // A user-role row written by an agent is a handoff, not the recruiter.
        role: message.role === "user" ? "user" : "bot",
        text: (message.blocks ?? []).some((block) => block.approvalEffectId)
          ? asSeen(botText(message), chinese)
          : botText(message),
        card: (message.blocks ?? []).some((block) => block.kind === "ask"),
        sendCard: (message.blocks ?? []).some((block) => block.approvalEffectId),
        at: message.createdAt,
      }));
    chats.push({ group, messages });
  }
  return chats;
}

export async function stopAll(rpc) {
  for (const group of await groupsOf(rpc)) {
    for (const message of await messagesOf(rpc, group.id))
      for (const block of openCards(message)) {
        if (!message.runId || block.input === "secret" || block.connection) continue;
        const answer = block.approvalEffectId
          ? "deny"
          : block.requestedSchema
            ? { action: "decline" }
            : "测试结束，不用继续。";
        await rpc("threads/answer", {
          groupId: group.id,
          runId: message.runId,
          messageId: message.id,
          answer,
        }).catch(() => {});
      }
    await rpc("threads/stop", { groupId: group.id, scope: "all" }).catch(() => {});
  }
}

// Role chats: every chat but Kruit that has messages (the crew's empty "Recruiting" chat is not a role).
export async function roleChats(rpc) {
  const chats = [];
  for (const group of await groupsOf(rpc)) {
    if (group.id.startsWith("recruiting-global-")) continue;
    const messages = await messagesOf(rpc, group.id);
    if (messages.length) chats.push({ ...group, threadId: messages[0].threadId });
  }
  return chats;
}
// A one-page PDF of plain ASCII lines, the way a recruiter attaches a JD exported from Word.
export function pdf(lines) {
  const literal = (line) => line.replace(/[\\()]/g, (char) => `\\${char}`);
  const stream = `BT /F1 11 Tf 50 760 Td 14 TL ${lines.map((line) => `(${literal(line)}) '`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

export async function send(rpc, groupId, text, file) {
  const busy = await working(rpc, groupId);
  // Same calls the web composer makes for an attachment: upload it, then send it with the text.
  const artifactIds = file
    ? [
        (
          await rpc("artifacts/create", {
            groupId,
            name: file.name,
            mimeType: "application/pdf",
            contentBase64: pdf(file.lines).toString("base64"),
          })
        ).id,
      ]
    : undefined;
  await rpc("threads/send", {
    groupId,
    addressing: "coordinator",
    text,
    ...(artifactIds ? { artifactIds } : {}),
    ...(busy ? { interrupt: true } : {}),
  });
}

/** Waits for a bot message after `since` that matches `pattern`, and returns it. */
export async function waitForText(rpc, pattern, since, limitMs) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    await sleep(10_000);
    for (const group of await groupsOf(rpc))
      for (const message of await messagesOf(rpc, group.id))
        if (
          message.role !== "user" &&
          Date.parse(message.createdAt) > since &&
          pattern.test(botText(message))
        )
          return botText(message);
  }
  return null;
}
export const PROFILE = /linkedin\.com\/in\/[\w%-]+/gi;
