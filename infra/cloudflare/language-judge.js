// Cloudflare Worker that decides, for each person in a batch, whether their profile shows a
// role's required language. The server posts six rows at a time and waits for every verdict, so
// nothing streams:
//   POST { requirement: string, rows: [{ id, name?, profile: string, candidate?: object }] }
//   200  { verdicts: { [id]: { verdict: "shown" | "unclear" | "no sign", p?: number } } }
// `profile` is the person's whole profile text; `candidate` is the search's row for them (title,
// company, location...), which the judge sees only if added to `state`. Leave out a row you
// cannot judge; that person stays unjudged. Any other status judges nobody in the batch, and if
// nobody in a search is judged the server reads the profile text itself.
// The caller's judge key arrives as its Bearer token and is passed on, so the Worker holds no
// secret. Turn it on by saving the Worker's URL as the judge's languageUrl
// (integrationSetup.saveJudge; the saved key is kept when none is given).
// Edit QUESTION or the bounds here to change the check.

const QUESTION = (requirement) =>
  `The role requires: "${requirement}". Does this profile text show the person can work in the required language? Count only what the text states: a Languages entry, posts or other content written in that language, a degree, school or job in a place where it is spoken, or work stated to use it.`;

/** At or above this the profile shows the language; below the lower bound it shows no sign. */
const SHOWN = 0.6;
const NO_SIGN = 0.25;

/** The judge's probability that one profile shows the language, or undefined when it fails. */
async function judge(authorization, requirement, row) {
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({
      model: "jev-latest",
      state: { profile: row.profile },
      questions: { answer: { type: "noul", instructions: QUESTION(requirement) } },
    }),
  }).catch(() => undefined);
  if (!response?.ok) return undefined;
  const p = (await response.json().catch(() => null))?.answers?.answer?.noul;
  return typeof p === "number" && p >= 0 && p <= 1 ? p : undefined;
}

export default {
  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const authorization = request.headers.get("authorization");
    if (!authorization) return new Response(null, { status: 401 });
    const body = await request.json().catch(() => null);
    const rows = Array.isArray(body?.rows)
      ? body.rows.filter((row) => typeof row?.id === "string" && typeof row.profile === "string")
      : [];
    if (typeof body?.requirement !== "string" || !rows.length)
      return new Response(null, { status: 400 });
    const verdicts = {};
    await Promise.all(
      rows.map(async (row) => {
        const p = await judge(authorization, body.requirement, row);
        if (p === undefined) return;
        verdicts[row.id] = {
          verdict: p >= SHOWN ? "shown" : p < NO_SIGN ? "no sign" : "unclear",
          p,
        };
      }),
    );
    return Response.json({ verdicts });
  },
};
