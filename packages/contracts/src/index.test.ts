import { describe, expect, it } from "vitest";
import {
  AskRequestedSchema,
  appContract,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
  CLOUDFLARE_AI_GATEWAY_PROVIDER_ID,
  CreateBotInput,
  CreateGroupInput,
  CreateRoutineInput,
  canReactToThreadMessage,
  McpServerConfigInput,
  MessageBlock,
  ModelConnectInputSchema,
  ModelOAuthBeginSchema,
  normalizeCreateBotProfile,
  ProductEventSchema,
  ProductEventType,
  parseAskFormResponse,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
  ReorderBotsInput,
  RunActivityRowSchema,
  RunSchema,
  SidebarBotStateSchema,
  UpdateBotInput,
  UpdateGroupInput,
  usableModelId,
} from "./index.js";

describe("contracts", () => {
  it("accepts an explicit group addressing mode without changing direct bot sends", () => {
    const schema = appContract.threads.send["~orpc"].inputSchema!;
    for (const addressing of ["coordinator", "mentions"] as const) {
      const input = { groupId: "group-1", text: "@Sourcer ask @everyone", addressing };
      expect(schema.parse(input)).toEqual(input);
      expect(schema.safeParse({ botId: "bot-1", text: "Hello", addressing }).success).toBe(false);
    }
    expect(schema.parse({ botId: "bot-1", text: "Hello" })).toEqual({
      botId: "bot-1",
      text: "Hello",
    });
    expect(schema.parse({ groupId: "group-1", text: "Hello" })).toEqual({
      groupId: "group-1",
      text: "Hello",
    });
    expect(schema.safeParse({ groupId: "group-1", text: "Hello", addressing: "all" }).success).toBe(
      false,
    );
  });

  it("accepts an optional interject flag on threads.send", () => {
    const schema = appContract.threads.send["~orpc"].inputSchema!;
    const input = { botId: "bot-1", text: "Stop, use the other file", interrupt: true };
    expect(schema.parse(input)).toEqual(input);
    expect(schema.safeParse({ botId: "bot-1", text: "Hi", interrupt: "yes" }).success).toBe(false);
  });

  it("accepts one optional bootstrap target without dropping group identity", () => {
    const schema = appContract.bootstrap["~orpc"].inputSchema!;
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ botId: "bot-1" })).toEqual({ botId: "bot-1" });
    expect(schema.parse({ groupId: "group-1" })).toEqual({ groupId: "group-1" });
    expect(schema.safeParse({ botId: "bot-1", groupId: "group-1" }).success).toBe(false);
  });
  it("accepts pre-registered MCP OAuth clients without allowing protocol or secret URL parameters", () => {
    const schema = appContract.mcp.oauth.begin["~orpc"].inputSchema!;
    const input = {
      serverId: "server-1",
      redirectUri: "https://app.example.test/mcp/oauth/callback",
      oauth: {
        clientId: "registered-client",
        clientSecret: "private-client-secret",
        scopes: ["mail.readonly"],
        authorizationParams: { access_type: "offline", prompt: "consent" },
      },
    };
    expect(schema.parse(input)).toEqual(input);
    for (const key of [
      "state",
      "client_id",
      "client_secret",
      "redirect_uri",
      "response_type",
      "response_mode",
      "request",
      "request_uri",
      "code_challenge",
      "code_challenge_method",
      "resource",
      "scope",
      "access_token",
    ]) {
      expect(
        schema.safeParse({
          ...input,
          oauth: { ...input.oauth, authorizationParams: { [key]: "override" } },
        }).success,
      ).toBe(false);
    }
    expect(
      schema.safeParse({
        ...input,
        oauth: { ...input.oauth, authorizationParams: { prompt: input.oauth.clientSecret } },
      }).success,
    ).toBe(false);
  });

  it("keeps an exact run selector on the existing authorized thread stop target", () => {
    const schema = appContract.threads.stop["~orpc"].inputSchema!;
    expect(schema.parse({ groupId: "group-1", runId: "run-1" })).toEqual({
      groupId: "group-1",
      runId: "run-1",
    });
    expect(schema.parse({ botId: "bot-1" })).toEqual({ botId: "bot-1" });
    expect(schema.safeParse({ runId: "run-1" }).success).toBe(false);
    expect(schema.safeParse({ groupId: "group-1", runId: "" }).success).toBe(false);
  });

  it("validates standard elicitation form fields and structured decisions", () => {
    const schema = AskRequestedSchema.parse({
      type: "object",
      properties: {
        website: { type: "string", format: "uri" },
        regions: {
          type: "array",
          minItems: 1,
          items: {
            anyOf: [
              { const: "north", title: "North" },
              { const: "south", title: "South" },
            ],
          },
        },
        count: { type: "integer", minimum: 1, maximum: 3 },
      },
      required: ["website", "regions", "count"],
    });
    const content = { website: "https://example.com", regions: ["north", "south"], count: 2 };
    expect(parseAskFormResponse(schema, { action: "accept", content })).toEqual({
      action: "accept",
      content,
    });
    for (const invalid of [
      { ...content, website: "invalid" },
      { ...content, regions: ["unknown"] },
      { ...content, count: 1.5 },
      { ...content, extra: true },
      { website: content.website },
    ])
      expect(() => parseAskFormResponse(schema, { action: "accept", content: invalid })).toThrow();
    expect(parseAskFormResponse(schema, { action: "cancel" })).toEqual({ action: "cancel" });
    expect(parseAskFormResponse(schema, { action: "decline" })).toEqual({ action: "decline" });
    expect(() => parseAskFormResponse(schema, { action: "cancel", content })).toThrow();
    const defaults = AskRequestedSchema.parse({
      type: "object",
      properties: {
        label: { type: "string", default: "Suggested" },
        optional: { type: "boolean", default: true },
      },
      required: ["label"],
    });
    expect(() => parseAskFormResponse(defaults, { action: "accept", content: {} })).toThrow();
    expect(
      parseAskFormResponse(defaults, { action: "accept", content: { label: "Chosen" } }),
    ).toEqual({ action: "accept", content: { label: "Chosen" } });
    expect(
      MessageBlock.safeParse({
        kind: "ask",
        text: "Form",
        requestedSchema: schema,
        input: "secret",
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "ask",
        text: "Form",
        requestedSchema: schema,
        approvalEffectId: "effect-1",
      }).success,
    ).toBe(false);
  });
  it("accepts structured live activity progress", () => {
    expect(MessageBlock.parse({ kind: "progress", text: "Using browser", activity: true })).toEqual(
      { kind: "progress", text: "Using browser", activity: true },
    );
  });

  it("parses bounded model image limits", () => {
    expect(parseModelMaxImagesPerPrompt("1")).toBe(1);
    expect(parseModelMaxImagesPerPrompt("1000")).toBe(1000);
    expect(parseModelMaxImagesPerPrompt("0")).toBeUndefined();
    expect(parseModelMaxImagesPerPrompt("1001")).toBeUndefined();
    expect(parseModelMaxImagesPerPrompt("1.5")).toBeUndefined();
    expect(parseModelMaxImagesPerPrompt("1", false)).toBeUndefined();
  });

  it("parses bounded model output-token limits", () => {
    expect(parseModelMaxTokens("1")).toBe(1);
    expect(parseModelMaxTokens("131072")).toBe(131072);
    expect(parseModelMaxTokens("0")).toBeUndefined();
    expect(parseModelMaxTokens("131073")).toBeUndefined();
    expect(parseModelMaxTokens("1.5")).toBeUndefined();
  });

  it("parses bounded model context-window limits", () => {
    expect(parseModelContextWindow("1")).toBe(1);
    expect(parseModelContextWindow("1048576")).toBe(1048576);
    expect(parseModelContextWindow("1050000")).toBe(1050000);
    expect(parseModelContextWindow("2147483647")).toBe(2147483647);
    expect(parseModelContextWindow("0")).toBeUndefined();
    expect(parseModelContextWindow("2147483648")).toBeUndefined();
    expect(parseModelContextWindow("1.5")).toBeUndefined();
  });

  it("treats null, undefined, and their string forms as an unset model id", () => {
    expect(usableModelId(null)).toBeNull();
    expect(usableModelId(undefined)).toBeNull();
    expect(usableModelId("null")).toBeNull();
    expect(usableModelId("undefined")).toBeNull();
    expect(usableModelId("  null  ")).toBeNull();
    expect(usableModelId("")).toBeNull();
    expect(usableModelId("   ")).toBeNull();
    expect(usableModelId("claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  it("rejects maxTokens larger than contextWindow on model connect", () => {
    const invalid = ModelConnectInputSchema.safeParse({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "arbitrary-model",
      maxTokens: 131072,
      contextWindow: 1,
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.some((issue) => issue.path[0] === "maxTokens")).toBe(true);
    }

    const valid = ModelConnectInputSchema.safeParse({
      provider: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      modelId: "arbitrary-model",
      maxTokens: 8192,
      contextWindow: 32768,
    });
    expect(valid.success).toBe(true);
  });

  it("validates each Cloudflare routing id and allows an update to send only one", () => {
    const provider = CLOUDFLARE_AI_GATEWAY_PROVIDER_ID;
    expect(
      ModelConnectInputSchema.safeParse({
        provider,
        apiKey: "cf-test-key-value",
      }).success,
    ).toBe(true);
    expect(
      ModelConnectInputSchema.safeParse({
        provider,
        maxTokens: 1024,
        accountId: "acct9999",
      }).success,
    ).toBe(true);
    expect(
      ModelConnectInputSchema.safeParse({
        provider,
        maxTokens: 1024,
        gatewayId: "gateway-2",
      }).success,
    ).toBe(true);
    const unsafeAccount = ModelConnectInputSchema.safeParse({
      provider,
      apiKey: "cf-test-key-value",
      accountId: "../account",
      gatewayId: "gateway-1",
    });
    expect(unsafeAccount.success).toBe(false);
    if (!unsafeAccount.success) {
      expect(unsafeAccount.error.issues.some((issue) => issue.path[0] === "accountId")).toBe(true);
      expect(
        unsafeAccount.error.issues.some(
          (issue) => issue.message === CLOUDFLARE_AI_GATEWAY_CONFIG_MESSAGE,
        ),
      ).toBe(true);
    }
    const unsafeGateway = ModelConnectInputSchema.safeParse({
      provider,
      maxTokens: 1024,
      gatewayId: "gateway/1",
    });
    expect(unsafeGateway.success).toBe(false);
    if (!unsafeGateway.success) {
      expect(unsafeGateway.error.issues.some((issue) => issue.path[0] === "gatewayId")).toBe(true);
    }
    expect(
      ModelConnectInputSchema.safeParse({
        provider,
        apiKey: "cf-test-key-value",
        accountId: "acct1234",
        gatewayId: "gateway-1",
      }).success,
    ).toBe(true);
    expect(
      ModelConnectInputSchema.safeParse({ provider: "openai", apiKey: "sk-test-key-123" }).success,
    ).toBe(true);
  });

  it("lets a built-in connection update maxTokens without a new API key", () => {
    expect(
      ModelConnectInputSchema.safeParse({ provider: "anthropic", maxTokens: 8192 }).success,
    ).toBe(true);
    expect(
      ModelConnectInputSchema.safeParse({ provider: "anthropic", maxTokens: null }).success,
    ).toBe(true);
    expect(ModelConnectInputSchema.safeParse({ provider: "anthropic" }).success).toBe(false);
    expect(
      ModelConnectInputSchema.safeParse({ provider: "anthropic", apiKey: "short" }).success,
    ).toBe(false);
  });

  it("accepts optional persisted duration only on valid steps blocks", () => {
    expect(
      MessageBlock.parse({
        kind: "steps",
        steps: [{ label: "Run tests", count: 1 }],
        durationMs: 103_000,
      }),
    ).toMatchObject({ durationMs: 103_000 });
    expect(MessageBlock.safeParse({ kind: "steps", steps: [], durationMs: -1 }).success).toBe(
      false,
    );
  });

  it("limits reactions to persisted non-channel messages", () => {
    expect(
      canReactToThreadMessage({ id: "message-1", blocks: [{ kind: "text", text: "hi" }] }),
    ).toBe(true);
    expect(
      canReactToThreadMessage({ id: "subagent:agent-1", blocks: [{ kind: "text", text: "hi" }] }),
    ).toBe(false);
    expect(
      canReactToThreadMessage({
        id: "message-2",
        blocks: [
          {
            kind: "channel_message",
            provider: "sendblue",
            channelId: "channel-1",
            fromAddress: "+15555550100",
            fromLabel: "Pat",
            text: "hi",
          },
        ],
      }),
    ).toBe(false);
  });

  it("parses bot create input", () => {
    const parsed = CreateBotInput.parse({ name: "Chief" });
    expect(parsed.title).toBe("");
    expect(parsed.notifyOnFinish).toBe(true);
  });

  it("normalizes bot creation fields without losing the longer instruction copy", () => {
    const profile = normalizeCreateBotProfile({
      name: `  ${"N".repeat(100)}  `,
      title: `  ${"T".repeat(BOT_TITLE_MAX_LENGTH + 10)}  `,
      description: `  ${"D".repeat(BOT_INSTRUCTIONS_MAX_LENGTH + 10)}  `,
    });

    expect(profile.name).toHaveLength(80);
    expect(profile.title).toHaveLength(BOT_TITLE_MAX_LENGTH);
    expect(profile.description).toHaveLength(BOT_DESCRIPTION_MAX_LENGTH);
    expect(profile.instructions).toHaveLength(BOT_INSTRUCTIONS_MAX_LENGTH);
  });

  it("rejects unknown built-in tool names and keeps a known denylist", () => {
    expect(
      UpdateBotInput.parse({ botId: "bot-1", disabledBuiltinTools: ["web_search", "web_search"] })
        .disabledBuiltinTools,
    ).toEqual(["web_search"]);
    const unknown = UpdateBotInput.safeParse({
      botId: "bot-1",
      disabledBuiltinTools: ["not_a_tool"],
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues.some((issue) => issue.message.includes("not_a_tool"))).toBe(true);
    }
  });

  it("accepts the same title limit when creating and updating bots", () => {
    const title = "T".repeat(BOT_TITLE_MAX_LENGTH);
    expect(CreateBotInput.safeParse({ name: "Chief", title }).success).toBe(true);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", title }).success).toBe(true);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", title: `${title}T` }).success).toBe(false);
  });

  it("normalizes bot names and rejects whitespace-only values at the contract boundary", () => {
    expect(CreateBotInput.parse({ name: "  Chief  " }).name).toBe("Chief");
    expect(UpdateBotInput.parse({ botId: "bot-1", name: "  Atlas  " }).name).toBe("Atlas");
    expect(UpdateBotInput.parse({ botId: "bot-1", title: "  Lead researcher  " }).title).toBe(
      "Lead researcher",
    );
    expect(
      UpdateBotInput.parse({ botId: "bot-1", description: "  Concise briefs.  " }).description,
    ).toBe("Concise briefs.");
    expect(CreateBotInput.safeParse({ name: "   " }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", name: "   " }).success).toBe(false);
  });

  it("rejects partial model override clears on bot update", () => {
    expect(UpdateBotInput.safeParse({ botId: "bot-1", modelId: null }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId: "bot-1", modelProvider: null }).success).toBe(false);
    expect(
      UpdateBotInput.safeParse({ botId: "bot-1", modelProvider: null, modelId: null }).success,
    ).toBe(true);
    expect(
      UpdateBotInput.safeParse({
        botId: "bot-1",
        modelProvider: "xai",
        modelId: "grok-4.6",
      }).success,
    ).toBe(true);
  });

  it("normalizes group names and rejects duplicate members", () => {
    expect(CreateGroupInput.parse({ name: "  Draft team  ", botIds: ["bot-1", "bot-2"] })).toEqual({
      name: "Draft team",
      botIds: ["bot-1", "bot-2"],
    });
    expect(CreateGroupInput.safeParse({ name: "   ", botIds: ["bot-1", "bot-2"] }).success).toBe(
      false,
    );
    expect(
      UpdateGroupInput.safeParse({ groupId: "group-1", botIds: ["bot-1", "bot-1"] }).success,
    ).toBe(false);
  });

  it("keeps model OAuth start results mode-specific", () => {
    const shared = {
      loginId: "login-1",
      provider: "anthropic",
      verificationUri: "https://example.com/authorize",
      expiresInSeconds: 900,
    };
    expect(ModelOAuthBeginSchema.safeParse({ ...shared, mode: "auth-url" }).success).toBe(true);
    expect(ModelOAuthBeginSchema.safeParse({ ...shared, mode: "device-code" }).success).toBe(false);
    expect(
      ModelOAuthBeginSchema.safeParse({ ...shared, mode: "device-code", userCode: "ABCD-1234" })
        .success,
    ).toBe(true);
    expect(
      ModelOAuthBeginSchema.safeParse({
        ...shared,
        mode: "auth-url",
        verificationUri: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  it("exposes the product rpc surface", () => {
    expect(appContract.models.beginOAuth).toBeTruthy();
    expect(appContract.bootstrap).toBeTruthy();
    expect(appContract.models.completeOAuth).toBeTruthy();
    expect(appContract.bots.create).toBeTruthy();
    expect(appContract.bots.reorder).toBeTruthy();
    expect(appContract.bots.archive).toBeTruthy();
    expect(appContract.bots.restore).toBeTruthy();
    expect(appContract.bots.remove).toBeTruthy();
    expect(appContract.spaces.rename).toBeTruthy();
    expect(appContract.spaces.remove).toBeTruthy();
    expect(appContract.spaces.subscribe).toBeTruthy();
    expect(appContract.botSections.list).toBeTruthy();
    expect(appContract.botSections.create).toBeTruthy();
    expect(appContract.botSections.update).toBeTruthy();
    expect(appContract.threads.subscribe).toBeTruthy();
    expect(appContract.threads.clear).toBeTruthy();
    expect(appContract.voice.prepare).toBeTruthy();
    expect(appContract.externalConversations.updatePolicy).toBeTruthy();
    expect(appContract.agentSecrets.list).toBeTruthy();
    expect(appContract.agentSecrets.put).toBeTruthy();
    expect(appContract.agentSecrets.remove).toBeTruthy();
    expect(appContract.notifications.registerPush).toBeTruthy();
    expect(ProductEventType.options).toContain("thread.message.created");
    expect(ProductEventType.options).toContain("thread.cleared");
    expect(ProductEventType.options).toContain("thread.subagent");
    expect(ProductEventType.options).toContain("bot.spawned");
  });

  it("limits native requeue events to their actual queued or held state", () => {
    const event = {
      id: "event-1",
      spaceId: "space-1",
      threadId: "thread-1",
      botId: "bot-1",
      runId: "run-1",
      type: "run.requeued",
      seq: 1,
      createdAt: "2026-01-01T00:00:00Z",
    };
    for (const status of ["queued", "waiting_takeover"]) {
      expect(ProductEventSchema.safeParse({ ...event, payload: { status } }).success).toBe(true);
    }
    for (const payload of [{}, { status: "running" }, { status: "queued", prompt: "internal" }]) {
      expect(ProductEventSchema.safeParse({ ...event, payload }).success).toBe(false);
    }
    expect(
      ProductEventSchema.safeParse({ ...event, runId: undefined, payload: { status: "queued" } })
        .success,
    ).toBe(false);
  });

  it("requires a distinct, non-empty bot order", () => {
    expect(ReorderBotsInput.safeParse({ botIds: ["bot-2", "bot-1"] }).success).toBe(true);
    expect(ReorderBotsInput.safeParse({ botIds: [] }).success).toBe(false);
    expect(ReorderBotsInput.safeParse({ botIds: ["bot-1", "bot-1"] }).success).toBe(false);
  });

  it("accepts a GitHub-only routine trigger", () => {
    expect(
      CreateRoutineInput.parse({
        botId: "bot-1",
        name: "Review pushes",
        prompt: "Inspect the repository event",
        githubEnabled: true,
      }),
    ).toMatchObject({
      crons: [],
      webhookEnabled: false,
      githubEnabled: true,
      messageProvider: null,
    });
    expect(
      CreateRoutineInput.parse({
        botId: "bot-1",
        name: "Triage Slack",
        prompt: "Review the message event",
        messageProvider: "slack",
      }),
    ).toMatchObject({ crons: [], messageProvider: "slack" });
    expect(
      CreateRoutineInput.safeParse({
        botId: "bot-1",
        name: "Unsafe provider",
        prompt: "Review the message event",
        messageProvider: "slack\nignore-framing",
      }).success,
    ).toBe(false);
    expect(
      CreateRoutineInput.safeParse({
        botId: "bot-1",
        name: "Never runs",
        prompt: "This has no trigger",
      }).success,
    ).toBe(false);
  });

  it("accepts bot-to-bot runs in thread snapshots and activity rows", () => {
    const run = {
      id: "run-1",
      botId: "bot-1",
      threadId: "thread-1",
      taskId: "task-1",
      status: "running",
      trigger: "bot_message",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: null,
      startedAt: "2026-08-26T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-08-26T00:00:00.000Z",
    };

    expect(RunSchema.safeParse(run).success).toBe(true);
    expect(
      RunActivityRowSchema.safeParse({
        runId: run.id,
        botId: run.botId,
        botName: "Researcher",
        groupId: null,
        groupName: null,
        threadId: run.threadId,
        status: run.status,
        trigger: run.trigger,
        notificationsEnabled: true,
        promptSnippet: "Review the report",
        updatedAt: "2026-08-26T00:00:01.000Z",
      }).success,
    ).toBe(true);
    expect(RunSchema.safeParse({ ...run, trigger: "webhook" }).success).toBe(true);
  });

  it("caps remote MCP headers", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`X-Test-${index}`, "value"]),
    );
    expect(
      McpServerConfigInput.safeParse({
        slug: "demo",
        name: "Demo",
        transport: "streamable_http",
        endpoint: "https://mcp.example.test",
        headers,
      }).success,
    ).toBe(false);
  });

  it("allows localhost HTTP MCP endpoints and other HTTP(S) URLs without credentials", () => {
    const base = {
      slug: "demo",
      name: "Demo",
      transport: "streamable_http" as const,
      headers: {},
    };
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://127.0.0.1:3000/mcp" }).success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://localhost:8123/api/mcp" })
        .success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://10.0.0.8:3927/mcp" }).success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://localhost:8123/api/mcp#" })
        .success,
    ).toBe(false);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "http://example.test/mcp" }).success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "https://mcp.example.test/mcp" }).success,
    ).toBe(true);
    expect(
      McpServerConfigInput.safeParse({ ...base, endpoint: "ftp://mcp.example.test/mcp" }).success,
    ).toBe(false);
  });

  it("rejects oversized chart data wherever it is embedded", () => {
    const rows = Array.from({ length: 5_001 }, (_, index) => index);

    expect(
      MessageBlock.safeParse({ kind: "chart", name: "outer", spec: {}, data: rows }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "spec",
        spec: { data: rows },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "marks",
        spec: { marks: [{ data: rows }] },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "combined",
        spec: { marks: [{ data: rows.slice(0, 2_500) }] },
        data: rows.slice(0, 2_501),
      }).success,
    ).toBe(false);
  });
});

describe("SidebarBotStateSchema", () => {
  const updatedAt = "2026-08-15T12:00:00.000Z";

  it("accepts a bot frame and a heartbeat frame", () => {
    expect(
      SidebarBotStateSchema.parse({
        botId: "bot-1",
        status: "running",
        unread: true,
        preview: "Working on it",
        updatedAt,
      }),
    ).toEqual({
      botId: "bot-1",
      status: "running",
      unread: true,
      preview: "Working on it",
      updatedAt,
    });
    expect(SidebarBotStateSchema.parse({ updatedAt })).toEqual({ updatedAt });
  });

  it("rejects unknown statuses and oversized previews", () => {
    expect(
      SidebarBotStateSchema.safeParse({ botId: "bot-1", status: "leased", updatedAt }).success,
    ).toBe(false);
    expect(
      SidebarBotStateSchema.safeParse({ botId: "bot-1", preview: "x".repeat(121), updatedAt })
        .success,
    ).toBe(false);
  });
});
