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
  /** Role rows with their current revision, as the role-records read returns them. */
  revisions?: Row[];
  effects?: Row[];
  /** Role campaign bindings and activate_campaign receipts. */
  bindings?: Row[];
  sends?: Row[];
}) {
  return {
    chatGroup: { findMany: vi.fn(async () => input.groups ?? []) },
    recruitingRole: {
      findMany: vi.fn(async ({ where }: { where: { id?: unknown } }) =>
        where.id ? (input.revisions ?? []) : (input.roles ?? []),
      ),
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
    run: {
      findMany: vi.fn(async ({ select }: { select: { id?: boolean } }) =>
        select.id ? [{ id: "run-1" }] : (input.runs ?? []),
      ),
    },
    externalEffect: {
      findMany: vi.fn(async ({ where }: { where: { kind: unknown } }) =>
        where.kind === "instantly_role_campaign"
          ? (input.bindings ?? [])
          : typeof where.kind === "object"
            ? (input.sends ?? [])
            : (input.effects ?? []),
      ),
    },
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

  it("puts each role's requirements and saved email on the card, and a role's own email in its conversation", async () => {
    const effects = [
      {
        request: { roleId: "role-1" },
        result: {
          steps: [
            { subject: "Agent infra at Acme", body: "Hi {{firstName}}, ..." },
            { subject: "", body: "Following up" },
          ],
        },
        updatedAt: new Date(now - 10 * 60_000),
      },
      {
        request: { roleId: "role-other" },
        result: { steps: [{ subject: "x", body: "y" }] },
        updatedAt: new Date(now),
      },
    ];
    const revisions = [
      {
        id: "role-1",
        currentRevision: {
          criteria: [
            { priority: "hard", expression: { kind: "atom", statement: "Backend in Go" } },
            {
              priority: "soft",
              expression: {
                kind: "all",
                items: [{ kind: "not", item: { kind: "atom", statement: "agency recruiter" } }],
              },
            },
          ],
          preferences: ["Seattle 3 days onsite"],
        },
      },
    ];
    const card = (
      await loadWorkingState(
        fakePrisma({ groups, roles, revisions, effects }) as never,
        scope,
        globalThread,
        (t) => t,
        now,
      )
    ).text;
    expect(card).toContain(
      "  Requirements on record: must: Backend in Go; nice: not agency recruiter; preference: Seattle 3 days onsite",
    );
    expect(card).toContain(
      'saved email for this role (2 steps, 10 min ago; read it with get_role_draft before writing another): "Agent infra at Acme — Hi {{firstName}}, ..."',
    );
    expect(card).not.toContain("role-other");
    const own = (
      await loadWorkingState(
        fakePrisma({ revisions, effects }) as never,
        scope,
        { id: "t1", groupId: "g1", activeRecruitingRoleId: "role-1" },
        (t) => t,
        now,
      )
    ).text;
    expect(own).toContain("- This role's saved email for this role (2 steps");
    expect(own).not.toContain("Saved emails: none");
  });

  it("says a confirmed send is not a delivery, and that a campaign with no confirmed send emailed nobody", async () => {
    const lead = { leadId: "l", email: "a@x.test" };
    const bindings = [
      {
        request: { roleId: "role-1" },
        result: {
          campaignId: "c-1",
          created: true,
          leads: { a: lead, b: lead },
          staged: { c: lead },
        },
      },
      {
        request: { roleId: "role-2" },
        result: { campaignId: "c-2", created: true, leads: { a: lead } },
      },
    ];
    const sends = [
      { result: { error: "paused", campaignId: "c-2" }, updatedAt: new Date(now) },
      {
        result: { content: [{ text: '{"queued":true,"campaignId":"c-1"}' }] },
        updatedAt: new Date(now - 13 * 60_000),
      },
    ];
    const card =
      (
        await loadWorkingState(
          fakePrisma({ groups, roles, bindings, sends }) as never,
          scope,
          globalThread,
          (t) => t,
          now,
        )
      ).text ?? "";
    expect(card).toContain(
      "  Campaign: 2 people in it, 1 more added and not in it until a confirmed send; the recruiter confirmed a send 13 min ago. Whether it is sending and who has been emailed are known only from get_campaign this turn",
    );
    expect(card).toContain(
      "  Campaign: 1 person in it; no send confirmed, so nobody has been emailed from it.",
    );
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
    expect(state.text).toContain(
      "Saved emails: none on record for the roles below. An email written only in chat",
    );
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

  it("takes no language from the copy of the recruiter's message a new role opens with", async () => {
    // Staging 11-14: an English JD opened the role, then 「远程也可以」 in the main conversation,
    // and the role team kept replying in English.
    const state = await loadWorkingState(
      fakePrisma({
        recruiter: [
          {
            ...text("Senior Data Engineer, Seattle, hybrid, 5+ years"),
            clientNonce: "start-role:k",
          },
        ],
        account: [text("对了，远程也可以，不一定要在西雅图")],
      }) as never,
      scope,
      { id: "t1", groupId: "g1", activeRecruitingRoleId: "role-1" },
      (t) => t,
      now,
    );
    expect(state.language).toBe("zh");
  });

  it("takes the language from that copy when the recruiter has written nothing else", async () => {
    // Staging 11-14 2bb9124c: with the copy left out, a new role's first question went out in
    // English to a Chinese recruiter.
    const state = await loadWorkingState(
      fakePrisma({
        recruiter: [
          {
            ...text("新岗位：华东区销售总监，常驻上海，医疗器械行业"),
            clientNonce: "start-role:k",
          },
        ],
        account: [],
      }) as never,
      scope,
      { id: "t1", groupId: "g1", activeRecruitingRoleId: "role-1" },
      (t) => t,
      now,
    );
    expect(state.language).toBe("zh");
  });

  it("spells the left menu as the recruiter's screen shows it", async () => {
    // Staging 11-14: a Korean recruiter was told replies are in "Inbox (收件箱)".
    const thread = { id: "t1", groupId: "g1", activeRecruitingRoleId: "role-1" };
    const korean = await loadWorkingState(
      fakePrisma({
        recruiter: [text("답장은 어디서 확인하나요? 화면에서 볼 수 있는 곳")],
      }) as never,
      scope,
      thread,
      (t) => t,
      now,
    );
    expect(korean.text).toContain("Their left menu reads: Candidates, Inbox, Sequence");
    expect(korean.text).not.toContain("收件箱");
    const chinese = await loadWorkingState(
      fakePrisma({ recruiter: [text("回复在哪里看？")] }) as never,
      scope,
      thread,
      (t) => t,
      now,
    );
    expect(chinese.text).toContain("Inbox = 收件箱");
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
