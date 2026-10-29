import type { Page } from "@playwright/test";
import type { ThreadMessage } from "@rakazo/contracts";

// Exercises the real App and Shell routes. All records are synthetic; every API
// request is intercepted here, and external resources are blocked.
export async function recruitingChatFixture(
  page: Page,
  options: {
    feedback?: "empty" | "loading" | "error" | "saved";
    running?: boolean;
    failed?: boolean;
    appearance?: "light" | "dark";
    developer?: boolean;
    workState?: "thinking" | "retrying" | "compacting";
  } = {},
) {
  const createdAt = options.running
    ? new Date(Date.now() - 42_000).toISOString()
    : "2026-10-23T10:00:00.000Z";
  const bot = {
    id: "bot-fixture",
    spaceId: "space-fixture",
    name: "Main",
    title: "Recruiter",
    color: "ink",
    description: "",
    instructions: "",
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    threadId: "thread-fixture",
    preview: "",
    status: "waiting_input",
    notifyOnFinish: false,
    computerMode: "team",
    autoSpeak: false,
    voiceId: null,
    spawnKey: "recruiting:user-fixture:main",
  };
  const members = [{ botId: bot.id, name: bot.name, color: bot.color, status: bot.status }];
  const group = {
    id: "group-fixture",
    spaceId: bot.spaceId,
    name: "Senior Perception Engineer",
    pinned: false,
    sectionId: null,
    archivedAt: null,
    members,
    threadId: bot.threadId,
    preview: "",
    unread: false,
  };
  const message = (id: string, role: "user" | "bot", text: string): ThreadMessage => ({
    id,
    threadId: bot.threadId,
    botId: role === "bot" ? bot.id : undefined,
    role,
    seq: 1,
    createdAt,
    blocks: [{ kind: "text", text }],
  });
  const messages: ThreadMessage[] = [
    message(
      "intro",
      "bot",
      "I’ve saved the role requirements. We can refine the search together as you review the calibration profiles.",
    ),
    message(
      "feedback-request",
      "user",
      "Focus on people who have shipped perception systems on real robots. Research alone isn’t enough. Keep the location flexible.",
    ),
    message(
      "long-response",
      "bot",
      "**Here’s how I’ll refine the search**\n\nI’ll prioritize evidence of production ownership: deploying perception models, diagnosing failures in the field, and working with the systems team to improve reliability.\n\n- **Keep:** hands-on sensor fusion across camera, lidar, or radar.\n- **Look for:** ownership from model development through deployment and monitoring.\n- **Clarify:** whether adjacent autonomous systems experience is enough.\n\nI’ll preserve the existing candidates and the evidence already collected. Where a profile does not establish production ownership, I’ll leave that as an unknown rather than infer it from a job title.\n\n**Calibration approval is still needed before scaling the search.** Your feedback refines the criteria; it does not replace that decision.",
    ),
    {
      ...message("calibration-question", "bot", ""),
      runId: "run-fixture",
      blocks: [
        {
          kind: "ask",
          approvalEffectId: "approval-fixture",
          text: "Approve this calibration direction before expanding the search?",
          status: "pending",
          actions: [
            { id: "allow", label: "Approve calibration" },
            { id: "deny", label: "Keep refining" },
          ],
        },
      ],
    },
  ];
  if (options.workState) {
    messages.splice(
      messages.findIndex((message) => message.id === "calibration-question"),
      1,
    );
    messages.push(
      {
        ...message("subagent:specialist", "bot", ""),
        blocks: [
          {
            kind: "subagent",
            agentId: "internal-specialist",
            name: "Internal worker",
            task: "private task",
            status: "running",
          },
        ],
      },
      {
        ...message("progress:run-fixture", "bot", ""),
        runId: "run-fixture",
        blocks: [
          { kind: "steps", steps: [{ label: "Recruiting role", count: 1 }] },
          {
            kind: "progress",
            text: "",
            activity: true,
            phase: options.workState,
            summary: options.workState === "thinking" ? "Reviewing the search" : undefined,
          },
        ],
      },
    );
  }
  if (options.developer)
    messages.push({
      ...message("tool-fixture", "bot", ""),
      runId: "run-fixture",
      blocks: [
        { kind: "steps", steps: [{ label: "Read file", count: 1 }], durationMs: 1200 },
        { kind: "text", text: "The saved criteria are ready for your review." },
      ],
    });
  const thread = {
    threadId: bot.threadId,
    groupId: group.id,
    groupName: group.name,
    members,
    cursor: 4,
    messages,
    olderCursor: null,
    run: {
      id: "run-fixture",
      botId: bot.id,
      threadId: bot.threadId,
      taskId: "task-fixture",
      status: options.failed ? "failed" : options.running ? "running" : "waiting_input",
      trigger: "user",
      routineId: null,
      error: options.failed ? "Synthetic source unavailable" : null,
      startedAt: createdAt,
      createdAt,
    },
  };
  const role = { id: "role-fixture", title: group.name, revision: 2 };
  const workspace = {
    role,
    crmTarget: null,
    revision: {
      id: "revision-fixture",
      roleId: role.id,
      revision: 2,
      sourceRefs: [],
      definitionQuestions: [],
      preferences: [],
      criteria: [
        "Shipped perception systems on robots",
        "Sensor fusion across camera, lidar or radar",
        "Flexible location",
      ].map((statement, i) => ({
        id: `criterion-${i}`,
        priority: i === 2 ? "soft" : "hard",
        expression: { kind: "atom", id: `atom-${i}`, statement },
        sourceRefs: [],
        definitionQuestions: [],
      })),
    },
  };
  const me = {
    userId: "user-fixture",
    spaceId: bot.spaceId,
    isDeploymentOwner: options.developer ?? false,
    ticketBoardEnabled: false,
    billingEnabled: false,
  };
  const spaces = [
    {
      id: bot.spaceId,
      name: "Recruiting",
      hasContent: true,
      bots: [bot],
      groups: [group],
      botSections: [],
    },
  ];
  const bootstrap = {
    me,
    bots: [bot],
    groups: [group],
    botSections: [],
    spaces,
    archivedBots: [],
    archivedGroups: [],
    thread,
    routines: [],
  };
  const calls: { procedure: string; input: Record<string, unknown> }[] = [];
  const unexpected: string[] = [];
  let releaseSend: (() => void) | undefined;
  const sendReady = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  let releaseFeedback: (() => void) | undefined;
  const feedbackReady = new Promise<void>((resolve) => {
    releaseFeedback = resolve;
  });
  let feedbackState = options.feedback ?? "empty";

  await page.addInitScript(
    ({ appearance, developer }) => {
      if (localStorage.getItem("rakazo.showToolActivity") === null)
        localStorage.setItem("rakazo.showToolActivity", developer ? "on" : "off");
      localStorage.setItem("rakazo.uiAppearance", appearance);
    },
    { appearance: options.appearance ?? "light", developer: options.developer ?? false },
  );
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return route.abort();
    if (url.pathname === "/api/auth/get-session")
      return route.fulfill({
        json: {
          user: {
            id: me.userId,
            name: "Synthetic recruiter",
            email: "recruiter@example.test",
            emailVerified: true,
            createdAt,
            updatedAt: createdAt,
          },
          session: {
            id: "session-fixture",
            userId: me.userId,
            expiresAt: "2099-01-01T00:00:00Z",
            token: "synthetic",
            createdAt,
            updatedAt: createdAt,
          },
        },
      });
    if (url.pathname === "/api/auth/account-security")
      return route.fulfill({ status: 404, body: "" });
    if (url.pathname === "/api/auth/capabilities")
      return route.fulfill({ json: { emailPassword: true, billing: false } });
    if (!url.pathname.startsWith("/rpc/")) {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/novnc/"))
        return route.abort();
      return route.continue();
    }
    const procedure = url.pathname.slice(5);
    const input = route.request().postDataJSON()?.json ?? {};
    calls.push({ procedure, input });
    const reply = (json: unknown) => route.fulfill({ json: { json } });
    switch (procedure) {
      case "approvalRules/list":
        return reply([]);
      case "autoReview/get":
        return reply({ enabled: false });
      case "bootstrap":
        return reply(bootstrap);
      case "me":
        return reply(me);
      case "spaces/list":
        return reply({ spaces, current: { bots: [bot], groups: [group], botSections: [] } });
      case "threads/get":
        return reply(thread);
      case "threads/markRead":
        return reply({ ok: true });
      case "threads/head":
        return reply(null);
      case "threads/subscribe":
      case "events/subscribe":
        return route.fulfill({ contentType: "text/event-stream", body: ": fixture\n\n" });
      case "threads/send":
        await sendReady;
        return reply({ runId: "sent-fixture" });
      case "threads/stop":
        return reply({ ok: true });
      case "recruiting/roleCandidates":
        return reply({ candidates: [], cursor: null, total: 0, hasMore: false });
      case "recruiting/readView":
        return reply({ ok: true });
      case "recruiting/getWorkspace":
        return reply(workspace);
      case "recruiting/calibrationRound":
        return reply({ round: null });
      case "recruiting/correspondence":
        return reply({
          status: "not_checked",
          checkedAt: null,
          connections: [],
          emails: [],
          events: [],
          contacts: [],
          partial: false,
        });
      case "recruiting/listFeedback":
        if (feedbackState === "loading") await feedbackReady;
        if (feedbackState === "error")
          return route.fulfill({
            status: 500,
            json: {
              json: { code: "INTERNAL_SERVER_ERROR", message: "Synthetic feedback failure" },
            },
          });
        return reply({
          feedback:
            feedbackState === "saved"
              ? [
                  {
                    id: "feedback-fixture",
                    choice: "hold",
                    candidateKey: null,
                    createdAt,
                    source: {
                      quote:
                        "Prioritize people who shipped perception systems. Keep location flexible.",
                    },
                    feedback: { kind: "criteria", expectedRoleRevision: 2 },
                  },
                ]
              : [],
          nextCursor: null,
        });
      case "recruiting/listCandidates":
        return reply({
          candidates: [],
          nextCursor: null,
          counts: { total: 0, shortlisted: 0, unscored: 0 },
          source: null,
        });
      case "recruiting/listAssessments":
        return reply([]);
      case "recruiting/listResearch":
        return reply({ tasks: [], actions: [], observations: [] });
      case "recruiting/listQuestions":
        return reply({ questions: [] });
      case "recruiting/crmData":
        return reply({ operation: "memberships", sources: [] });
      case "voice/status":
        return reply(null);
      case "memory/providerConfig":
        return reply(null);
      case "recruiting/roleSetup":
        return reply({
          ready: false,
          attention: {
            kind: "question",
            threadId: bot.threadId,
            cardId: "calibration-question",
            createdAt,
          },
          items: [],
        });
      case "messaging/status":
        return reply({ enabled: false, providers: [] });
      case "bots/listArchived":
      case "groups/listArchived":
      case "routines/list":
      case "models/credentials":
      case "models/list":
      case "skills/list":
      case "agentSkills/list":
      case "connections/list":
      case "connections/catalog":
      case "memory/list":
        return reply([]);
      default:
        unexpected.push(procedure);
        return route.fulfill({
          status: 501,
          json: { json: { message: `Unhandled fixture request: ${procedure}` } },
        });
    }
  });
  return {
    calls,
    unexpected,
    releaseSend: () => releaseSend?.(),
    recoverFeedback: () => {
      feedbackState = "empty";
      releaseFeedback?.();
    },
    appendReply: () => {
      thread.messages.push(
        message("new-reply", "bot", "The saved criteria are ready for your review."),
      );
      thread.cursor += 1;
    },
  };
}
