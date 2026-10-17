// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { ORPCError } from "@orpc/client";
import type {
  RecruitingAssessment,
  RecruitingAssessmentSnapshot,
  RecruitingAssessmentSourceRef,
  RecruitingEmploymentRule,
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
  confirmBrief: vi.fn(),
  editCriteria: vi.fn(),
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

function artifactSourceFixture(
  content: string | Uint8Array = "Before\nBuilt a compiler\nAfter",
  mimeType = "text/plain",
  artifactId = "artifact-source",
) {
  const bytes = Buffer.from(content);
  const reference = { artifactId, sha256: createHash("sha256").update(bytes).digest("hex") };
  return {
    reference,
    artifact: {
      id: artifactId,
      botId: "material-bot",
      groupId: null,
      name: "original-material.txt",
      mimeType,
      size: bytes.length,
      contentBase64: bytes.toString("base64"),
    },
    source: {
      ...source,
      anchor: { kind: "artifact", artifact: reference, locator: "Source excerpt" },
      quote: "Built a compiler",
      selection: { kind: "artifact_text", start: 7, end: 23 },
    } satisfies RecruitingAssessmentSourceRef,
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
  const request = artifactSourceFixture("{}", "application/json", "artifact-request");
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
        requestArtifact: request.reference,
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
    ...request.artifact,
    botId: "source-bot",
    name: "request.json",
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
    return details!;
  };
  return { container, render, click, expand, reveal };
}

async function changeStatement(container: HTMLElement, statement: string, index = 0) {
  const input = container.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Statement"]')[
    index
  ]!;
  expect(input).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      statement,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function changeInput(container: HTMLElement, name: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
  expect(input, name).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const employmentRule: RecruitingEmploymentRule = {
  minimumMonths: 60,
  countingRule: "complete_calendar_months",
  qualificationDefinition: "Full-time systems work",
  cutoff: { kind: "assessment_date" },
};

function typedCriteria(rule = employmentRule) {
  return {
    role,
    revision: {
      ...revision,
      criteria: [
        {
          ...revision.criteria[0]!,
          expression: {
            kind: "atom" as const,
            id: "atom-1",
            statement: "Five years of systems work",
            employmentRule: rule,
          },
        },
      ],
    },
  };
}

it("edits the executed employment rule from 60 to 84 months with an exact fixed cutoff", async () => {
  api.getWorkspace.mockResolvedValue(typedCriteria());
  const view = await mounted();
  expect(view.container.textContent).toContain("Minimum 60 complete calendar months");
  await view.click("Edit criteria");
  expect(
    view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Minimum complete calendar months"]',
    )?.value,
  ).toBe("60");
  expect(view.container.querySelector('textarea[aria-label="Statement"]')).toBeNull();
  expect(
    view.container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Qualifying work"]')
      ?.value,
  ).toBe("Full-time systems work");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeInput(view.container, "Minimum complete calendar months", "84");
  const cutoff = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Count through"]',
  )!;
  await act(async () => {
    cutoff.value = "fixed";
    cutoff.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeInput(view.container, "Cutoff date", "2026-10-16");
  const rule = {
    ...employmentRule,
    minimumMonths: 84,
    cutoff: {
      kind: "fixed" as const,
      date: { precision: "day" as const, year: 2026, month: 10, day: 16 },
    },
  };
  const typed = typedCriteria(rule);
  const saved = {
    role: { ...role, revision: 3, currentRevisionId: "revision-3" },
    revision: {
      ...typed.revision,
      id: "revision-3",
      revision: 3,
      criteria: [
        {
          ...typed.revision.criteria[0]!,
          expression: {
            ...typed.revision.criteria[0]!.expression,
            statement:
              "At least 84 complete calendar months of Full-time systems work; cutoff: 2026-10-16 (UTC).",
          },
        },
      ],
    },
  };
  api.editCriteria.mockResolvedValue(saved);
  api.getWorkspace.mockResolvedValue(saved);
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "hard",
        atoms: [{ atomId: "atom-1", employmentRule: rule }],
      },
    ],
  });
  expect(view.container.textContent).toContain("Minimum 84 complete calendar months");
  expect(view.container.textContent).toContain("2026-10-16");
  expect(view.container.textContent).not.toContain("Five years of systems work");
});

it("validates employment months and qualification, and can use the assessment date", async () => {
  api.getWorkspace.mockResolvedValue(
    typedCriteria({
      ...employmentRule,
      cutoff: { kind: "fixed", date: { precision: "day", year: 2026, month: 10, day: 16 } },
    }),
  );
  const view = await mounted();
  await view.click("Edit criteria");
  for (const value of ["", "-1", "1.5"]) {
    await changeInput(view.container, "Minimum complete calendar months", value);
    await view.click("Save");
    expect(api.editCriteria).not.toHaveBeenCalled();
  }
  await changeInput(view.container, "Minimum complete calendar months", "84");
  const definition = view.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Qualifying work"]',
  )!;
  const changeDefinition = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        definition,
        value,
      );
      definition.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await changeDefinition("  ");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeDefinition("  Full-time compiler work  ");
  const cutoff = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Count through"]',
  )!;
  await act(async () => {
    cutoff.value = "assessment_date";
    cutoff.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(view.container.querySelector('input[aria-label="Cutoff date"]')).toBeNull();
  api.editCriteria.mockRejectedValue(new Error("offline"));
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "hard",
        atoms: [
          {
            atomId: "atom-1",
            employmentRule: {
              ...employmentRule,
              minimumMonths: 84,
              qualificationDefinition: "Full-time compiler work",
            },
          },
        ],
      },
    ],
  });
  expect(
    view.container.querySelector<HTMLInputElement>(
      'input[aria-label="Minimum complete calendar months"]',
    )?.value,
  ).toBe("84");
  expect(definition.value).toBe("  Full-time compiler work  ");
});

it("keeps shared typed rules and newer month edits while a save is pending", async () => {
  const initial = typedCriteria();
  const shared = initial.revision.criteria[0]!;
  const criteria = [shared, { ...shared, id: "criterion-2", priority: "preferred" as const }];
  api.getWorkspace.mockResolvedValue({ ...initial, revision: { ...initial.revision, criteria } });
  let finish!: (value: unknown) => void;
  api.editCriteria.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Edit criteria");
  await changeInput(view.container, "Minimum complete calendar months", "84");
  const monthValues = () =>
    [
      ...view.container.querySelectorAll<HTMLInputElement>(
        'input[aria-label="Minimum complete calendar months"]',
      ),
    ].map((input) => input.value);
  expect(monthValues()).toEqual(["84", "84"]);
  await view.click("Save");
  await changeInput(view.container, "Minimum complete calendar months", "96");
  const saved = {
    role: { ...role, revision: 3, currentRevisionId: "revision-3" },
    revision: {
      ...initial.revision,
      id: "revision-3",
      revision: 3,
      criteria: criteria.map((criterion) => ({
        ...criterion,
        expression: {
          ...criterion.expression,
          statement:
            "At least 84 complete calendar months of Full-time systems work; cutoff: assessment date (UTC).",
          employmentRule: { ...employmentRule, minimumMonths: 84 },
        },
      })),
    },
  };
  api.getWorkspace.mockResolvedValue(saved);
  await act(async () => finish(saved));
  expect(monthValues()).toEqual(["96", "96"]);
  api.editCriteria.mockRejectedValueOnce(new Error("offline"));
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenLastCalledWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 3,
    criteria: criteria.map((criterion) => ({
      criterionId: criterion.id,
      priority: criterion.priority,
      atoms: [{ atomId: "atom-1", employmentRule: { ...employmentRule, minimumMonths: 96 } }],
    })),
  });
  expect(monthValues()).toEqual(["96", "96"]);
});

function savedCriteria(statement = "Build reliable systems") {
  return {
    role: { ...role, revision: 3, currentRevisionId: "revision-3" },
    revision: {
      ...revision,
      id: "revision-3",
      revision: 3,
      criteria: [
        {
          ...revision.criteria[0]!,
          expression: { kind: "atom" as const, id: "atom-1", statement },
        },
      ],
    },
  };
}

it("edits exact existing atoms and priority while preserving compound groups", async () => {
  const compound = {
    ...revision.criteria[0]!,
    expression: {
      kind: "all",
      items: [
        { kind: "atom", id: "atom-1", statement: "Build systems" },
        {
          kind: "any",
          items: [
            { kind: "atom", id: "atom-2", statement: "Use compilers" },
            { kind: "not", item: { kind: "atom", id: "atom-3", statement: "Only manage teams" } },
          ],
        },
      ],
    },
  } satisfies RecruitingRoleRevision["criteria"][number];
  const unchanged = {
    ...revision.criteria[0]!,
    id: "criterion-2",
    priority: "preferred" as const,
    expression: { kind: "atom" as const, id: "atom-4", statement: "Write documentation" },
  };
  api.getWorkspace.mockResolvedValue({
    role,
    revision: { ...revision, criteria: [compound, unchanged] },
  });
  const saved = savedCriteria();
  const next = {
    ...saved,
    revision: {
      ...saved.revision,
      criteria: [
        {
          ...compound,
          priority: "preferred" as const,
          expression: {
            ...compound.expression,
            items: [
              { kind: "atom" as const, id: "atom-1", statement: "Build reliable systems" },
              compound.expression.items[1]!,
            ],
          },
        },
        unchanged,
      ],
    },
  };
  api.editCriteria.mockResolvedValue(next);
  const view = await mounted();
  await view.click("Edit criteria");
  expect(
    [...view.container.querySelectorAll("fieldset legend")].map((item) => item.textContent),
  ).toEqual(expect.arrayContaining(["AND", "OR", "NOT"]));
  const groups = [...view.container.querySelectorAll("fieldset")].filter(
    (item) => item.querySelector(":scope > legend")?.textContent === "AND",
  );
  expect(groups[0]?.querySelectorAll("textarea")).toHaveLength(3);
  await changeStatement(view.container, "  Build reliable systems  ");
  const priority = view.container.querySelector<HTMLSelectElement>(
    'select[aria-label="Priority"]',
  )!;
  await act(async () => {
    priority.value = "preferred";
    priority.dispatchEvent(new Event("change", { bubbles: true }));
  });
  api.getWorkspace.mockResolvedValue(next);
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "preferred",
        atoms: [
          { atomId: "atom-1", statement: "Build reliable systems" },
          { atomId: "atom-2", statement: "Use compilers" },
          { atomId: "atom-3", statement: "Only manage teams" },
        ],
      },
    ],
  });
  expect(view.container.textContent).toContain(
    "(Build reliable systems AND (Use compilers OR NOT (Only manage teams)))",
  );
});

it("does not save unchanged or blank criteria and Cancel discards the draft", async () => {
  const view = await mounted();
  await view.click("Edit criteria");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeStatement(view.container, "  Build systems  ");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await changeStatement(view.container, "  ");
  await view.click("Save");
  expect(api.editCriteria).not.toHaveBeenCalled();
  await view.click("Cancel");
  expect(view.container.querySelector("textarea")).toBeNull();
  expect(view.container.textContent).toContain("Build systems");
});

it("edits one shared atom definition across repeated leaves and criteria", async () => {
  const shared = revision.criteria[0]!;
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      criteria: [
        { ...shared, expression: { kind: "any", items: [shared.expression, shared.expression] } },
        { ...shared, id: "criterion-2", priority: "preferred" },
      ],
    },
  });
  const view = await mounted();
  await view.click("Edit criteria");
  await changeStatement(view.container, "Build shared systems");
  expect([...view.container.querySelectorAll("textarea")].map((item) => item.value)).toEqual([
    "Build shared systems",
    "Build shared systems",
    "Build shared systems",
  ]);
  api.editCriteria.mockResolvedValue(savedCriteria());
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenCalledExactlyOnceWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "hard",
        atoms: [{ atomId: "atom-1", statement: "Build shared systems" }],
      },
      {
        criterionId: "criterion-2",
        priority: "preferred",
        atoms: [{ atomId: "atom-1", statement: "Build shared systems" }],
      },
    ],
  });
});

it.each([new Error("offline"), new ORPCError("CONFLICT")])(
  "keeps edited criteria after a save failure %s and same-role refresh",
  async (error) => {
    api.editCriteria.mockRejectedValue(error);
    const view = await mounted();
    await view.click("Edit criteria");
    await changeStatement(view.container, "Keep this draft");
    await view.click("Save");
    expect(view.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Keep this draft",
    );
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be saved",
    );
    api.getWorkspace.mockResolvedValue(savedCriteria("Server edited systems"));
    await view.click("Refresh");
    expect(view.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Keep this draft",
    );
    await view.click("Cancel");
    expect(view.container.textContent).toContain("Server edited systems");
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  },
);

it("keeps newer edits made while saving and saves them against the returned revision", async () => {
  let finish!: (value: ReturnType<typeof savedCriteria>) => void;
  api.editCriteria.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Edit criteria");
  await changeStatement(view.container, "Build reliable systems");
  await view.click("Save");
  await changeStatement(view.container, "Build observable systems");
  const saved = savedCriteria();
  api.getWorkspace.mockResolvedValue(saved);
  await act(async () => finish(saved));
  expect(view.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    "Build observable systems",
  );
  api.editCriteria.mockResolvedValue(saved);
  await view.click("Save");
  expect(api.editCriteria).toHaveBeenLastCalledWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 3,
    criteria: [
      {
        criterionId: "criterion-1",
        priority: "hard",
        atoms: [{ atomId: "atom-1", statement: "Build observable systems" }],
      },
    ],
  });
});

it.each([
  ["role", "success"],
  ["role", "failure"],
  ["thread", "success"],
  ["thread", "failure"],
])("discards a late criteria save after switching %s (%s)", async (scope, outcome) => {
  let finish!: (value: ReturnType<typeof savedCriteria>) => void;
  let fail!: (reason: Error) => void;
  api.editCriteria.mockReturnValueOnce(
    new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    }),
  );
  const view = await mounted();
  await view.click("Edit criteria");
  await changeStatement(view.container, "Old role draft");
  await view.click("Save");
  const next = {
    role: {
      ...role,
      id: "role-next",
      title: "Compiler engineer",
      currentRevisionId: "revision-next",
    },
    revision: { ...revision, roleId: "role-next", id: "revision-next" },
  };
  api.getWorkspace.mockResolvedValue(next);
  await view.render(scope === "thread" ? "thread-next" : "thread-1", 1);
  expect(view.container.querySelector("textarea")).toBeNull();
  await view.click("Edit criteria");
  await changeStatement(view.container, "Next role draft");
  const reads = api.getWorkspace.mock.calls.length;
  await act(async () =>
    outcome === "success" ? finish(savedCriteria()) : fail(new Error("Old save failed")),
  );
  expect(api.getWorkspace).toHaveBeenCalledTimes(reads);
  expect(view.container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    "Next role draft",
  );
  expect(view.container.querySelector('[role="alert"]')).toBeNull();
});

it("refreshes brief confirmation and saved assessments after editing criteria", async () => {
  const brief = {
    fields: [],
    questions: [],
    rules: [],
    confirmation: {
      revision: 2,
      userId: "user-1",
      messageId: "confirmation-message",
      confirmedAt: "2026-01-01T00:00:00Z",
    },
  };
  api.getWorkspace.mockResolvedValue({ role, revision: { ...revision, brief } });
  api.listAssessments.mockResolvedValue([
    {
      ...assessment,
      isCurrent: true,
      roleRevision: revision,
      assessment: { ...assessment.assessment, roleRevisionId: revision.id },
    },
  ]);
  const view = await mounted();
  expect(view.container.textContent).toContain("Brief confirmed");
  await view.click("Edit criteria");
  await changeStatement(view.container, "Build reliable systems");
  const saved = savedCriteria();
  const next = {
    ...saved,
    revision: { ...saved.revision, brief: { ...brief, confirmation: null } },
  };
  api.editCriteria.mockResolvedValue(next);
  api.getWorkspace.mockResolvedValue(next);
  api.listAssessments.mockResolvedValue([{ ...assessment, isCurrent: false }]);
  await view.click("Save");
  expect(view.container.querySelector("textarea")).toBeNull();
  expect(view.container.textContent).toContain("Build reliable systems");
  expect(view.container.textContent).not.toContain("Brief confirmed");
  await view.click("Evidence");
  expect(view.container.textContent).toContain("Outdated");
});

it.each(["text/plain", "text/html", "application/json"])(
  "opens attested legacy %s source text with the exact quote highlighted and reads only",
  async (mimeType) => {
    const text = "  Before\r\nBuilt a compiler 😀\n<script>window.bad = true</script>  ";
    const quote = "Built a compiler 😀";
    const f = artifactSourceFixture(
      mimeType === "application/json" ? JSON.stringify({ text }) : text,
      mimeType,
    );
    const { selection: _, ...legacy } = f.source;
    api.getWorkspace.mockResolvedValue({
      role,
      revision: {
        ...revision,
        criteria: [],
        sourceRefs: [{ ...legacy, quote, anchor: { ...legacy.anchor, locator: "text" } }],
      },
    });
    api.getById.mockResolvedValue(f.artifact);
    const view = await mounted();
    expect(api.getById).not.toHaveBeenCalled();
    const details = await view.expand("text");
    await vi.waitFor(() => expect(details.querySelector("pre mark")?.textContent).toBe(quote));
    expect(details.querySelector("pre")?.textContent).toBe(text);
    expect(details.querySelector('pre[role="document"][aria-label="Source text"]')).not.toBeNull();
    expect(details.querySelector("mark")?.className).toBe("bg-accent text-accent-foreground");
    const metadata = details.querySelector("details");
    expect(metadata?.open).toBe(false);
    expect(metadata?.querySelector("summary")?.textContent).toBe("Details");
    expect(metadata?.textContent).toContain(f.reference.artifactId);
    expect(metadata?.textContent).toContain(f.reference.sha256);
    expect(details.textContent).toContain("Source text");
    expect(details.querySelector("script")).toBeNull();
    expect(details.querySelector('[data-artifact-id="artifact-source"]')).not.toBeNull();
    expect(api.getById).toHaveBeenCalledExactlyOnceWith({ artifactId: f.reference.artifactId });
    for (const method of [
      api.createRole,
      api.bindRole,
      api.reviseRole,
      api.update,
      api.search,
      api.answer,
    ])
      expect(method).not.toHaveBeenCalled();
    expect(api.get).not.toHaveBeenCalled();
    expect(view.reveal).not.toHaveBeenCalled();
    await view.click("Refresh");
    expect(api.getById).toHaveBeenCalledTimes(1);
  },
);

it("projects a nested JSON string at exact UTF-16 offsets without normalizing escaped text", async () => {
  const quote = 'same\t"quoted"\\path 😀';
  const text = `  Prefix 😀\r\n${quote}\n${quote} trailing  `;
  const start = text.lastIndexOf(quote);
  const f = artifactSourceFixture(JSON.stringify({ rows: [{ detail: text }] }), "application/json");
  api.listAssessments.mockResolvedValue([
    {
      ...assessment,
      assessment: {
        ...assessment.assessment,
        sourceRefs: [
          {
            ...f.source,
            kind: "provider_report",
            quote,
            selection: {
              kind: "artifact_json_string",
              path: ["rows", 0, "detail"],
              start,
              end: start + quote.length,
            },
          },
        ],
      },
    },
  ]);
  api.getById.mockResolvedValue(f.artifact);
  const view = await mounted();
  await view.click("Evidence");
  await view.click("candidate-1");
  expect(api.getById).not.toHaveBeenCalled();
  const details = await view.expand("Source excerpt");
  await vi.waitFor(() => expect(details.querySelector("mark")?.textContent).toBe(quote));
  expect(details.querySelector("pre")?.textContent).toBe(text);
  expect(details.querySelector("mark")?.previousSibling?.textContent).toBe(text.slice(0, start));
  expect(view.container.textContent).toContain("provider_report · read");
  expect(view.container.textContent).toContain("Unknown");
});

it.each(["id", "hash", "size", "access"])(
  "withholds source files and text when Artifact %s verification fails",
  async (failure) => {
    const f = artifactSourceFixture();
    api.getWorkspace.mockResolvedValue({
      role,
      revision: { ...revision, criteria: [], sourceRefs: [f.source] },
    });
    if (failure === "access")
      api.getById.mockRejectedValue(new Error("Private unrelated artifact details"));
    else
      api.getById.mockResolvedValue({
        ...f.artifact,
        ...(failure === "id" ? { id: "foreign-artifact" } : {}),
        ...(failure === "hash"
          ? { contentBase64: Buffer.from("Different source bytes").toString("base64"), size: 22 }
          : {}),
        ...(failure === "size" ? { size: f.artifact.size + 1 } : {}),
      });
    const view = await mounted();
    const details = await view.expand("Source excerpt");
    await vi.waitFor(() => expect(details.textContent).toContain("Source unavailable"));
    expect(details.querySelector("[data-artifact-id]")).toBeNull();
    expect(details.querySelector("pre")).toBeNull();
    expect(details.textContent).not.toContain("Private unrelated artifact details");
    expect(details.textContent).not.toContain("foreign-artifact");
  },
);

it.each(["quote", "range", "surrogate", "path", "utf8", "binary", "legacy locator"])(
  "keeps the original file available without inventing text for an invalid %s source",
  async (failure) => {
    const text = "Before\nBuilt a compiler 😀\nAfter";
    const f = artifactSourceFixture(
      failure === "path"
        ? JSON.stringify({ rows: [{ detail: text }] })
        : failure === "utf8"
          ? new Uint8Array([0xc3, 0x28])
          : text,
      failure === "path"
        ? "application/json"
        : failure === "binary"
          ? "application/pdf"
          : "text/plain",
    );
    const source: RecruitingAssessmentSourceRef = {
      ...f.source,
      ...(failure === "quote" ? { quote: "A different quote" } : {}),
      ...(failure === "range"
        ? { selection: { kind: "artifact_text", start: -1, end: text.length } }
        : {}),
      ...(failure === "surrogate"
        ? {
            quote: "\ude00",
            selection: {
              kind: "artifact_text",
              start: text.indexOf("😀") + 1,
              end: text.indexOf("😀") + 2,
            },
          }
        : {}),
      ...(failure === "path"
        ? {
            selection: {
              kind: "artifact_json_string",
              path: ["rows", "0", "detail"],
              start: 7,
              end: 23,
            },
          }
        : {}),
      ...(failure === "legacy locator" ? { selection: undefined } : {}),
    };
    api.getWorkspace.mockResolvedValue({
      role,
      revision: { ...revision, criteria: [], sourceRefs: [source] },
    });
    api.getById.mockResolvedValue(f.artifact);
    const view = await mounted();
    const details = await view.expand("Source excerpt");
    await vi.waitFor(() => expect(details.textContent).toContain("Source unavailable"));
    expect(details.querySelector('[data-artifact-id="artifact-source"]')).not.toBeNull();
    expect(details.querySelector("pre")).toBeNull();
    expect(details.querySelector("mark")).toBeNull();
  },
);

it("replaces the excerpt when selection changes and ignores the late old selection read", async () => {
  const text = "First excerpt\nSecond excerpt";
  const f = artifactSourceFixture(text);
  const first = {
    ...f.source,
    quote: "First excerpt",
    selection: { kind: "artifact_text" as const, start: 0, end: 13 },
  };
  const second = {
    ...f.source,
    quote: "Second excerpt",
    selection: { kind: "artifact_text" as const, start: 14, end: text.length },
  };
  let finish!: (artifact: typeof f.artifact) => void;
  api.getWorkspace.mockResolvedValue({
    role,
    revision: { ...revision, criteria: [], sourceRefs: [first] },
  });
  api.getById
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue(f.artifact);
  const view = await mounted();
  await view.expand("Source excerpt");
  api.getWorkspace.mockResolvedValue({
    role,
    revision: { ...revision, criteria: [], sourceRefs: [second] },
  });
  await view.click("Refresh");
  await vi.waitFor(() =>
    expect(view.container.querySelector("pre mark")?.textContent).toBe("Second excerpt"),
  );
  await act(async () => {
    finish(f.artifact);
  });
  expect(view.container.querySelector("pre mark")?.textContent).toBe("Second excerpt");
});

it("does not carry expanded evidence or a late source response into another thread", async () => {
  const f = artifactSourceFixture();
  let finish!: (artifact: typeof f.artifact) => void;
  api.getWorkspace.mockResolvedValue({
    role,
    revision: { ...revision, criteria: [], sourceRefs: [f.source] },
  });
  api.getById.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.expand("Source excerpt");
  api.getWorkspace.mockResolvedValue(null);
  await view.render("thread-2");
  await act(async () => {
    finish(f.artifact);
  });
  expect(view.container.querySelector("mark")).toBeNull();
  expect(view.container.textContent).not.toContain("original-material.txt");
  expect(view.container.textContent).not.toContain("Source excerpt");
});

it("does not carry expanded evidence or a late source response into another candidate", async () => {
  const f = artifactSourceFixture();
  const original = {
    ...assessment,
    assessment: { ...assessment.assessment, sourceRefs: [f.source] },
  };
  const second = {
    ...original,
    assessment: { ...original.assessment, candidateKey: "candidate-2" },
  };
  let finish!: (artifact: typeof f.artifact) => void;
  api.listAssessments.mockResolvedValue([original, second]);
  api.getById.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = await mounted();
  await view.click("Evidence");
  await view.click("candidate-1");
  await view.expand("Source excerpt");
  await view.click("candidate-2");
  await act(async () => {
    finish(f.artifact);
  });
  expect(view.container.querySelector("mark")).toBeNull();
  expect(view.container.querySelector("[data-artifact-id]")).toBeNull();
  expect(api.getById).toHaveBeenCalledTimes(1);
});

it("does not carry expanded evidence into another role with the same source reference", async () => {
  const f = artifactSourceFixture();
  const original = { ...revision, criteria: [], sourceRefs: [f.source] };
  api.getWorkspace.mockResolvedValue({ role, revision: original });
  api.getById.mockResolvedValue(f.artifact);
  const view = await mounted();
  await view.expand("Source excerpt");
  await vi.waitFor(() =>
    expect(view.container.querySelector("mark")?.textContent).toBe(f.source.quote),
  );
  const nextRole = { ...role, id: "role-next", currentRevisionId: "revision-next" };
  api.getWorkspace.mockResolvedValue({
    role: nextRole,
    revision: { ...original, id: nextRole.currentRevisionId, roleId: nextRole.id },
  });
  api.listAssessments.mockResolvedValue([]);
  api.listResearch.mockResolvedValue({ tasks: [], actions: [] });
  await view.click("Refresh");
  expect(view.container.querySelector("mark")).toBeNull();
  expect(view.container.querySelector("[data-artifact-id]")).toBeNull();
});

it.each(["thread", "assessment sources", "bot memory"])(
  "clears previously opened evidence after %s authorization is revoked and reloads without old selection",
  async (boundary) => {
    const f = artifactSourceFixture();
    api.listAssessments.mockResolvedValue([
      { ...assessment, assessment: { ...assessment.assessment, sourceRefs: [f.source] } },
    ]);
    api.getById.mockResolvedValue(f.artifact);
    const view = await mounted("thread-1", "owner-bot");
    await view.click("Evidence");
    await view.click("candidate-1");
    await view.expand("Source excerpt");
    await vi.waitFor(() =>
      expect(view.container.querySelector("mark")?.textContent).toBe(f.source.quote),
    );
    if (boundary === "thread")
      api.getWorkspace.mockRejectedValueOnce(new ORPCError("UNAUTHORIZED"));
    else if (boundary === "assessment sources")
      api.listAssessments.mockRejectedValueOnce(new ORPCError("NOT_FOUND"));
    else
      api.list
        .mockImplementationOnce(async () => [])
        .mockRejectedValueOnce(new ORPCError("FORBIDDEN"));
    await view.click("Refresh");
    expect(view.container.textContent).toContain("Could not load recruiting");
    expect(view.container.textContent).not.toContain("candidate-1");
    expect(view.container.textContent).not.toContain(f.source.quote);
    expect(view.container.querySelector("mark")).toBeNull();
    expect(view.container.querySelector("[data-artifact-id]")).toBeNull();
    await view.click("Refresh");
    await view.click("Evidence");
    expect(view.container.textContent).toContain("candidate-1");
    expect(view.container.querySelector('section[aria-label="candidate-1"]')).toBeNull();
    await view.click("candidate-1");
    await view.expand("Source excerpt");
    await vi.waitFor(() =>
      expect(view.container.querySelector("mark")?.textContent).toBe(f.source.quote),
    );
    expect(api.getById).toHaveBeenCalledTimes(2);
  },
);

it.each(["recruiting reads", "memory reads"])(
  "clears opened evidence when %s deny access after a sibling already failed offline",
  async (boundary) => {
    const f = artifactSourceFixture();
    api.listAssessments.mockResolvedValue([
      { ...assessment, assessment: { ...assessment.assessment, sourceRefs: [f.source] } },
    ]);
    api.getById.mockResolvedValue(f.artifact);
    const view = await mounted("thread-1", "owner-bot");
    await view.click("Evidence");
    await view.click("candidate-1");
    await view.expand("Source excerpt");
    await vi.waitFor(() =>
      expect(view.container.querySelector("mark")?.textContent).toBe(f.source.quote),
    );
    let deny!: (error: ORPCError<"NOT_FOUND", unknown>) => void;
    const laterDenial = new Promise((_, reject) => {
      deny = reject;
    });
    if (boundary === "recruiting reads") {
      api.listResearch.mockRejectedValueOnce(new Error("offline"));
      api.listAssessments.mockReturnValueOnce(laterDenial);
    } else {
      api.list.mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(laterDenial);
    }
    await view.click("Refresh");
    expect(view.container.textContent).toContain("Could not load recruiting");
    expect(view.container.querySelector("mark")?.textContent).toBe(f.source.quote);
    await act(async () => {
      deny(new ORPCError("NOT_FOUND"));
    });
    expect(view.container.querySelector("mark")).toBeNull();
    expect(view.container.querySelector("[data-artifact-id]")).toBeNull();
    expect(view.container.textContent).not.toContain("candidate-1");
    expect(view.container.textContent).not.toContain(f.source.quote);
  },
);

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
  const next = artifactSourceFixture('{"next":true}', "application/json", "request-2");
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
        requestArtifact: next.reference,
      },
    ],
  });
  api.getById.mockResolvedValue({
    ...next.artifact,
    botId: null,
    groupId: "source-group",
    name: "request-2.json",
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

it("confirms only the reviewed brief revision through the human API", async () => {
  const brief = {
    fields: [
      {
        key: "salary_range",
        value: "GBP 90,000 to 120,000",
        origin: "jd",
        state: "known",
        consequential: true,
        sourceRefIds: [source.id],
      },
    ],
    questions: [],
    rules: [],
    confirmation: null,
  };
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      brief,
      criteria: revision.criteria.map((criterion) => ({ ...criterion, definitionQuestions: [] })),
    },
  });
  api.confirmBrief.mockResolvedValue({ role, revision });
  const view = await mounted();
  expect(api.confirmBrief).not.toHaveBeenCalled();
  await view.click("Confirm brief");
  expect(api.confirmBrief).toHaveBeenCalledWith({
    threadId: "thread-1",
    roleId: role.id,
    expectedRevision: 2,
  });
});

it("keeps an unresolved brief unconfirmed and preserves its view after a conflict", async () => {
  const brief = {
    fields: [
      {
        key: "salary_range",
        value: null,
        origin: "jd",
        state: "conflict",
        consequential: true,
        sourceRefIds: [],
      },
    ],
    questions: [],
    rules: [],
    confirmation: null,
  };
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      brief,
      criteria: revision.criteria.map((criterion) => ({ ...criterion, definitionQuestions: [] })),
    },
  });
  const view = await mounted();
  const button = [...view.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Confirm brief",
  );
  expect(button?.disabled).toBe(true);
  brief.fields[0] = {
    ...brief.fields[0]!,
    state: "known",
    value: "GBP 90,000 to 120,000",
  } as never;
  api.getWorkspace.mockResolvedValue({
    role,
    revision: {
      ...revision,
      brief,
      criteria: revision.criteria.map((criterion) => ({ ...criterion, definitionQuestions: [] })),
    },
  });
  await view.render("thread-1", 1);
  api.confirmBrief.mockRejectedValueOnce(new Error("Revision changed"));
  await view.click("Confirm brief");
  expect(view.container.textContent).toContain("Brief changed or could not be confirmed");
  expect(view.container.textContent).toContain("GBP 90,000 to 120,000");
  expect(view.container.textContent).not.toContain("Brief confirmed");
});
