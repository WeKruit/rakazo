// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import type {
  RecruitingAssessment,
  RecruitingAssessmentSnapshot,
  RecruitingAssessmentSourceRef,
  RecruitingQuestion,
  RecruitingRole,
  RecruitingRoleRevision,
} from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readRightPanelState, writeRightPanelState } from "../lib/right-panel-state";

const api = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  listAssessments: vi.fn(),
  listResearch: vi.fn(),
  listQuestions: vi.fn(),
  answer: vi.fn(),
  createRole: vi.fn(),
  bindRole: vi.fn(),
  reviseRole: vi.fn(),
  list: vi.fn(),
  history: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  getById: vi.fn(),
  search: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    recruiting: api,
    memory: api,
    artifacts: api,
    threads: { answer: api.answer },
    search: { query: api.search },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
}));
vi.mock("../components/ArtifactFileCard", () => ({
  ArtifactFileCard: ({
    name,
    artifactId,
    target,
  }: {
    name: string;
    artifactId: string;
    target: { botId?: string; groupId?: string };
  }) => (
    <span data-artifact-id={artifactId} data-bot-id={target.botId} data-group-id={target.groupId}>
      {name}
    </span>
  ),
}));

import { RecruitingPanel } from "./RecruitingPanel";

function rawResultsFixture(actionId = "raw-action", name = "Synthetic raw candidate") {
  const rows = [{ name, label: "Strong Match", _sources: { s1: "https://example.test/profile" } }];
  const snapshot = {
    version: 1,
    taskId: "raw-task",
    actionId,
    operation: "rows",
    effectId: `read-${actionId}`,
    request: { task_id: "raw-provider-task", cursor: "  real-cursor==  " },
    providerResult: { rows },
    observation: {
      deliveryState: "accepted",
      providerTaskId: "raw-provider-task",
      observedProviderState: null,
      done: null,
      providerApplicationConfirmed: false,
      automaticRetry: false,
      usage: null,
      rows,
      nextCursor: null,
    },
  };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const reference = {
    artifactId: `artifact-${actionId}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const task = {
    id: "raw-task",
    roleId: "role-1",
    providerTaskId: "raw-provider-task",
    state: "completed",
  };
  const action = {
    id: actionId,
    taskId: task.id,
    roleRevisionId: "old-revision",
    kind: "continue",
    deliveryState: "accepted",
    observedProviderState: "completed",
    runId: "original-run",
    sourceMessageId: "original-message",
    clientNonce: `nonce-${actionId}`,
    requestArtifact: { artifactId: `request-${actionId}`, sha256: "b".repeat(64) },
    contextArtifact: { artifactId: `context-${actionId}`, sha256: "c".repeat(64) },
    receiptArtifact: null,
    recallScope: null,
    cursor: null,
    effectId: "mutation-effect",
    usage: null,
    outputArtifacts: [reference],
  };
  const artifact = {
    id: reference.artifactId,
    botId: "original-bot",
    groupId: "original-group",
    runId: "capture-run",
    name: "raw-results.json",
    mimeType: "application/json",
    size: bytes.length,
    version: 1,
    createdAt: "2026-01-01T00:00:00Z",
    contentBase64: bytes.toString("base64"),
  };
  return { snapshot, reference, task, action, artifact };
}

function nativeOutput(f: ReturnType<typeof rawResultsFixture>, snapshot: unknown, id: string) {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  return {
    reference: { artifactId: id, sha256: createHash("sha256").update(bytes).digest("hex") },
    artifact: { ...f.artifact, id, size: bytes.length, contentBase64: bytes.toString("base64") },
  };
}

const source = {
  id: "source-1",
  kind: "original_material" as const,
  anchor: { kind: "message" as const, messageId: "message-1", locator: "Role brief" },
  readState: "read" as const,
  readAt: "2026-01-01T00:00:00Z",
  quote: "Build systems",
};
const role: RecruitingRole = {
  id: "role-1",
  spaceId: "space-1",
  userId: "user-1",
  sourceThreadId: "thread-1",
  title: "Systems engineer",
  revision: 2,
  currentRevisionId: "revision-2",
};
const revision: RecruitingRoleRevision = {
  id: "revision-2",
  roleId: role.id,
  revision: 2,
  sourceRefs: [source],
  preferences: ["Small teams"],
  definitionQuestions: ["Which location?"],
  criteria: [
    {
      id: "criterion-1",
      priority: "hard",
      expression: { kind: "atom", id: "atom-1", statement: "Build systems" },
      sourceRefs: [source],
      definitionQuestions: ["What scale?"],
    },
  ],
  createdAt: "2026-01-01T00:00:00Z",
};
const assessmentSource = {
  ...source,
  selection: { kind: "message_text", blockIndex: 0, start: 0, end: source.quote.length },
} satisfies RecruitingAssessmentSourceRef;
const assessment = {
  assessment: {
    roleId: role.id,
    candidateKey: "candidate-1",
    roleRevisionId: "revision-1",
    version: 1,
    basedOnVersion: null,
    createdByRunId: "run-1",
    createdAt: "2026-01-01T00:00:00Z",
    facts: [
      { kind: "statement", id: "fact-1", statement: "Built a compiler", sourceRefIds: [source.id] },
    ],
    sourceRefs: [assessmentSource],
    judgments: {
      atoms: [
        {
          atomId: "atom-1",
          verdict: "unknown",
          factIds: ["fact-1"],
          evidence: [source.id],
          missing: ["Which component?"],
        },
      ],
      employment: [],
      hardGate: "unknown",
      criteria: [
        {
          criterionId: "criterion-1",
          verdict: "unknown",
          factIds: ["fact-1"],
          evidence: [source.id],
          missing: ["Which component?"],
        },
      ],
    },
    questions: ["How long?"],
  } satisfies RecruitingAssessment,
  isCurrent: false,
  roleRevision: {
    ...revision,
    id: "revision-1",
    revision: 1,
    criteria: [
      {
        ...revision.criteria[0]!,
        expression: { kind: "atom", id: "atom-1", statement: "Original systems requirement" },
      },
    ],
  },
  sourceMessageTargets: [
    {
      messageId: source.anchor.messageId,
      threadId: "material-thread",
      target: { groupId: "material-group" },
    },
  ],
} satisfies RecruitingAssessmentSnapshot;
let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("crypto", webcrypto);
  api.getWorkspace.mockResolvedValue({ role, revision });
  api.listAssessments.mockResolvedValue([assessment]);
  api.listQuestions.mockResolvedValue({ questions: [] });
  api.answer.mockResolvedValue({ ok: true });
  api.listResearch.mockResolvedValue({
    tasks: [{ id: "task-1", roleId: role.id, state: "active", providerTaskId: "provider-task-1" }],
    actions: [
      {
        id: "action-1",
        taskId: "task-1",
        kind: "create",
        roleRevisionId: revision.id,
        deliveryState: "accepted",
        observedProviderState: "running",
        recallScope: "Compiler teams",
        requestArtifact: { artifactId: "artifact-request", sha256: "a".repeat(64) },
        contextArtifact: { artifactId: "artifact-context", sha256: "b".repeat(64) },
        receiptArtifact: null,
        outputArtifacts: [],
        usage: null,
      },
    ],
  });
  api.list.mockResolvedValue([
    {
      id: "doc-1",
      scope: "user",
      botId: null,
      path: "preferences.md",
      content: "Remote teams",
      revision: 3,
      updatedAt: "2026-01-01",
    },
  ]);
  api.history.mockResolvedValue([
    {
      id: "history-1",
      documentId: "doc-1",
      revision: 2,
      content: "Earlier preference",
      sourceThreadId: "thread-1",
      sourceRunId: "run-1",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ]);
  api.getById.mockResolvedValue({
    botId: "source-bot",
    groupId: null,
    id: "artifact-request",
    name: "request.json",
    mimeType: "application/json",
    size: 23,
    contentBase64: "",
  });
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function mounted(threadId = "thread-1", botId?: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const reveal = vi.fn();
  const render = async (id: string, refreshSignal = 0) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <RecruitingPanel
            threadId={id}
            botId={botId}
            refreshSignal={refreshSignal}
            onClose={() => {}}
            onRevealMessage={reveal}
          />
        </MemoryRouter>,
      ),
    );
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await render(threadId);
  const click = async (name: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === name || item.getAttribute("aria-label") === name,
    );
    expect(button, name).toBeDefined();
    await act(async () => button!.click());
  };
  const expand = async (name: string) => {
    const details = [...container.querySelectorAll("details")].find((item) =>
      item.querySelector("summary")?.textContent?.includes(name),
    );
    expect(details, name).toBeDefined();
    await act(async () => {
      details!.open = true;
      details!.dispatchEvent(new Event("toggle"));
    });
  };
  return { container, render, click, expand, reveal };
}

it("shows unassessed raw provider rows from saved Artifacts without creating an assessment or search", async () => {
  const f = rawResultsFixture();
  api.listAssessments.mockResolvedValue([]);
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action] });
  api.getById.mockResolvedValue(f.artifact);
  const view = await mounted();
  expect(api.getById).not.toHaveBeenCalled();
  await view.click("Evidence");
  await view.expand("Raw search results");
  await vi.waitFor(() => expect(view.container.textContent).toContain("Synthetic raw candidate"));
  expect(
    view.container.querySelector('[data-research-action="raw-action"] > summary')?.textContent,
  ).toBe("Raw search results · continue · Role · Outdated");
  expect(view.container.textContent).toContain("Unassessed");
  expect(view.container.textContent).toContain("provider_report");
  expect(view.container.textContent).toContain("Strong Match");
  expect(view.container.textContent).toContain("https://example.test/profile");
  expect(view.container.textContent).toContain("Outdated");
  expect(api.getById).toHaveBeenCalledExactlyOnceWith({ artifactId: f.reference.artifactId });
  for (const method of [api.createRole, api.bindRole, api.reviseRole, api.update, api.search])
    expect(method).not.toHaveBeenCalled();
});

it("keeps saved assessments visible when no domain research tasks exist", async () => {
  api.listResearch.mockResolvedValue({ tasks: [], actions: [] });
  const view = await mounted();
  await view.click("Evidence");
  expect(view.container.textContent).toContain("candidate-1");
  expect(view.container.textContent).not.toContain("Raw search results");
  expect(api.getById).not.toHaveBeenCalled();
});

it("does not reload immutable result bytes when refresh returns the same source references", async () => {
  const f = rawResultsFixture();
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action] });
  api.getById.mockResolvedValue(f.artifact);
  const view = await mounted();
  await view.click("Evidence");
  await view.expand("Raw search results");
  await vi.waitFor(() => expect(view.container.textContent).toContain("Synthetic raw candidate"));
  api.listResearch.mockResolvedValue({
    tasks: [{ ...f.task }],
    actions: [{ ...f.action, outputArtifacts: [{ ...f.reference }] }],
  });
  await view.click("Refresh");
  expect(api.listResearch).toHaveBeenCalledTimes(2);
  expect(view.container.textContent).toContain("Synthetic raw candidate");
  expect(api.getById).toHaveBeenCalledTimes(1);
});

it("discards a pending result when refresh replaces that action's output references", async () => {
  const f = rawResultsFixture();
  const next = nativeOutput(
    f,
    rawResultsFixture(f.action.id, "Current raw snapshot").snapshot,
    "current-output",
  );
  let finish!: (artifact: typeof f.artifact) => void;
  api.listAssessments.mockResolvedValue([]);
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action] });
  api.getById.mockImplementation(({ artifactId }) =>
    artifactId === f.artifact.id
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(next.artifact),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.expand("Raw search results");
  api.listResearch.mockResolvedValue({
    tasks: [f.task],
    actions: [{ ...f.action, outputArtifacts: [next.reference] }],
  });
  await view.click("Refresh");
  await vi.waitFor(() => expect(view.container.textContent).toContain("Current raw snapshot"));
  await act(async () => {
    finish(f.artifact);
  });
  expect(view.container.textContent).not.toContain("Synthetic raw candidate");
  expect(view.container.textContent).toContain("Current raw snapshot");
});

it("keeps different rows snapshots at the same cursor while excluding status receipts", async () => {
  const f = rawResultsFixture();
  const second = rawResultsFixture(f.action.id, "Changed raw candidate");
  const changed = nativeOutput(f, { ...second.snapshot, effectId: "second-read" }, "changed-page");
  const { rows: _, nextCursor: __, ...observation } = f.snapshot.observation;
  const status = nativeOutput(
    f,
    {
      ...f.snapshot,
      operation: "status",
      providerResult: { state: "completed", done: true },
      observation: { ...observation, observedProviderState: "completed", done: true },
    },
    "status-output",
  );
  const outputs = [f, changed, status];
  api.listAssessments.mockResolvedValue([]);
  api.listResearch.mockResolvedValue({
    tasks: [f.task],
    actions: [{ ...f.action, outputArtifacts: outputs.map((output) => output.reference) }],
  });
  api.getById.mockImplementation(
    async ({ artifactId }) => outputs.find((output) => output.artifact.id === artifactId)!.artifact,
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.expand("Raw search results");
  await vi.waitFor(() => expect(view.container.textContent).toContain("Changed raw candidate"));
  expect(
    view.container.querySelectorAll(
      'section[aria-label="artifact-raw-action"], section[aria-label="changed-page"]',
    ),
  ).toHaveLength(2);
  expect(view.container.querySelector('section[aria-label="status-output"]')).toBeNull();
  expect(view.container.textContent).toContain("Synthetic raw candidate");
  expect(view.container.textContent).toContain("  real-cursor==  ");
  expect(view.container.textContent).toContain('"nextCursor": null');
  expect(view.container.textContent).toContain("second-read");
  expect(view.container.textContent).not.toContain('"effectId": "mutation-effect"');
});

it.each(["hash", "action", "artifact", "access"])(
  "does not display raw rows after %s validation fails",
  async (boundary) => {
    const f = rawResultsFixture();
    let artifact = f.artifact;
    if (boundary === "hash")
      artifact = { ...artifact, contentBase64: Buffer.from("{}").toString("base64") };
    if (boundary === "action") {
      const foreign = nativeOutput(
        f,
        { ...f.snapshot, actionId: "foreign-action" },
        f.reference.artifactId,
      );
      f.reference.sha256 = foreign.reference.sha256;
      artifact = foreign.artifact;
    }
    if (boundary === "artifact") artifact = { ...artifact, id: "foreign-artifact" };
    api.listAssessments.mockResolvedValue([]);
    api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action] });
    if (boundary === "access") api.getById.mockRejectedValue(new Error("Private source details"));
    else api.getById.mockResolvedValue(artifact);
    const view = await mounted();
    await view.click("Evidence");
    await view.expand("Raw search results");
    await vi.waitFor(() =>
      expect(view.container.textContent).toContain("Could not load search results"),
    );
    expect(view.container.textContent).not.toContain("Synthetic raw candidate");
    expect(view.container.textContent).not.toContain("Private source details");
  },
);

it("discards a late original action Artifact after navigation to another thread", async () => {
  const f = rawResultsFixture();
  let finish!: (artifact: typeof f.artifact) => void;
  api.listAssessments.mockResolvedValue([]);
  api.listResearch.mockResolvedValue({ tasks: [f.task], actions: [f.action] });
  api.getById.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.expand("Raw search results");
  api.getWorkspace.mockResolvedValue(null);
  await view.render("thread-2");
  await act(async () => {
    finish(f.artifact);
  });
  expect(view.container.textContent).not.toContain("Synthetic raw candidate");
  expect(view.container.textContent).not.toContain("Raw search results");
});

const nativeQuestion = {
  effectId: "question-effect",
  roleId: role.id,
  roleRevisionId: revision.id,
  target: {
    kind: "candidate",
    candidateKey: "candidate-1",
    assessmentVersion: 1,
    criterionIds: ["criterion-1"],
  },
  threadId: "origin-thread",
  botId: "origin-bot",
  groupId: "origin-group",
  runId: "origin-run",
  messageId: "origin-question",
  askIndex: 0,
  block: {
    kind: "ask",
    text: "Which component did the candidate implement?",
    status: "pending",
    actions: [
      { id: "choice-1", label: "Coordinate transforms" },
      { id: "choice-2", label: "Need more evidence" },
    ],
  },
  runStatus: "waiting_input",
  isCurrent: true,
  canAnswer: true,
} satisfies RecruitingQuestion;

it("answers the original native group question and reloads its persisted answered state", async () => {
  api.listQuestions.mockResolvedValue({ questions: [nativeQuestion] });
  const view = await mounted("thread-1", "current-bot");
  expect(api.listQuestions).toHaveBeenCalledWith({ threadId: "thread-1", roleId: role.id });
  await view.click("Missing info");
  expect(view.container.textContent).toContain(nativeQuestion.block.text);
  expect(view.container.textContent).toContain("candidate-1");
  api.listQuestions.mockResolvedValue({
    questions: [
      {
        ...nativeQuestion,
        block: { ...nativeQuestion.block, status: "answered", answer: "choice-1" },
        runStatus: "queued",
        canAnswer: false,
      },
    ],
  });
  await view.click("Coordinate transforms");
  expect(api.answer).toHaveBeenCalledExactlyOnceWith({
    groupId: "origin-group",
    runId: "origin-run",
    messageId: "origin-question",
    answer: "choice-1",
  });
  expect(api.listQuestions).toHaveBeenCalledTimes(2);
  expect(view.container.textContent).toContain("Answered: Coordinate transforms");
  await view.click("Open original question");
  expect(view.reveal).toHaveBeenCalledExactlyOnceWith({
    groupId: "origin-group",
    messageId: "origin-question",
  });
});

it("submits custom input to the native originating bot without creating a new task", async () => {
  api.listQuestions.mockResolvedValue({ questions: [{ ...nativeQuestion, groupId: null }] });
  const view = await mounted();
  await view.click("Missing info");
  await view.click("Type your answer");
  const answer = " \n  Implemented the geometry library in C++ 😀\n  ";
  const input = view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Answer"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      answer,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await view.click("Send answer");
  expect(api.answer).toHaveBeenCalledExactlyOnceWith({
    botId: "origin-bot",
    runId: "origin-run",
    messageId: "origin-question",
    answer,
  });
  expect(api.createRole).not.toHaveBeenCalled();
  expect(api.bindRole).not.toHaveBeenCalled();
  expect(api.search).not.toHaveBeenCalled();
});

it("keeps answered native questions visible and leaves stale cancelled cards inactive", async () => {
  api.listQuestions.mockResolvedValue({
    questions: [
      {
        ...nativeQuestion,
        isCurrent: false,
        canAnswer: false,
        runStatus: "cancelled",
      },
      {
        ...nativeQuestion,
        effectId: "answered-effect",
        messageId: "answered-question",
        block: { ...nativeQuestion.block, status: "answered", answer: "choice-2" },
        isCurrent: false,
        canAnswer: false,
        runStatus: "completed",
      },
    ],
  });
  const view = await mounted();
  await view.click("Missing info");
  expect(view.container.textContent).toContain("No longer active");
  expect(view.container.textContent).toContain("Answered: Need more evidence");
  expect(view.container.textContent).toContain("Outdated");
  expect(
    [...view.container.querySelectorAll("button")].some(
      (button) => button.textContent === "Coordinate transforms",
    ),
  ).toBe(false);
  expect(api.answer).not.toHaveBeenCalled();
});

it("shows native answer failures without marking a question answered", async () => {
  api.listQuestions.mockResolvedValue({ questions: [nativeQuestion] });
  api.answer.mockRejectedValueOnce(new Error("This prompt is no longer awaiting an answer"));
  const view = await mounted();
  await view.click("Missing info");
  await view.click("Need more evidence");
  expect(view.container.textContent).toContain("This prompt is no longer awaiting an answer");
  expect(view.container.textContent).not.toContain("Answered: Need more evidence");
  expect(api.listQuestions).toHaveBeenCalledOnce();
});

it("does not publish questions from a role changed while the read was pending", async () => {
  let finish!: (value: { questions: (typeof nativeQuestion)[] }) => void;
  api.listQuestions.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  const nextRole = { ...role, id: "role-2", currentRevisionId: "revision-next" };
  api.getWorkspace.mockResolvedValue({
    role: nextRole,
    revision: { ...revision, id: nextRole.currentRevisionId, roleId: nextRole.id },
  });
  await act(async () => finish({ questions: [nativeQuestion] }));
  await view.click("Missing info");
  expect(view.container.textContent).not.toContain(nativeQuestion.block.text);
  expect(api.listQuestions).toHaveBeenLastCalledWith({ threadId: "thread-1", roleId: nextRole.id });
});
it("reads the native five views and lazily resolves memory history and Artifact references", async () => {
  const view = await mounted();
  expect(view.container.textContent).toContain("Systems engineer");
  expect(view.container.textContent).toContain("Version 2");
  expect(api.getWorkspace).toHaveBeenCalledWith({ threadId: "thread-1" });
  expect(api.listAssessments).toHaveBeenCalledWith({ roleId: role.id });
  expect(api.listResearch).toHaveBeenCalledWith({ roleId: role.id });
  expect(api.list).toHaveBeenCalledExactlyOnceWith({ scope: "user" });
  expect(api.history).not.toHaveBeenCalled();
  expect(api.getById).not.toHaveBeenCalled();
  expect(api.get).not.toHaveBeenCalled();
  await view.click("Evidence");
  expect(view.container.textContent).toContain("Outdated");
  await view.click("candidate-1");
  expect(view.container.textContent).toContain("Unknown");
  expect(view.container.textContent).toContain("Built a compiler");
  await view.click("Missing info");
  expect(view.container.textContent).toContain("Which location?");
  expect(view.container.textContent).toContain("Which component?");
  await view.click("Memory");
  await view.expand("preferences.md");
  await view.click("History");
  expect(api.history).toHaveBeenCalledWith({ documentId: "doc-1" });
  expect(view.container.textContent).toContain("Earlier preference");
  await view.click("Activity");
  expect(view.container.textContent).toContain("Compiler teams");
  await view.expand("Request");
  expect(api.getById).toHaveBeenCalledWith({ artifactId: "artifact-request" });
  expect(
    view.container
      .querySelector('[data-artifact-id="artifact-request"]')
      ?.getAttribute("data-bot-id"),
  ).toBe("source-bot");
  expect(view.container.textContent).toContain("request.json");
  for (const method of [api.createRole, api.bindRole, api.reviseRole, api.update, api.search])
    expect(method).not.toHaveBeenCalled();
});
it("discards the old thread response and does not carry its role into the next thread", async () => {
  let finish!: (value: { role: RecruitingRole; revision: RecruitingRoleRevision }) => void;
  api.getWorkspace
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(null);
  const view = await mounted();
  await view.render("thread-2");
  await act(async () => finish({ role, revision }));
  expect(view.container.textContent).not.toContain(role.title);
  expect(view.container.textContent).toContain("No role linked");
  expect(api.listResearch).not.toHaveBeenCalled();
});
it("keeps known results when a refresh fails and recovers on explicit refresh", async () => {
  const view = await mounted();
  api.getWorkspace.mockRejectedValueOnce(new Error("offline"));
  await view.click("Refresh");
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.container.textContent).toContain(role.title);
  api.getWorkspace.mockResolvedValue(null);
  await view.click("Refresh");
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
  expect(view.container.textContent).toContain("No role linked");
});
it("restores only the native panel preference and still performs reads only", async () => {
  writeRightPanelState("layout", "recruiting");
  expect(readRightPanelState("layout")).toEqual({ panel: "recruiting" });
  const view = await mounted("thread-1", "bot-1");
  expect(api.list).toHaveBeenCalledWith({ scope: "bot", botId: "bot-1" });
  for (const name of ["Evidence", "Missing info", "Memory", "Activity", "Role"])
    await view.click(name);
  expect(api.getWorkspace).toHaveBeenCalledTimes(2);
  for (const method of [api.createRole, api.bindRole, api.reviseRole, api.update, api.search])
    expect(method).not.toHaveBeenCalled();
  expect(localStorage.getItem("layout")).toBe('{"panel":"recruiting"}');
});
it("distinguishes empty saved assessments from a successful candidate search", async () => {
  api.listAssessments.mockResolvedValue([]);
  const view = await mounted();
  await view.click("Evidence");
  expect(view.container.textContent).toContain("No saved assessments");
  expect(api.search).not.toHaveBeenCalled();
});
it("keeps saved facts and sources inspectable even before a criterion judgment exists", async () => {
  api.listAssessments.mockResolvedValue([
    {
      ...assessment,
      assessment: {
        ...assessment.assessment,
        judgments: { ...assessment.assessment.judgments, atoms: [], criteria: [] },
        sourceRefs: [
          assessmentSource,
          {
            ...assessmentSource,
            id: "source-2",
            quote: "Additional material",
            selection: {
              kind: "message_text",
              blockIndex: 1,
              start: 0,
              end: "Additional material".length,
            },
          },
        ],
      },
    },
  ]);
  const view = await mounted();
  await view.click("Evidence");
  await view.click("candidate-1");
  expect(view.container.textContent).toContain("Built a compiler");
  expect(view.container.textContent).toContain("Additional material");
});
it("discards late evidence reads from a previously selected thread", async () => {
  let finish!: (value: (typeof assessment)[]) => void;
  api.listAssessments.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  api.getWorkspace.mockResolvedValue(null);
  await view.render("thread-2");
  await act(async () => finish([assessment]));
  expect(view.container.textContent).toContain("No role linked");
  await view.click("Evidence");
  expect(view.container.textContent).toContain("No saved assessments");
  expect(view.container.textContent).not.toContain("candidate-1");
});
it("preserves saved evidence when a later research read fails", async () => {
  const view = await mounted();
  api.listResearch.mockRejectedValueOnce(new Error("offline"));
  await view.click("Refresh");
  await view.click("Evidence");
  expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
  expect(view.container.textContent).toContain("candidate-1");
});

it("never guesses a native message route for material from another chat", async () => {
  const view = await mounted();
  const roleSources = [...view.container.querySelectorAll("details")].find(
    (item) => item.querySelector("summary")?.textContent === "Role sources",
  )!;
  expect(roleSources.textContent).toContain("Message");
  expect(roleSources.textContent).toContain(source.quote);
  expect(roleSources.textContent).not.toContain("message-1");
  expect(roleSources.querySelector("button")).toBeNull();
  expect(roleSources.querySelector('a[href*="?m="]')).toBeNull();
});
it("reloads the same thread on native invalidation and rejects its old delayed assessments", async () => {
  let finish!: (value: (typeof assessment)[]) => void;
  const pending = new Promise<(typeof assessment)[]>((resolve) => {
    finish = resolve;
  });
  api.listAssessments.mockImplementation(({ roleId }: { roleId: string }) =>
    roleId === role.id ? pending : Promise.resolve([]),
  );
  const view = await mounted();
  const next = {
    role: { ...role, id: "role-2", title: "Hardware engineer", currentRevisionId: "revision-b" },
    revision: { ...revision, id: "revision-b", roleId: "role-2" },
  };
  api.getWorkspace.mockResolvedValue(next);
  await view.render("thread-1", 1);
  expect(view.container.textContent).toContain("Hardware engineer");
  await act(async () => finish([assessment]));
  expect(view.container.textContent).not.toContain(role.title);
  await view.click("Evidence");
  expect(view.container.textContent).not.toContain("candidate-1");
  api.getWorkspace.mockResolvedValue(null);
  await view.render("thread-1", 2);
  await view.click("Role");
  expect(view.container.textContent).toContain("No role linked");
});
it("rechecks the binding and revision after reading lists before publishing them", async () => {
  const next = {
    role: { ...role, currentRevisionId: "revision-3", revision: 3 },
    revision: { ...revision, id: "revision-3", revision: 3 },
  };
  api.getWorkspace.mockResolvedValueOnce({ role, revision }).mockResolvedValue(next);
  api.listAssessments.mockResolvedValueOnce([assessment]).mockResolvedValue([]);
  const view = await mounted();
  expect(view.container.textContent).toContain("Version 3");
  await view.click("Evidence");
  expect(view.container.textContent).toContain("No saved assessments");
  expect(api.listAssessments).toHaveBeenCalledTimes(2);
});
it("drops cached Artifact metadata when its exact reference changes", async () => {
  const view = await mounted();
  await view.click("Activity");
  await view.expand("Request");
  expect(view.container.textContent).toContain("request.json");
  const research = await api.listResearch.mock.results[0]!.value;
  api.listResearch.mockResolvedValue({
    ...research,
    actions: [
      {
        ...research.actions[0],
        requestArtifact: { artifactId: "request-2", sha256: "c".repeat(64) },
      },
    ],
  });
  api.getById.mockResolvedValue({
    id: "request-2",
    botId: null,
    groupId: "source-group",
    name: "request-2.json",
    mimeType: "application/json",
    size: 5,
    contentBase64: "",
  });
  await view.click("Refresh");
  expect(view.container.textContent).not.toContain("request.json");
  await view.expand("Request");
  expect(api.getById).toHaveBeenCalledWith({ artifactId: "request-2" });
  expect(
    view.container.querySelector('[data-artifact-id="request-2"]')?.getAttribute("data-group-id"),
  ).toBe("source-group");
});
it("states which memory scopes a group actually queries", async () => {
  api.list.mockResolvedValue([]);
  const view = await mounted();
  await view.click("Memory");
  expect(view.container.textContent).toContain("User memory");
  expect(view.container.textContent).toContain("Group bot memory is not included");
  expect(view.container.textContent).toContain("No saved memory in these scopes");
  expect(api.list).toHaveBeenCalledExactlyOnceWith({ scope: "user" });
});

it.each([60, null])(
  "renders the saved unknown hard gate, preferred verdict and employment upper bound %s without recomputing qualification",
  async (upperMonths) => {
    const qualificationDefinition = "Full-time relevant systems work";
    const preferred = {
      ...revision.criteria[0]!,
      id: "preferred-criterion",
      priority: "preferred" as const,
      expression: { kind: "atom" as const, id: "preferred-atom", statement: "Compiler experience" },
      definitionQuestions: [],
    };
    api.getWorkspace.mockResolvedValue({
      role,
      revision: { ...revision, criteria: [...revision.criteria, preferred] },
    });
    const quote = "  Built a compiler.\r\n";
    const saved = {
      ...assessment.assessment,
      roleRevisionId: revision.id,
      facts: [
        ...assessment.assessment.facts,
        {
          kind: "employment",
          id: "job-1",
          statement: "Worked on infrastructure",
          sourceRefIds: [source.id],
          employmentType: "full-time",
          start: { precision: "year", year: 2020 },
          end: "present",
        },
      ],
      sourceRefs: [
        {
          ...assessmentSource,
          quote,
          selection: { kind: "message_text", blockIndex: 0, start: 3, end: 3 + quote.length },
        },
      ],
      judgments: {
        atoms: [
          ...assessment.assessment.judgments.atoms,
          {
            atomId: "preferred-atom",
            verdict: "met",
            factIds: ["fact-1"],
            evidence: [source.id],
            missing: [],
          },
        ],
        employment: [
          {
            atomId: "atom-1",
            intervals: [
              {
                factId: "job-1",
                qualifyingFullTime: "unknown",
                evidence: [source.id],
                missing: ["Confirm full-time work"],
              },
            ],
            historyCompletenessFactId: null,
            evidence: [source.id],
            missing: ["Complete the work history"],
            cutoff: { precision: "day", year: 2026, month: 10, day: 16 },
            minimumMonths: 84,
            countingRule: "complete_calendar_months",
            qualificationDefinition,
            lowerMonths: 36,
            upperMonths,
            verdict: "unknown",
            factIds: ["job-1"],
          },
        ],
        criteria: [
          ...assessment.assessment.judgments.criteria,
          {
            criterionId: preferred.id,
            verdict: "met",
            factIds: ["fact-1"],
            evidence: [source.id],
            missing: [],
          },
        ],
        hardGate: "unknown",
      },
    } satisfies RecruitingAssessment;
    api.listAssessments.mockResolvedValue([
      {
        ...assessment,
        assessment: saved,
        isCurrent: true,
        roleRevision: { ...revision, criteria: [...revision.criteria, preferred] },
      },
    ]);
    const view = await mounted();
    await view.click("Evidence");
    await view.click("candidate-1");
    const gate = [...view.container.querySelectorAll("p")].find(
      (item) => item.textContent === "Hard criteriaUnknown",
    );
    expect(gate).toBeDefined();
    const preferredSummary = [...view.container.querySelectorAll("summary")].find((item) =>
      item.textContent?.includes(preferred.expression.statement),
    );
    expect(preferredSummary?.textContent).toContain("Met");
    expect(view.container.textContent).toContain(`${36}–${upperMonths ?? "?"} months`);
    expect(view.container.textContent).toContain("≥ 84");
    expect(view.container.textContent).toContain("2026-10-16");
    expect(view.container.textContent).toContain(qualificationDefinition);
    expect(
      [...view.container.querySelectorAll("blockquote")].some((item) => item.textContent === quote),
    ).toBe(true);
    await view.click("Missing info");
    expect(view.container.textContent).toContain("Which component?");
  },
);

it("switches Cards/Table with one original-revision detail, preserves a refreshed candidate and rejects late data from another role", async () => {
  const additionalSource = {
    ...assessmentSource,
    id: "source-2",
    anchor: { ...source.anchor, messageId: "message-2", locator: "Additional evidence" },
    quote: "Independent source",
    selection: { ...assessmentSource.selection, end: "Independent source".length },
  };
  const original = {
    ...assessment,
    assessment: {
      ...assessment.assessment,
      facts: [
        ...assessment.assessment.facts,
        {
          kind: "statement",
          id: "fact-2",
          statement: "Maintained a compiler",
          sourceRefIds: [additionalSource.id],
        },
      ],
      sourceRefs: [...assessment.assessment.sourceRefs, additionalSource],
      judgments: {
        ...assessment.assessment.judgments,
        criteria: [
          {
            ...assessment.assessment.judgments.criteria[0]!,
            factIds: ["fact-1", "fact-2"],
            evidence: [source.id, additionalSource.id],
          },
        ],
      },
    },
    roleRevision: {
      ...assessment.roleRevision,
      criteria: [{ ...assessment.roleRevision.criteria[0]!, priority: "hard" as const }],
    },
  } satisfies RecruitingAssessmentSnapshot;
  const second = {
    ...assessment,
    assessment: {
      ...assessment.assessment,
      candidateKey: "candidate-2",
      facts: [{ ...assessment.assessment.facts[0]!, statement: "Second candidate evidence" }],
    },
    sourceMessageTargets: [
      {
        messageId: source.anchor.messageId,
        threadId: "second-material-thread",
        target: { botId: "second-material-bot" },
      },
    ],
  };
  api.listAssessments.mockResolvedValue([original, second]);
  const view = await mounted();
  await view.click("Evidence");
  expect(view.container.querySelector("table")).toBeNull();
  await view.click("candidate-1");
  const condition = [...view.container.querySelectorAll("details")].find((element) =>
    element.querySelector("summary")?.textContent?.includes("Original systems requirement"),
  );
  expect(condition).toBeDefined();
  expect(condition?.querySelector("summary")?.textContent).toContain("Hard criteria");
  expect([...condition!.querySelectorAll("blockquote")].map((item) => item.textContent)).toEqual([
    source.quote,
    additionalSource.quote,
  ]);
  expect(condition?.textContent).toContain("Built a compiler");
  expect(condition?.textContent).toContain("Maintained a compiler");
  expect(view.container.textContent).not.toContain("revision-1");
  expect(view.container.textContent).toContain("Role · Version 1");
  await view.click("Message");
  expect(view.reveal).toHaveBeenCalledExactlyOnceWith({
    groupId: "material-group",
    messageId: source.anchor.messageId,
  });
  await view.click("Table");
  expect(view.container.querySelector("table caption")?.textContent).toBe("Saved assessments");
  expect(
    [...view.container.querySelectorAll("th[scope=col]")].map((element) => element.textContent),
  ).toEqual(["Candidate", "Version", "Status", "Hard criteria"]);
  expect(view.container.textContent).toContain("Original systems requirement");
  await view.click("candidate-2");
  expect(view.container.textContent).toContain("Second candidate evidence");
  expect(view.container.textContent).not.toContain("Built a compiler");
  const refreshed = {
    ...second,
    assessment: {
      ...second.assessment,
      version: 2,
      basedOnVersion: 1,
      facts: [{ ...second.assessment.facts[0]!, statement: "Second candidate updated evidence" }],
    },
  };
  api.listAssessments.mockResolvedValue([original, refreshed]);
  await view.click("Refresh");
  expect(view.container.querySelector("table")).not.toBeNull();
  expect(view.container.textContent).toContain("Second candidate updated evidence");
  await view.click("Cards");
  expect(view.container.querySelector("table")).toBeNull();
  expect(view.container.textContent).toContain("Second candidate updated evidence");
  await view.click("Message");
  expect(view.reveal).toHaveBeenLastCalledWith({
    botId: "second-material-bot",
    messageId: source.anchor.messageId,
  });
  let finish!: (value: (typeof assessment)[]) => void;
  const pending = new Promise<(typeof assessment)[]>((resolve) => {
    finish = resolve;
  });
  api.listAssessments.mockReturnValueOnce(pending);
  await view.click("Refresh");
  const nextRole = { ...role, id: "role-next", currentRevisionId: "revision-next" };
  const nextRevision = { ...revision, id: nextRole.currentRevisionId, roleId: nextRole.id };
  api.getWorkspace.mockResolvedValue({ role: nextRole, revision: nextRevision });
  api.listAssessments.mockResolvedValue([
    {
      ...second,
      assessment: {
        ...second.assessment,
        roleId: nextRole.id,
        roleRevisionId: nextRevision.id,
        facts: [{ ...second.assessment.facts[0]!, statement: "Different role evidence" }],
      },
      roleRevision: nextRevision,
      isCurrent: true,
    },
  ]);
  await view.render("thread-1", 1);
  await act(async () => finish([original]));
  expect(view.container.textContent).not.toContain("Second candidate updated evidence");
  expect(view.container.textContent).not.toContain("Different role evidence");
  await view.click("candidate-2");
  expect(view.container.textContent).toContain("Different role evidence");
  expect(view.container.textContent).not.toContain("Built a compiler");
});
