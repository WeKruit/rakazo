import type { AdapterContext, ConnectorEvent } from "@rakazo/adapter-kit";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadMcpCredentialRecord,
  McpConnector,
  PLATFORM_PEOPLE_SEARCH_ENDPOINT,
} from "./mcp-connector.js";

vi.mock("./recruiting-research.js", async (actual) => ({
  ...(await actual<typeof import("./recruiting-research.js")>()),
  requireFullEnrichJobOwnership: async () => undefined,
}));

const success = { content: [{ type: "text", text: '{"results":[]}' }] };
const context = {
  operationId: "search-test",
  traceId: "search-test",
  spaceId: "test-space",
  userId: "test-user",
  botId: "test-bot",
  signal: new AbortController().signal,
} satisfies AdapterContext;

function fixture(
  replies: Array<number | Record<string, unknown> | Error>,
  options: { endpoint?: string; toolName?: string } = {},
) {
  const server = {
    id: "test-search-server",
    slug: "people-search",
    transport: "streamable_http",
    endpoint: options.endpoint ?? PLATFORM_PEOPLE_SEARCH_ENDPOINT,
    secretId: null,
    revision: 1,
    args: [],
  };
  const assignment = {
    server,
    serverId: server.id,
    spaceId: context.spaceId,
    userId: context.userId,
    botId: context.botId,
    allowAllTools: true,
    allowedTools: [],
  };
  const findFirst = vi.fn(async () => assignment as typeof assignment | null);
  const calls: Array<{ at: number; name: string; args: unknown }> = [];
  const controller = new AbortController();
  const connector = new McpConnector({ botMcpServer: { findFirst } } as never, {} as never, {
    network: {
      resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const message = JSON.parse(await request.text());
        if (message.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            },
          });
        if (message.method === "tools/call") {
          calls.push({
            at: Date.now(),
            name: message.params.name,
            args: message.params.arguments,
          });
          const reply = replies[calls.length - 1] ?? success;
          if (reply instanceof Error) throw reply;
          if (typeof reply === "number")
            return new Response("Request rejected; HTTP 429 mentioned in response text", {
              status: reply,
            });
          return Response.json({ jsonrpc: "2.0", id: message.id, result: reply });
        }
        return new Response(null, { status: 202 });
      },
    },
  });
  const toolName = options.toolName ?? "web_search_advanced_exa";
  const read = async () => {
    const events: ConnectorEvent[] = [];
    for await (const event of connector.execute(
      {
        tool: `mcp__people-search__${toolName}`,
        executionId: "search-call",
        route: {
          connectorId: "mcp",
          resourceId: server.id,
          resourceRevision: 1,
          toolName,
        },
        args:
          toolName === "get_enrichment_results"
            ? { enrichment_id: "lookup-1" }
            : { query: "test role", category: "people", numResults: 25 },
      },
      { ...context, signal: controller.signal },
    ))
      events.push(event);
    return events;
  };
  return { calls, read, connector, controller, findFirst };
}

beforeEach(() => {
  vi.stubEnv("EXA_API_KEY", "fake-search-key");
  vi.stubEnv("FULLENRICH_API_KEY", "fake-enrich-key");
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("people search rate limits", () => {
  it("warns once per process for keyless connections, without logging credential material", async () => {
    const previous = getLogger();
    const sink = createTestSink();
    installLogger(createLogger({ service: "people-search-test", sinks: [sink] }));
    const official = {
      secretId: null,
      transport: "streamable_http",
      endpoint: PLATFORM_PEOPLE_SEARCH_ENDPOINT,
    };
    try {
      const keyed = await loadMcpCredentialRecord({} as never, {} as never, official, context);
      expect(JSON.parse(keyed.plaintext!)).toEqual({ headers: { "x-api-key": "fake-search-key" } });
      vi.stubEnv("EXA_API_KEY", "");
      await loadMcpCredentialRecord(
        {
          secret: { findFirst: async () => ({ id: "test-secret", ciphertext: "fake-ref" }) },
        } as never,
        { load: async () => '{"headers":{"x-api-key":"fake-personal-key"}}' } as never,
        { ...official, secretId: "test-secret" },
        context,
      );
      expect(sink.events).toHaveLength(0);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const keyless = await loadMcpCredentialRecord({} as never, {} as never, official, context);
        expect(keyless.plaintext).toBeUndefined();
      }
      expect(sink.events).toHaveLength(1);
      expect(sink.events[0]).toMatchObject({
        message: "people_search.keyless",
        rateLimit: "shared free tier",
      });
      const log = JSON.stringify(sink.events);
      expect(log).not.toContain("fake-search-key");
      expect(log).not.toContain("fake-personal-key");
      expect(log).not.toContain("fake-ref");
    } finally {
      installLogger(previous);
    }
  });

  it("retries HTTP 429 after 1 s and 2 s, then returns the original successful result", async () => {
    const f = fixture([429, 429, success]);
    try {
      const pending = f.read();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(f.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(f.calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual([{ type: "result", data: success }]);
      expect(f.calls.map(({ at }) => at)).toEqual([0, 1_000, 3_000]);
      expect(
        f.calls.every(({ args }) => JSON.stringify(args) === JSON.stringify(f.calls[0]!.args)),
      ).toBe(true);
      expect(f.findFirst).toHaveBeenCalledTimes(3);
    } finally {
      await f.connector.close();
    }
  });

  it.each([
    { content: [{ type: "text", text: "429 Too Many Requests" }] },
    { content: [{ type: "text", text: "You have hit the free MCP rate limit" }] },
    { content: [{ type: "text", text: '{"status":429,"message":"slow down"}' }] },
    { content: [], structuredContent: { statusCode: 429 } },
  ])("retries a failed tool result that explicitly reports a rate limit: %j", async (result) => {
    const f = fixture([{ ...result, isError: true }, success]);
    try {
      const pending = f.read();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual([{ type: "result", data: success }]);
      expect(f.calls.map(({ at }) => at)).toEqual([0, 1_000]);
    } finally {
      await f.connector.close();
    }
  });

  it("reports exhausted rate limits as a definite error, with bounded retries and safe diagnostics", async () => {
    const f = fixture([429, 429, 429]);
    const previous = getLogger();
    const sink = createTestSink();
    installLogger(createLogger({ service: "people-search-test", sinks: [sink] }));
    try {
      const pending = f.read();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toEqual([
        { type: "error", message: "People search is rate-limited (HTTP 429); retry later." },
      ]);
      expect(f.calls).toHaveLength(3);
      expect(
        sink.events.map(({ message, attempt, retryMs, exhausted }) => ({
          message,
          attempt,
          retryMs,
          exhausted,
        })),
      ).toEqual([
        { message: "people_search.rate_limited", attempt: 1, retryMs: 1_000, exhausted: false },
        { message: "people_search.rate_limited", attempt: 2, retryMs: 2_000, exhausted: false },
        { message: "people_search.rate_limited", attempt: 3, retryMs: 0, exhausted: true },
        { message: "mcp.call.failed" },
      ]);
      expect(JSON.stringify(sink.events)).not.toContain("fake-search-key");
      expect(JSON.stringify(sink.events)).not.toContain("test role");
    } finally {
      await f.connector.close();
      installLogger(previous);
    }
  });

  it("stops during backoff as soon as the run is cancelled", async () => {
    const f = fixture([429]);
    try {
      const pending = f.read();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.calls).toHaveLength(1);
      f.controller.abort(new Error("run cancelled"));
      expect(await pending).toEqual([
        { type: "error", message: "run cancelled", outcome: "uncertain" },
      ]);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.connector.close();
    }
  });

  it("does not dispatch a retry after the assignment is revoked during backoff", async () => {
    const f = fixture([429]);
    try {
      const pending = f.read();
      await vi.advanceTimersByTimeAsync(0);
      f.findFirst.mockResolvedValue(null);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual([
        {
          type: "error",
          message: "MCP tool is not assigned to this bot",
          outcome: "uncertain",
        },
      ]);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.connector.close();
    }
  });

  it.each([400, 401, 403, 500])(
    "does not retry HTTP %s even when its body mentions 429",
    async (status) => {
      const f = fixture([status]);
      try {
        const result = await f.read();
        expect(result).toEqual([expect.objectContaining({ type: "error" })]);
        expect(f.calls).toHaveLength(1);
      } finally {
        await f.connector.close();
      }
    },
  );

  it("preserves uncertain outcome for an unrelated transport failure and does not retry it", async () => {
    const f = fixture([new Error("socket disconnected")]);
    try {
      expect(await f.read()).toEqual([
        {
          type: "error",
          message: "Could not reach mcp.exa.ai: socket disconnected",
          outcome: "uncertain",
        },
      ]);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.connector.close();
    }
  });

  it.each([{ toolName: "send_email" }, { endpoint: "https://mcp.example.test/mcp" }])(
    "does not retry another tool or service: %j",
    async (options) => {
      const f = fixture([429], options);
      try {
        expect(await f.read()).toEqual([
          expect.objectContaining({ type: "error", outcome: "uncertain" }),
        ]);
        expect(f.calls).toHaveLength(1);
      } finally {
        await f.connector.close();
      }
    },
  );

  it.each([
    { content: [{ type: "text", text: "A profile mentions HTTP 429 and free MCP rate limit" }] },
    { content: [{ type: "text", text: "No results" }], isError: true },
    { content: [{ type: "text", text: "Request 429 was invalid" }], isError: true },
  ])("preserves successful search text and non-rate-limit tool results: %j", async (result) => {
    const f = fixture([result]);
    try {
      expect(await f.read()).toEqual([{ type: "result", data: result }]);
      expect(f.calls).toHaveLength(1);
    } finally {
      await f.connector.close();
    }
  });
});

describe("contact lookup results", () => {
  const ENRICH = "https://mcp.fullenrich.com/mcp";
  const pending = { content: [{ type: "text", text: '{"status":"in_progress"}' }] };
  const finished = { content: [{ type: "text", text: '{"status":"FINISHED","results":[]}' }] };

  it("waits for a lookup in progress and returns the finished result", async () => {
    const f = fixture([pending, pending, finished], {
      endpoint: ENRICH,
      toolName: "get_enrichment_results",
    });
    try {
      const result = f.read();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toEqual([{ type: "result", data: finished }]);
      expect(f.calls.map(({ at }) => at)).toEqual([0, 5_000, 10_000]);
    } finally {
      await f.connector.close();
    }
  });

  it("returns the in-progress status once the wait runs out", async () => {
    const f = fixture(Array(60).fill(pending), {
      endpoint: ENRICH,
      toolName: "get_enrichment_results",
    });
    try {
      const result = f.read();
      await vi.advanceTimersByTimeAsync(240_000);
      expect(await result).toEqual([{ type: "result", data: pending }]);
      expect(f.calls.length).toBeLessThanOrEqual(48);
    } finally {
      await f.connector.close();
    }
  });
});
