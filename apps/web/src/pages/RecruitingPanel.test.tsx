// @vitest-environment jsdom
import type {
  RecruitingAssessment,
  RecruitingAssessmentSourceRef,
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
};
let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.getWorkspace.mockResolvedValue({ role, revision });
  api.listAssessments.mockResolvedValue([assessment]);
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
  const render = async (id: string, refreshSignal = 0) =>
    act(async () =>
      root.render(
        <MemoryRouter>
          <RecruitingPanel
            threadId={id}
            botId={botId}
            refreshSignal={refreshSignal}
            onClose={() => {}}
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
  return { container, render, click, expand };
}
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
  await view.expand("candidate-1");
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
  await view.expand("candidate-1");
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
  expect(roleSources.textContent).toContain("Role brief");
  expect(roleSources.textContent).toContain("message-1");
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
    api.listAssessments.mockResolvedValue([{ assessment: saved, isCurrent: true }]);
    const view = await mounted();
    await view.click("Evidence");
    await view.expand("candidate-1");
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
