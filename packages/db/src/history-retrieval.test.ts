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
  };
  return { mock, prisma: mock as unknown as PrismaClient };
}
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
  it("retains exact uploaded-file references from scoped messages without a run or artifact query", async () => {
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
