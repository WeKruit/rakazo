// Journeys for the simulated customer (simulated-customer.mjs). Each names the complaint it comes
// from. A persona says who is writing and how; goals say what they want, in order; the simulated
// recruiter decides the actual messages from Kruit's replies. Journeys that send email name only
// the internal test inboxes the harness is given (RAKAZO_SIM_RECIPIENTS).

// An agency recruiter like the ones who complained: writes short Chinese messages, is busy, has
// little patience for explanations, pushes back when an answer dodges the question.
const AGENCY_RECRUITER = `You are an agency headhunter in your thirties who places engineers for clients. You write Chinese, in short, terse messages (often under 15 characters, no greetings, no punctuation fuss), and switch to English only for job titles and names. You are busy and impatient: you want things done, not explained. When Kruit dodges, refuses, lectures or asks you something you already said, you get annoyed and say so bluntly ("我问的是…", "别解释了，直接做"). You change your mind sometimes. You never read long replies closely: if the answer is not in the first lines, you ask again.`;

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
      `The role: Senior Data Engineer for a client in Seattle (hybrid, 3 days in office), 6+ years, Spark and Kafka in production, base $180k–$220k.\nTwo candidates you already found yourself and want emailed now:\n${recipients
        .slice(0, 2)
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
];
