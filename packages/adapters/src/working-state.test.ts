import { recruitingHomeGroupId } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { isRolelessHomeTeam, loadWorkingState } from "./working-state.js";

const now = Date.parse("2026-11-01T04:00:00Z");
const scope = { spaceId: "s", userId: "u" };
const globalThread = { id: "tg", groupId: "recruiting-global-abc", activeRecruitingRoleId: null };

type Row = Record<string, unknown>;

function fakePrisma(input: {
  groups?: Row[];
  roles?: Row[];
  recruiter?: Row[];
  /** The account's newest recruiter messages, when they differ from this conversation's. */
  account?: Row[];
  messagesByThread?: Record<string, Row[]>;
  runs?: Row[];
  completed?: Row[];
  called?: Row[];
}) {
  return {
    chatGroup: { findMany: vi.fn(async () => input.groups ?? []) },
    recruitingRole: {
      findMany: vi.fn(async () => input.roles ?? []),
      count: vi.fn(async () => 1175),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where: { threadId?: unknown; role?: string } }) =>
        where.role !== "user"
          ? (input.messagesByThread?.[where.threadId as string] ?? [])
          : typeof where.threadId === "object"
            ? (input.account ?? input.recruiter ?? [])
            : (input.recruiter ?? []),
      ),
    },
    bot: { findMany: vi.fn(async () => [{ id: "bot-sourcer", name: "Sourcer" }]) },
    run: { findMany: vi.fn(async () => input.runs ?? []) },
    event: {
      findMany: vi.fn(async ({ where }: { where: { type: string } }) =>
        where.type === "agent.tool.completed" ? (input.completed ?? []) : (input.called ?? []),
      ),
    },
  };
}

const roles = [
  {
    id: "role-1",
    title: "Agent Engineer Ref 0153",
    playbookStage: "calibration_10",
    _count: { candidates: 12 },
  },
  {
    id: "role-2",
    title: "Payments Go Engineer Ref 0303",
    playbookStage: "intake",
    _count: { candidates: 0 },
  },
];
const groups = [
  {
    id: "g1",
    name: "Agent",
    updatedAt: new Date(now),
    thread: { id: "t1", activeRecruitingRoleId: "role-1" },
  },
  {
    id: "g2",
    name: "Payments",
    updatedAt: new Date(now),
    thread: { id: "t2", activeRecruitingRoleId: "role-2" },
  },
];
const text = (value: string) => ({ blocks: [{ kind: "text", text: value }] });

describe("loadWorkingState", () => {
  it("gives the router each role's state from records, its receipts and the role the recruiter names", async () => {
    const state = await loadWorkingState(
      fakePrisma({
        groups,
        roles,
        recruiter: [text("Ref 0303 的 Ada 现在就发"), text("帮我看看两个岗位")],
        messagesByThread: {
          t1: [
            {
              role: "bot",
              botId: "bot-sourcer",
              blocks: [{ kind: "ask", text: "Is USC required?", status: "pending" }],
            },
          ],
          t2: [
            {
              role: "bot",
              botId: "bot-sourcer",
              blocks: [{ kind: "text", text: "secret draft ready" }],
            },
          ],
        },
        runs: [
          { threadId: "t1", status: "waiting_input", updatedAt: new Date(now - 5 * 60_000) },
          { threadId: "t2", status: "running", updatedAt: new Date(now) },
          { threadId: "t2", status: "failed", updatedAt: new Date(now - 3_600_000) },
        ],
        completed: [
          {
            threadId: "t2",
            createdAt: new Date(now - 60_000),
            payload: { outcome: "succeeded", work: "sent" },
          },
          {
            threadId: "t2",
            createdAt: new Date(now - 120_000),
            payload: { outcome: "succeeded", work: "people_saved" },
          },
          {
            threadId: "t2",
            createdAt: new Date(now - 180_000),
            payload: { outcome: "succeeded", work: "people_saved" },
          },
          {
            threadId: "tg",
            createdAt: new Date(now - 60_000),
            payload: { outcome: "error", name: "save_template" },
          },
          {
            threadId: "tg",
            createdAt: new Date(now - 60_000),
            payload: { outcome: "succeeded", name: "read" },
          },
        ],
      }) as never,
      scope,
      globalThread,
      (t) => t.replace("secret", "[redacted]"),
      now,
    );
    expect(state.language).toBe("zh");
    const card = state.text ?? "";
    expect(card).toContain("writes in Chinese");
    expect(card).toContain('Role in focus: "Payments Go Engineer Ref 0303" (roleId role-2)');
    expect(card).toContain(
      "Done in this conversation in the last 24 h (tool receipts): FAILED save_template (1 min ago).",
    );
    expect(card).toContain(
      "stage calibration_10 · 12 people saved · team waiting on the recruiter since 5 min ago",
    );
    expect(card).toContain(
      "Role teams: 1175 active roles in all; the 2 most recently active are below",
    );
    expect(card).toContain('  Waiting on the recruiter: "Is USC required?"');
    // The latest run decides, not an older failed one.
    expect(card).toContain("0 people saved · team working now");
    expect(card).toContain(
      "sent the email (1 min ago), saved people to the role ×2 (latest 2 min ago)",
    );
    expect(card).toContain('Team\'s last report (Sourcer): "[redacted] draft ready"');
  });

  it("keeps the role last handed work in focus until the recruiter names another, and says when nothing was done", async () => {
    const state = await loadWorkingState(
      fakePrisma({
        groups,
        roles,
        recruiter: [text("ok go ahead and send them now please")],
        called: [
          { payload: { name: "recruiting_candidates", argsSummary: "operation=roles" } },
          { payload: { name: "delegate_to_role", argsSummary: "roleId=role-1, message=send" } },
        ],
      }) as never,
      scope,
      globalThread,
      (t) => t,
      now,
    );
    expect(state.language).toBe("en");
    expect(state.text).toContain(
      'Role in focus: "Agent Engineer Ref 0153" (roleId role-1), the role this conversation last handed work to',
    );
    expect(state.text).toContain("nothing saved, sent or changed by a tool");
  });

  it("gives a role conversation the recruiter's language from anywhere in the account", async () => {
    const prisma = fakePrisma({ recruiter: [text("候选人要会普通话，西雅图现场办公")] });
    const state = await loadWorkingState(
      prisma as never,
      scope,
      { id: "t1", groupId: "g1", activeRecruitingRoleId: "role-1" },
      (t) => t,
      now,
    );
    expect(state.language).toBe("zh");
    expect(state.text).not.toContain("Role teams");
  });

  it("puts this conversation's own words before the account's newest", async () => {
    const thread = { id: "t1", groupId: "g1", activeRecruitingRoleId: "role-1" };
    const zh = await loadWorkingState(
      fakePrisma({
        recruiter: [text("西雅图现场办公，要会普通话")],
        account: [text("please send the new grads list to my manager now")],
      }) as never,
      scope,
      thread,
      (t) => t,
      now,
    );
    expect(zh.language).toBe("zh");
    const handedOff = await loadWorkingState(
      fakePrisma({ recruiter: [], account: [text("候选人要会普通话")] }) as never,
      scope,
      thread,
      (t) => t,
      now,
    );
    expect(handedOff.language).toBe("zh");
  });

  it("never offers the account's own team as a role team before it holds a role", async () => {
    const home = recruitingHomeGroupId(scope);
    const roleless = { id: home, thread: { activeRecruitingRoleId: null } };
    expect(isRolelessHomeTeam(scope, roleless)).toBe(true);
    expect(
      isRolelessHomeTeam(scope, { id: home, thread: { activeRecruitingRoleId: "role-1" } }),
    ).toBe(false);
    expect(
      isRolelessHomeTeam(scope, { id: "role-abc", thread: { activeRecruitingRoleId: null } }),
    ).toBe(false);
    expect(isRolelessHomeTeam({ spaceId: "s", userId: "other" }, roleless)).toBe(false);
    const state = await loadWorkingState(
      fakePrisma({
        groups: [
          {
            ...roleless,
            name: "Recruiting",
            updatedAt: new Date(now),
            thread: { id: "t0", activeRecruitingRoleId: null },
          },
          {
            id: "role-abc",
            name: "Data Scientist",
            updatedAt: new Date(now),
            thread: { id: "t2", activeRecruitingRoleId: null },
          },
        ],
      }) as never,
      scope,
      globalThread,
      (t) => t,
      now,
    );
    expect(state.text).not.toContain(home);
    expect(state.text).toContain("groupId role-abc, no saved role yet");
  });
});
