import { profilesIn } from "./request-completion.mjs";
import { SUPPLIER, TOOL_NAME } from "./ui-regressions-checks.mjs";

// Checks for what a real recruiter sees, taken from conversations that went wrong. Each check
// reads one conversation (oldest first) and returns failure strings; an empty list passes.
// Messages are { role, text, card, at }: `text` is what the recruiter reads, `card` is true when
// the message carries a question or approval card they can answer.

// A reply that keeps a saved record over what the recruiter just said, or refuses to search again.
const OVERRIDE =
  /按(?:照)?(?:当前|已保存的?|现有的?)(?:岗位|职位)?记录(?:执行|处理)?|不是硬性(?:条件|要求)|不另行(?:启动)?搜索|不(?:会|再)(?:另外|重新)?(?:启动|开始|发起)?(?:新的?)?搜索|\bnot an? (?:hard|strict|firm) requirement\b|\b(?:won['’]t|will not|not going to) (?:start|run|launch) (?:a |another )?(?:new )?search\b|\bper the saved (?:role|brief|record)\b/i;
// Sends the recruiter to someone else instead of taking the next step.
const CONTACT_ADMIN =
  /请?(?:联系|找)(?:你们?的?|贵司的?)?(?:管理员|客服|支持|技术支持|运营|我们的?(?:团队|客服))|管理员开通|请?联系\s*\S+@|\bcontact (?:your |the |our )?(?:admin(?:istrator)?|support|account manager|team)\b|\bask (?:your |an? |the )?admin(?:istrator)?\b/i;
// A request declined outright.
const DECLINE =
  /(?:我)?(?:无法|不能|没法)(?:为你|帮你|替你)?(?:处理|完成|执行|做到)(?:这个|此)?(?:请求|要求)?|\bI (?:can['’]t|cannot|am unable to) (?:help with|do) (?:that|this)\b/i;
// Blames a permission or a path the product did not build ("当前权限不支持创建一次性邮件"). The
// agents work with general tools, so a missing permission is never the answer to a recruiter.
const NO_PERMISSION =
  /(?:没有|无|缺少|不支持|需要|开通)[^。！？\n]{0,10}权限|权限(?:不足|不够|不支持|未开通|受限)|(?:先)?(?:打开|进入|切换到)[^。！？\n]{0,6}(?:岗位|职位|角色)(?:对话|页面|会话)?(?:后|再|才)|\b(?:don['’]t|do not|doesn['’]t) have (?:the )?(?:permission|access)\b|\bnot (?:permitted|authorized|allowed) to\b|\bno permission\b|\bopen (?:a|the) role (?:conversation|chat) (?:first|before)\b/i;
// The work is blocked: the reply must then leave a step the recruiter can take.
const BLOCKED =
  /无法|不能|没有可用|暂时不|没法|\b(?:can['’]t|cannot|unable|isn['’]t (?:ready|set up)|not (?:ready|set up|available)|no (?:sending|sender))\b/i;
// A line that only restates what the recruiter asked ("我正在梳理你问的发送人数") says nothing.
const RESTATES =
  /正在梳理|梳理你(?:问|提到|说)的|\bI(?:['’]m| am) looking into (?:your|the) (?:question|request)\b/i;
// An unasked lecture on how language is judged, in place of doing the work (11-13).
const NAME_LECTURE =
  /(?:不能|不会|无法|不应)[^。！？\n]{0,12}(?:靠|凭|仅凭|根据|按)?(?:姓名|名字)[^。！？\n]{0,10}(?:判断|推断|认定|作为)|(?:姓名|名字)不能(?:证明|作为|代表|判断)|\b(?:can['’]t|cannot|won['’]t|will not) (?:infer|judge|guess|assume)[^.]{0,40}\bfrom (?:a |their )?names?\b/i;
const CAVEAT =
  /(?:不能|无法)(?:保证|确保|核实|确认|验证)|\b(?:can['’]t|cannot) (?:guarantee|promise)\b/gi;
// What counts as a next step in words: something to connect or open, a draft, an offer, work
// that carries on (a send on its way, with when it will be out), or what to send so it can.
const NEXT_STEP =
  /连接|接入|绑定|设置|集成|点击|打开|草稿|我先|我会|要不要|是否|可以先|可以直接|告诉我|请(?:发|提供|告诉|补充|上传)|预计|最迟|\b(?:connect|set up|integrations?|open|click|draft|meanwhile|carry on|I(?:['’]ll| will)|would you like|want me to|shall I|(?:send|tell|give) me|out by|on its way|expected (?:by|within|in))\b/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SENDER =
  /(?:发件(?:地址|邮箱|人)|\b(?:sender|sending (?:address|mailbox)|from)\b)[^@\n]{0,12}?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi;
// The brief one agent writes for another, shown to the recruiter as if it were a reply.
export const AGENT_BRIEF = /^\s*(?:\*\*)?(?:Goal|Deliverable|Done when|Context)(?:\*\*)?\s*:/m;
// The header of a round of people the search returns.
export const ROUND = /(?:people|person) this round|本轮|这一轮/i;
// A fill-in left in an email or template ("Hi [Candidate Name],"). A merge field such as
// {{firstName}} is filled per person by the sender and is fine.
export const PLACEHOLDER =
  /\[(?:candidate|first|last|full)?\s*(?:name|company|role|title|interviewer|your name|候选人|姓名|名字|公司)[^\]\n]{0,20}\]/i;
const GATE_CODE = /\b(?:G[0-2]|S[1-5])\b(?!\.\d)/;

// Addresses and links say nothing about the language a message is written in. A Chinese
// sentence often carries English role titles and names ("这份 Senior Data Engineer 职位"), so
// Chinese characters are weighed against English words, not letters, and eight or more Chinese
// characters make a message Chinese however much English it quotes.
// An email body the recruiter dictates ("正文：Hi Alex, …") or quotes is the candidate's language.
const DICTATED =
  /(?:正文|内容|邮件内容|\bbody|\bmessage)\s*[:：][\s\S]*$|“[^”]*”|「[^」]*」|"[^"]*"/gi;
export const mostlyChinese = (raw) => {
  const own = raw.replace(EMAIL, "").replace(/https?:\/\/\S+|linkedin\.com\/[\w/-]+/g, "");
  const said = own.replace(DICTATED, " ");
  const text = /[\p{Script=Han}A-Za-z]/u.test(said) ? said : own;
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  // A Chinese writer mixes in English titles, skills and quoted emails; an English writer does not
  // write a Chinese sentence. So a clause's worth of Chinese makes the message Chinese.
  return han >= 8 || han > (text.match(/[A-Za-z]+/g)?.length ?? 0);
};
const quote = (text, match) =>
  `"…${text.slice(Math.max(0, match.index - 50), match.index + match[0].length + 50).replace(/\s+/g, " ")}…"`;
// People lists carry English names and titles whatever the reply language.
// An email draft is written for the candidate, in their language; only the words around it count.
// A draft starts at its header or, for a bare template, at its greeting ("Hi {{firstName}}," or
// "Hi Li Wei, I'm hiring…"): candidate emails stay English-first inside a Chinese reply.
const DRAFT = /^\s*(?:(?:\*\*)?(?:To|Subject|收件人|主题)(?:\*\*)?\s*[:：]|(?:Hi|Hello|Hey|Dear)\s[^\n,]{1,40},)/im;
const prose = (text) =>
  text
    .slice(0, DRAFT.test(text) ? text.search(DRAFT) : undefined)
    .split("\n")
    .filter(
      (line) =>
        !/linkedin\.com|^\s*\d+\.\s|^\s*>|^\s*(?:Not verified|所有人都还未核实|未核实)[:：]/i.test(
          line,
        ),
    )
    .join("\n");
// Addresses are kept whole; their dots are not sentence ends.
const sentences = (text) =>
  text
    .replace(EMAIL, "<address>")
    .split(/(?<=[。！？!?.])\s*|\n+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 12);
const bigrams = (text) => {
  const flat = text.toLowerCase().replace(/[\s\p{P}]/gu, "");
  const set = new Set();
  for (let index = 0; index < flat.length - 1; index += 1) set.add(flat.slice(index, index + 2));
  return set;
};
// Shared character pairs over the longer sentence: two sentences that merely share a role title
// or quote the same preference the recruiter gave are not the same sentence.
export const similar = (a, b) => {
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / Math.max(left.size, right.size);
};

// Every recruiter message gets a visible reply within this long, even while work runs.
export const FIRST_REPLY_MS = 10_000;
/** The questions a message asks the recruiter; quoted text and email drafts are not its own. */
export const questionsIn = (text) =>
  text
    .slice(0, DRAFT.test(text) ? text.search(DRAFT) : undefined)
    .split("\n")
    .filter((line) => !/^\s*>|linkedin\.com/i.test(line))
    .join("\n")
    .replace(EMAIL, "<address>")
    // A quoted "？" repeats what the recruiter typed; it is not a question.
    .replace(/“[^”\n]*”|"[^"\n]*"/g, "“”")
    .split(/(?<=[。！？!?])\s*|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && /[?？]$/.test(part));

const ROUND_SIZE = /^(?:(\d+) (?:people|person) this round:|本轮 (\d+) 人：)/m;
const SHOWN_SO_FAR =
  /累计展示 (\d+) 人(?:，你淘汰了 (\d+) 人，计入 (\d+) 人)?|(\d+) shown so far(?:, (\d+) turned down by you, (\d+) counted)?/;
const OWN_COUNT = /(?:计入|计数为?)\s*\**\s*(\d+)|(\d+)\**\s*counted/;

/**
 * The number Kruit says is the number of people on screen (the recruiter's rule, 11-26): a round's
 * heading equals the people listed under it, and the running count is never below the people this
 * chat has listed (it said "20 shown" under rounds that listed 21 to 30).
 */
export function countChecks(messages) {
  const failures = [];
  const listed = new Set();
  let latest;
  for (const message of messages) {
    if (message.role === "user") continue;
    const text = message.text ?? "";
    const round = ROUND_SIZE.exec(text);
    if (round) {
      const said = Number(round[1] ?? round[2]);
      const rows = text.match(/^\d+\. /gm)?.length ?? 0;
      // A list in the agent's own prose has no numbered rows to count.
      if (rows && said !== rows) failures.push(`count: round says ${said} people and lists ${rows}`);
      for (const profile of profilesIn(text)) listed.add(profile);
    }
    const total = SHOWN_SO_FAR.exec(text);
    if (!total) {
      // A count in Kruit's own words is the one its newest list gave ("计入 8 人" came a few
      // seconds after the list that said 10, from a note it kept).
      const own = OWN_COUNT.exec(text);
      const said = own && Number(own[1] ?? own[2]);
      if (own && latest !== undefined && said !== latest)
        failures.push(`count: says ${said} counted, its newest list said ${latest}`);
      continue;
    }
    const [shown, turnedDown, counted] = (total[1] ? total.slice(1, 4) : total.slice(4, 7)).map(
      (value) => (value === undefined ? undefined : Number(value)),
    );
    if (shown < listed.size)
      failures.push(`count: says ${shown} shown, this chat has listed ${listed.size}`);
    latest = counted ?? shown;
    if (counted !== undefined && counted !== shown - turnedDown)
      failures.push(`count: ${shown} shown less ${turnedDown} turned down is not ${counted}`);
  }
  return failures;
}

/** Every check that applies to any conversation. */
// What the recruiter reads in a bot message. A connect card's title is app chrome the web
// translates ("连接 Gmail"); its stored text is the English fallback, so the agent's reason counts.
// The chat shows agent-to-agent messages only as a "Messaged …" marker, never their brief.
const HIDDEN = new Set(["handoff", "bot_message_sent", "bot_message_received"]);
export const botText = (message) =>
  (message.blocks ?? [])
    .filter((block) => !HIDDEN.has(block.kind))
    .map((block) => block.connection?.reason ?? block.text ?? block.question ?? "")
    .filter(Boolean)
    .join("\n");

// A recruiter asking for a recap or a one-line summary of what changed.
const RECAP = /一句话|总结|概括|说下改了|改了(什么|啥)|summari[sz]e|\brecap\b|what changed|in one line|tl;?dr/i;

// The product's rule (textLanguage, recruiterWords): the newest message with a clear language
// counts. A word or two ("allow", "OK") says nothing, and the brief confirmation it posts as the
// recruiter's is in English whatever they speak.
const BRIEF_CONFIRMATION = /^Confirm recruiting brief for .+ \(requirements version \d+\)\.$/;
const clearLanguage = (text) =>
  !BRIEF_CONFIRMATION.test(text.trim()) &&
  (/\p{Script=Han}/u.test(text) || (text.match(/[A-Za-z]{2,}/g) ?? []).length >= 3);
/**
 * `recruiter` is every message the recruiter wrote in any chat (with `at`): the product answers in
 * the language of their newest message wherever they wrote it, so a role chat's reply follows an
 * aside typed in Kruit's chat. Without it, the chat's own last message counts. The product's copy
 * of an earlier message (the JD it posts to open a role chat) keeps the original's time.
 */
export function conversationChecks(messages, { recruiter } = {}) {
  const failures = [];
  recruiter = recruiter
    ?.toSorted((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
    .filter((item, index, all) => !all.slice(0, index).some((earlier) => earlier.text === item.text));
  const typed = messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.text.match(EMAIL) ?? [])
    .map((address) => address.toLowerCase());
  failures.push(...countChecks(messages));
  const said = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") continue;
    const text = message.text;
    if (!text.trim()) continue;
    const asked = messages.slice(0, index).findLast((item) => item.role === "user");
    const newest =
      (recruiter && message.at
        ? recruiter
            .filter((item) => item.at <= message.at && clearLanguage(item.text))
            .sort((a, b) => a.at.localeCompare(b.at))
            .at(-1)
        : undefined) ??
      messages
        .slice(0, index)
        .findLast((item) => item.role === "user" && clearLanguage(item.text)) ??
      asked;
    // The reply follows the language of the recruiter's newest message; a lone "？" has none.
    if (newest && /[\p{Script=Han}A-Za-z]/u.test(newest.text)) {
      const chinese = mostlyChinese(newest.text);
      const words = prose(text);
      // A reply that only repeats words the recruiter typed (a name, an address) has no language.
      const typed = new Set(
        messages
          .slice(0, index)
          .filter((item) => item.role === "user")
          .flatMap((item) => item.text.toLowerCase().match(/[a-z]+/g) ?? []),
      );
      const echo =
        !/\p{Script=Han}/u.test(words) &&
        (words.toLowerCase().match(/[a-z]+/g) ?? []).every((word) => typed.has(word));
      // Its row's time is when it was created; the words may be written until the chat's next
      // message, so a recruiter message in between can set the language too.
      const until = messages[index + 1]?.at;
      const between = (recruiter ?? []).filter(
        (item) =>
          message.at &&
          item.at > message.at &&
          (!until || item.at <= until) &&
          clearLanguage(item.text),
      );
      const fits = [newest, ...between].some(
        (item) => mostlyChinese(item.text) === mostlyChinese(words),
      );
      if (words.trim() && !echo && !fits)
        failures.push(
          `language: recruiter wrote ${chinese ? "Chinese" : "English"}, reply is not: "${words.slice(0, 80)}"`,
        );
    }
    for (const [name, pattern, where] of [
      ["overrides what the recruiter said", OVERRIDE],
      ["sends the recruiter to someone else", CONTACT_ADMIN],
      ["declines the request", DECLINE],
      ["blames a permission or a missing path", NO_PERMISSION],
      ["supplier name", SUPPLIER],
      ["internal tool name", TOOL_NAME],
      // People's evidence quotes their profiles, where "S3" is the AWS service.
      ["internal gate code", GATE_CODE, prose(text)],
      ["internal agent brief", AGENT_BRIEF],
      ["restates the question", RESTATES],
      ["lectures on judging language by name", NAME_LECTURE],
      ["unfilled placeholder", PLACEHOLDER],
    ]) {
      const match = (where ?? text).match(pattern);
      if (match) failures.push(`${name}: ${quote(where ?? text, match)}`);
    }
    // The account's own sending mailbox is the product's to show ("发件地址是 liu@…").
    const senders = [...text.matchAll(SENDER)].map((match) => match[1].toLowerCase());
    for (const address of text.match(EMAIL) ?? [])
      if (!typed.includes(address.toLowerCase()) && !senders.includes(address.toLowerCase()))
        failures.push(`shows an address the recruiter never gave: ${address}`);
    // A new round of people starts over: its header and the next-step card come with every round.
    if (ROUND.test(text)) said.length = 0;
    // Restating what the recruiter said ("你之前说，…署名 Jules Hou") is an answer, not a repeat.
    const theirs = messages
      .slice(0, index)
      .filter((item) => item.role === "user")
      .map((item) => bigrams(item.text));
    const quotesThem = (sentence) => {
      const own = bigrams(sentence);
      return theirs.some((words) => {
        let shared = 0;
        for (const gram of own) if (words.has(gram)) shared += 1;
        return own.size > 0 && shared / own.size >= 0.6;
      });
    };
    // The same sentence again, in this reply or an earlier one.
    // A list's items ("- 测试固定 · 发信测试2", "- …3") share their wording by design.
    const listless = prose(text)
      .split("\n")
      .filter((line) => !/^\s*[-*•]\s/.test(line))
      .join("\n");
    // The recap the recruiter asked for ("一句话说下改了什么") restates by design: only the first
    // reply after that ask; a later or unasked repeat of the same sentence still fails.
    const recap =
      asked &&
      RECAP.test(asked.text) &&
      !messages.slice(messages.indexOf(asked) + 1, index).some((item) => item.text.trim());
    for (const sentence of sentences(listless)) {
      const again =
        !recap &&
        !quotesThem(sentence) &&
        said.find((earlier) => similar(earlier, sentence) >= 0.8);
      if (again) failures.push(`repeats itself: "${sentence.slice(0, 80)}"`);
      said.push(sentence);
    }
  }
  // Per recruiter message: a quick first reply, and one question at a time until they answer.
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user") continue;
    const next = messages.findIndex((item, at) => at > index && item.role === "user");
    const turn = messages.slice(index + 1, next === -1 ? undefined : next);
    const first = turn.find((item) => item.text.trim());
    const waited = first && message.at ? Date.parse(first.at) - Date.parse(message.at) : 0;
    if (waited > FIRST_REPLY_MS)
      failures.push(
        `slow first reply: ${Math.round(waited / 1000)} s after "${message.text.slice(0, 40)}"`,
      );
    const questions = turn.flatMap((item) => questionsIn(item.text));
    if (questions.length > 1)
      failures.push(
        `asks ${questions.length} questions at once: ${questions.map((q) => `"${q.slice(0, 60)}"`).join(" ")}`,
      );
  }
  const lastAt = messages.findLastIndex(
    (message) => message.role !== "user" && message.text.trim(),
  );
  const last = messages[lastAt];
  const lastAsk = messages.findLastIndex((message) => message.role === "user");
  if (!last) failures.push("no reply");
  // An open card or a running search never holds the recruiter's latest message unanswered.
  else if (lastAt < lastAsk) failures.push(`no reply to "${messages[lastAsk].text.slice(0, 40)}"`);
  else if (deadEnd(last))
    failures.push(`dead end: "${last.text.slice(-160).replace(/\s+/g, " ")}"`);
  return [...new Set(failures)];
}

/**
 * The conversation ends on a blocker with nothing the recruiter can do: no card, no question,
 * nothing to connect or open, no work that carries on.
 */
export function deadEnd(message) {
  if (message.card) return false;
  const tail = sentences(message.text).slice(-3).join(" ");
  // "不能保证…最新" or "无法核实时会标明" qualifies an answer; it is not a blocker.
  if (!BLOCKED.test(tail.replace(CAVEAT, ""))) return false;
  if (/[?？]/.test(tail)) return false;
  return !NEXT_STEP.test(tail);
}

/** A hard requirement the recruiter gave reached the saved role. */
export function requirementSaved(roleText, pattern) {
  const required = new RegExp(
    `(?:必须|硬性|必需|required|must)[^\\n]{0,60}(?:${pattern.source})|(?:${pattern.source})[^\\n]{0,60}(?:必须|硬性|必需|required|must)`,
    "i",
  );
  const optional = new RegExp(
    `(?:${pattern.source})[^\\n]{0,40}(?:不是硬性|不强求|加分|优先|nice to have|not required|preferred|a plus)`,
    "i",
  );
  if (optional.test(roleText)) return ["the saved role still treats the requirement as optional"];
  return required.test(roleText) ? [] : ["the requirement is not saved as required in the role"];
}

/**
 * Who a send card emails: the "- name <address>" lines of its "To (n):" list, or the address after
 * the title's arrow. Never the sending mailbox ("From:") or an address inside an email body. A
 * list cut short ("- and 3 more") cannot be checked, so it reads as no recipients: deny.
 */
export function recipientsOf(title, detail) {
  const lines = detail.split("\n");
  const start = lines.findIndex((line) => /^(?:To|收件人)(?:\s*\(\d+\+?\))?\s*[:：]/i.test(line));
  let found = [];
  if (start >= 0) {
    // A reply card names its one recipient on the To line itself.
    found.push(...(lines[start].match(EMAIL) ?? []));
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line) && !line.startsWith("- ")) break;
      if (/^- and \d+ more/.test(line)) return [];
      if (line.startsWith("- ")) found.push(...(line.match(EMAIL) ?? []));
    }
  } else found = (title.split("→")[1] ?? "").match(EMAIL) ?? [];
  return [...new Set(found.map((address) => address.toLowerCase()))];
}

/** Turns the recruiter's typed answer into what the card takes: a button's id when the answer is
 * one of its labels, a filled form for a form card, otherwise the typed text as a custom answer. */
export function cardAnswer(card, text) {
  const typed = String(text ?? "").trim();
  if (card.schema) {
    const content = {};
    for (const [name, field] of Object.entries(card.schema.properties ?? {})) {
      const choices = field.enum ?? field.oneOf?.map((option) => option.const) ?? null;
      if (choices)
        content[name] = choices.find((choice) => typed.includes(String(choice))) ?? choices[0];
      else if (field.type === "boolean") content[name] = /^(是|对|要|yes|y|true)/i.test(typed);
      else if (field.type === "number" || field.type === "integer")
        content[name] = Number(typed.match(/\d+/)?.[0] ?? field.minimum ?? 0);
      else if (field.type === "array") {
        const items = field.items?.enum ?? field.items?.anyOf?.map((option) => option.const) ?? [];
        const picked = items.filter((item) => typed.includes(String(item)));
        content[name] = picked.length ? picked : items.slice(0, 1);
      } else content[name] = typed || "按 JD 来";
    }
    return { action: "accept", content };
  }
  const button = card.actions.find((action) => action.label === typed || action.id === typed);
  return button ? button.id : typed;
}
