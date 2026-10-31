import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { EncryptedSecretStore, LocalArtifactStore, ScriptedAgentRuntime } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { bindRecruitingSchedulingOperation, createRecruitingSchedulingPlan } from "@rakazo/db";

/** Deterministic provider data only. The browser still uses real auth, RPC, persistence and tools. */
export class RecruitingGlobalJourneyFixture implements AgentRuntime {
  private prisma!: PrismaClient;
  private readonly fallback = new ScriptedAgentRuntime();
  private readonly campaigns = new Map<
    string,
    {
      id: string;
      name: string;
      email: string;
      person: string;
      leadId: string;
      bookingUid: string;
      start: string;
      end: string;
    }
  >();
  readonly records: Array<{ kind: string; operation: string }> = [];
  constructor(
    private readonly dataDir: string,
    private readonly encryptionKey: string,
  ) {}
  bind(prisma: PrismaClient) {
    this.prisma = prisma;
  }
  describe() {
    return {
      ...this.fallback.describe(),
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    };
  }
  abort(runId: string) {
    return this.fallback.abort(runId);
  }

  async *run(
    request: AgentRunRequest,
    _context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const currentRun = await this.prisma.run.findUniqueOrThrow({ where: { id: request.runId } });
    const sourceMessageId = request.sourceMessageId ?? currentRun.sourceMessageId;
    if (!sourceMessageId) {
      yield { type: "done", text: "Ready for recruiting." };
      return;
    }
    const currentMessage = await this.prisma.message.findUniqueOrThrow({
      where: { id: sourceMessageId },
    });
    const text = Array.isArray(currentMessage.blocks)
      ? currentMessage.blocks
          .flatMap((block) =>
            block &&
            typeof block === "object" &&
            !Array.isArray(block) &&
            block.kind === "text" &&
            typeof block.text === "string"
              ? [block.text]
              : [],
          )
          .join("\n")
      : request.prompt;
    const question = /what interviews are coming up|who is shortlisted|how many replied/i.exec(
      text,
    )?.[0];
    if (question) {
      const operation = question.startsWith("what")
        ? "interviews"
        : question.startsWith("who")
          ? "shortlist"
          : "replies";
      if (!request.executeTool) throw new Error("Native tool host is missing");
      const executionId = `${request.runId}:overview`;
      yield { type: "tool", name: "recruiting_candidates", args: { operation }, executionId };
      const output = (await request.executeTool(
        "recruiting_candidates",
        { operation },
        executionId,
      )) as {
        roles: Array<{ id: string; title: string }>;
        items: Array<{
          roleId: string;
          correspondence?: {
            events: Array<{ kind?: string; title: string; start: string }>;
            emails: Array<{ sender: string }>;
          };
          candidates?: { items: Array<{ name: string }> };
        }>;
        counts?: { messages: number; people: number };
      };
      await request.onToolCompleted?.({
        name: "recruiting_candidates",
        executionId,
        durationMs: 0,
        readOnly: true,
        result: output,
      });
      if (!output) throw new Error("The native account tool produced no data");
      const lines = output.items.flatMap((item) => {
        const role = output.roles.find((role) => role.id === item.roleId)?.title;
        if (operation === "interviews")
          return (
            item.correspondence?.events
              .filter((event) => event.kind !== "availability" && event.title)
              .map((event) => `${role}: ${event.title}`) ?? []
          );
        if (operation === "shortlist")
          return item.candidates?.items.map((person) => `${role}: ${person.name}`) ?? [];
        return item.correspondence?.emails.map((email) => `${role}: ${email.sender}`) ?? [];
      });
      const answer = `${operation === "replies" ? `${output.counts?.messages ?? 0} replies from ${output.counts?.people ?? 0} people. ` : ""}${lines.join("\n")}`;
      this.records.push({ kind: "tool", operation });
      yield { type: "done", text: answer };
      return;
    }
    const title =
      currentMessage.role === "user" ? /Fixture (Engineer|Designer)/.exec(text)?.[0] : undefined;
    if (!title) {
      yield { type: "done", text: "Ready for recruiting." };
      return;
    }
    let thread = await this.prisma.thread.findUniqueOrThrow({ where: { id: request.threadId } });
    if (!thread.activeRecruitingRoleId) {
      if (!request.executeTool) throw new Error("Native tool host is missing");
      const source = await this.prisma.message.findUniqueOrThrow({
        where: { id: request.sourceMessageId! },
      });
      const args = {
        operation: "create",
        title,
        sourceRefs: [
          {
            id: "jd",
            kind: "original_material",
            anchor: { kind: "message", messageId: source.id, locator: "blocks[0].text" },
            readState: "read",
            readAt: source.createdAt.toISOString(),
            quote: text,
          },
        ],
        criteria: [],
        preferences: [],
        definitionQuestions: [],
        intent: { basis: "direct", quote: text },
      };
      const executionId = `${request.runId}:create-role`;
      yield { type: "tool", name: "recruiting_role", args, executionId };
      const result = await request.executeTool("recruiting_role", args, executionId);
      await request.onToolCompleted?.({
        name: "recruiting_role",
        executionId,
        durationMs: 0,
        readOnly: false,
        result,
      });
      if (result && typeof result === "object" && "error" in result)
        throw new Error(JSON.stringify(result));
      thread = await this.prisma.thread.findUniqueOrThrow({ where: { id: request.threadId } });
    }
    if (!thread.activeRecruitingRoleId) throw new Error("Ordinary chat did not create a role");
    const current = await this.prisma.recruitingRole.findUniqueOrThrow({
      where: { id: thread.activeRecruitingRoleId },
    });
    if (current.title !== title) {
      const result = await request.executeTool!(
        "recruiting_role",
        {
          operation: "update",
          roleId: current.id,
          expectedRevision: current.revision,
          title,
          intent: { basis: "direct", quote: text },
        },
        `${request.runId}:title`,
      );
      if (result && typeof result === "object" && "error" in result)
        throw new Error(JSON.stringify(result));
    }
    const revision = await this.prisma.recruitingRole.findUniqueOrThrow({
      where: { id: thread.activeRecruitingRoleId },
    });
    const brief = await request.executeTool!(
      "recruiting_role",
      {
        operation: "update",
        roleId: revision.id,
        expectedRevision: revision.revision,
        brief: {
          fields: [
            {
              key: "Experience",
              value: "Five years of experience",
              origin: "user_instruction",
              state: "known",
              sourceRefIds: [],
            },
          ],
          questions: [],
          rules: [],
          searchFilters: [],
        },
        intent: { basis: "direct", quote: text },
      },
      `${request.runId}:brief`,
    );
    if (brief && typeof brief === "object" && "error" in brief)
      throw new Error(JSON.stringify(brief));
    await this.seed(request, thread.activeRecruitingRoleId, title);
    yield {
      type: "done",
      text: `Saved ${title} records for Morgan ${title.endsWith("Engineer") ? "Reed" : "Lane"}.`,
    };
  }

  private async seed(request: AgentRunRequest, roleId: string, title: string) {
    const role = await this.prisma.recruitingRole.findUniqueOrThrow({ where: { id: roleId } });
    if (await this.prisma.recruitingCandidate.count({ where: { roleId } })) return;
    const run = await this.prisma.run.findUniqueOrThrow({ where: { id: request.runId } });
    const scope = { spaceId: run.spaceId, userId: run.userId };
    const context: AdapterContext = {
      ...scope,
      botId: run.botId,
      runId: run.id,
      operationId: "fixture-provider-data",
      traceId: "fixture-provider-data",
      signal: new AbortController().signal,
    };
    const person = title.endsWith("Engineer") ? "Morgan Reed" : "Morgan Lane";
    const email = title.endsWith("Engineer")
      ? "morgan.reed@example.test"
      : "morgan.lane@example.test";
    const candidateKey = `linkedin:${title.endsWith("Engineer") ? "morgan-reed" : "morgan-lane"}`;
    const campaign = {
      id: randomUUID(),
      name: `${title} sequence`,
      email,
      person,
      leadId: randomUUID(),
      bookingUid: `booking-${roleId}`,
      start: new Date(Date.now() + 172800000).toISOString(),
      end: new Date(Date.now() + 174600000).toISOString(),
    };
    this.campaigns.set(campaign.id, campaign);
    const crew = await this.prisma.bot.findMany({ where: { ...scope, archivedAt: null } });
    const servers: Record<string, string> = {};
    for (const [slug, endpoint, tools] of [
      [
        "journey-mail",
        "https://mcp.instantly.ai/mcp",
        ["get_email", "list_emails", "get_campaign", "list_leads", "get_campaign_analytics"],
      ],
      [
        "journey-calendar",
        "https://mcp.cal.com/mcp",
        ["get_bookings", "get_booking", "get_availability", "create_booking"],
      ],
    ] as const) {
      let server = await this.prisma.mcpServer.findFirst({ where: { ...scope, slug } });
      if (!server) {
        const secret = await new EncryptedSecretStore(this.encryptionKey).put(
          JSON.stringify({ secret: "offline-fixture-key" }),
          context,
        );
        const row = await this.prisma.secret.create({
          data: { id: secret.id, ...scope, kind: "api_key", ciphertext: secret.ciphertext },
        });
        server = await this.prisma.mcpServer.create({
          data: {
            ...scope,
            slug,
            name: slug,
            endpoint,
            transport: "streamable_http",
            secretId: row.id,
          },
        });
      }
      servers[slug] = server.id;
      await this.prisma.botMcpServer.createMany({
        data: crew.map((bot) => ({
          ...scope,
          botId: bot.id,
          serverId: server!.id,
          allowedTools: [...tools],
          allowAllTools: false,
        })),
        skipDuplicates: true,
      });
    }
    const effect = await this.prisma.externalEffect.create({
      data: {
        spaceId: run.spaceId,
        runId: run.id,
        kind: "recruiting_research",
        idempotencyKey: `journey-people:${roleId}`,
        status: "completed",
        request: { operation: "save_search", expectedRoleRevision: role.revision },
        result: { provider: "offline-fixture" },
      },
    });
    const bytes = Buffer.from(
      JSON.stringify({
        kind: "people_search",
        version: 1,
        rows: [
          {
            row: {
              name: person,
              title: "Senior professional",
              company: "Example Labs",
              linkedin_url: `https://www.linkedin.com/in/${candidateKey.split(":")[1]}`,
              email,
              match_score: "88",
            },
          },
        ],
      }),
    );
    const stored = await new LocalArtifactStore(this.dataDir).put(
      { name: "people.json", mimeType: "application/json", bytes },
      context,
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    const artifact = await this.prisma.artifact.create({
      data: {
        ...scope,
        botId: run.botId,
        runId: run.id,
        name: "people.json",
        mimeType: "application/json",
        size: bytes.length,
        hash,
        storageKey: stored.id,
        clientNonce: `recruiting-people-search:${effect.id}`,
      },
    });
    await this.prisma.externalEffect.update({
      where: { id: effect.id },
      data: {
        result: {
          roleId,
          roleRevisionId: role.currentRevisionId,
          outputArtifact: { artifactId: artifact.id, sha256: hash },
        },
      },
    });
    await this.prisma.recruitingCandidatePage.create({
      data: {
        effectId: effect.id,
        roleId,
        roleRevisionId: role.currentRevisionId!,
        artifactId: artifact.id,
        artifactHash: hash,
        observedAt: new Date(),
        rowCount: 1,
      },
    });
    await this.prisma.recruitingCandidate.create({
      data: { roleId, candidateKey, shortlisted: true, shortlistedAt: new Date(), revision: 1 },
    });
    await this.prisma.recruitingCandidateOccurrence.create({
      data: {
        pageId: effect.id,
        rowIndex: 0,
        roleId,
        candidateKey,
        name: person,
        title: "Senior professional",
        company: "Example Labs",
        linkedinUrl: `https://www.linkedin.com/in/${candidateKey.split(":")[1]}`,
        issues: [],
        matchFields: { match_score: "88" },
      },
    });
    await this.prisma.externalEffect.create({
      data: {
        spaceId: run.spaceId,
        runId: run.id,
        kind: "instantly_role_campaign",
        idempotencyKey: `instantly-role-campaign:${servers["journey-mail"]}:${roleId}`,
        status: "completed",
        request: { serverId: servers["journey-mail"], roleId },
        result: {
          campaignId: campaign.id,
          campaignName: campaign.name,
          eaccount: "recruiter@example.test",
          leads: { [candidateKey]: { leadId: campaign.leadId, email } },
        },
      },
    });
    await this.prisma.recruitingReminder.create({
      data: {
        spaceId: run.spaceId,
        ownerUserId: run.userId,
        roleId,
        candidateKey,
        title: `Follow up with ${person}`,
        dueAt: new Date(Date.now() + 86400000),
        createdByBotId: run.botId,
      },
    });
    const feedback = {
      target: "round",
      operation: "scope",
      roleId,
      expectedRoleRevision: role.revision,
      summary: "Client approved the interview shortlist.",
      intent: { basis: "direct", quote: "Client approved the interview shortlist." },
      sourceRefs: [],
    };
    const source = {
      id: "client-feedback",
      kind: "original_material",
      anchor: { kind: "message", messageId: run.sourceMessageId!, locator: "blocks[0].text" },
      readState: "read",
      readAt: new Date().toISOString(),
      quote: "Client approved the interview shortlist.",
    };
    await this.prisma.externalEffect.create({
      data: {
        spaceId: run.spaceId,
        runId: run.id,
        kind: "recruiting_feedback",
        idempotencyKey: `journey-feedback:${roleId}`,
        status: "completed",
        request: feedback,
        result: {
          status: "recorded",
          workspace: { revision: { id: role.currentRevisionId } },
          feedback,
          source,
        },
      },
    });
    // The provider's booking receipt is fixture data; no invitation is sent by the test.
    await this.prisma.run.update({
      where: { id: run.id },
      data: { initialRecruitingRoleRevisionId: role.currentRevisionId },
    });
    const booking = {
      status: "success",
      data: {
        uid: campaign.bookingUid,
        status: "accepted",
        title: `${person} interview`,
        start: campaign.start,
        end: campaign.end,
        attendees: [{ name: person, email }],
        eventTypeId: 1,
      },
    };
    const bookingEffect = await this.prisma.externalEffect.create({
      data: {
        spaceId: run.spaceId,
        runId: run.id,
        kind: "connector",
        idempotencyKey: `journey-booking:${roleId}`,
        status: "intended",
        request: [
          "__rakazoCatalogTool",
          "direct",
          {
            route: {
              connectorId: "mcp",
              resourceId: servers["journey-calendar"],
              resourceRevision: 1,
              toolName: "create_booking",
            },
            args: {
              eventTypeId: 1,
              lengthInMinutes: 30,
              start: campaign.start,
              attendee: { name: person, email, timeZone: "America/Chicago" },
            },
          },
        ],
        result: { structuredContent: booking },
      },
    });
    const nativeRequest = (sourceId: string, toolName: string, args: object) => [
      "__rakazoCatalogTool",
      "direct",
      { route: { connectorId: "mcp", resourceId: sourceId, resourceRevision: 1, toolName }, args },
    ];
    const mail = await this.prisma.externalEffect.create({
      data: {
        spaceId: run.spaceId,
        runId: run.id,
        kind: "get_email",
        idempotencyKey: `journey-mail:${roleId}`,
        status: "completed",
        request: nativeRequest(servers["journey-mail"]!, "get_email", { id: campaign.leadId }),
        result: { structuredContent: this.email(campaign) },
      },
    });
    const available = await this.prisma.externalEffect.create({
      data: {
        spaceId: run.spaceId,
        runId: run.id,
        kind: "get_availability",
        idempotencyKey: `journey-availability:${roleId}`,
        status: "completed",
        request: nativeRequest(servers["journey-calendar"]!, "get_availability", {
          eventTypeId: 1,
          format: "range",
          start: campaign.start,
          end: campaign.end,
        }),
        result: {
          structuredContent: {
            status: "success",
            data: { [campaign.start.slice(0, 10)]: [{ start: campaign.start, end: campaign.end }] },
          },
        },
      },
    });
    const plan = await createRecruitingSchedulingPlan(
      this.prisma,
      { ...scope, email: "fixture@example.test", isDeploymentOwner: false },
      {
        threadId: run.threadId,
        roleId,
        expectedRoleRevision: role.revision,
        originalEmail: {
          threadId: run.threadId,
          roleId,
          emailId: campaign.leadId,
          sourceId: servers["journey-mail"]!,
          providerMessageId: campaign.leadId,
          providerThreadId: `thread-${campaign.leadId}`,
          campaignId: campaign.id,
          eaccount: "recruiter@example.test",
          savedRead: { effectId: mail.id, linkedRunId: run.id, messageId: run.sourceMessageId! },
          sourceName: "journey-mail",
          sender: email,
          subject: "Interested in the interview",
          date: new Date().toISOString(),
          snippet: false,
        },
        candidate: { candidateKey, name: person, email, timeZone: "America/Chicago" },
        interviewer: {
          name: "Recruiter",
          email: "recruiter@example.test",
          timeZone: "America/Chicago",
        },
        calendar: {
          sourceId: servers["journey-calendar"]!,
          sourceRevision: 1,
          eventTypeId: 1,
          availabilityEffectId: available.id,
          start: campaign.start,
          end: campaign.end,
          lengthInMinutes: 30,
        },
      },
    );
    await bindRecruitingSchedulingOperation(
      this.prisma,
      { ...scope, email: "fixture@example.test", isDeploymentOwner: false },
      { threadId: run.threadId, planId: plan.id, operation: "book", effectId: bookingEffect.id },
    );
    await this.prisma.externalEffect.update({
      where: { id: bookingEffect.id },
      data: { status: "completed", result: { structuredContent: booking } },
    });
    await this.prisma.routine.create({
      data: {
        ...scope,
        botId: run.botId,
        threadId: run.threadId,
        name: `${title} follow up`,
        prompt: "Read upcoming interviews and report changes.",
        crons: [],
        active: false,
        notify: false,
      },
    });
    this.records.push({ kind: "role", operation: title });
  }

  readonly fetch =
    (fallback: typeof globalThis.fetch): typeof globalThis.fetch =>
    async (input, init) => {
      const url = urlFromPinnedFetch(input, init);
      if (url.hostname === "api.instantly.ai") {
        const body = parseBody(init?.body);
        const id = url.searchParams.get("id") ?? url.pathname.split("/").at(-1) ?? body.campaign;
        const campaign = this.campaigns.get(id ?? "") ?? [...this.campaigns.values()][0];
        this.records.push({ kind: "mail", operation: url.pathname });
        if (url.pathname.endsWith("analytics/overview"))
          return Response.json({
            emails_sent_count: 4,
            open_count_unique: 3,
            reply_count_unique: 1,
          });
        if (url.pathname.endsWith("leads/list"))
          return Response.json({
            items: campaign
              ? [
                  {
                    id: campaign.leadId,
                    email: campaign.email,
                    first_name: "Morgan",
                    last_name: campaign.person.split(" ")[1],
                    status: 1,
                  },
                ]
              : [],
          });
        if (url.pathname.includes("/emails")) {
          const campaignId =
            url.searchParams.get("campaign_id") ?? url.searchParams.get("campaign") ?? campaign?.id;
          const matched = this.campaigns.get(campaignId!);
          return Response.json({
            items: matched ? [this.email(matched)] : [],
            next_starting_after: null,
          });
        }
        if (url.pathname.includes("/accounts"))
          return Response.json({ items: [{ email: "recruiter@example.test", status: 1 }] });
        return Response.json(
          campaign
            ? {
                id: campaign.id,
                name: campaign.name,
                status: 1,
                stop_on_reply: true,
                email_list: ["recruiter@example.test"],
                sequences: [
                  {
                    steps: [
                      {
                        type: "email",
                        delay: 0,
                        variants: [{ subject: "Your next role", body: "Hello Morgan" }],
                      },
                    ],
                  },
                ],
              }
            : {},
        );
      }
      if (
        [
          "mcp.cal.com",
          "mcp.instantly.ai",
          "mcp.exa.ai",
          "api.autumn.ai",
          "mcp.fullenrich.com",
        ].includes(url.hostname)
      ) {
        const body = parseBody(init?.body);
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "offline-recruiting-provider", version: "1" },
            },
          });
        const tools =
          url.hostname === "mcp.cal.com"
            ? ["get_bookings", "get_booking", "get_availability", "create_booking"]
            : url.hostname === "mcp.instantly.ai"
              ? ["get_email", "list_emails"]
              : [];
        if (body.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              tools: tools.map((name) => ({
                name,
                description: name,
                inputSchema: { type: "object", properties: {}, additionalProperties: true },
                annotations: { readOnlyHint: name !== "create_booking" },
              })),
            },
          });
        this.records.push({ kind: "calendar", operation: body.params?.name ?? "unknown" });
        const data = [...this.campaigns.values()].map((campaign) => ({
          uid: campaign.bookingUid,
          status: "accepted",
          title: `${campaign.person} interview`,
          start: campaign.start,
          end: campaign.end,
          attendees: [{ name: campaign.person, email: campaign.email }],
          eventTypeId: 1,
        }));
        const result = { status: "success", data };
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          },
        });
      }
      return fallback(input, init);
    };
  private email(campaign: { id: string; email: string; person: string; leadId: string }) {
    return {
      id: campaign.leadId,
      timestamp_created: new Date().toISOString(),
      timestamp_email: new Date().toISOString(),
      message_id: `<${campaign.leadId}@example.test>`,
      subject: "Interested in the interview",
      from_address_email: campaign.email,
      to_address_email_list: "recruiter@example.test",
      body: { text: `Hi, this is ${campaign.person}. I would like to interview.` },
      organization_id: "11111111-1111-4111-8111-111111111111",
      campaign_id: campaign.id,
      lead: campaign.email,
      lead_id: campaign.leadId,
      eaccount: "recruiter@example.test",
      ue_type: 2,
      thread_id: `thread-${campaign.leadId}`,
    };
  }
}

function urlFromPinnedFetch(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    const host = new Headers(init?.headers).get("host");
    if (host) url.host = host;
  }
  return url;
}

type FixtureRequest = {
  campaign?: string;
  id?: string | number;
  method?: string;
  params?: { protocolVersion?: string; name?: string };
};
function parseBody(body: RequestInit["body"] | undefined): FixtureRequest {
  if (body instanceof ArrayBuffer)
    return JSON.parse(new TextDecoder().decode(new Uint8Array(body)));
  if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body));
  return typeof body === "string" ? JSON.parse(body) : {};
}
