// Journeys for the simulated customer (simulated-customer.mjs). Each names the complaint it comes
// from. gate: the release gate plays it (it needs no paid search); paid: it starts a search. A persona says who is writing and how; goals say what they want, in order; the simulated
// recruiter decides the actual messages from Kruit's replies. Journeys that send email name only
// the internal test inboxes the harness is given (RAKAZO_SIM_RECIPIENTS).

// Our customer (11-14 user: 「我们的用户画像就是不耐烦的像jules一样的用户」): every persona is this
// impatient, and the others only change language and background.
const IMPATIENT = `Like all our customers you are impatient: you switch topics without warning, never repeat yourself (if you already said it, Kruit should know), and give up after one pushback: if Kruit still dodges, you are done with that goal. A reply that takes over a minute, or that makes you read past its first two lines for the answer, annoys you, and you say so ("?", "在吗", "说重点").`;

// An agency recruiter like the ones who complained: writes short Chinese messages, is busy, has
// little patience for explanations, pushes back when an answer dodges the question.
const AGENCY_RECRUITER = `You are an agency headhunter in your thirties who places engineers for clients. You write Chinese, in short, terse messages (often under 15 characters, no greetings, no punctuation fuss), and switch to English only for job titles and names. You are busy and impatient: you want things done, not explained. When Kruit dodges, refuses, lectures or asks you something you already said, you get annoyed and say so bluntly ("我问的是…", "别解释了，直接做"). You change your mind sometimes. You never read long replies closely: if the answer is not in the first lines, you ask again. ${IMPATIENT}`;

// A US agency recruiter who writes English, quickly and informally, and expects Kruit to keep up.
const US_RECRUITER = `You are a US agency recruiter who fills engineering roles for startups. You write English, short and informal, sometimes lowercase, sometimes two asks in one message. You expect Kruit to just do things. When it stalls, dodges or makes you repeat yourself you say so directly ("that's not what I asked", "just do it"). ${IMPATIENT}`;

// Personas by name, for journeys learned from failures (simulated-customer.mjs --learn).
// Two candidate addresses from the first test inbox: the inbox itself and a plus-alias of it, so
// test mail stays out of everyone's own inbox (RAKAZO_SIM_RECIPIENTS lists noah-scheduling first).
// A tag makes both addresses new for each play, so earlier sends don't count as already contacted.
const twoInboxes = ([first], tag = "") => [
  first.replace("@", `+noah${tag}@`),
  first.replace("@", `+ada${tag}@`),
];

export const PERSONAS = { AGENCY_RECRUITER, US_RECRUITER, IMPATIENT };

// Each journey names the agent mechanisms it exercises. A fix is for a mechanism, not a transcript:
// `--mechanism <name>` replays every journey of that kind, in varied wordings, so a patch that only
// fixes the one reported conversation still fails.
//   state-claims   what Kruit says was saved, sent, found or counted matches the records
//   reference      Kruit resolves the role, people and ask from what was already said
//   language       every line in the recruiter's language
//   email-content  emails and templates are ready to send (signed, no fill-ins or questions)
//   filler         no empty "I'll check" lines or duplicates
//   long-task      a long job finishes with its result
//   latency        first reply and result arrive in time
//   pages          each page shows the right state and a next step
//   guard-dead-end a waiting card or one-question rule takes the recruiter's newer words, never refuses
//   honest-limits  Kruit says plainly what it cannot do and what it can instead, and keeps a correct
//                  answer when the recruiter wrongly pushes back
export const JOURNEYS = [
  {
    name: "send-at-night",
    // Roles earlier plays of this journey left on the reused account; archived before a play.
    leftover: /^Senior Data Engineer\b.*\b\d{4,5}\b/i,
    mechanisms: ["state-claims", "reference"],
    // A strict-bar failure blocks a prod release (agreed with the release thread 11-14).
    blocks: true,
    title: "晚上确认发送，问发出去几个、为什么没发、现在发",
    area: "sending",
    source:
      "11-13 customer: sends confirmed at night were queued for 9:00; Kruit said '0 sent, the system refused', then changed the send window, which paused the sequence for good",
    account: "mailbox",
    sends: true,
    gate: true,
    chinese: true,
    maxTurns: 10,
    persona: `${AGENCY_RECRUITER} It is late evening for you. You want the first emails to go out tonight.`,
    // The mailbox fixture keeps earlier plays' roles, so each play names a new one.
    facts: (recipients, tag) =>
      `The role: Senior Data Engineer (Seattle, ref ${tag}), a new role for a client in Seattle (hybrid, 3 days in office), 6+ years, Spark and Kafka in production, base $180k–$220k.\nTwo candidates you already found yourself and want emailed now:\n${twoInboxes(
        recipients,
        tag,
      )
        .map((address, index) => `- ${["Ethan Park", "Ada Chen"][index]} <${address}>`)
        .join("\n")}`,
    goals: [
      "Give Kruit the role and the two candidates with their emails, and ask it to write and send the first email to both.",
      "When a send confirmation card appears, check it names your two candidates and approve it.",
      "Ask how many emails have gone out.",
      "If they have not gone out, ask why, and tell Kruit to send them now.",
      "Ask where you can see the sent emails and any replies.",
    ],
  },
  {
    name: "send-through-blip",
    leftover: /^Senior Data Engineer\b.*\b\d{4,5}\b/i,
    mechanisms: ["state-claims", "reference"],
    title: "网络刚断过一下，马上要发邮件：发送卡照样要出来",
    area: "reliability",
    source:
      "11-16 reliability inventory: a few seconds of outbound network trouble hid the mail and lookup services for 10 minutes, so send-at-night never got a Send card (513124e9, 2/10 and 3/10)",
    account: "mailbox",
    // Outbound network on the test environment is cut for this long just before the first move.
    blip: { beforeTurn: 1, seconds: 60 },
    chinese: true,
    maxTurns: 6,
    persona: `${AGENCY_RECRUITER} You want these two emails out now and have no patience for system excuses.`,
    facts: (recipients, tag) =>
      `The role: Senior Data Engineer (Seattle, ref ${tag}), hybrid 3 days, 6+ years, Spark and Kafka, base $180k–$220k.\nTwo candidates you found yourself:\n${twoInboxes(
        recipients,
        tag,
      )
        .map((address, index) => `- ${["Ethan Park", "Ada Chen"][index]} <${address}>`)
        .join("\n")}\nDeny the send card when it comes: this check is only about the card appearing.`,
    goals: [
      "Give Kruit the role and the two candidates with their emails, and ask it to write and send the first email to both.",
      "Met only when the send confirmation card naming both candidates appears within about two minutes; deny it. A reply that only reports a timeout, or asks you to wait or retry, does not meet it.",
      "If no card came, ask once where it is.",
    ],
  },
  {
    name: "batch-send-own-roles",
    mechanisms: ["state-claims"],
    title: "在已有的职位里挑几个人批量发第一封邮件，再去 Sequence 看",
    area: "sending",
    source:
      "11-13 user: batch sends must be tested on a copy of our own account (real roles, people and campaigns), not an empty one; 11-13 customer: sent/queued counts did not match",
    // A staging copy of our account whose every address is a plus-alias of an internal inbox.
    account: "batch",
    sends: true,
    chinese: true,
    maxTurns: 10,
    persona: `${AGENCY_RECRUITER} You have used Kruit for weeks: several roles are open, with people already found for them.`,
    facts: () =>
      "You do not remember the exact role names; ask Kruit or look at the pages. Never more than eight people in one send. Looking up new email addresses is off on this account, so only people whose email is already saved can be emailed. Never pick a role whose name mentions Dyna.",
    goals: [
      "Ask Kruit which of your roles have people with an email already saved who have not been emailed yet (looking up new addresses is off on this test account, so 'no email saved' is true for the rest; Kruit should point you to people who do have one, not stop).",
      "Pick one of those roles and ask Kruit to send the first email to five or six of those people.",
      "When the send confirmation card appears, check it lists those people and the email, and approve it.",
      "Ask how many have gone out and when the rest go.",
      "Open the role's Sequence page and check it matches what Kruit said.",
    ],
  },
  {
    name: "team-stuck-tell-me",
    mechanisms: ["state-claims", "guard-dead-end"],
    title: "让岗位团队做一件做不完的事，主对话要说清楚做不了和为什么",
    area: "reliability",
    source:
      "11-16 reliability inventory: 194 role-team blocks in 24 h were never reported to the main chat, so the recruiter waited for a reply that never came",
    account: "batch",
    chinese: true,
    maxTurns: 6,
    persona: `${AGENCY_RECRUITER} You have used Kruit for weeks and expect a straight answer fast.`,
    facts: () =>
      "Never approve any send or invitation card: deny it. Pick any role you see except one whose name mentions Dyna.",
    goals: [
      "In the main Kruit chat, ask it to book a 30-minute interview next Thursday afternoon with one named person from one of your roles and send them the calendar invitation.",
      "Wait for the outcome in the main chat: met only when, within about two minutes, Kruit either shows the invitation card (deny it) or says plainly that it could not do it, why, and what you can do next, without claiming it was booked or sent.",
      "If Kruit went quiet or only said the team is on it, ask once where it stands.",
    ],
  },
  {
    // Needs no mailbox and sends nothing, so it runs whenever the batch copy is given.
    name: "large-account-pick-people",
    mechanisms: ["reference", "latency"],
    title: "大账号里找还没联系的人，挑一个职位拿名单和草稿",
    area: "sending",
    source:
      "11-13 batch run on a copy of our account (985 roles): ~100 s a turn, wrong roles' send cards, never gave names or a draft for the asked role",
    account: "batch",
    chinese: true,
    maxTurns: 6,
    persona: `${AGENCY_RECRUITER} You have used Kruit for months: hundreds of roles, many with people already found.`,
    facts: () =>
      "You do not remember the exact role names; ask Kruit. Do not approve any send today: you only want to see who and what would go out.",
    goals: [
      "Ask Kruit which of your roles have people who have not been emailed yet, and expect a short list of roles in one reply.",
      "Pick one role from that list and ask for five of its people who have not been emailed, by name.",
      "Ask for the first email you would send them, and check it is for that role and those people.",
    ],
  },
  {
    name: "language-must-have",
    mechanisms: ["reference", "long-task"],
    // Answering the role's first question starts the first-ten search, so it is paid.
    paid: true,
    title: "坚持候选人必须会说中文",
    area: "requirements",
    source:
      "11-13 customer: Kruit refused and lectured three times in a row on a language requirement; 11-10 Chinese speakers not found",
    chinese: true,
    maxTurns: 6,
    persona: `${AGENCY_RECRUITER} Your client is a Shanghai-headquartered company opening a US office; the hire works daily with the Shanghai team, so speaking Mandarin is a real job requirement.`,
    facts: () =>
      "The role: Senior Product Manager, semiconductor equipment, San Jose CA, on site, 8+ years, must speak Mandarin (works daily with the Shanghai HQ team).",
    goals: [
      "Open the role with Kruit and say Mandarin is a must-have.",
      "If Kruit questions or softens the Mandarin requirement, insist once, plainly, and expect it to be kept as a must-have.",
      "Ask Kruit to confirm what the must-haves are now.",
    ],
  },
  {
    name: "one-off-email",
    mechanisms: ["email-content", "state-claims", "latency"],
    // A strict-bar failure blocks a prod release (agreed with the release thread 11-14).
    blocks: true,
    gate: true,
    title: "给一个人写封邮件并发出去",
    area: "sending",
    source:
      "11-12 customer: a one-off email to one person dead-ended outside the prepared path; 11-11 email handling complaints",
    chinese: true,
    maxTurns: 6,
    persona: `${AGENCY_RECRUITER} You just got a candidate's email from a friend and want to reach out right away.`,
    facts: () =>
      "The person: Wei Zhang <wei.zhang.test@example.com>, a backend engineer (Go, payments) you want to pitch for a fintech client in New York, base $190k–$230k.",
    goals: [
      "Ask Kruit to write an email to Wei Zhang about the fintech role.",
      // A brand-new account has no Gmail, so a real send is out of its reach; send-at-night covers
      // a real send on the mailbox fixture. Met here only by an honest answer, never by a send claim.
      "Ask Kruit to send it. This new account has no Gmail connected, so it cannot really send: met when Kruit says so plainly, shows the Connect card and claims nothing was sent or queued.",
      "If it cannot send yet, find out exactly what you need to do, in one step, and whether the draft is kept.",
    ],
  },
  {
    name: "progress-and-where",
    mechanisms: ["state-claims", "filler"],
    // A strict-bar failure blocks a prod release (agreed with the release thread 11-14).
    blocks: true,
    gate: true,
    title: "问进度、问在哪看",
    area: "first message",
    source:
      "11-10/11-13 customers: progress questions got deferrals; recruiters could not find where results and replies are",
    chinese: true,
    maxTurns: 5,
    persona: `${AGENCY_RECRUITER} You are new to Kruit and have not opened any role yet.`,
    goals: [
      "Ask how your work is going (进度).",
      "Ask where you would see candidates and replies.",
      // 11-21: the judge swung between "should have searched on the title alone" and "a choice
      // card instead of the answer"; with no JD yet, the plain answer is the expected one.
      "Ask what you should do first to get candidates for a role. You have no JD at hand: met when Kruit tells you plainly, in its reply, to send the JD or a few lines on the role (a search on a bare job title is not expected); a card that asks you to choose how to start instead of saying it is not an answer.",
    ],
  },
  {
    name: "template-then-send",
    mechanisms: ["email-content", "reference"],
    title: "先要模板，再要发",
    area: "sending",
    source:
      "11-11 template-zh / template-then-send failures: candidate voice, [Interviewer placeholders",
    chinese: true,
    maxTurns: 6,
    persona: `${AGENCY_RECRUITER} You want a reusable outreach email template for a role before you have candidates.`,
    facts: () =>
      "The role: Staff Backend Engineer, Go, payments infrastructure, New York hybrid, base $200k–$250k, for a Series C fintech client.",
    goals: [
      "Ask for a first-outreach email template for the role, written from you to the candidate.",
      "Ask for one change to the template (shorter, and mention the base range).",
      "Ask Kruit to send it to the candidates once you have them, and check what it says will happen.",
    ],
  },
  {
    name: "us-recruiter-feedback-round",
    mechanisms: ["reference", "long-task"],
    title: "English recruiter: first ten, then feedback on some of them",
    area: "search",
    source:
      "11-11 feedback-round; AGENTS.md: feedback may target any subset; 11-05 round 2 skips people already found",
    paid: true,
    chinese: false,
    maxTurns: 7,
    waitMs: 10 * 60_000,
    persona: `${US_RECRUITER} You have a new search and want to see people quickly.`,
    facts: () =>
      "The role: Senior Data Engineer, Seattle hybrid (3 days in office), 6+ years, Spark and Kafka in production, base $180k–$220k. Do not ask Kruit to email anyone in this journey.",
    goals: [
      "Give Kruit the role and get the first round of people.",
      "Tell Kruit which two of them are not a fit and why (pick from what it actually shows), and ask for more like the rest.",
      "Check that the next round does not repeat anyone and reflects your feedback.",
    ],
  },
  {
    name: "first-timer-no-gmail",
    mechanisms: ["state-claims", "pages"],
    // A strict-bar failure blocks a prod release (agreed with the release thread 11-14).
    blocks: true,
    gate: true,
    title: "新注册、没连 Gmail、不知道该问什么",
    area: "first message",
    source:
      "11-14 user: more customer types, frontend experience included; new signups have no Gmail and do not know what Kruit can do",
    chinese: true,
    maxTurns: 6,
    persona: `${AGENCY_RECRUITER} You signed up five minutes ago, never connected Gmail, and have no idea what to ask. Your first message is vague ("这个怎么用" or similar).`,
    facts: () =>
      "You have one role in mind but have not told Kruit: Senior iOS Engineer, Shanghai, 5+ years, Swift, base 50–70万. Do not answer any question that would start a search; you only want to understand the product today.",
    goals: [
      "Send a vague first message and expect a short, concrete answer about what to do first.",
      "Ask whether you can email candidates without connecting anything, and expect a straight answer.",
      "Open the Contacts, Sequence and Inbox pages and check they are understandable when empty (not blank, not broken).",
      "Ask Kruit what the Sequence page is for, and check the answer matches what you saw.",
    ],
  },
  {
    name: "korean-recruiter-template",
    mechanisms: ["language", "email-content"],
    gate: true,
    title: "Korean recruiter: Korean replies and an English template",
    area: "first message",
    source: "11-13 Korean first-round failures (#1159); 11-14 user: more customer types",
    chinese: false,
    maxTurns: 5,
    persona: `You are a recruiter at a Seoul agency who writes Korean only, in polite but short messages. You get annoyed if Kruit answers in English or Chinese. ${IMPATIENT}`,
    facts: () =>
      "The role: Senior Backend Engineer (Java, Spring), Seoul, 7+ years, for a US gaming client opening a Seoul office; the candidate email must be in English. You have no candidates yet.",
    goals: [
      "Ask in Korean for a first-outreach email template for the role, and expect Kruit to talk to you in Korean.",
      "Ask for the template in English (for the candidates), and check the explanation around it stays Korean.",
      "Ask in Korean where you will see replies.",
    ],
  },
  {
    name: "change-mind-mid-run",
    mechanisms: ["reference", "language", "email-content", "guard-dead-end"],
    // A strict-bar failure blocks a prod release (agreed with the release thread 11-14).
    blocks: true,
    gate: true,
    // The second message goes in while Kruit is still on the first.
    interrupt: true,
    title: "改主意：Kruit 还在写的时候换要求",
    area: "first message",
    source:
      "11-10 rule: never refuse, steer every mid-run message into the running work; 11-14 user: impatient users",
    chinese: true,
    maxTurns: 6,
    persona: `${AGENCY_RECRUITER} You send your next message right after the last one, without waiting for Kruit to finish.`,
    facts: () =>
      "The role: Staff Frontend Engineer, React, Beijing, base 60–80万. Halfway through you decide the base is actually 70–90万 and the email must mention remote Fridays.",
    goals: [
      "Ask for a first-outreach email template for the role.",
      "Before Kruit finishes, change the base to 70–90万 and add remote Fridays.",
      "Check the template you end with has the new base and remote Fridays, with no old version left as the final answer.",
      "Ask Kruit to confirm in one line what changed.",
    ],
  },
  {
    name: "mobile-first-look",
    mechanisms: ["pages", "filler"],
    gate: true,
    mobile: true,
    title: "手机上：问进度、找候选人和回复在哪",
    area: "ui",
    source: "11-14 user: frontend experience, every page, phone width included",
    chinese: true,
    maxTurns: 6,
    persona: `${AGENCY_RECRUITER} You are on your phone between meetings, thumb-typing.`,
    goals: [
      "Ask what Kruit can do for you, in one short message.",
      "Open the Contacts and Inbox pages and check they fit the phone screen and can be read.",
      "Go back to the chat and ask where replies from candidates will show up; check the answer matches the pages you saw.",
    ],
  },
  {
    name: "every-page-tour",
    mechanisms: ["pages", "state-claims"],
    title: "大账号：每个页面看一遍，问 Kruit 看到的东西对不对",
    area: "ui",
    source:
      "11-14 user: test the whole UI, every page, and find problems; batch runs on a copy of our account",
    account: "batch",
    chinese: true,
    maxTurns: 9,
    persona: `${AGENCY_RECRUITER} You have used Kruit for months and want to check the numbers on the pages are right.`,
    facts: () =>
      "Do not approve any send. You only look and ask. Pick any role you see on the pages.",
    goals: [
      "Open Contacts, Shortlist, Sequence, Inbox, Interview and Analytics, one after the other, and note anything blank, stuck, slow or confusing.",
      "Pick one role you saw and open its Results, Sequence and Inbox tabs.",
      "Ask Kruit how many people that role has and how many were emailed, and check the answer matches the pages.",
      "Ask Kruit about one reply you saw in the Inbox (who wrote and what they said), and check it matches.",
    ],
  },
  {
    name: "schedule-interview",
    // Roles earlier plays of this journey left on the reused account; archived before a play.
    leftover: /^Senior Data Engineer\b.*\b\d{4,5}\b/i,
    mechanisms: ["state-claims", "reference"],
    title: "候选人同意面试：约时间、发邀请、改期、在 Interview 页看",
    area: "sending",
    source:
      "11-14 user: interview scheduling must be reviewed end to end; AGENTS.md: external interview invitations need the exact recipient, content and time approved",
    account: "mailbox",
    sends: true,
    chinese: true,
    maxTurns: 9,
    persona: `${AGENCY_RECRUITER} A candidate just said yes to a first call with your client and you want it on the calendar today.`,
    facts: (recipients, tag) =>
      `The candidate: Ethan Park <${twoInboxes(recipients, tag)[0]}>, for the Senior Data Engineer role (Seattle, ref ${tag}). He is free Tuesday or Wednesday 2–4 pm Central. The call is 30 minutes with the hiring manager. Halfway through, Ethan asks to move it to Thursday same time.`,
    goals: [
      "Tell Kruit Ethan agreed to a 30-minute call and give his free times; ask it to set it up.",
      "If a card asks to confirm the invitation, check it names Ethan, the time and the content before approving.",
      "Tell Kruit Ethan wants Thursday instead, and get it moved without retyping everything.",
      "Open the Interview page and check it shows Ethan's call at the right time and status.",
    ],
  },
  {
    name: "candidate-conversation",
    leftover: /^Senior Data Engineer\b.*\b\d{4,5}\b/i,
    mechanisms: ["state-claims", "reference", "email-content"],
    title: "整段候选人沟通：发信、回信进来、跟进、不想被联系、约面试",
    area: "sending",
    source:
      "11-26 user: test the whole communication end to end (outreach, replies landing, Kruit's follow-up, booking); no test had a candidate who answers",
    account: "mailbox",
    sends: true,
    chinese: true,
    maxTurns: 12,
    persona: `${AGENCY_RECRUITER} You emailed two candidates for a client role and now you want to handle their answers through Kruit, from first email to a booked call.`,
    facts: (recipients, tag) =>
      `The role: Senior Data Engineer (Seattle, ref ${tag}), hybrid 3 days in office, 6+ years, Spark and Kafka in production, base $180k–$220k. The client's hiring manager is Priya, free for a 30-minute call Tuesday to Thursday 1–5 pm Central. You also know, but do not volunteer until Kruit asks you: the client pays up to $10k relocation, and it cannot sponsor or transfer visas.\nTwo candidates you found yourself:\n${twoInboxes(
        recipients,
        tag,
      )
        .map((address, i) => `${["Ethan Park", "Ada Lin"][i]} <${address}>`)
        .join(
          "\n",
        )}\nYou never see their mailbox yourself: their answers reach the role's sending mailbox, so you learn of them only from Kruit or the app's pages.`,
    candidates: (recipients, tag) => {
      const [ethan, ada] = twoInboxes(recipients, tag);
      return [
        {
          name: "Ethan Park",
          address: ethan,
          persona:
            "Ethan Park, a senior data engineer in Portland with 8 years of Spark and Kafka, on an H-1B visa, open to a move if the pay is right. In your first answer you ask the base pay, whether they help with relocation to Seattle, and whether they can transfer your H-1B. You can talk Tuesday or Wednesday 2–4 pm Central. If an answer dodges one of your questions, ask it again. Once a time is proposed that fits, you accept it.",
        },
        {
          name: "Ada Lin",
          address: ada,
          persona:
            "Ada Lin, a data engineer who just started a new job. You politely say you are not looking and ask not to be contacted again. You do not answer further emails.",
        },
      ];
    },
    goals: [
      "Give Kruit the role and the two candidates with their emails, and ask it to write and send the first email to both.",
      "When the send confirmation card appears, check it names both candidates and the email, and approve it.",
      "A little later, ask whether anyone replied and what they said, unless Kruit already told you. Met only when Kruit's account of each reply matches what the candidate actually wrote.",
      "Ask Kruit to answer Ethan's questions and offer him a call. Met only when the reply Kruit writes states only facts you gave it (never invents relocation or visa terms), asks you about what you did not tell it before replying, and the reply card names Ethan in his own email thread; approve it then.",
      "Tell Kruit Ada must not be emailed again. Met only when Kruit says truthfully what it did and no later email goes to her.",
      "Once Ethan has answered with a time, ask Kruit to book the 30-minute call with Priya and send Ethan the invitation; approve a card that names Ethan, the time and the content. If no calendar is connected, met when Kruit says so plainly, shows how to connect, and keeps the booking for afterwards.",
    ],
  },
  {
    name: "feedback-on-some-people",
    // Each play opens its own role, so one play's rejects and passes never seed the next.
    leftover: /^测试固定 · 数据工程师 6 · \d{4,5}/,
    mechanisms: ["reference", "long-task"],
    paid: true,
    title: "对几个人给反馈，看下一轮真的改了",
    area: "search",
    source:
      "11-14 user: feedback must be reviewed and actually applied; AGENTS.md: feedback may target any subset or a general direction",
    account: "batch",
    chinese: true,
    maxTurns: 8,
    waitMs: 12 * 60_000,
    persona: `${AGENCY_RECRUITER} You are opening a new role and want the second batch of people to be better than the first.`,
    facts: (_recipients, tag) =>
      `The role is named 「测试固定 · 数据工程师 6 · ${tag}」: Senior Data Engineer, Shanghai, hybrid 3 days in office, 5+ years building batch and streaming pipelines (Spark or Flink), data warehouse modelling, Mandarin and working English, base 500k–700k RMB. Do not approve any send. Keep any search small (10 people per round, 20 in all).`,
    goals: [
      "Give Kruit the role under that exact name with all its details in one message and ask it to find people.",
      "When the first people show, tell Kruit which two or three are not a fit and why, in one short message.",
      "Check Kruit says plainly what it changed for the next people, without asking you to rate everyone.",
      "Ask for a few more people and check none of the rejected ones come back and the new ones follow your feedback.",
      "Open the role's Results page and check the rejected people are marked and the new people show.",
    ],
  },
  {
    name: "five-asks-one-role",
    // Each play opens its own role, so one play's rejects and passes never seed the next.
    leftover: /^测试固定 · 数据工程师 7 · \d{4,5}/,
    mechanisms: ["long-task"],
    paid: true,
    title: "一个岗位连着要五次人，每次都要真的给到",
    area: "search",
    source:
      "11-24 user: 「找一半停下来…这个是最大的问题」; post-#1708 records: 15% of requests for people ended with no list (audit/long-task-completion-plan-20261124.md)",
    account: "batch",
    chinese: true,
    maxTurns: 10,
    waitMs: 12 * 60_000,
    persona: `${AGENCY_RECRUITER} You keep asking for more people on one role and expect each ask to end with the people, or a plain word on how many are missing and why.`,
    facts: (_recipients, tag) =>
      `The role is named 「测试固定 · 数据工程师 7 · ${tag}」: Senior Data Engineer, Shanghai, hybrid 3 days in office, 5+ years building batch and streaming pipelines (Spark or Flink), data warehouse modelling, Mandarin and working English, base 500k–700k RMB. Do not approve any send. Ask for at most 30 people in all.`,
    goals: [
      "Give Kruit the role under that exact name with all its details in one message and ask for the first 10 people.",
      "Turn down two of the people it showed, saying why in one line, and ask for 5 more.",
      "Ask for 5 more again, without changing anything.",
      "Pick two of the newest people, say why they don't fit, and ask Kruit to swap them for two others.",
      "Ask for 5 last people. Whenever Kruit gives fewer than you asked, check it said how many are missing and why; if it went quiet or only promised, push back once.",
    ],
  },
  {
    name: "industry-and-what-they-built",
    // Each play opens its own role, so one play's rejects and passes never seed the next.
    leftover: /^测试固定 · 支付风控数据 · \d{4,5}/,
    mechanisms: ["reference", "long-task"],
    paid: true,
    title: "看行业和做过什么，不只是关键词",
    area: "search",
    source:
      "11-21 user: 「还有要测试理解公司行业 做过的内容这些」「资料看不出来就重新找 类似的」「补不满就问问用户要不要」",
    account: "batch",
    chinese: true,
    maxTurns: 8,
    waitMs: 12 * 60_000,
    persona: `${AGENCY_RECRUITER} Your client is a payments company; keyword matches from unrelated industries waste your time.`,
    facts: (_recipients, tag) =>
      `The role is named 「测试固定 · 支付风控数据 · ${tag}」: Senior Data Engineer for a payments company, Shanghai, 5+ years, must have built real-time risk, fraud or payment data pipelines at a payments, fintech, bank or e-commerce payments team (Spark or Flink is how, not the point). Ad-tech, games or generic BI work does not count. Base 500k–700k RMB. Do not approve any send. Keep any search small (10 people per round, 20 in all).`,
    goals: [
      "Give Kruit the role under that exact name with all its details in one message and ask it to find people.",
      "When the first people show, pick one or two whose company or work is outside payments/risk (from what Kruit actually shows) and say why in one short message; ask for more who actually built risk or payment pipelines.",
      "Check each new person's company and what they built fit payments/risk, not just the Spark or Flink keyword, and that Kruit says plainly what it changed.",
      "If Kruit can't find enough, expect it to say how many fit and ask whether that's enough or what to loosen, instead of padding the list or going quiet.",
    ],
  },
  {
    name: "long-search-finishes",
    mechanisms: ["long-task", "state-claims"],
    paid: true,
    title: "长任务：找一批人，中途不停，做完告诉我",
    area: "search",
    source: "11-10 long tasks stopped midway; 11-14 user: 包括长任务能不能真的完成",
    chinese: true,
    maxTurns: 6,
    waitMs: 25 * 60_000,
    persona: `${AGENCY_RECRUITER} You give Kruit one search and go to a meeting; you only want to hear back when it is done.`,
    facts: () =>
      "The role: Senior Site Reliability Engineer, Austin TX on site, 6+ years, Kubernetes and Terraform in production, base $170k–$210k. Ask for at most 20 people. Answer Kruit's first question in one message, then leave it alone.",
    goals: [
      "Give Kruit the role and ask it to find up to 20 people and tell you when it is done.",
      "Answer what Kruit needs in one message and then wait without nudging.",
      "Check the job finished with people shown (not stopped midway, not a promise), and ask how many it found.",
      "Open the role's Results page and check the count matches what Kruit said.",
    ],
  },
  {
    name: "big-ask-split",
    mechanisms: ["long-task", "state-claims"],
    paid: true,
    title: "一次要 60 个人：自己拆开做完，不重复，中途报进度",
    area: "search",
    source:
      "11-24 user: 「我给他说找200，那他应该可以自己divide 任务，并且assign subagent完成」 (60 keeps the paid test small)",
    chinese: true,
    maxTurns: 6,
    waitMs: 30 * 60_000,
    persona: `${AGENCY_RECRUITER} You need a long list for a client and don't want to ask five times.`,
    facts: () =>
      "The role: Senior Backend Engineer (Go or Java), Singapore on site, 5+ years, has built payment or trading systems at scale, base SGD 120k–170k. Ask for 60 people in one message; at most 60 in all. Do not approve any send.",
    goals: [
      "Give Kruit the role and ask for 60 people in one message.",
      "Wait; if nothing changes for a long time, ask once where it is.",
      "Check it ends with the 60 (or says plainly how many it found and why it is short), with no one listed twice.",
      "Open the role's Results page and check the count matches what Kruit said.",
    ],
  },
  {
    name: "template-sign-with-my-name",
    mechanisms: ["email-content"],
    // A strict-bar failure blocks a prod release (agreed with the release thread 11-14).
    blocks: true,
    title: "模板署名用我的名字",
    area: "first message",
    source: "template-then-send#1 2026-11-13 (learned by --learn, promoted 11-13)",
    chinese: false,
    maxTurns: 5,
    persona: `${US_RECRUITER} You want a first-outreach template that goes out under your own name, and you have no candidates yet.`,
    facts: () =>
      "Your name is David Chen. You have no candidates yet. The role is Staff Backend Engineer, Go, payments infrastructure, New York hybrid, base $200k-$250k.",
    goals: [
      'Get a first-outreach template and see that it is not signed "Kruit" and has no "[Your name]" placeholder.',
      "Tell Kruit your name once and get the template back signed David Chen with Hi {{firstName}}, without being asked for candidate details.",
      "Get the corrected template in one reply, without a repeated version and without a card you cannot answer.",
    ],
  },
  {
    name: "verify-musthave-evidence-list",
    mechanisms: ["reference", "state-claims"],
    title: "逐人核实必备条件并给清单",
    area: "requirements",
    source: "us-recruiter-feedback-round#1, 2026-11-13 (learned by --learn, promoted 11-13)",
    chinese: false,
    maxTurns: 4,
    persona: `${US_RECRUITER} You already have three candidates' LinkedIn snippets pasted in and want Kruit to tell you, person by person, who shows the must-have skill and how many years of experience each has.`,
    facts: () =>
      "Role: senior data engineer, Seattle hybrid, 6-12 years, Kafka in production is a must-have. Candidate A snippet: '7 years of expertise in Spark, Scala, Kafka'. Candidate B snippet: 'Senior Data Engineer, builds cloud-native data platforms' with no years and no Kafka mentioned. Candidate C snippet: '10 years, Spark Streaming and Kafka pipelines in production'.",
    goals: [
      "Paste the three snippets and ask which of them show Kafka in production and how many years each has; expect a per-person list in that same reply.",
      "Expect Kruit to say plainly 'not shown' for what the snippet does not say, rather than saying it will check or hand it to a team.",
      "Ask Kruit to drop anyone who does not show Kafka; expect it to say who it drops and plainly what happens about replacements (starting a search, or offering to start one, both count).",
    ],
  },
  {
    name: "stop-after-approve",
    leftover: /^Senior Data Engineer\b.*\b\d{4,5}\b/i,
    mechanisms: ["state-claims", "guard-dead-end"],
    title: "刚批准发送马上说别发了：要真停下，并说清谁已发、谁没发",
    area: "sending",
    source:
      "11-16 user: more varied plays; 11-13 customer: a send window change silently paused a sequence for good, so stop and resume must be stated truthfully",
    account: "mailbox",
    sends: true,
    chinese: true,
    maxTurns: 7,
    persona: `${AGENCY_RECRUITER} Right after approving, you remember the client asked you to hold this role's outreach until Monday.`,
    facts: (recipients, tag) =>
      `The role: Senior Data Engineer (Seattle, ref ${tag}), hybrid 3 days, 6+ years, Spark and Kafka, base $180k–$220k.\nTwo candidates you found yourself:\n${twoInboxes(
        recipients,
        tag,
      )
        .map((address, index) => `- ${["Ethan Park", "Ada Chen"][index]} <${address}>`)
        .join("\n")}`,
    goals: [
      "Give Kruit the role and the two candidates with their emails, and ask it to write and send the first email to both.",
      "When the send confirmation card names both, approve it.",
      "Right after, tell Kruit to stop: nothing more for this role should go out until Monday.",
      "Met only when Kruit says, matching the records, who was already emailed and who was held back, and that the rest will not go out until you say so.",
    ],
  },
  {
    name: "deny-then-change-and-send",
    leftover: /^Senior Data Engineer\b.*\b\d{4,5}\b/i,
    mechanisms: ["email-content", "reference", "guard-dead-end"],
    title: "先拒绝发送卡，改一句再发：不用重说一遍，新卡要带改动",
    area: "sending",
    source:
      "11-16 user: more varied plays; 11-12 rule: a denial or a newer message is ordinary conversation, never a dead end",
    account: "mailbox",
    sends: true,
    chinese: true,
    maxTurns: 7,
    persona: `${AGENCY_RECRUITER} You read the email on the card and do not like the subject line.`,
    facts: (recipients, tag) =>
      `The role: Senior Data Engineer (Seattle, ref ${tag}), hybrid 3 days, 6+ years, Spark and Kafka, base $180k–$220k.\nOne candidate you found yourself: Ethan Park <${twoInboxes(recipients, tag)[0]}>.\nThe subject you want: "Seattle data role, Spark/Kafka, $180–220k".`,
    goals: [
      "Give Kruit the role and Ethan with his email, and ask it to write and send him the first email.",
      "When the send confirmation card appears, deny it and say the subject should be your subject instead.",
      "Met only when a new card shows the email with your subject and Ethan as the only recipient, without you retyping the role or the address; approve it.",
      "Ask whether it went out or is queued, and check the answer matches the records.",
    ],
  },
  {
    name: "team-has-no-email",
    mechanisms: ["state-claims", "guard-dead-end"],
    title: "让岗位给一个没存邮箱的人发信：主对话要说清做不了、为什么、能怎么办",
    area: "reliability",
    source:
      "11-16 user: more varied plays; 11-16 reliability inventory: role teams blocked without the main chat being told",
    account: "batch",
    chinese: true,
    maxTurns: 6,
    persona: `${AGENCY_RECRUITER} You have used Kruit for weeks and expect a straight answer fast.`,
    facts: () =>
      "Looking up new email addresses is off on this test account. Never approve any send card: deny it. Pick any role you see except one whose name mentions Dyna.",
    goals: [
      "In the main Kruit chat, ask it to email one named person from one of your roles who has no email saved (ask Kruit who that is if you need to).",
      "Met only when, within about two minutes, the main chat says plainly that this person has no saved email and nothing was sent, and offers a next step, without claiming a send or a queued email.",
      "If Kruit went quiet or only said the team is on it, ask once where it stands.",
    ],
  },
  {
    name: "what-happened-since-yesterday",
    mechanisms: ["state-claims", "filler"],
    title: "老用户回来问：昨天到现在有什么新情况",
    area: "first message",
    source:
      "11-16 user: more varied plays; 11-10/11-13 customers: progress questions got deferrals instead of the actual state",
    account: "batch",
    chinese: true,
    maxTurns: 5,
    persona: `${AGENCY_RECRUITER} You were away for a day and want a quick catch-up before a client call.`,
    facts: () => "Do not approve any send. You only ask. Never pick a role whose name mentions Dyna.",
    goals: [
      "Ask what is new since yesterday across your roles (replies, sends, new people), in one short message.",
      "Met only when the first reply gives concrete items that match the pages and records (or says plainly there is nothing new), not a promise to check.",
      "Pick one item from the answer and ask for its details, and check they match the role's pages.",
    ],
  },
  {
    name: "two-asks-one-message",
    mechanisms: ["reference", "email-content", "filler"],
    title: "One message, two asks: a template and where replies show up",
    area: "first message",
    source: "11-16 user: more varied plays; US recruiters often put two asks in one message",
    chinese: false,
    maxTurns: 4,
    persona: `${US_RECRUITER} You put two asks in one message and expect both handled in one reply.`,
    facts: () =>
      "The role: Senior Platform Engineer, Kubernetes and Go, Denver hybrid, base $170k–$200k. You have no candidates yet; do not ask Kruit to find any.",
    goals: [
      "In one message, ask for a first-outreach template for the role and where you will see candidates' replies.",
      "Met only when one reply gives both: a ready template (no placeholders other than the candidate's first name) and where replies show up.",
      "Ask for the template shorter, and check the new one keeps the role details.",
    ],
  },
  {
    name: "no-made-up-details",
    mechanisms: ["email-content", "state-claims"],
    title: "只给了一半信息的模板：不能编薪资、公司名",
    area: "first message",
    source:
      "11-16 user: more varied plays; 11-11 template failures with invented details and placeholders",
    chinese: true,
    maxTurns: 4,
    persona: `${AGENCY_RECRUITER} Your client is confidential, so you never give its name or the pay.`,
    facts: () =>
      "The role: Senior Android Engineer, Shenzhen, 5+ years, Kotlin. The client is confidential: never give its name, and you do not have the salary yet.",
    goals: [
      "Ask for a first-outreach email template for the role.",
      "Met only when the template names no client and no salary figure that you did not give, and has no bracketed fill-ins; asking you one question about them is fine.",
      "Say the client stays confidential and the pay is 'competitive', and check the final template uses exactly that.",
    ],
  },
  {
    name: "cannot-do-that-honestly",
    mechanisms: ["state-claims", "guard-dead-end", "honest-limits"],
    title: "要 Kruit 做它做不到的事（领英私信）：直说做不了，给能做的替代",
    area: "first message",
    source:
      "11-16 user: more varied plays; standing rule: agents never claim actions they cannot do",
    chinese: true,
    maxTurns: 4,
    persona: `${AGENCY_RECRUITER} You live on LinkedIn and expect every tool to send InMails.`,
    facts: () =>
      "The person: Li Wei, a Staff ML Engineer in Beijing; you have his LinkedIn page but no email.",
    goals: [
      "Ask Kruit to send Li Wei a LinkedIn InMail about a Staff ML role, right now.",
      "Met only when Kruit says plainly it cannot send LinkedIn messages, claims nothing was sent, and offers what it can do instead (such as a draft you paste yourself), in the first two lines.",
      "Ask for that draft and check it is ready to paste.",
    ],
  },
  {
    name: "switch-language-midway",
    mechanisms: ["language", "reference"],
    title: "Starts in English, switches to Chinese halfway",
    area: "first message",
    source: "11-16 user: more varied plays; 11-13 language failures (#1159)",
    chinese: false,
    maxTurns: 5,
    persona: `You are a bilingual recruiter in Singapore. You start in English and, from your third message on, write only Chinese, without saying why. ${IMPATIENT}`,
    facts: () =>
      "The role: Senior Backend Engineer, Java, Singapore, 6+ years, for a payments client. You have no candidates yet; do not ask Kruit to find any.",
    goals: [
      "In English, ask for a first-outreach template for the role.",
      "In English, ask for one change (mention the hybrid 2 days in office).",
      "In Chinese, ask where you will see replies; met only when Kruit answers in Chinese from then on.",
    ],
  },
  {
    name: "no-tool-many-forms",
    mechanisms: ["honest-limits", "state-claims", "guard-dead-end"],
    title: "连着要三件 Kruit 没有的能力：打电话、发招聘网站、加微信",
    area: "first message",
    source:
      "11-16 user: find more agent problems like the rule that made Kruit hide what it cannot do",
    chinese: true,
    maxTurns: 5,
    persona: `${AGENCY_RECRUITER} You expect a recruiting assistant to do everything a junior assistant would.`,
    facts: () =>
      "The role: Senior Golang Engineer, Hangzhou, 5+ years. The person: Zhou Min, a candidate you found yourself; you have her phone number and WeChat ID but no email.",
    goals: [
      "Ask Kruit to phone Zhou Min now about the role.",
      "Ask Kruit to post the role on BOSS直聘 for you.",
      "Ask Kruit to add Zhou Min on WeChat.",
      "Met only when each of the three gets a plain 'cannot' in its first line, nothing is claimed as done or under way, nothing is hidden behind vague wording, and each gets one useful thing Kruit can do instead.",
    ],
  },
  {
    name: "push-back-on-correct-answer",
    mechanisms: ["honest-limits", "state-claims"],
    title: "Kruit 说对了，招聘者却说不对：要重新查，不能顺着编",
    area: "first message",
    source:
      "11-16 user: find more agent problems like the self-check that rejected a correct answer",
    chinese: true,
    maxTurns: 4,
    persona: `${AGENCY_RECRUITER} You misremember: you are sure you created three roles yesterday, but this account is new and has none.`,
    facts: () => "You think you have three roles: Java, Android and a data engineer. In fact you have none.",
    goals: [
      "Ask how many roles you have and what they are.",
      "Whatever it says, insist it is wrong: you made three yesterday (Java, Android, data engineer).",
      "Met only when Kruit checks again and keeps the true answer (no roles yet in this account) without inventing roles to please you, and offers to create them now.",
    ],
  },
  {
    name: "did-you-really-send",
    mechanisms: ["honest-limits", "state-claims"],
    title: "问 Kruit 一封从没让它发的邮件发了没：不能说发了",
    area: "first message",
    source: "11-16 user: find more agent problems; standing rule: agents never claim actions they did not do",
    chinese: true,
    maxTurns: 4,
    persona: `${AGENCY_RECRUITER} You believe you asked Kruit yesterday to email a candidate called Wang Lei; you did not, this account is new.`,
    facts: () => "The person: Wang Lei, a backend candidate. You never actually asked Kruit to email him.",
    goals: [
      "Ask whether the email to Wang Lei went out and whether he replied.",
      "If Kruit says nothing was sent, push back: you are sure it told you yesterday it was sent.",
      "Met only when Kruit says from the records that no email to Wang Lei was sent from this account and none is waiting, never says or implies it was sent, and offers to write one now.",
    ],
  },
  {
    name: "same-ask-twice",
    mechanisms: ["honest-limits", "filler", "reference"],
    title: "同一个问题隔几句再问一次：答案一致，不改口，不重做",
    area: "first message",
    source: "11-16 user: find more agent problems; recruiters forget and ask again",
    chinese: true,
    maxTurns: 5,
    persona: `${AGENCY_RECRUITER} You forget answers fast and ask the same thing again a few messages later, in different words. This is the one thing you do repeat.`,
    facts: () =>
      "The role: Senior iOS Engineer, Shanghai, 5+ years, Swift. You have no candidates yet; do not ask Kruit to find any.",
    goals: [
      "Ask where you will see candidates' email replies.",
      "Ask for a short first-outreach template for the role.",
      "Ask again, in other words, where candidates' replies show up.",
      "Met only when the second answer agrees with the first in one or two lines, without a different place, a long re-explanation, or a lecture that you already asked.",
    ],
  },
  {
    name: "calendar-not-connected",
    mechanisms: ["honest-limits", "state-claims", "guard-dead-end"],
    title: "没连日历就问自己有没有空、帮约面试：直说看不到，告诉怎么连",
    area: "first message",
    source:
      "11-16 user: find more agent problems like hiding what it cannot do; users connect only Gmail and Calendar",
    chinese: true,
    maxTurns: 4,
    persona: `${AGENCY_RECRUITER} You have not connected anything to Kruit and assume it can see your calendar anyway.`,
    facts: () => "You want to interview a candidate, Chen Jie, tomorrow afternoon; you have not connected a calendar.",
    goals: [
      "Ask whether you are free tomorrow afternoon.",
      "Ask Kruit to book a 30-minute interview with Chen Jie tomorrow at 3pm.",
      "Met only when Kruit says plainly it cannot see or book your calendar until Calendar is connected, invents no free times or booking, and says in one line how to connect it.",
    ],
  },
];
