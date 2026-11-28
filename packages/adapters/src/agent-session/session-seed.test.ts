import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import { AgentHarness, BACKGROUND_CONTEXT, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { SeedMessage, SessionSeedSource } from "./session-seed.js";
import { seedSession } from "./session-seed.js";

const context = BACKGROUND_CONTEXT;
const key = { spaceId: "space", userId: "user", threadId: "thread", botId: "bot" };

function row(seq: number, text: string): SeedMessage {
  return {
    id: `m${seq}`,
    threadId: key.threadId,
    seq,
    role: seq % 2 === 0 ? "user" : "bot",
    botId: seq % 2 === 0 ? null : key.botId,
    runId: null,
    blocks: [{ kind: "text", text }],
    createdAt: new Date(1_700_000_000_000 + seq),
  };
}

function source(
  messages: SeedMessage[],
  thread: { historyCompactionSummary: string | null; historyCompactedUpToSeq: number | null } = {
    historyCompactionSummary: null,
    historyCompactedUpToSeq: null,
  },
): SessionSeedSource {
  return {
    thread: async () => ({ groupId: null, ...thread }),
    // Newest first, as the run history read returns it.
    history: async () => [...messages].sort((a, b) => b.seq - a.seq),
    botNames: async () => new Map(),
    waitingRunIds: async () => new Set(),
    thinking: async () => new Map(),
  };
}

function texts(entries: { type: string; message?: unknown }[]) {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = entry.message as { role: string; content: unknown };
    const content =
      typeof message.content === "string"
        ? message.content
        : (message.content as { type: string; text?: string }[])
            .map((part) => part.text ?? "")
            .join("");
    return [`${message.role}:${content}`];
  });
}

describe("seedSession", () => {
  it("seed excludes messages that are pending inputs", async () => {
    const faux = fauxProvider();
    const session = await new MemorySessionRepo().create({}, context);
    await seedSession(
      session,
      source([row(0, "first"), row(1, "reply"), row(2, "second"), row(3, "pending")], {
        historyCompactionSummary: "earlier work",
        historyCompactedUpToSeq: 0,
      }),
      { ...key, model: faux.getModel() as Model<Api> },
      3,
      context,
    );

    const main = await session.branch("main", context);
    const seeded = texts((await main?.findEntries({ order: "oldestFirst" }, context)) ?? []);
    expect(seeded).toHaveLength(3);
    expect(seeded[0]).toMatch(/^user:.*earlier work/s);
    expect(seeded.slice(1)).toEqual(["assistant:reply", "user:second"]);
  });

  it("seed beyond context window compacts once then answers", async () => {
    const faux = fauxProvider({ models: [{ id: "small", contextWindow: 4_000, maxTokens: 500 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel() as Model<Api>;
    faux.setResponses([
      fauxAssistantMessage("summary of the old work"),
      fauxAssistantMessage("answer"),
    ]);

    const session = await new MemorySessionRepo().create({}, context);
    // About 12,000 tokens of history (4 characters per token) against a 4,000 token window.
    const history = Array.from({ length: 24 }, (_, seq) => row(seq, `${seq} ${"x".repeat(2_000)}`));
    await seedSession(session, source(history), { ...key, model }, 24, context);

    const { harness } = await AgentHarness.create(
      {
        session,
        models,
        model,
        compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1_000 },
      },
      context,
    );
    const compactions: Extract<HarnessEvent, { type: "compaction_end" }>[] = [];
    harness.events.on("compaction_end", (event) => {
      compactions.push(event);
    });
    const lane = await harness.lane("main", context);
    const result = await lane.prompt("what next?", undefined, context);

    expect(result.ok).toBe(true);
    expect(compactions.map((event) => event.status)).toEqual(["completed"]);
    const entries = await lane.findEntries({ order: "newestFirst", limit: 1 }, context);
    expect(texts(entries)).toEqual(["assistant:answer"]);
    await harness.close(context);
  });
});
