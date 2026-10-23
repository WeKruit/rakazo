import { boundDirectApprovalRequest, catalogApprovalRequest } from "@rakazo/core";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { historyMessageText, readHistory, searchHistory } from "./history-retrieval.js";

const scope = { spaceId: "space", userId: "user", threadId: "thread", botId: "bot" };
const row = (seq: number, text = "Use batch exports") => ({
  id: `message-${seq}`,
  seq,
  role: "user",
  blocks: [{ kind: "text", text }],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  runId: null,
  replyToMessageId: null,
});
const pdfRow = (seq: number, name = `${"证".repeat(251)}.pdf`) => ({
  ...row(seq, "Read supplied PDFs"),
  blocks: [
    { kind: "text", text: "Read supplied PDFs" },
    ...Array.from({ length: 4 }, (_, index) => ({
      kind: "file",
      artifactId: `original-artifact-${seq}-${index}`,
      name,
      mimeType: "application/pdf",
      size: 42,
    })),
  ],
});
function db() {
  const mock = {
    $queryRaw: vi.fn(),
    run: { findMany: vi.fn().mockResolvedValue([]) },
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
    externalEffect: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
  };
  return { mock, prisma: mock as unknown as PrismaClient };
}
describe("history MCP receipts", () => {
  const route = {
    connectorId: "mcp",
    resourceId: "connection",
    resourceRevision: 1,
    toolName: "research",
  };
  const oldRun = {
    id: "old-run",
    botId: scope.botId,
    sourceMessageId: "message-1",
    status: "completed",
    createdAt: new Date("2026-01-01"),
    completedAt: new Date("2026-01-01"),
  };
  const request = boundDirectApprovalRequest(
    route,
    { prompt: "Private request must not be exposed" },
    "__rakazoCatalogTool",
  );
  const effect = (id: string, storedRequest: unknown = request) => ({
    id,
    runId: oldRun.id,
    kind: "mcp__connection__research",
    status: "completed",
    createdAt: oldRun.createdAt,
    request: storedRequest,
  });
  function receiptDb() {
    const f = db();
    f.mock.$queryRaw.mockResolvedValue([row(1)]);
    f.mock.run.findMany.mockResolvedValue([oldRun]);
    return f;
  }
  it("does not scan effects or assignments during an ordinary history read", async () => {
    const { mock, prisma } = receiptDb();
    const authorize = vi.fn(async () => true);
    await readHistory(prisma, scope, { messageId: "message-1" }, authorize);
    expect(mock.externalEffect.findMany).not.toHaveBeenCalled();
    expect(mock.externalEffect.findFirst).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
  it("lists bounded authorized metadata, never results or request arguments", async () => {
    const { mock, prisma } = receiptDb();
    mock.externalEffect.findMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => effect(`effect-${i}`)),
    );
    const authorize = vi.fn(async () => true);
    const result = await readHistory(
      prisma,
      scope,
      { messageId: "message-1", linkedRunId: oldRun.id },
      authorize,
    );
    expect(result.runs[0]!.effects.map((e) => e.effectId)).toEqual([
      "effect-0",
      "effect-1",
      "effect-2",
      "effect-3",
      "effect-4",
    ]);
    expect(result.nextEffectId).toBe("effect-4");
    expect(result.receipt).toBeNull();
    expect(JSON.stringify(result)).not.toContain("Private request");
    expect(mock.externalEffect.findFirst).not.toHaveBeenCalled();
    expect(mock.externalEffect.findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        spaceId: scope.spaceId,
        status: "completed",
        runId: { in: [oldRun.id] },
        run: {
          spaceId: scope.spaceId,
          userId: scope.userId,
          threadId: scope.threadId,
          botId: scope.botId,
        },
      },
      select: { id: true, request: true },
    });
    expect(mock.externalEffect.findMany.mock.calls[0]![0].select).not.toHaveProperty("result");
    expect(authorize).toHaveBeenCalledWith(route);
  });
  it("authorizes a selected receipt before fetching its original result and pages UTF-16 exactly", async () => {
    const { mock, prisma } = receiptDb();
    mock.$queryRaw.mockResolvedValue([row(1), row(2)]);
    const original = {
      task_id: "original-task",
      prompt: `Provider-returned text ${"😀证".repeat(4000)}`,
    };
    const text = JSON.stringify(original);
    mock.externalEffect.findFirst.mockImplementation(async ({ select }) =>
      select.result ? { result: original } : effect("selected"),
    );
    let allow!: () => void;
    const allowed = new Promise<void>((resolve) => {
      allow = resolve;
    });
    const authorize = vi.fn(async () => {
      await allowed;
      return true;
    });
    const base = { messageId: "message-1", linkedRunId: oldRun.id, effectId: "selected" };
    const first = readHistory(prisma, scope, base, authorize);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    expect(mock.externalEffect.findFirst).toHaveBeenCalledOnce();
    expect(mock.externalEffect.findFirst.mock.calls[0]![0].select).not.toHaveProperty("result");
    allow();
    let page = await first;
    let joined = "";
    for (;;) {
      const receipt = page.receipt!;
      expect(page.messages[0]!.textOffset).toBe(0);
      expect(mock.run.findMany.mock.lastCall![0].where.OR[0]).toEqual({
        sourceMessageId: { in: ["message-1", "message-2"] },
      });
      expect(receipt.offsetUnit).toBe("utf16");
      expect(receipt.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(10000);
      joined += receipt.text;
      if (receipt.nextTextOffset === null) break;
      expect(receipt.nextTextOffset).toBeGreaterThan(receipt.textOffset);
      page = await readHistory(
        prisma,
        scope,
        { ...base, textOffset: receipt.nextTextOffset },
        authorize,
      );
    }
    expect(joined).toBe(text);
    expect(JSON.parse(joined).prompt).toBe(original.prompt);
    expect(mock.externalEffect.findFirst.mock.calls[1]![0]).toMatchObject({
      where: { id: "selected", AND: [{ request: { equals: request } }] },
      select: { result: true },
    });
  });
  it.each(["denied", "unbound", "secret", "other-connector", "other-bot", "unlinked"])(
    "does not expose %s receipts",
    async (failure) => {
      const { mock, prisma } = receiptDb();
      const denied =
        failure === "unbound" || failure === "secret"
          ? { ...effect("hidden"), kind: "request_secret", request: { password: "Hidden secret" } }
          : failure === "other-connector"
            ? effect(
                "hidden",
                boundDirectApprovalRequest(
                  { ...route, connectorId: "other" },
                  {},
                  "__rakazoCatalogTool",
                ),
              )
            : effect("hidden");
      if (failure === "other-bot")
        mock.run.findMany.mockResolvedValue([{ ...oldRun, botId: "other-bot" }]);
      if (failure === "unlinked") mock.run.findMany.mockResolvedValue([]);
      mock.externalEffect.findMany.mockResolvedValue([denied]);
      mock.externalEffect.findFirst.mockResolvedValue(denied);
      const authorize = vi.fn(async () => failure !== "denied");
      const page = await readHistory(
        prisma,
        scope,
        { messageId: "message-1", linkedRunId: oldRun.id, effectId: "hidden" },
        authorize,
      );
      expect(page.receipt).toBeNull();
      expect(page.runs.flatMap((run) => run.effects)).toEqual([]);
      expect(mock.externalEffect.findFirst.mock.calls.some(([query]) => query.select.result)).toBe(
        false,
      );
      if (failure !== "denied") expect(authorize).not.toHaveBeenCalled();
    },
  );
  it("paginates past rejected routes without disclosing their cursor or metadata", async () => {
    const { mock, prisma } = receiptDb();
    const denied = boundDirectApprovalRequest(
      { ...route, resourceId: "unassigned" },
      {},
      "__rakazoCatalogTool",
    );
    const catalog = catalogApprovalRequest(
      "mcp_execute_tool",
      { id: "connection:research", arguments: {} },
      "__rakazoCatalogTool",
      route,
    );
    mock.externalEffect.findMany
      .mockResolvedValueOnce(Array.from({ length: 6 }, (_, i) => effect(`denied-${i}`, denied)))
      .mockResolvedValueOnce(Array.from({ length: 6 }, (_, i) => effect(`allowed-${i}`, catalog)));
    const page = await readHistory(
      prisma,
      scope,
      { messageId: "message-1", linkedRunId: oldRun.id },
      async (route) => route.resourceId === "connection",
    );
    expect(page.nextEffectId).toBe("allowed-4");
    expect(page.runs[0]!.effects).toHaveLength(5);
    expect(JSON.stringify(page)).not.toContain("denied-");
    expect(mock.externalEffect.findMany.mock.calls[1]![0].where.id).toEqual({ gt: "denied-5" });
  });
  it("keeps missing anchors and receipt-store failures on their original paths", async () => {
    const { mock, prisma } = receiptDb();
    const authorize = vi.fn(async () => true);
    mock.$queryRaw.mockResolvedValue([]);
    expect(
      (await readHistory(prisma, scope, { messageId: "foreign" }, authorize)).receipt,
    ).toBeNull();
    expect(mock.externalEffect.findMany).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    mock.$queryRaw.mockResolvedValue([row(1)]);
    const error = new Error("receipt store unavailable");
    mock.externalEffect.findMany.mockRejectedValue(error);
    await expect(
      readHistory(prisma, scope, { messageId: "message-1", linkedRunId: oldRun.id }, authorize),
    ).rejects.toBe(error);
  });
  it("rejects an exhausted byte budget rather than return a stalled Unicode cursor", async () => {
    const { mock, prisma } = receiptDb();
    mock.$queryRaw.mockResolvedValue([row(1, "")]);
    mock.externalEffect.findFirst.mockImplementation(async ({ select }) =>
      select.result ? { result: "😀" } : effect("selected"),
    );
    const artifact = {
      id: "artifact",
      runId: oldRun.id,
      name: "",
      mimeType: "text/plain",
      size: 1,
    };
    mock.artifact.findMany.mockResolvedValue([artifact]);
    const input = {
      messageId: "message-1",
      linkedRunId: oldRun.id,
      effectId: "selected",
      textOffset: 1,
    };
    const initial = await readHistory(prisma, scope, input, async () => true);
    artifact.name = "a".repeat(10000 - Buffer.byteLength(JSON.stringify(initial)) + 1);
    await expect(readHistory(prisma, scope, input, async () => true)).rejects.toThrow(
      "History metadata exceeds response budget",
    );
  });
});
function sql(mock: ReturnType<typeof db>["mock"], call = 0) {
  return mock.$queryRaw.mock.calls[call]![0] as Prisma.Sql;
}
describe("local history retrieval", () => {
  it("bounds search excerpts and pages by stable sequence", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([row(10), row(9), row(8)]);
    const result = await searchHistory(prisma, scope, {
      query: "exports",
      limit: 2,
      beforeSeq: 20,
    });
    expect(result.messages.map((message) => message.seq)).toEqual([10, 9]);
    expect(result.nextBeforeSeq).toBe(9);
    expect(result.untrusted).toBe(true);
    expect(sql(mock).sql).toContain("plainto_tsquery");
    expect(sql(mock).values).toEqual(
      expect.arrayContaining(["space", "user", "bot", "thread", "exports", 20, 3]),
    );
  });
  it("searches raw and separator-normalized upload names through the same scoped query", async () => {
    const { mock, prisma } = db();
    const query = "ledger-canary.csv";
    const upload = {
      ...row(5),
      blocks: [
        {
          kind: "file",
          artifactId: "original-upload",
          name: query,
          mimeType: "text/csv",
          size: 42,
        },
      ],
    };
    mock.$queryRaw.mockResolvedValue([upload, row(4), row(3)]);
    const result = await searchHistory(
      prisma,
      { ...scope, channelId: "channel", searchBeforeSeq: 50 },
      {
        query,
        beforeSeq: 9999,
        limit: 2,
        after: "2026-01-01T00:00:00Z",
        before: "2026-01-02T00:00:00Z",
      },
    );
    const statement = sql(mock);
    const branches = statement.sql.split("UNION ALL");
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch).toContain('SELECT m.id FROM messages m JOIN threads t ON t.id = m."threadId"');
      for (const predicate of [
        "t.id = ?",
        't."spaceId" = ?',
        't."userId" = ?',
        't."botId" = ?',
        'source.id = r."sourceMessageId"',
        'm."createdAt" < ?',
        'm."createdAt" >= ?',
        "m.seq < ?",
      ])
        expect(branch).toContain(predicate);
    }
    expect(branches[0]).toContain('(@.kind == "subagent").result\')::text) @@');
    expect(branches[0]).not.toContain('(@.kind == "file")');
    const filenameNames =
      "jsonb_path_query_array(m.blocks, '$[*] ? (@.kind == \"file\").name')::text";
    expect(branches[1]!.replace(/\s+/g, " ")).toContain(
      `${filenameNames} || regexp_replace(${filenameNames}, '[[:punct:]]+', ' ', 'g')`,
    );
    expect(statement.sql).toContain("WHERE m.id IN (");
    expect(statement.sql.match(/ORDER BY m.seq DESC LIMIT/g)).toHaveLength(1);
    const branchValues = statement.values.slice(0, -1);
    const firstValues = branchValues.slice(0, branchValues.length / 2);
    expect(firstValues).toEqual(branchValues.slice(branchValues.length / 2));
    expect(firstValues).toEqual(
      expect.arrayContaining([
        "space",
        "user",
        "thread",
        "bot",
        JSON.stringify([{ kind: "channel_message", channelId: "channel" }]),
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-02T00:00:00Z"),
        query,
        50,
      ]),
    );
    expect(statement.values).not.toContain(9999);
    expect(statement.sql).not.toContain(query);
    expect(result.messages[0]).toMatchObject({
      text: "",
      files: [{ blockIndex: 0, artifactId: "original-upload" }],
    });
    expect(result).toMatchObject({
      untrusted: true,
      nextBeforeSeq: 4,
      nextSearch: { query, beforeSeq: 4, limit: 2 },
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    expect(mock.$queryRaw).toHaveBeenCalledOnce();
    expect(mock.artifact.findMany).not.toHaveBeenCalled();
  });
  it("keeps an unfinished broad query actionable after an exhausted narrower query", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw
      .mockResolvedValueOnce([row(7), row(6), row(5), row(4), row(3), row(2)])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row(2), row(1, "Aurora original label ORBIT-731")]);
    const historicalScope = { ...scope, searchBeforeSeq: 50 };
    const broad = await searchHistory(prisma, historicalScope, {
      query: " Aurora ",
      limit: 20,
      beforeSeq: 9999,
      after: "2026-01-01T00:00:00Z",
      before: "2026-01-02T00:00:00Z",
    });
    expect(broad.coverage).toEqual({ scope: "requested_query_and_range", status: "partial" });
    expect(broad.query).toBe("Aurora");
    expect(broad.nextSearch).toEqual({
      query: "Aurora",
      limit: 5,
      beforeSeq: 3,
      after: "2026-01-01T00:00:00Z",
      before: "2026-01-02T00:00:00Z",
    });
    expect(sql(mock).values).toContain(50);
    const narrow = await searchHistory(prisma, historicalScope, { query: "extraction" });
    expect(narrow).toMatchObject({
      query: "extraction",
      coverage: {
        scope: "requested_query_and_range",
        status: "exhausted",
      },
      nextBeforeSeq: null,
      nextSearch: null,
    });
    const older = await searchHistory(prisma, historicalScope, broad.nextSearch!);
    expect(older.messages.some((message) => message.text.includes("ORBIT-731"))).toBe(true);
    expect(older.coverage.status).toBe("exhausted");
    expect(sql(mock, 2).values).toContain(3);
    expect(mock.$queryRaw).toHaveBeenCalledTimes(3);
  });
  it("bounds Unicode search pages without discarding the continuation or original offsets", async () => {
    const { mock, prisma } = db();
    const query = "星".repeat(250);
    mock.$queryRaw.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => row(10 - index, query + "界".repeat(1000))),
    );
    const result = await searchHistory(prisma, scope, { query });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
    expect(result.nextSearch).toEqual({ query, beforeSeq: 6, limit: 5 });
    expect(result.messages).toHaveLength(5);
    for (const message of result.messages) {
      expect(message.text).toBe(
        (query + "界".repeat(1000)).slice(
          message.textOffset,
          message.textOffset + message.text.length,
        ),
      );
      expect(message.nextTextOffset).toBe(message.textOffset + message.text.length);
    }
  });
  it("points search excerpts at the matching portion of an oversized message", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([
      row(1, `${"filler ".repeat(1000)}ledger-indexer final outcome`),
    ]);
    const result = await searchHistory(prisma, scope, { query: "ledger-indexer" });
    expect(result.messages[0]!.text).toContain("ledger-indexer");
    expect(result.messages[0]!.textOffset).toBeGreaterThan(6000);
    const original = `${"filler ".repeat(1000)}ledger-indexer final outcome`;
    expect(result.messages[0]!.text).toBe(
      original.slice(
        result.messages[0]!.textOffset,
        result.messages[0]!.textOffset + result.messages[0]!.text.length,
      ),
    );
  });
  it("restricts channel inputs and bot output using the run source, including neighbors", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValueOnce([row(4)]).mockResolvedValueOnce([row(3), row(4)]);
    await readHistory(prisma, { ...scope, channelId: "group-channel" }, { messageId: "message-4" });
    for (const call of [0, 1]) {
      expect(sql(mock, call).sql).toContain('source.id = r."sourceMessageId"');
      expect(sql(mock, call).sql).toContain('source."threadId" = t.id');
      expect(sql(mock, call).values).toContain(
        JSON.stringify([{ kind: "channel_message", channelId: "group-channel" }]),
      );
    }
    expect(mock.run.findMany.mock.calls[0]![0].where).toMatchObject({
      ...scope,
      sourceMessage: { threadId: "thread", role: "user" },
    });
  });
  it("does not retrieve runs or artifacts for a missing, cleared, or inaccessible anchor", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([]);
    expect((await readHistory(prisma, scope, { messageId: "foreign" })).messages).toEqual([]);
    expect(mock.run.findMany).not.toHaveBeenCalled();
    expect(mock.artifact.findMany).not.toHaveBeenCalled();
    expect(sql(mock).sql).toContain('t."spaceId" =');
    expect(sql(mock).sql).toContain('t."userId" =');
    expect(sql(mock).sql).toContain('t."botId" =');
  });
  it("retains exact file and image references from scoped messages without a run or artifact query", async () => {
    const { mock, prisma } = db();
    const upload = {
      ...row(1, "Read the supplied PDF"),
      blocks: [
        { kind: "image", artifactId: "photo", name: "photo.png", mimeType: "image/png" },
        { kind: "text", text: "Read the supplied PDF" },
        {
          kind: "file",
          artifactId: "original-pdf",
          name: "attachments/other-id.pdf",
          mimeType: "application/pdf",
          size: 42,
        },
      ],
    };
    mock.$queryRaw.mockResolvedValue([upload]);
    const result = await readHistory(prisma, scope, { messageId: upload.id });
    const files = [
      { blockIndex: 0, artifactId: "photo" },
      {
        blockIndex: 2,
        artifactId: "original-pdf",
      },
    ];
    expect(result.messages[0]).toMatchObject({ runId: null, text: "Read the supplied PDF", files });
    expect(result.runs).toEqual([]);
    expect(mock.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mock.run.findMany).toHaveBeenCalledOnce();
    expect(mock.artifact.findMany).not.toHaveBeenCalled();
    const search = await searchHistory(prisma, scope, { query: "supplied" });
    expect(search.messages[0]).toMatchObject({ files });
    expect(mock.$queryRaw).toHaveBeenCalledTimes(3);
    expect(mock.artifact.findMany).not.toHaveBeenCalled();
  });
  it.each([`${"证".repeat(251)}.pdf`, "\u0001".repeat(255)])(
    "keeps all long-name upload references within existing search/read byte bounds (%#)",
    async (name) => {
      const { mock, prisma } = db();
      const originals = Array.from({ length: 5 }, (_, index) => pdfRow(index + 1, name));
      mock.$queryRaw.mockResolvedValueOnce([...originals].reverse());
      const search = await searchHistory(prisma, scope, { query: "supplied" });
      mock.$queryRaw.mockResolvedValueOnce([originals[2]!]).mockResolvedValueOnce(originals);
      const read = await readHistory(prisma, scope, { messageId: originals[2]!.id });
      for (const page of [search, read]) {
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(10000);
        expect(page.messages).toHaveLength(5);
        for (const message of page.messages)
          expect(message.files).toEqual(
            Array.from({ length: 4 }, (_, index) => ({
              blockIndex: index + 1,
              artifactId: `original-artifact-${message.seq}-${index}`,
            })),
          );
      }
      expect(search.nextBeforeSeq).toBeNull();
      expect(read.olderMessageId).toBe(originals[0]!.id);
      expect(read.newerMessageId).toBe(originals[4]!.id);
      expect(read.snapshots.map((snapshot) => snapshot.anchorMessageId)).toEqual(
        originals.map((message) => message.id),
      );
      expect(mock.$queryRaw).toHaveBeenCalledTimes(3);
      expect(mock.artifact.findMany).not.toHaveBeenCalled();
    },
  );
  it.each([`${"证".repeat(251)}.pdf`, "\u0001".repeat(255)])(
    "keeps mixed linked streams and exact upload IDs within the original byte bound (%#)",
    async (name) => {
      const { mock, prisma } = db();
      const anchor = pdfRow(1, name);
      const outcome = { ...pdfRow(10, name), role: "bot", runId: "run-0" };
      const runs = Array.from({ length: 5 }, (_, index) => ({
        id: `run-${index}`,
        sourceMessageId: anchor.id,
        status: "running",
        createdAt: anchor.createdAt,
        completedAt: null,
      }));
      mock.run.findMany.mockResolvedValue(runs);
      mock.artifact.findMany.mockResolvedValue([
        { id: "linked-artifact", runId: runs[0]!.id, name, mimeType: "application/pdf", size: 42 },
      ]);
      mock.$queryRaw
        .mockResolvedValueOnce([anchor])
        .mockResolvedValueOnce([anchor])
        .mockResolvedValueOnce([outcome]);
      const result = await readHistory(prisma, scope, { messageId: anchor.id });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(10000);
      expect(result.runs).toHaveLength(5);
      expect(result.messages[0]!.files).toHaveLength(4);
      expect(result.runs[0]!.outcomes[0]).toMatchObject({
        messageId: outcome.id,
        files: Array.from({ length: 4 }, (_, index) => ({
          blockIndex: index + 1,
          artifactId: `original-artifact-10-${index}`,
        })),
      });
      expect(result.runs[0]!.artifacts[0]).toMatchObject({ id: "linked-artifact", name });
      expect(mock.$queryRaw).toHaveBeenCalledTimes(3);
      expect(mock.run.findMany).toHaveBeenCalledOnce();
      expect(mock.artifact.findMany).toHaveBeenCalledOnce();
    },
  );
  it("reuses originals without inference and invalidates snapshots when content changes", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValueOnce([row(1)]).mockResolvedValueOnce([row(1)]);
    const first = await readHistory(prisma, scope, { messageId: "message-1" });
    mock.$queryRaw
      .mockResolvedValueOnce([row(1)])
      .mockResolvedValueOnce([row(1, "Use streaming exports")]);
    const second = await readHistory(prisma, scope, { messageId: "message-1" });
    expect(first.snapshots[0]!.source).toBe("original");
    expect(first.snapshots[0]!.version).not.toBe(second.snapshots[0]!.version);
    expect(second.snapshots[0]!.topic).toBe("Use streaming exports");
  });
  it("pages inside an oversized original without dumping the entire message", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([
      row(1, `${"a".repeat(2000)}distant exact fact${"b".repeat(2000)}`),
    ]);
    const result = await readHistory(prisma, scope, { messageId: "message-1", textOffset: 2000 });
    expect(result.messages[0]!.text).toContain("distant exact fact");
    expect(result.messages[0]!.text.length).toBe(2000);
    expect(result.messages[0]!.nextTextOffset).toBe(4000);
    expect(result.messages[0]!.textOffset).toBe(2000);
    expect(mock.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it("omits non-text secrets, progress, and commands from retrieved text", () => {
    expect(
      historyMessageText([
        { kind: "text", text: "visible" },
        { kind: "secret_prompt", text: "hidden" },
        { kind: "progress", text: "trace" },
      ]),
    ).toBe("visible");
  });
  it("searches the user's other conversations under the same user and Space boundary", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([
      {
        ...row(7, "Berlin shortlist: exports agreed with the client"),
        id: "other-message",
        threadId: "other-thread",
        botName: "Sourcer",
        groupName: null,
      },
      {
        ...row(3, "Older exports note"),
        id: "older",
        threadId: "group-thread",
        botName: null,
        groupName: "Hiring",
      },
      {
        ...row(2, "exports"),
        id: "oldest",
        threadId: "group-thread",
        botName: null,
        groupName: "Hiring",
      },
    ]);
    const result = await searchHistory(prisma, scope, {
      query: "exports",
      scope: "mine",
      limit: 2,
    });
    const statement = sql(mock);
    expect(statement.sql).toContain("t.id <>");
    expect(statement.sql).toContain('owner."userId" =');
    expect(statement.sql).not.toContain("m.seq <");
    expect(statement.values).toEqual(
      expect.arrayContaining(["space", "user", "bot", "thread", "exports", 3]),
    );
    expect(result.messages).toEqual([
      {
        threadId: "other-thread",
        threadTitle: "Sourcer",
        messageId: "other-message",
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        snippet: "Berlin shortlist: exports agreed with the client",
      },
      expect.objectContaining({
        threadId: "group-thread",
        threadTitle: "Hiring",
        messageId: "older",
      }),
    ]);
    expect(result.messages[0]).not.toHaveProperty("text");
    expect(result.nextSearch).toEqual({
      query: "exports",
      scope: "mine",
      before: "2026-01-01T00:00:00.000Z",
      beforeMessageId: "older",
      limit: 2,
    });
    expect(result.coverage.status).toBe("partial");
    mock.$queryRaw.mockClear();
    await searchHistory(prisma, scope, result.nextSearch!);
    expect(sql(mock).sql).toContain('(m."createdAt", m.id) <');
    expect(sql(mock).values).toEqual(
      expect.arrayContaining([new Date("2026-01-01T00:00:00.000Z"), "older"]),
    );
  });
  it("reads another conversation of the same user as messages only", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw
      .mockResolvedValueOnce([{ ...row(7), id: "other-message", runId: "foreign-run" }])
      .mockResolvedValueOnce([{ ...row(7), id: "other-message", runId: "foreign-run" }]);
    const result = await readHistory(prisma, scope, {
      messageId: "other-message",
      threadId: "other-thread",
    });
    for (const call of [0, 1]) {
      expect(sql(mock, call).sql).toContain("t.id =");
      expect(sql(mock, call).sql).toContain('owner."userId" =');
      expect(sql(mock, call).values).toEqual(
        expect.arrayContaining(["other-thread", "space", "user", "bot"]),
      );
    }
    expect(mock.run.findMany).not.toHaveBeenCalled();
    expect(mock.artifact.findMany).not.toHaveBeenCalled();
    expect(result.messages.map((message) => message.messageId)).toEqual(["other-message"]);
    expect(result.runs).toEqual([]);
    expect(result.snapshots[0]!.openRunIds).toEqual([]);
  });
  it("keeps the current-thread predicate when threadId names this conversation", async () => {
    const { mock, prisma } = db();
    mock.$queryRaw.mockResolvedValue([row(4)]);
    await readHistory(prisma, scope, { messageId: "message-4", threadId: scope.threadId });
    expect(sql(mock).sql).not.toContain('owner."userId"');
    expect(mock.run.findMany).toHaveBeenCalled();
  });
  it("validates dates, query size and pagination before accessing the database", async () => {
    const { mock, prisma } = db();
    await expect(searchHistory(prisma, scope, { query: "x", before: "invalid" })).rejects.toThrow(
      "Invalid history date",
    );
    await expect(searchHistory(prisma, scope, { query: "x", limit: 0 })).rejects.toThrow();
    await expect(searchHistory(prisma, scope, { query: "x", beforeSeq: -1 })).rejects.toThrow();
    await expect(searchHistory(prisma, scope, { query: " " })).rejects.toThrow();
    expect(mock.$queryRaw).not.toHaveBeenCalled();
  });
});
