// Did each request for people end with the people? For every move where the simulated recruiter
// asked for new people, counts the new LinkedIn profiles Kruit showed (in any chat) before the
// recruiter's next move, and how long the last of them took. The judge's average score barely
// moves when a request ends without its list (it marked "stopped midway" twice in 101 plays while
// the chats held dozens of requests with no list, 11-24), so completion is counted here instead.

const PROFILE = /linkedin\.com\/in\/([^\s)\]/?#]+)/giu;

/** The LinkedIn profiles a message links, by lowercased, decoded handle. */
export function profilesIn(text) {
  const found = new Set();
  for (const match of String(text ?? "").matchAll(PROFILE)) {
    let handle = match[1];
    try {
      handle = decodeURIComponent(handle);
    } catch {}
    found.add(handle.toLowerCase());
  }
  return found;
}

/** Above this, the chat shows the top people and a link; the rest are counted in Results. */
export const LISTED_IN_CHAT_MAX = 20;

/** Graded fits across the role chats' Results, as the play read them after a move. */
const fitIn = (records) => (records ?? []).reduce((sum, record) => sum + (record.fit ?? 0), 0);

/**
 * One row per move that asked for people: asked, how many new people were shown before the next
 * move (a person shown earlier in the play is not new), and the seconds until the last of them.
 * A large ask counts the new graded fits in Results too, since its chat lists only the top.
 */
export function requestCompletion(turns, chats) {
  const bot = (chats ?? [])
    .flatMap((chat) => chat.messages ?? [])
    .filter((message) => message.role === "bot" && message.at)
    .map((message) => ({ at: Date.parse(message.at), profiles: profilesIn(message.text) }))
    .sort((a, b) => a.at - b.at);
  const seen = new Set();
  let next = 0;
  const rows = [];
  (turns ?? []).forEach((turn, index) => {
    const start = Date.parse(turn.at);
    const end = index + 1 < turns.length ? Date.parse(turns[index + 1].at) : Infinity;
    for (; next < bot.length && bot[next].at < start; next++)
      for (const profile of bot[next].profiles) seen.add(profile);
    let shown = 0;
    let lastAt = null;
    for (; next < bot.length && bot[next].at < end; next++) {
      const fresh = [...bot[next].profiles].filter((profile) => !seen.has(profile));
      for (const profile of bot[next].profiles) seen.add(profile);
      if (fresh.length) {
        shown += fresh.length;
        lastAt = bot[next].at;
      }
    }
    const asked = Number(turn.move?.people) || 0;
    // Graded fits found while this move's work ran: Results after it, less Results before it.
    const fitGain = fitIn(turn.records) - fitIn(index ? turns[index - 1].records : []);
    if (asked > 0)
      rows.push({
        turn: turn.turn,
        asked,
        shown: asked > LISTED_IN_CHAT_MAX ? Math.max(shown, fitGain) : shown,
        seconds: lastAt === null ? null : Math.round((lastAt - start) / 1000),
      });
  });
  return rows;
}

/** delivered: all asked shown; stated: fewer, and Kruit said the gap; else not delivered. */
export function completionOutcome(row, gap) {
  if (row.shown >= row.asked) return "delivered";
  return gap === "said" ? "stated" : "not delivered";
}

/** Counts and list times over request rows (each with an outcome). */
export function completionSummary(rows) {
  const count = (outcome) => rows.filter((row) => row.outcome === outcome).length;
  const seconds = rows
    .map((row) => row.seconds)
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const at = (share) => (seconds.length ? seconds[Math.floor(share * (seconds.length - 1))] : null);
  return {
    requests: rows.length,
    delivered: count("delivered"),
    stated: count("stated"),
    notDelivered: count("not delivered"),
    p50: at(0.5),
    p90: at(0.9),
  };
}
