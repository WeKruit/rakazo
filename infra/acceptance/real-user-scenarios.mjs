// Conversation scenarios for real-user.mjs, each from a complaint or bug in this product's history.
// The wording is how recruiters actually wrote; every JD, name and address is invented.
//
// Turns: { say } sends to Kruit, { sayRole } to the newest role chat, { answerCard } types into the
// newest open question card, { wait } pauses (ms), { stop } presses Stop.
// Expectations: noRole (no role may be opened), role (a role must be opened, not titled "New
// role"), requirement (regex that must be saved as required in the role brief), last / lastNot
// (regex the last reply must / must not match). Every conversation also passes the common checks
// in real-user-checks.mjs. paid: answering a role's first question starts the paid first-ten search.

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
    lastNot: /\[Interviewer|thank you for taking the time to speak with me/i,
  },
  {
    name: "template-then-send",
    area: "email",
    source: "drafts that dead-ended at sending",
    turns: [{ say: "帮我写一封面试后跟进邮件的模板" }, { say: `发给 ${CANDIDATE}` }],
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
  // Paid: answering a role's first question starts the first-ten search.
  {
    name: "must-have-on-card",
    area: "requirements",
    source: "11-10 outside user: 「你能听的懂话吗？中文是必须！」 overridden by the saved role",
    paid: true,
    turns: [{ say: JD_ZH_OPTIONAL }, { answerCard: "你能听的懂话吗？中文是必须！" }],
    requirement: CHINESE,
  },
];
