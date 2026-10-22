import { createHash } from "node:crypto";
import type { AdapterContext, ConnectorCall, ConnectorEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutumnFileConnector } from "./autumn-files.js";

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const context: AdapterContext = {
    operationId: "operation-1",
    traceId: "trace-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    runId: "run-1",
    signal: new AbortController().signal,
  };
  const server = {
    id: "server-1",
    slug: "research",
    transport: "streamable_http",
    endpoint: "https://api.autumn.ai/mcp",
    enabled: true,
    revision: 1,
    secretId: "secret-1",
  };
  const assignment = {
    botId: context.botId,
    spaceId: context.spaceId,
    userId: context.userId,
    serverId: server.id,
    allowAllTools: false,
    allowedTools: ["reply"],
    server,
  };
  const bytes = Buffer.from("Original notes\r\n中文\n");
  const artifact = {
    id: "artifact-1",
    spaceId: context.spaceId,
    userId: context.userId,
    botId: "another-bot",
    runId: context.runId,
    name: "notes.md",
    mimeType: "text/markdown",
    storageKey: "stored-original",
    hash: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    rootArtifactId: null,
  };
  const prisma = {
    recruitingResearchTask: {
      findFirst: vi.fn(async ({ where }) =>
        where.providerTaskId === "task-1" &&
        where.mcpServerId === server.id &&
        where.serverRevision === server.revision &&
        where.role.userId === context.userId &&
        where.role.spaceId === context.spaceId &&
        where.createdByRun.userId === context.userId &&
        where.createdByRun.spaceId === context.spaceId
          ? { id: "native-task-1" }
          : null,
      ),
    },
    externalEffect: { findMany: vi.fn(async () => []) },
    botMcpServer: {
      findMany: vi.fn(async () => [assignment]),
      findFirst: vi.fn(async ({ where }) =>
        where.botId === assignment.botId &&
        where.spaceId === assignment.spaceId &&
        where.userId === assignment.userId &&
        where.serverId === assignment.serverId &&
        server.enabled
          ? assignment
          : null,
      ),
    },
    secret: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === server.secretId &&
        where.spaceId === context.spaceId &&
        where.userId === context.userId
          ? { id: server.secretId, ciphertext: "encrypted-material" }
          : null,
      ),
    },
    artifact: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === artifact.id &&
        where.spaceId === artifact.spaceId &&
        where.userId === artifact.userId
          ? artifact
          : null,
      ),
    },
    $queryRaw: vi.fn(async (_query: unknown) => [] as Array<{ id: string }>),
  };
  const secrets = { load: vi.fn(async () => JSON.stringify({ secret: "offline-api-key" })) };
  const artifacts = { get: vi.fn(async () => bytes) };
  const uploadUrl = "https://uploads.example.test/object?signature=private-upload-signature";
  const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.autumn.ai/upload-url")
      return Response.json({ upload_url: uploadUrl, key: "object", filename: "stored-notes.md" });
    if (url === uploadUrl) return new Response(null, { status: 200 });
    if (url === "https://api.autumn.ai/validate-upload")
      return Response.json({ filename: "validated-notes.md", rows: null, fields: null });
    if (url === "https://api.autumn.ai/task/task-1/continue")
      return Response.json(
        { task_id: "task-1", status: "accepted", queued_count: 1 },
        { status: 202 },
      );
    throw new Error("Unexpected test request");
  });
  const connector = new AutumnFileConnector(prisma as never, secrets as never, artifacts as never, {
    fetch,
    resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
  });
  const call: ConnectorCall = {
    tool: "autumn__research__continue_with_file",
    executionId: "effect-1",
    route: {
      connectorId: "autumn-files",
      resourceId: server.id,
      resourceRevision: server.revision,
      toolName: "continue_with_file",
    },
    args: { task_id: "task-1", artifactId: artifact.id, message: "Use the complete saved notes." },
  };
  const execute = async (overrides: Partial<AdapterContext> = {}) => {
    const events: ConnectorEvent[] = [];
    for await (const event of connector.execute(call, { ...context, ...overrides }))
      events.push(event);
    return events;
  };
  return {
    connector,
    context,
    server,
    assignment,
    artifact,
    bytes,
    prisma,
    secrets,
    artifacts,
    fetch,
    uploadUrl,
    call,
    execute,
  };
}

describe("native Autumn file continuation", () => {
  it("uses the configured official platform credential without copying a personal secret", async () => {
    vi.stubEnv("AUTUMN_API_KEY", "platform-service-key");
    const f = fixture();
    Object.assign(f.server, { secretId: null });
    expect(await f.execute()).toEqual([expect.objectContaining({ type: "result" })]);
    expect(f.secrets.load).not.toHaveBeenCalled();
    expect(new Headers(f.fetch.mock.calls[0]![1]!.headers).get("authorization")).toBe(
      "Bearer platform-service-key",
    );
  });
  it("rejects a foreign task before reading the file or dispatching upload requests", async () => {
    const f = fixture();
    f.call.args.task_id = "foreign-task";
    expect(await f.execute()).toEqual([expect.objectContaining({ type: "error" })]);
    expect(f.artifacts.get).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("uploads exact saved bytes without API auth and continues the same task with its validated filename", async () => {
    const f = fixture();
    const events = await f.execute();
    expect(f.fetch).toHaveBeenCalledTimes(4);
    const requests = f.fetch.mock.calls;
    expect(requests.map(([url]) => String(url))).toEqual([
      "https://api.autumn.ai/upload-url",
      f.uploadUrl,
      "https://api.autumn.ai/validate-upload",
      "https://api.autumn.ai/task/task-1/continue",
    ]);
    expect(JSON.parse(String(requests[0]![1]!.body))).toEqual({
      task_id: "task-1",
      filename: "notes.md",
    });
    expect(requests[1]![1]!.method).toBe("PUT");
    expect(requests[1]![1]!.body).toEqual(f.bytes);
    const putHeaders = new Headers(requests[1]![1]!.headers);
    expect(putHeaders.get("content-type")).toBe("application/octet-stream");
    expect(putHeaders.has("authorization")).toBe(false);
    expect(putHeaders.has("x-api-key")).toBe(false);
    for (const index of [0, 2, 3])
      expect(new Headers(requests[index]![1]!.headers).get("authorization")).toBe(
        "Bearer offline-api-key",
      );
    expect(JSON.parse(String(requests[2]![1]!.body))).toEqual({
      task_id: "task-1",
      filename: "stored-notes.md",
    });
    expect(JSON.parse(String(requests[3]![1]!.body))).toEqual({
      message: f.call.args.message,
      input_files: ["validated-notes.md"],
      wait: false,
    });
    expect(events).toEqual([
      {
        type: "result",
        data: {
          file: {
            artifactId: f.artifact.id,
            sha256: f.artifact.hash,
            size: f.bytes.byteLength,
            filename: "validated-notes.md",
            rows: null,
            fields: null,
          },
          continuation: { httpStatus: 202, task_id: "task-1", status: "accepted", queued_count: 1 },
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("offline-api-key");
    expect(JSON.stringify(events)).not.toContain("private-upload-signature");
    expect(f.artifacts.get).toHaveBeenCalledOnce();
    expect(f.prisma.$queryRaw).toHaveBeenCalledOnce();
  });

  it.each([
    ["Recovered exclusion input", "text/plain", "Recovered exclusion input.txt"],
    ["Saved report", "Text/Markdown; charset=utf-8", "Saved report.md"],
    ["Saved rows", "text/csv; charset=utf-8", "Saved rows.csv"],
    ["notes.markdown", "text/plain", "notes.markdown"],
    ["notes.csv", "text/plain", "notes.csv.txt"],
  ])(
    "derives the upload filename from saved MIME without changing the artifact (%s)",
    async (name, mimeType, filename) => {
      const f = fixture();
      Object.assign(f.artifact, { name, mimeType });
      const original = { ...f.artifact };

      expect(await f.execute()).toEqual([expect.objectContaining({ type: "result" })]);

      expect(JSON.parse(String(f.fetch.mock.calls[0]![1]!.body))).toEqual({
        task_id: "task-1",
        filename,
      });
      expect(f.fetch.mock.calls[1]![1]!.body).toEqual(f.bytes);
      expect(f.artifact).toEqual(original);
      expect(createHash("sha256").update(f.bytes).digest("hex")).toBe(original.hash);
    },
  );

  it("discovers a local write tool only for the assigned official API-key connection without network calls", async () => {
    const f = fixture();
    expect(await f.connector.discoverTools(f.context)).toEqual([
      expect.objectContaining({
        name: f.call.tool,
        readOnly: false,
        description: expect.stringContaining("Local Autumn REST"),
        route: f.call.route,
      }),
    ]);
    f.assignment.allowedTools = ["get_rows"];
    expect(await f.connector.discoverTools(f.context)).toEqual([]);
    f.assignment.allowedTools = ["reply"];
    f.secrets.load.mockResolvedValue(
      JSON.stringify({ oauth: { tokens: { access_token: "oauth" } } }),
    );
    expect(await f.connector.discoverTools(f.context)).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.artifacts.get).not.toHaveBeenCalled();
  });

  it.each([
    { headers: { "X-API-Key": "offline-api-key" } },
    { headers: { Authorization: "Bearer offline-api-key" } },
  ])("accepts the existing explicit static API-key header %j", async (material) => {
    const f = fixture();
    f.secrets.load.mockResolvedValue(JSON.stringify(material));
    expect(await f.execute()).toEqual([expect.objectContaining({ type: "result" })]);
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    { spaceId: "other-space" },
    { userId: "other-user" },
    { botId: "other-bot" },
    { botId: undefined },
  ])("rejects an unassigned actor/Space/bot before storage or network %j", async (context) => {
    const f = fixture();
    expect(await f.execute(context)).toEqual([expect.objectContaining({ type: "error" })]);
    expect(f.secrets.load).not.toHaveBeenCalled();
    expect(f.artifacts.get).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each(["disabled", "foreign endpoint", "stale revision", "reply denied", "missing credential"])(
    "rejects %s before storage or network",
    async (condition) => {
      const f = fixture();
      if (condition === "disabled") f.server.enabled = false;
      if (condition === "foreign endpoint") f.server.endpoint = "https://other.example.test/mcp";
      if (condition === "stale revision") f.server.revision++;
      if (condition === "reply denied") f.assignment.allowedTools = ["get_rows"];
      if (condition === "missing credential") f.prisma.secret.findFirst.mockResolvedValue(null);
      expect(await f.execute()).toEqual([expect.objectContaining({ type: "error" })]);
      expect(f.artifacts.get).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { oauth: { tokens: { access_token: "oauth-access-token" } } },
    { secret: "offline-api-key", oauth: {} },
    { headers: { Cookie: "unrelated-session" } },
    { secret: "offline-api-key", headers: { "X-API-Key": "another-account-key" } },
  ])("does not reuse OAuth or ambiguous credentials %j", async (material) => {
    const f = fixture();
    f.secrets.load.mockResolvedValue(JSON.stringify(material));
    expect(await f.execute()).toEqual([expect.objectContaining({ type: "error" })]);
    expect(f.artifacts.get).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "foreign actor",
    "internal context",
    "corrupt bytes",
    "unsupported MIME",
    "malformed path",
  ])("retains the native artifact boundary for %s", async (condition) => {
    const f = fixture();
    if (condition === "foreign actor") f.artifact.userId = "another-user";
    if (condition === "internal context")
      f.prisma.$queryRaw.mockResolvedValue([{ id: f.artifact.id }]);
    if (condition === "corrupt bytes") f.artifact.hash = "0".repeat(64);
    if (condition === "unsupported MIME") f.artifact.mimeType = "application/octet-stream";
    if (condition === "malformed path") f.artifact.name = "folder/notes.md";
    expect(await f.execute()).toEqual([expect.objectContaining({ type: "error" })]);
    expect(f.fetch).not.toHaveBeenCalled();
    if (condition === "foreign actor" || condition === "internal context")
      expect(f.artifacts.get).not.toHaveBeenCalled();
  });

  it("blocks an unsafe presigned URL using the native URL policy without sending a PUT", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(
      Response.json({ upload_url: "http://127.0.0.1/private", filename: "notes.md" }),
    );
    expect(await f.execute()).toEqual([
      expect.objectContaining({ type: "error", outcome: "uncertain" }),
    ]);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("rejects redirects instead of forwarding the API credential", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
    );
    expect(await f.execute()).toEqual([
      expect.objectContaining({ type: "error", outcome: "uncertain" }),
    ]);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("returns a definite HTTP rejection without marking a rejected continuation uncertain", async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) =>
      String(input).endsWith("/continue")
        ? Response.json({ error: "invalid_request" }, { status: 400 })
        : original(input, init),
    );
    expect(await f.execute()).toEqual([
      { type: "error", message: expect.stringContaining("HTTP 400") },
    ]);
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });

  it("leaves a lost continuation response uncertain, redacted and unretried", async () => {
    const f = fixture();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith("/continue")) throw new Error(`offline-api-key ${f.uploadUrl}`);
      return original(input, init);
    });
    const events = await f.execute();
    expect(events).toEqual([expect.objectContaining({ type: "error", outcome: "uncertain" })]);
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(events)).not.toMatch(/offline-api-key|private-upload-signature/);
  });

  it("does not issue requests for an already cancelled call", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await f.execute({ signal: controller.signal })).toEqual([
      expect.objectContaining({ type: "error" }),
    ]);
    expect(f.artifacts.get).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("waits for an issued upload to settle after cancellation and never validates or continues", async () => {
    const f = fixture();
    const controller = new AbortController();
    let resolveUpload!: (response: Response) => void;
    const pendingUpload = new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    });
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((input, init) =>
      String(input) === f.uploadUrl ? pendingUpload : original(input, init),
    );
    let settled = false;
    const pending = f.execute({ signal: controller.signal }).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveUpload(new Response(null, { status: 200 }));
    expect(await pending).toEqual([
      expect.objectContaining({ type: "error", outcome: "uncertain" }),
    ]);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["reply revoked", "server revision changed", "credential rotated"])(
    "rechecks the same authorization before validation when %s",
    async (condition) => {
      const f = fixture();
      const original = f.fetch.getMockImplementation()!;
      f.fetch.mockImplementation(async (input, init) => {
        const result = await original(input, init);
        if (String(input) === f.uploadUrl) {
          if (condition === "reply revoked") f.assignment.allowedTools = [];
          if (condition === "server revision changed") f.server.revision++;
          if (condition === "credential rotated")
            f.secrets.load.mockResolvedValue(JSON.stringify({ secret: "replacement-account-key" }));
        }
        return result;
      });
      expect(await f.execute()).toEqual([
        expect.objectContaining({ type: "error", outcome: "uncertain" }),
      ]);
      expect(f.fetch).toHaveBeenCalledTimes(2);
    },
  );
});
