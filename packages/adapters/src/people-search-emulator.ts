/**
 * The platform people search (an MCP server) for a test backend that must not reach it: every
 * search returns ten made-up people no earlier search returned, shaped like the provider's
 * results, so journeys that find people, give feedback and ask for the next round can run with no
 * spend and no real profiles. An agent run completes at once with the same kind of people.
 */

const FIRST = [
  "Avery",
  "Jordan",
  "Riley",
  "Casey",
  "Morgan",
  "Quinn",
  "Rowan",
  "Skyler",
  "Emerson",
  "Hayden",
  "Mei",
  "Wen",
  "Arjun",
  "Priya",
  "Diego",
  "Lucia",
  "Tomas",
  "Ingrid",
  "Kenji",
  "Amara",
];
const LAST = [
  "Calder",
  "Fenwick",
  "Hollis",
  "Marlowe",
  "Prescott",
  "Thorne",
  "Whitlock",
  "Ashby",
  "Brennan",
  "Lindqvist",
  "Okafor",
  "Varga",
  "Sato",
  "Iyer",
  "Moreau",
  "Novak",
  "Quintero",
  "Reyes",
  "Zhou",
];
/** Fictional employers. */
const COMPANIES = [
  "Northwind Labs",
  "Bluefin Systems",
  "Cobalt Harbor",
  "Ironleaf Data",
  "Juniper Grid",
  "Lumen Forge",
  "Maple Circuit",
  "Orbit Lane",
  "Pinecrest Analytics",
  "Quarry Works",
];
const SCHOOLS = ["Westbrook University", "Lakeside Institute of Technology", "Harlow College"];
const SKILL_WORDS =
  /\b(kafka|spark|python|java|go|golang|react|typescript|kubernetes|aws|gcp|sql|ml|pytorch|android|ios|rust|scala|airflow|flink)\b/gi;

type Person = {
  name: string;
  linkedin_url: string;
  title: string;
  company: string;
  location: string;
  evidence: string;
};

function titleFrom(query: string): string {
  const role =
    /((?:senior|staff|principal|lead)?\s*[a-z ]*?(?:engineer|developer|scientist|manager|designer|recruiter))/i.exec(
      query,
    )?.[1];
  const words = (role ?? "Software Engineer").trim().split(/\s+/).slice(-4);
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

function locationFrom(query: string): string {
  const city =
    /\b(seattle|san francisco|new york|austin|boston|beijing|shanghai|seoul|london|remote)\b/i.exec(
      query,
    )?.[1];
  return city ? city[0]!.toUpperCase() + city.slice(1).toLowerCase() : "Seattle";
}

export class PeopleSearchEmulator {
  private next = 0;

  /** Ten people no earlier call returned, fitting the query's title, place and skills. */
  people(query: string, count = 10): Person[] {
    const title = titleFrom(query);
    const location = locationFrom(query);
    const skills = [
      ...new Set((query.match(SKILL_WORDS) ?? []).map((skill) => skill.toLowerCase())),
    ];
    return Array.from({ length: Math.min(Math.max(count, 1), 10) }, () => {
      const n = this.next++;
      const name = `${FIRST[n % FIRST.length]} ${LAST[(n * 7) % LAST.length]}`;
      const company = COMPANIES[(n * 3) % COMPANIES.length]!;
      // Two in three show the skills asked for, so a round has people to keep and to turn down.
      const shown = n % 3 === 2 ? [] : skills;
      const years = 3 + (n % 9);
      return {
        name,
        linkedin_url: `https://www.linkedin.com/in/sim-${n}-${name.toLowerCase().replace(/\s+/g, "-")}`,
        title: n % 5 === 4 ? title.replace(/^(Senior|Staff|Principal|Lead) /, "") : title,
        company,
        location,
        evidence: `${title} at ${company}, ${years} years in the field.${
          shown.length
            ? ` Works in production with ${shown.join(", ")}.`
            : " Profile lists no specific stack."
        } Studied at ${SCHOOLS[n % SCHOOLS.length]}.`,
      };
    });
  }

  /** One MCP JSON-RPC request to the people search. */
  handle(request: Record<string, unknown>): unknown {
    const method = String(request.method ?? "");
    if (method === "initialize")
      return {
        protocolVersion: String(
          (request.params as Record<string, unknown> | undefined)?.protocolVersion ?? "2025-06-18",
        ),
        capabilities: { tools: {} },
        serverInfo: { name: "people-search-emulator", version: "1.0.0" },
      };
    if (method === "tools/list") return { tools: TOOLS };
    if (method !== "tools/call") return undefined;
    const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const args = params.arguments ?? {};
    const query = String(args.query ?? args.instructions ?? args.prompt ?? "");
    const count = Number(args.numResults ?? 10);
    if (params.name === "agent_run") {
      const people = this.people(query, count);
      const body = {
        runId: `sim-run-${this.next}`,
        status: "completed",
        output: {
          text: people.map((person) => `${person.name}: ${person.evidence}`).join("\n"),
          structured: {
            people: people.map((person) => ({
              name: person.name,
              linkedin_url: person.linkedin_url,
              current_title: person.title,
              current_company: person.company,
              location: person.location,
              evidence: person.evidence,
            })),
          },
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
    }
    const results = this.people(query, count).map((person) => ({
      title: `${person.name} - ${person.title} - ${person.company}`,
      url: person.linkedin_url,
      text: person.evidence,
      highlights: [person.evidence],
      entities: [
        {
          properties: {
            name: person.name,
            location: person.location,
            workHistory: [
              {
                title: person.title,
                company: { name: person.company },
                dates: { from: "2021-01" },
              },
            ],
          },
        },
      ],
    }));
    return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
  }
}

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    numResults: { type: "number" },
    category: { type: "string" },
  },
  required: ["query"],
};

const TOOLS = [
  { name: "web_search_exa", description: "Search the web.", inputSchema: SEARCH_SCHEMA },
  {
    name: "web_search_advanced_exa",
    description: "Search with filters; category people finds people.",
    inputSchema: SEARCH_SCHEMA,
  },
  {
    name: "agent_run",
    description: "Run a research agent over people and return structured results.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, runId: { type: "string" } },
    },
  },
];
