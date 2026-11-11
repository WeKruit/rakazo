import assert from "node:assert/strict";
import test from "node:test";
import {
  botText,
  conversationChecks,
  deadEnd,
  questionsIn,
  requirementSaved,
} from "./real-user-checks.mjs";

const user = (text) => ({ role: "user", text, card: false });
const bot = (text, card = false) => ({ role: "bot", text, card });

test("a reply that keeps the saved record over a typed must-have fails", () => {
  const failures = conversationChecks([
    user("你能听的懂话吗？中文是必须！"),
    bot(
      "我按当前岗位记录执行：中文口语不是硬性条件，姓名只作搜索偏好；先从已保存人选中选出10位并登记本轮，不另行启动搜索。",
    ),
  ]);
  assert(failures.some((failure) => failure.startsWith("overrides what the recruiter said")));
});

test("the no-mailbox reply from production fails on the address, the admin and the repeat", () => {
  const failures = conversationChecks([
    user("其他几位可以根据实际情况发送邮件吗"),
    bot(
      "目前无法从此账号发送候选人邮件：账号还没有可用的发件地址，且无法由我直接开通。请联系 admin@company.test 开通邮件发送后，我就可以继续处理 Sam 和 Nicholas。",
    ),
    bot(
      "目前没有发送任何邮件：这个账号尚无可用发件地址，因此 Sam 和 Nicholas 的邮件暂时无法发出。请管理员开通邮件发送后再继续。",
    ),
  ]);
  assert(failures.some((failure) => failure.includes("never gave: admin@company.test")));
  assert(failures.some((failure) => failure.startsWith("sends the recruiter to someone else")));
  assert(failures.some((failure) => failure.startsWith("dead end")));
});

test("a blocker stated once with a step the recruiter can take passes", () => {
  assert.deepEqual(
    conversationChecks([
      user("帮我给 alex@example.com 发封邮件"),
      bot(
        "这个账号还没有连接发件邮箱。去「集成」里连接你的 Gmail 后，我会逐封给你确认再发。草稿我先写好了。",
      ),
    ]),
    [],
  );
  assert.equal(deadEnd(bot("Sending isn't ready for this account yet.", true)), false);
});

test("the address the recruiter typed may be repeated back", () => {
  assert.deepEqual(
    conversationChecks([
      user("Email alex@example.com about the role"),
      bot("Here is a draft to alex@example.com. Want me to send it once your Gmail is connected?"),
    ]),
    [],
  );
});

test("the reply follows the recruiter's language, people lists aside", () => {
  assert(
    conversationChecks([user("找人"), bot("Sure, which role should I search for?")]).some(
      (failure) => failure.startsWith("language"),
    ),
  );
  assert.deepEqual(
    conversationChecks([
      user("这轮怎么样？"),
      bot(
        "这一轮找到 2 位，都在湾区，你看看要不要继续？\n1. Harrison Lam · Senior Technical Product Manager · linkedin.com/in/x",
      ),
    ]),
    [],
  );
});

test("the same sentence in consecutive replies fails", () => {
  const failures = conversationChecks([
    user("send it"),
    bot("Sending isn't ready for this account yet, and I've let the team know about it."),
    user("just send it"),
    bot(
      "Sending isn't ready for this account yet, and I've let the team know about it. Drafts are ready.",
    ),
  ]);
  assert(failures.some((failure) => failure.startsWith("repeats itself")));
});

test("a must-have reaches the saved role", () => {
  const chinese = /中文|mandarin|chinese/;
  assert.deepEqual(requirementSaved('{"mustHave":["Mandarin: required"]}', chinese), []);
  assert.deepEqual(requirementSaved("必须会说中文", chinese), []);
  assert.equal(requirementSaved("Mandarin a plus", chinese).length, 1);
  assert.equal(requirementSaved("中文口语不是硬性条件", chinese).length, 1);
  assert.equal(requirementSaved("Bay Area, 5 years", chinese).length, 1);
});

test("per-person evidence lines and addresses are not repeats", () => {
  assert.deepEqual(
    conversationChecks([
      user("这轮怎么样？给 a.b.test@example.com 也看看"),
      bot(
        "这一轮找到两位，你看看要不要继续？\nNot verified: 产品管理年限及晶圆厂合作细节\nNot verified: 产品管理年限及晶圆厂合作细节\n收件人是 a.b.test@example.com，草稿我先写好了。",
      ),
    ]),
    [],
  );
});

test("an English email draft inside a Chinese reply is not a language switch", () => {
  assert.deepEqual(
    conversationChecks([
      user("帮我给 alex@example.com 写封邮件"),
      bot(
        "草稿我先写好了，连接邮箱后我就能发：\n\n**To:** alex@example.com\n**Subject:** Quick chat about a backend role\n\nHi Alex,\n\nWould you be available sometime next week for a brief conversation about a backend role?\n\nBest,\nRecruiting Team",
      ),
    ]),
    [],
  );
});

test("an agent's brief shown to the recruiter fails", () => {
  assert(
    conversationChecks([
      user("帮我给 alex@example.com 发封邮件"),
      bot("Goal: Draft and send an email to Alex Chen asking whether he is available next week."),
    ]).some((failure) => failure.startsWith("internal agent brief")),
  );
});

test("an address inside Chinese text does not hide the Chinese around it", () => {
  assert(
    conversationChecks([
      user("帮我约 Alex Chen（alex@example.com）下周二下午两点面试，30分钟"),
      bot("Which time zone should 2pm be in?"),
    ]).some((failure) => failure.startsWith("language: recruiter wrote Chinese")),
  );
});

test("a connect card is read by its reason, not the untranslated title", () => {
  const card = {
    blocks: [
      {
        kind: "ask",
        text: "Connect Gmail",
        status: "pending",
        connection: { name: "Gmail", reason: "连接你的邮箱后，我就能把这封邮件从你的地址发出。" },
      },
    ],
  };
  const text = botText(card);
  assert.equal(text, "连接你的邮箱后，我就能把这封邮件从你的地址发出。");
  assert.deepEqual(conversationChecks([user("那你就直接发啊"), bot(text, true)]), []);
  const english = {
    blocks: [
      { ...card.blocks[0], connection: { name: "Gmail", reason: "Connect Gmail to send." } },
    ],
  };
  assert(
    conversationChecks([user("那你就直接发啊"), bot(botText(english), true)]).some((f) =>
      f.startsWith("language"),
    ),
  );
});

const at = (seconds) => new Date(Date.UTC(2026, 10, 11, 0, 0, seconds)).toISOString();

test("a message answered only after the long step ends fails as a slow first reply", () => {
  const failures = conversationChecks([
    { ...user("对了，远程也可以，不一定要在西雅图"), at: at(0) },
    { ...bot("好的，远程也可以，我按这个调整搜索。"), at: at(16) },
  ]);
  assert(failures.some((failure) => failure.startsWith("slow first reply: 16 s")));
});

test("a quick line within seconds passes the first-reply check", () => {
  const failures = conversationChecks([
    { ...user("对了，远程也可以，不一定要在西雅图"), at: at(0) },
    { ...bot("好的，我把远程也加进来。"), at: at(3) },
    { ...bot("已按远程调整，继续找人。"), at: at(40) },
  ]);
  assert(!failures.some((failure) => failure.startsWith("slow first reply")));
});

test("two questions in one turn fail, across the text and the card", () => {
  const failures = conversationChecks([
    { ...user("find me engineers"), at: at(0) },
    { ...bot("I don’t have a role yet. What role should I find people for?"), at: at(2) },
    { ...bot("Which city should they be in?", true), at: at(5) },
  ]);
  assert(failures.some((failure) => failure.startsWith("asks 2 questions at once")));
});

test("one question, a draft with its own question and a quoted line count as one", () => {
  assert.deepEqual(
    questionsIn(
      "> 你能听的懂话吗？\n草稿写好了。要现在发吗？\nSubject: Quick chat?\nHi Alex, are you open to a call?",
    ),
    ["要现在发吗？"],
  );
});
test("a Chinese question with an English role title is still Chinese", () => {
  const failures = conversationChecks([
    user("继续吧"),
    bot("这份 Senior Data Engineer 职位主要面向哪个地点和工作方式？"),
  ]);
  assert.deepEqual(failures, []);
});

test("a blocker that says what to send next is not a dead end", () => {
  assert.equal(
    deadEnd(
      bot(
        "我现在没法直接发出：这封邮件是首次联系，缺少可关联的岗位信息。请发我该岗位的职位描述或链接；有了岗位信息，我就能继续准备邮件。",
      ),
    ),
    false,
  );
});

test("a second round of people may repeat the round header and next-step card, and S3 in evidence is AWS", () => {
  const round = (name) =>
    bot(
      `10 people this round:\n1. **[${name}](https://www.linkedin.com/in/${name.toLowerCase()})** · Data Engineer\n   > Built Glue ETL pipelines on S3 Parquet tables.`,
    );
  const card = bot(
    "What's next? I'd find 150 similar people if these ten look right; otherwise tell me who is off and I'll run another round.",
    true,
  );
  const failures = conversationChecks([
    user("Go with the JD as written and start the search."),
    round("Ann"),
    card,
    user("#2 and #5 are not a fit. Find more people who run Kafka in production."),
    round("Bob"),
    card,
  ]);
  assert.deepEqual(failures, []);
});
