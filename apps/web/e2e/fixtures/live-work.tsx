import { I18nProvider } from "@lingui/react";
import type { ProductEvent, ThreadSnapshot } from "@rakazo/contracts";
import type { WorkSession } from "@rakazo/core";
import { observeWorkSession } from "@rakazo/core";
import { createRoot } from "react-dom/client";
import { LiveWork } from "../../src/components/LiveWork";
import { bootstrapI18n, i18n } from "../../src/lib/i18n";
import { reduceThreadSnapshot } from "../../src/lib/thread-events";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const live = params.get("phase") !== "done";

const USER_TEXT = "Find staff backend engineers in Seattle for the platform role.";
const REPLY_TEXT = "Here are ten people to review for the platform role.";

// The run started 42 seconds ago; a finished turn took 1m 12s.
const startedAt = Date.now() - 42_000;
const iso = (offsetSeconds: number) => new Date(startedAt + offsetSeconds * 1000).toISOString();

function event(seq: number, type: string, seconds: number, payload = {}): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "workspace-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type,
    runId: "run-1",
    createdAt: iso(seconds),
    payload,
  } as ProductEvent;
}

/** The same events the shell folds: a role read, two searches, then one in flight. */
const events: ProductEvent[] = [
  event(1, "thread.message.created", -1, {
    messageId: "user-1",
    role: "user",
    blocks: [{ kind: "text", text: USER_TEXT }],
  }),
  event(2, "run.started", 0, { trigger: "user" }),
  event(3, "agent.tool.called", 1, { name: "recruiting_role", executionId: "e1" }),
  event(4, "agent.tool.completed", 2, { name: "recruiting_role", executionId: "e1" }),
  event(5, "agent.tool.called", 3, { name: "mcp__autumn__research", executionId: "e2" }),
  event(6, "agent.tool.completed", 20, { name: "mcp__autumn__research", executionId: "e2" }),
  event(7, "agent.tool.called", 21, { name: "recruiting_candidates", executionId: "e3" }),
  event(8, "agent.tool.completed", 30, { name: "recruiting_candidates", executionId: "e3" }),
  event(9, "agent.tool.called", 31, { name: "mcp__autumn__get_rows", executionId: "e4" }),
  ...(live
    ? []
    : [
        event(10, "agent.tool.completed", 60, { name: "mcp__autumn__get_rows", executionId: "e4" }),
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
        <LiveWork session={session} live={live} label="Working…" />
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
