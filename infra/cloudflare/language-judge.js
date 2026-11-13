// Cloudflare Worker that decides whether one person's profile shows a role's required language.
// The server posts one row and waits for one verdict, so nothing streams:
//   POST { requirement: string, name?: string, profile: string }
//   200  { verdict: "shown" | "unclear" | "no sign", p?: number }
// The caller's judge key arrives as its Bearer token and is passed on, so the Worker holds no
// secret. Any non-200 answer makes the server use its own check for that search.
// Turn it on by saving the Worker's URL as the judge's languageUrl (integrationSetup.saveJudge;
// the saved key is kept when none is given). Edit QUESTION or the bounds here to change the check.

const QUESTION = (requirement) =>
  `The role requires: "${requirement}". Does this profile text show the person can work in the required language? Count only what the text states: a Languages entry, posts or other content written in that language, a degree, school or job in a place where it is spoken, or work stated to use it. The name is hidden on purpose; never guess from names, photos or origin.`;

/** At or above this the profile shows the language; below the lower bound it shows no sign. */
const SHOWN = 0.6;
const NO_SIGN = 0.25;

/** The person's name taken out, so the judge reads only what the profile states. */
function withoutName(text, name) {
  let out = text;
  for (const part of [name, ...name.split(/[\s,.()]+/)].filter((item) => item.length > 1)) {
    const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}])${escaped}(?![\\p{L}])`, "gu"), "[name]");
  }
  return out;
}

export default {
  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const authorization = request.headers.get("authorization");
    if (!authorization) return new Response(null, { status: 401 });
    const row = await request.json().catch(() => null);
    if (typeof row?.requirement !== "string" || typeof row?.profile !== "string")
      return new Response(null, { status: 400 });
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({
        model: "jev-latest",
        state: { profile: withoutName(row.profile, typeof row.name === "string" ? row.name : "") },
        questions: { answer: { type: "noul", instructions: QUESTION(row.requirement) } },
      }),
    });
    if (!response.ok) return new Response(null, { status: 502 });
    const p = (await response.json().catch(() => null))?.answers?.answer?.noul;
    if (typeof p !== "number" || p < 0 || p > 1) return new Response(null, { status: 502 });
    const verdict = p >= SHOWN ? "shown" : p < NO_SIGN ? "no sign" : "unclear";
    return Response.json({ verdict, p });
  },
};
