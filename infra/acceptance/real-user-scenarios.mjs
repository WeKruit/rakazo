// Conversation scenarios for real-user.mjs, each from a complaint or bug in this product's history.
// The wording is how recruiters actually wrote; every JD, name and address is invented.
//
// Turns: { say } sends to Kruit (with { file } it attaches a PDF of those lines), { sayRole } to the
// newest role chat, { answerCard } types into the newest open question card, { results } waits for
// a round of people after the last message (and fails if it repeats people already shown),
// { wait } pauses (ms), { stop } presses Stop.
// Expectations: noRole (no role may be opened), role (a role must be opened, not titled "New
// role"), roleTitle (regex the new role's name must match), requirement (regex that must be saved as required in the role brief), last / lastNot
// (regex the last reply must / must not match), sendCard (a send card must appear; it is denied),
// foundEmail (the reply may show an address the recruiter never typed: a lookup's result).
// account: "onboarded" plays on the fixture account we set up by hand (no credit limit, no
// mailbox), "mailbox" on the outside fixture account we gave a mailbox, instead of a fresh
// self-signup account. Every conversation also passes the common checks
// in real-user-checks.mjs. paid: answering a role's first question starts the paid first-ten search.
// known: a product failure already handed to a fix thread; it still fails on the scoreboard but
// does not fail the release gate. Remove it with the fix.

const CANDIDATE = "alex.chen.test@example.com";
const JD_EN = `Senior Data Engineer — Seattle, WA (hybrid, 3 days on site)
We are a 200-person logistics software company. You will own our batch and streaming pipelines.
Requirements: 6+ years of data engineering; Spark or Flink in production; Python and SQL; AWS.
Nice to have: Kafka, dbt, logistics domain. Salary $170k–$200k plus equity. Visa sponsorship not available.`;
const JD_ZH_MUST =
  "新岗位：华东区销售总监，常驻上海，医疗器械行业，10年以上销售经验，带过20人以上团队。必须会说普通话和英语，必须有三甲医院渠道资源。";
const JD_ZH_OPTIONAL =
  "帮我开个新岗位：高级技术产品经理，湾区（Sunnyvale），半导体或芯片背景，5年以上产品经验，和晶圆厂、封测厂合作过。会说中文更好，不强求。";
const CHINESE = /中文|普通话|汉语|mandarin|chinese/;
// Plain ASCII, as a recruiter's exported JD; the PDF holds no other clue about the role.
const JD_FILE = {
  name: "JD - Staff ML Engineer.pdf",
  lines: [
    "Staff Machine Learning Engineer - Austin, TX (on site)",
    "Fintech company, 400 people. You will lead our fraud-detection models.",
    "Requirements: 8+ years in ML engineering; PyTorch; models in production at scale.",
    "Nice to have: payments or fraud domain. Salary $210k-$250k. No visa sponsorship.",
  ],
};

export const SCENARIOS = [
  // First message: the account is brand new and the recruiter has not said what they want yet.
  { name: "greet-zh", area: "first message", source: "new accounts", turns: [{ say: "你好" }] },
  { name: "greet-en", area: "first message", source: "new accounts", turns: [{ say: "hi" }] },
  {
    name: "capabilities-zh",
    area: "first message",
    source: "new accounts",
    turns: [{ say: "你能帮我做什么？" }],
  },
  {
    name: "angry-zh",
    area: "first message",
    source: "11-10 outside user: 它听不懂我说的话",
    turns: [{ say: "你能听懂我说话吗？" }],
  },
  {
    name: "vague-en",
    area: "first message",
    source: "vague asks declined (#ambiguous)",
    turns: [{ say: "need people. fast" }],
  },
  {
    name: "lone-question-mark",
    area: "first message",
    source: "vague asks declined (#ambiguous)",
    turns: [{ say: "？" }],
  },
  {
    name: "out-of-scope-zh",
    area: "first message",
    source: "never refuse (11-10 rule)",
    turns: [{ say: "帮我订一张下周去纽约的机票" }],
  },
  {
    name: "data-source-zh",
    area: "first message",
    source: "supplier names shown to customers",
    turns: [{ say: "你们的人才数据是从哪来的？用的什么数据库？" }],
  },
  {
    name: "agent-mentions",
    area: "first message",
    source: "pasted @mentions must not route or show agents",
    turns: [{ say: "@Main @Sourcer 帮我找几个做跨境电商运营的人" }],
    lastNot: /\b(?:Sourcer|Reviewer)\b|@Main/,
  },
  // Opening a role.
  {
    name: "jd-en",
    area: "new role",
    source: "10-27 T3: English JD asked in Chinese, role named from a JD fragment",
    turns: [{ say: JD_EN }],
    role: true,
  },
  {
    name: "jd-zh-must-have",
    area: "new role",
    source: "11-10 「我不是说了要会说中文吗？」",
    turns: [{ say: JD_ZH_MUST }],
    role: true,
    requirement: CHINESE,
  },
  {
    name: "jd-upload-pdf",
    area: "new role",
    source: "recruiters attach the JD file instead of pasting it",
    turns: [{ say: "这是一个新的岗位，我们来找一下候选人", file: JD_FILE }],
    role: true,
    roleTitle: /machine learning|\bML\b|机器学习/i,
  },
  {
    name: "mixed-language-ask",
    area: "new role",
    source: "Chinese recruiters mixing English titles",
    turns: [{ say: "帮我找几个奥斯汀的 backend 工程师，要会 Go 语言，五年以上经验" }],
    role: true,
  },
  {
    name: "change-while-opening",
    area: "steering",
    source: "11-10 never refuse, steer mid-run messages",
    turns: [{ say: JD_EN }, { wait: 4_000 }, { say: "对了，远程也可以，不一定要在西雅图" }],
    role: true,
  },
  {
    name: "stop-then-continue",
    area: "steering",
    source: "stopped runs that never resumed",
    turns: [{ say: JD_EN }, { wait: 5_000 }, { stop: true }, { say: "继续吧" }],
  },
  {
    name: "roles-empty-zh",
    area: "status",
    source: "nightly 11-10",
    turns: [{ say: "我现在有哪些在招的职位？" }],
    last: /没有|暂无|还没|尚未|0/,
  },
  {
    name: "progress-idle-zh",
    area: "status",
    source: "progress replies claiming work that did not exist",
    turns: [{ say: "进度怎么样了？" }],
  },
  {
    // 11-13: people queued for the 9:00 send window were reported as "0 sent", with a lecture on
    // names nobody asked for. The answer leads with the actual state.
    name: "send-count-zh",
    area: "status",
    source: "11-13 queued emails reported as none sent, talking in circles",
    turns: [{ say: "现在发送了多少人呢" }, { say: "你找了这么多人为什么一个邮件都发不出去？" }],
  },
  {
    name: "credits-zh",
    area: "status",
    source: "new accounts with starting credits",
    turns: [{ say: "我还剩多少额度？" }],
  },
  // Email.
  {
    name: "email-no-mailbox-zh",
    area: "email",
    source: "11-10 outside user told to contact an internal address, three times",
    noRole: true,
    turns: [
      { say: `帮我给 ${CANDIDATE} 发封邮件，问他下周有没有空聊一个后端岗位` },
      { say: "其他几位可以根据实际情况发送邮件吗" },
      { say: "那你就直接发啊" },
    ],
  },
  {
    // The production case: an account we onboarded (no credit limit) before its mailbox was
    // assigned. One line, no address, said once; no self-serve step is expected.
    name: "email-onboarded-no-mailbox-zh",
    area: "email",
    source: "11-10 onboarded account told three times to contact an internal address",
    account: "onboarded",
    noRole: true,
    turns: [{ say: "其他几位可以根据实际情况发送邮件吗" }, { say: "那你就直接发啊" }],
  },
  {
    // An account we gave a mailbox emails an address the recruiter typed, outside any role.
    name: "email-assigned-mailbox-zh",
    area: "email",
    source: "11-12 assigned mailbox had no way to send one email to a named address",
    account: "mailbox",
    noRole: true,
    turns: [
      {
        say: `请给 ${CANDIDATE} 发一封简短的邮件，主题写 Quick chat，正文：Hi Alex, do you have time next week to talk about a backend role?`,
      },
    ],
    sendCard: true,
  },
  {
    // A second one-off email: tool search returned only mail reads, so no card came.
    name: "email-assigned-mailbox-again-zh",
    area: "email",
    source: "11-12 second one-off email found no way to send and asked to connect a mailbox",
    account: "mailbox",
    noRole: true,
    turns: [
      {
        say: `再给 ${CANDIDATE} 发一封新邮件，主题 Kruit test 2，正文：Second test, please ignore.`,
      },
    ],
    sendCard: true,
  },
  {
    name: "email-no-mailbox-en",
    area: "email",
    source: "11-10 outside user told to contact an internal address",
    noRole: true,
    turns: [{ say: "Can you just email the candidates for me?" }],
  },
  {
    name: "template-zh",
    area: "email",
    source: "11-09/10 template written in the candidate's voice",
    noRole: true,
    turns: [{ say: "帮我写一封面试后跟进邮件的模板" }],
    last: /\[Candidate|候选人|Hi \[|您好/,
    // A recruiter thanking the candidate for their time is fine; the greeting tells whose voice it is.
    lastNot: /\[(?:Interviewer|Hiring Manager)/i,
  },
  {
    name: "template-then-send",
    area: "email",
    source: "drafts that dead-ended at sending",
    turns: [{ say: "帮我写一封面试后跟进邮件的模板" }, { say: `发给 ${CANDIDATE}` }],
  },
  {
    // A message written while a send card waits: it gets its own reply, the card stays open.
    name: "ask-while-send-card",
    area: "email",
    source: "11-11 messages sat unread behind an open send card",
    turns: [
      { say: `帮我给 ${CANDIDATE} 写封邮件，问他下周有没有空聊一个后端岗位，写好就发` },
      { say: "对了，我现在有几个岗位？" },
    ],
    last: /岗位|角色|没有|0|个/,
  },
  {
    // The 11-11 case on an account with a mailbox: a real Send card is open when the
    // recruiter asks something else, and the question gets its own answer.
    name: "ask-while-send-card-mailbox",
    area: "email",
    source: "11-11 messages sat unread behind an open send card",
    account: "mailbox",
    noRole: true,
    turns: [
      {
        say: `请给 ${CANDIDATE} 发一封简短的邮件，主题写 Quick chat，正文：Hi Alex, do you have time next week to talk about a backend role?`,
      },
      { say: "对了，我现在有几个岗位？" },
    ],
    sendCard: true,
    last: /岗位|角色|没有|0|个/,
  },
  {
    name: "cold-email-en",
    area: "email",
    source: "10-27 T1: drafts in Chinese for English candidates",
    turns: [
      { say: "Write me a short cold outreach email for a senior data engineer role in Seattle" },
    ],
    last: /Subject|Hi\b/,
  },
  // Scheduling.
  {
    name: "schedule-zh",
    area: "scheduling",
    source: "Scheduling asked to connect Cal.com without a next step",
    turns: [{ say: `帮我约 Alex Chen（${CANDIDATE}）下周二下午两点面试，30分钟` }],
  },
  {
    name: "schedule-en",
    area: "scheduling",
    source: "Scheduling asked to connect Cal.com without a next step",
    turns: [
      { say: `Book a 30 minute interview with Alex Chen (${CANDIDATE}) next Tuesday at 2pm` },
    ],
  },
  // Memory.
  {
    name: "memory-recall",
    area: "memory",
    source: "preferences told to Kruit and forgotten",
    turns: [
      { say: "记住：以后所有候选人邮件都用英文写，署名 Jules Hou" },
      { say: "我的候选人邮件署名是什么？" },
    ],
    last: /Jules Hou/,
  },
  {
    name: "memory-after-role",
    area: "memory",
    source: "11-03 new role ignored saved preference",
    turns: [
      { say: "记住：以后所有候选人邮件都用英文写，署名 Jules Hou" },
      { say: JD_EN },
      { say: "我之前说的邮件署名是什么？" },
    ],
    last: /Jules Hou/,
  },
  {
    name: "language-switch",
    area: "language",
    source: "server lines stuck in English / Chinese",
    turns: [
      { say: "帮我写一封面试后跟进邮件的模板" },
      { say: "Actually, talk to me in English from now on. Make it shorter." },
    ],
  },
  // Off the built paths: one-off asks no role step was made for. Each must be done with the
  // general tools (or asked about once), never answered with "no permission" or "open a role".
  {
    // A contact lookup charges for what it finds, so it plays only with --paid.
    name: "offpath-find-email-zh",
    area: "off path",
    source: "11-12 agents dead-ended outside pre-built paths",
    paid: true,
    foundEmail: true,
    noRole: true,
    turns: [
      {
        say: "帮我查一下这个人的邮箱：Alex Chen，linkedin.com/in/alex-chen-test-0000，现在在 Stripe 做后端",
      },
    ],
  },
  {
    // Two addresses typed at once, outside any role: one email each, each on its own Send card.
    name: "offpath-email-two-zh",
    area: "off path",
    source: "11-12 agents dead-ended outside pre-built paths",
    account: "mailbox",
    noRole: true,
    turns: [
      {
        say: `给 ${CANDIDATE} 和 sam.lee.test@example.com 各发一封邮件，主题 Quick chat，正文：Hi, do you have 15 minutes next week to talk about a backend role?`,
      },
    ],
    sendCard: true,
  },
  {
    name: "offpath-add-candidate-zh",
    area: "off path",
    source: "11-12 agents dead-ended outside pre-built paths",
    turns: [
      {
        say: `把这个人存到我的候选人里：Alex Chen，linkedin.com/in/alex-chen-test-0000，邮箱 ${CANDIDATE}`,
      },
    ],
  },
  {
    name: "offpath-reply-no-mail-zh",
    area: "off path",
    source: "11-12 agents dead-ended outside pre-built paths",
    noRole: true,
    turns: [{ say: `帮我回复 ${CANDIDATE} 的上一封邮件，就说周四下午可以聊` }],
  },
  {
    name: "offpath-company-en",
    area: "off path",
    source: "11-12 agents dead-ended outside pre-built paths",
    noRole: true,
    turns: [{ say: "Roughly how big is Stripe's engineering team, and which cities are they in?" }],
    last: /Stripe/,
  },
  {
    name: "offpath-reminder-zh",
    area: "off path",
    source: "11-12 agents dead-ended outside pre-built paths",
    noRole: true,
    turns: [{ say: "下周一上午提醒我跟进一下 Alex Chen" }],
  },
  {
    name: "offpath-rewrite-jd-zh",
    area: "off path",
    source: "11-12 agents dead-ended outside pre-built paths",
    noRole: true,
    turns: [{ say: `先别开岗位，帮我把这段 JD 改写得更吸引候选人：${JD_ZH_MUST}` }],
    last: /销售总监/,
  },
  {
    name: "offpath-calendar-en",
    area: "off path",
    source: "11-12 agents dead-ended outside pre-built paths",
    noRole: true,
    turns: [{ say: "What's on my calendar tomorrow?" }],
  },
  // Paid: answering a role's first question starts the first-ten search.
  {
    name: "feedback-round",
    area: "feedback",
    source: "feedback on a few people must continue the same search with new people",
    paid: true,
    turns: [
      { say: JD_EN },
      { answerCard: "Go with the JD as written and start the search." },
      { results: {} },
      {
        sayRole:
          "#2 and #5 are not a fit: no streaming pipelines in production. Find more people who run Kafka in production.",
      },
      { results: {} },
    ],
    role: true,
    lastNot: /\b(?:rate|score) (?:all|each|every)\b|每一位都|逐一评价/i,
  },
  {
    name: "must-have-on-card",
    area: "requirements",
    source: "11-10 outside user: 「你能听的懂话吗？中文是必须！」 overridden by the saved role",
    paid: true,
    turns: [{ say: JD_ZH_OPTIONAL }, { answerCard: "你能听的懂话吗？中文是必须！" }],
    requirement: CHINESE,
  },
];
