// Journeys for the simulated customer (simulated-customer.mjs). Each names the complaint it comes
// from. gate: the release gate plays it (it needs no paid search); paid: it starts a search. A persona says who is writing and how; goals say what they want, in order; the simulated
// recruiter decides the actual messages from Kruit's replies. Journeys that send email name only
// the internal test inboxes the harness is given (RAKAZO_SIM_RECIPIENTS).

// An agency recruiter like the ones who complained: writes short Chinese messages, is busy, has
// little patience for explanations, pushes back when an answer dodges the question.
const AGENCY_RECRUITER = `You are an agency headhunter in your thirties who places engineers for clients. You write Chinese, in short, terse messages (often under 15 characters, no greetings, no punctuation fuss), and switch to English only for job titles and names. You are busy and impatient: you want things done, not explained. When Kruit dodges, refuses, lectures or asks you something you already said, you get annoyed and say so bluntly ("我问的是…", "别解释了，直接做"). You change your mind sometimes. You never read long replies closely: if the answer is not in the first lines, you ask again.`;

// A US agency recruiter who writes English, quickly and informally, and expects Kruit to keep up.
const US_RECRUITER = `You are a US agency recruiter who fills engineering roles for startups. You write English, short and informal, sometimes lowercase, sometimes two asks in one message. You expect Kruit to just do things. When it stalls, dodges or makes you repeat yourself you say so directly ("that's not what I asked", "just do it").`;

// Personas by name, for journeys learned from failures (simulated-customer.mjs --learn).
// Two candidate addresses from the first test inbox: the inbox itself and a plus-alias of it, so
// test mail stays out of everyone's own inbox (RAKAZO_SIM_RECIPIENTS lists noah-scheduling first).
const twoInboxes = ([first]) => [first, first.replace("@", "+ada@")];

export const PERSONAS = { AGENCY_RECRUITER, US_RECRUITER };

export const JOURNEYS = [
  {
    name: "send-at-night",
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
    facts: (recipients) =>
      `The role: Senior Data Engineer for a client in Seattle (hybrid, 3 days in office), 6+ years, Spark and Kafka in production, base $180k–$220k.\nTwo candidates you already found yourself and want emailed now:\n${twoInboxes(
        recipients,
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
    name: "template-sign-with-my-name",
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
      "Ask Kruit to drop anyone who does not show Kafka; expect it to say who it drops and what it will do about replacements.",
    ],
  },
];
