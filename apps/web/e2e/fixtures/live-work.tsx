import { I18nProvider } from "@lingui/react";
import type { ProductEvent, ThreadSnapshot } from "@rakazo/contracts";
import type { WorkSession } from "@rakazo/core";
import { observeWorkSession, specialistWorkLabel, workStageKind } from "@rakazo/core";
import { createRoot } from "react-dom/client";
import { CollaborationMarker } from "../../src/components/ai/CollaborationMarker";
import { LiveWork } from "../../src/components/LiveWork";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { reduceThreadSnapshot } from "../../src/lib/thread-events";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const live = params.get("phase") !== "done";
// Main reads the role and hands the search to Sourcer, whose run carries the turn on.
const staged = params.has("stage");

const USER_TEXT = "Find staff backend engineers in Seattle for the platform role.";
const REPLY_TEXT = "Here are ten people to review for the platform role.";

// The run started 42 seconds ago; a finished turn took 1m 12s.
const startedAt = Date.now() - 42_000;
const iso = (offsetSeconds: number) => new Date(startedAt + offsetSeconds * 1000).toISOString();

function event(
  seq: number,
  type: string,
  seconds: number,
  payload = {},
  runId = staged && seq > 6 ? "run-2" : "run-1",
): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: runId === "run-2" ? "bot-2" : "bot-1",
    seq,
    type,
    runId,
    createdAt: iso(seconds),
    payload,
  } as ProductEvent;
}

const stagedStart: ProductEvent[] = [
  event(1, "thread.message.created", -1, {
    messageId: "user-1",
    role: "user",
    blocks: [{ kind: "text", text: USER_TEXT }],
  }),
  event(2, "run.started", 0, { trigger: "user" }),
  event(3, "agent.tool.called", 1, { name: "recruiting_role", executionId: "e1" }),
  event(4, "agent.tool.completed", 2, { name: "recruiting_role", executionId: "e1" }),
  event(5, "agent.tool.called", 3, { name: "handoff_to_bot", executionId: "e2" }),
  event(6, "agent.tool.completed", 4, { name: "handoff_to_bot", executionId: "e2" }),
  event(7, "run.started", 5, { trigger: "follow_up" }),
  event(8, "run.completed", 5, {}, "run-1"),
  event(9, "agent.tool.called", 6, { name: "mcp__autumn__research", executionId: "e3" }),
  event(10, "agent.tool.completed", 20, { name: "mcp__autumn__research", executionId: "e3" }),
  event(11, "agent.tool.called", 21, { name: "recruiting_candidates", executionId: "e4" }),
  event(12, "agent.tool.completed", 30, { name: "recruiting_candidates", executionId: "e4" }),
  event(13, "agent.tool.called", 31, { name: "mcp__autumn__get_rows", executionId: "e5" }),
];

/** The same events the shell folds: a role read, two searches, then one in flight. */
const events: ProductEvent[] = staged
  ? [
      ...stagedStart,
      ...(live
        ? []
        : [
            event(14, "agent.tool.completed", 60, {
              name: "mcp__autumn__get_rows",
              executionId: "e5",
            }),
            event(15, "thread.message.created", 72, {
              messageId: "reply-1",
              role: "bot",
              blocks: [{ kind: "text", text: REPLY_TEXT }],
            }),
            event(16, "run.completed", 72),
          ]),
    ]
  : [
      event(1, "thread.message.created", -1, {
        messageId: "user-1",
        role: "user",
        blocks: [{ kind: "text", text: USER_TEXT }],
      }),
      event(2, "run.started", 0, { trigger: "user" }),
      event(3, "agent.tool.called", 1, { name: "recruiting_role", executionId: "e1" }),
      event(4, "agent.tool.completed", 2, {
        name: "recruiting_role",
        executionId: "e1",
        ...(params.has("outcomes") ? { outcome: "error" } : {}),
      }),
      event(5, "agent.tool.called", 3, { name: "mcp__autumn__research", executionId: "e2" }),
      event(6, "agent.tool.completed", 20, {
        name: "mcp__autumn__research",
        executionId: "e2",
        ...(params.has("outcomes") ? { outcome: "succeeded", lookup: { found: 3 } } : {}),
      }),
      event(7, "agent.tool.called", 21, { name: "recruiting_candidates", executionId: "e3" }),
      event(8, "agent.tool.completed", 30, { name: "recruiting_candidates", executionId: "e3" }),
      event(9, "agent.tool.called", 31, { name: "mcp__autumn__get_rows", executionId: "e4" }),
      ...(params.get("state")
        ? [
            event(10, "thread.progress", 40, {
              text: "",
              activity: true,
              phase: params.get("state"),
              ...(params.get("state") === "thinking" ? { summary: "Reviewing the search" } : {}),
            }),
          ]
        : []),
      ...(live
        ? []
        : [
            event(10, "agent.tool.completed", 60, {
              name: "mcp__autumn__get_rows",
              executionId: "e4",
            }),
            event(11, "thread.message.created", 72, {
              messageId: "reply-1",
              role: "bot",
              blocks: [{ kind: "text", text: REPLY_TEXT }],
            }),
            event(12, "run.completed", 72),
          ]),
    ];

let snapshot: ThreadSnapshot = {
  botId: "bot-1",
  threadId: "thread-1",
  cursor: 0,
  messages: [],
  olderCursor: null,
  run: null,
};
let session: WorkSession | null = null;
for (const item of events) {
  snapshot = reduceThreadSnapshot(snapshot, item) ?? snapshot;
  session = observeWorkSession(
    session,
    {
      runs: snapshot.activeRuns ?? (snapshot.run ? [snapshot.run] : []),
      messages: snapshot.messages,
    },
    item.createdAt,
  );
}

function ThreadFixture() {
  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground md:px-8 md:py-8">
      <div data-testid="transcript" className="flex flex-col gap-3">
        <div className="flex justify-end">
          <div className="max-w-[74%] rounded-[20px] bg-primary px-[18px] py-3 text-[15.5px] text-primary-foreground">
            {USER_TEXT}
          </div>
        </div>
        {live ? null : (
          <div className="flex justify-start">
            <div
              data-testid="message-bot-bubble"
              className="max-w-[74%] rounded-[20px] bg-muted px-[18px] py-3 text-[15.5px] leading-[1.5]"
            >
              {REPLY_TEXT}
            </div>
          </div>
        )}
        {params.has("specialist") ? (
          <CollaborationMarker
            ariaLabel={specialistWorkLabel(live ? "running" : "completed")}
            label={specialistWorkLabel(live ? "running" : "completed")}
            color="slate"
            identity="specialist"
            status={live ? "running" : "completed"}
          />
        ) : null}
        <LiveWork
          session={session}
          live={live}
          label="Working…"
          stageKind={(botId) => workStageKind(botId === "bot-2" ? { name: "Sourcer" } : undefined)}
        />
      </div>
    </main>
  );
}

void bootstrapI18n("en").then(() => {
  createRoot(document.getElementById("root")!).render(
    <I18nProvider i18n={i18n}>
      <ThreadFixture />
    </I18nProvider>,
  );
});
