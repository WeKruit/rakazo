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

export const JOURNEYS = [
  {
    name: "send-at-night",
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
        .map((address, index) => `- ${["Noah Liu", "Ada Chen"][index]} <${address}>`)
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
    name: "batch-send-own-roles",
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
      "You do not remember the exact role names; ask Kruit or look at the pages. Never more than eight people in one send.",
    goals: [
      "Ask Kruit which of your roles have people who have not been emailed yet.",
      "Pick one of those roles and ask Kruit to send the first email to five or six of those people.",
      "When the send confirmation card appears, check it lists those people and the email, and approve it.",
      "Ask how many have gone out and when the rest go.",
      "Open the role's Sequence page and check it matches what Kruit said.",
    ],
  },
  {
    // Needs no mailbox and sends nothing, so it runs whenever the batch copy is given.
    name: "large-account-pick-people",
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
      "Ask Kruit to send it.",
      "If it cannot send yet, find out exactly what you need to do, in one step, and whether the draft is kept.",
    ],
  },
  {
    name: "progress-and-where",
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
      "Ask what you should do first to get candidates for a role.",
    ],
  },
  {
    name: "template-then-send",
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
      `The candidate: Noah Liu <${twoInboxes(recipients, tag)[0]}>, for the Senior Data Engineer role (Seattle, ref ${tag}). He is free Tuesday or Wednesday 2–4 pm Central. The call is 30 minutes with the hiring manager. Halfway through, Noah asks to move it to Thursday same time.`,
    goals: [
      "Tell Kruit Noah agreed to a 30-minute call and give his free times; ask it to set it up.",
      "If a card asks to confirm the invitation, check it names Noah, the time and the content before approving.",
      "Tell Kruit Noah wants Thursday instead, and get it moved without retyping everything.",
      "Open the Interview page and check it shows Noah's call at the right time and status.",
    ],
  },
  {
    name: "feedback-on-some-people",
    paid: true,
    title: "对几个人给反馈，看下一轮真的改了",
    area: "search",
    source:
      "11-14 user: feedback must be reviewed and actually applied; AGENTS.md: feedback may target any subset or a general direction",
    account: "batch",
    chinese: true,
    maxTurns: 8,
    waitMs: 12 * 60_000,
    persona: `${AGENCY_RECRUITER} You have a role with people already found and want the next people to be better.`,
    facts: () =>
      "Pick one role that already shows people. Do not approve any send. Keep any new search small (20 people at most).",
    goals: [
      "Look at one role's people and tell Kruit which two or three are not a fit and why, in one short message.",
      "Check Kruit says plainly what it changed for the next people, without asking you to rate everyone.",
      "Ask for a few more people and check none of the rejected ones come back and the new ones follow your feedback.",
      "Open the role's Results page and check the rejected people are marked and the new people show.",
    ],
  },
  {
    name: "long-search-finishes",
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
    name: "template-sign-with-my-name",
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
];
