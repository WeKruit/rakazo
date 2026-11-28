import { recruitingHomeGroupId } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { requirementsText } from "./role-records.js";
import { isRolelessHomeTeam, loadWorkingState } from "./working-state.js";

const now = Date.parse("2026-11-01T04:00:00Z");
const scope = { spaceId: "s", userId: "u" };
type ThreadFixture = { id: string; groupId: string; activeRecruitingRoleId: string | null };
const globalThread: ThreadFixture = {
  id: "tg",
  groupId: "recruiting-global-abc",
  activeRecruitingRoleId: null,
};
const roleThread: ThreadFixture = {
  id: "t1",
  groupId: "role-abc",
  activeRecruitingRoleId: "role-1",
};

type Row = Record<string, unknown>;

function fakePrisma(input: {
  groups?: Row[];
  /** Groups not among the most recently active, found only by id. */
  otherGroups?: Row[];
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
  /** The focus role's latest calibration round. */
  round?: Row | null;
  /** Each card role's latest calibration round. */
  rounds?: Row[];
  /** Saved rows of the people those rounds showed. */
  shownPeople?: Row[];
  /** The account's active roles, and its archived ones. */
  roleCount?: number;
  archivedCount?: number;
}) {
  return {
    // No one was turned down in these fixtures.
    $queryRaw: vi.fn(async () => []),
    recruitingCandidate: { findMany: vi.fn(async () => []) },
    recruitingCalibrationRound: {
      findFirst: vi.fn(async () => input.round ?? null),
      findMany: vi.fn(async () =>
        (input.rounds ?? []).map((round) => ({ candidateKeys: [], ...round })),
      ),
    },
    recruitingCandidateOccurrence: { findMany: vi.fn(async () => input.shownPeople ?? []) },
    chatGroup: {
      findMany: vi.fn(async () => input.groups ?? []),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          [...(input.groups ?? []), ...(input.otherGroups ?? [])].find(
            (group) => group.id === where.id,
          ) ?? null,
      ),
    },
    recruitingRole: {
      findMany: vi.fn(async ({ where }: { where: { id?: unknown } }) =>
        where.id ? (input.revisions ?? []) : (input.roles ?? []),
      ),
      count: vi.fn(
        async ({ where }: { where: { archivedAt?: unknown; sourceThread?: unknown } }) =>
          where.archivedAt !== null
            ? (input.archivedCount ?? 0)
            : // Staging 11-21 (what-happened x5): a count that kept roles whose chat was archived
              // said 977 next to the activity read's 53, so every reply hedged on 924 "uncovered".
              where.sourceThread
              ? (input.roleCount ?? 1175)
              : (input.roleCount ?? 1175) + 924,
      ),
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
    _count: { candidates: 12 },
  },
  {
    id: "role-2",
    title: "Payments Go Engineer Ref 0303",
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
const card = (groupId: string) => ({ blocks: [{ kind: "role_link", groupId, title: groupId }] });

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
    const card = state.text ?? "";
    expect(card).toContain(
      "Done in this conversation in the last 24 h (tool receipts): FAILED save_template (1 min ago).",
    );
    expect(card).toContain(
      "0 people shown to the recruiter (less any they turned down) · team waiting on the recruiter since 5 min ago",
    );
    expect(card).toContain(
      "Role teams: 1175 active roles in all; the 2 most recently active are below",
    );
    expect(card).toContain('  Waiting on the recruiter: "Is USC required?"');
    // The latest run decides, not an older failed one.
    expect(card).toContain("0 people shown to the recruiter (less any they turned down) · team working now");
    expect(card).toContain(
      "sent the email (1 min ago), saved people to the role ×2 (latest 2 min ago)",
    );
    expect(card).not.toContain("draft ready");
  });

  it("tells Kruit to hand work on a round waiting for the recruiter to its team first", async () => {
    const load = (round: Row | null) =>
      loadWorkingState(
        fakePrisma({
          groups,
          roles,
          recruiter: [text("#8 不行，再找类似的")],
          messagesByThread: { tg: [card("g2")] },
          round,
        }) as never,
        scope,
        globalThread,
        (t) => t,
        now,
      );
    expect((await load({ round: 1, approvedAt: null })).text).toContain(
      "Its round 1 waits on the recruiter's answer",
    );
    expect((await load({ round: 1, approvedAt: new Date(now) })).text).not.toContain("waits on");
  });

  // Feedback-round 11-16: the recruiter's feedback on round one reached the role, but its
  // next-step card stayed open, so Kruit said the next ten "haven't started, waiting on your choice".
  it("drops a card the recruiter has written past in the role's chat", async () => {
    const state = await loadWorkingState(
      fakePrisma({
        groups,
        roles,
        recruiter: [text("more like the rest")],
        messagesByThread: {
          t1: [
            { role: "user", blocks: [{ kind: "text", text: "#8 and #10 aren't it" }] },
            {
              role: "bot",
              botId: "bot-sourcer",
              blocks: [{ kind: "ask", text: "What should I do next?", status: "pending" }],
            },
          ],
        },
      }) as never,
      scope,
      globalThread,
      (t) => t,
      now,
    );
    expect(state.text ?? "").not.toContain("Waiting on the recruiter");
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
    expect(own).not.toContain("Saved emails");
  });

  // Staging 11-14 send-at-night: a role opened from 「…hybrid 每周3天，6年以上…base 180-220k…」 saved
  // no criteria, and its team asked for the salary and location the recruiter had already given.
  it("puts the recruiter's own words on record before any requirement is saved", async () => {
    const quote = "Senior Data Engineer 西雅图，hybrid 每周3天，base 180-220k";
    const revisions = [
      {
        id: "role-1",
        currentRevision: {
          criteria: [],
          preferences: [],
          sourceRefs: [{ kind: "original_material", quote }],
        },
      },
    ];
    const own = (
      await loadWorkingState(
        fakePrisma({ revisions }) as never,
        scope,
        { id: "t1", groupId: "g1", activeRecruitingRoleId: "role-1" },
        (t) => t,
        now,
      )
    ).text;
    expect(own).toContain(
      `- This role's requirements on record: the recruiter's words: "${quote}"`,
    );
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
        result: { structuredContent: { result: { queued: true, campaignId: "c-1" } } },
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
      "  Campaign (campaign_id c-1): 2 people in it, 1 more added and not in it until a confirmed send; the recruiter confirmed a send 13 min ago. Whether it is sending and who has been emailed are known from get_campaign, not from the confirmation.",
    );
    expect(card).toContain(
      "  Campaign (campaign_id c-2): 1 person in it; no send confirmed, so nobody has been emailed from it.",
    );
  });

  it("names the role this conversation last opened or handed work to, and says when nothing was done", async () => {
    // Stage 3a3ee156: two roles saved as "Senior Data Engineer"; with no record of the one just
    // opened, Kruit handed "3 more" to the older one.
    const load = (messages: Row[]) =>
      loadWorkingState(
        fakePrisma({
          groups,
          otherGroups: [{ id: "g9", name: "Data Engineer 8 · 11491", thread: { id: "t9" } }],
          roles,
          recruiter: [text("ok go ahead and send them now please")],
          messagesByThread: { tg: messages },
        }) as never,
        scope,
        globalThread,
        (t) => t,
        now,
      );
    const state = await load([text("Done."), card("g1"), card("g2")]);
    expect(state.text).toContain(
      'This conversation last opened, or handed work to, "Agent" (roleId role-1).',
    );
    expect((await load([card("g9")])).text).toContain(
      'last opened, or handed work to, "Data Engineer 8 · 11491" (groupId g9, no saved role yet).',
    );
    // Several roles' cards in one message point to no one role.
    expect(
      (await load([{ blocks: [...card("g1").blocks, ...card("g2").blocks] }])).text,
    ).not.toContain("last opened");
    expect(state.text).toContain("nothing saved, sent or changed by a tool");
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

  // Gate ecebc59b, one-off-email: 「直接发吧」 got a going-ahead line and the Connect Gmail card
  // only 22 s later, so the first line read as if the email were going out.
  it("says the recruiter's own Gmail is not connected on an account that sends from it", async () => {
    const card = (gmail: Row | null, creditLimit: number | null, thread = roleThread) =>
      loadWorkingState(
        {
          ...fakePrisma({ groups }),
          user: { findUnique: vi.fn(async () => ({ usageCreditLimit: creditLimit })) },
          mcpServer: { findFirst: vi.fn(async () => gmail) },
        } as never,
        scope,
        thread,
        (t) => t,
        now,
      ).then((state) => state.text ?? "");
    expect(await card(null, 10_000)).toContain("Gmail: not connected");
    expect(await card({ id: "gmail-1" }, 10_000)).not.toContain("Gmail: not connected");
    // deny-then-change-and-send 11-16: on an account that sends from its outreach mailbox, Kruit
    // said 「Gmail 尚未连接，邮件无法发出」 and a role run said it had no email connection at all.
    expect(await card(null, null)).not.toContain("Gmail: not connected");
    expect(await card(null, null)).toContain("outreach mailbox");
    // Replay handoff4 11-27: told in Kruit's own conversation to write the email now, Kruit
    // drafted there instead of handing it to the role, which says how its mail goes out.
    expect(await card(null, 10_000, globalThread)).not.toContain("Gmail");
    expect(await card(null, null, globalThread)).not.toContain("outreach mailbox");
  });
  // team-stuck 11-16: Kruit said "checking" and handed an interview to the team, which found the
  // missing calendar two minutes later; feedback-round 11-16: "34 found" came from an old report.
  it("says when no calendar is connected and reads each team's round from records", async () => {
    const card = (server: Row | null, linked: Row | null, thread = globalThread) =>
      loadWorkingState(
        {
          ...fakePrisma({
            groups,
            roles,
            rounds: [
              {
                roleId: "role-1",
                round: 2,
                status: "shown",
                statusAt: new Date(now - 5 * 60_000),
                approvedAt: null,
                candidateKeys: ["k1", "k2"],
              },
            ],
            shownPeople: [
              { roleId: "role-1", name: "Steven Choi" },
              { roleId: "role-1", name: "Wensong Jing" },
            ],
            messagesByThread: {
              t1: [
                {
                  role: "bot",
                  botId: "bot-sourcer",
                  createdAt: new Date(now - 30 * 60_000),
                  ...text("Found 34 people"),
                },
              ],
            },
          }),
          mcpServer: { findFirst: vi.fn(async () => server) },
          connection: { findFirst: vi.fn(async () => linked) },
        } as never,
        scope,
        thread,
        (t) => t,
        now,
      ).then((state) => state.text ?? "");
    const none = await card(null, null);
    // Kruit's own conversation hands bookings over; the role's says what its calendar lacks.
    expect(none).not.toContain("calendar");
    expect(none).toContain(
      "2 people shown to the recruiter (less any they turned down) · round 2 shown in the role team's chat 5 min ago",
    );
    // Staging 11-26: three people named without their role cost seven reads before the first line.
    expect(none).toContain("People in its latest round: Steven Choi, Wensong Jing");
    expect(await card(null, null, roleThread)).toContain("calendar: none connected");
    expect(await card({ id: "gcal" }, null, roleThread)).not.toContain("calendar: none connected");
    expect(await card(null, { id: "composio-gcal" }, roleThread)).not.toContain(
      "calendar: none connected",
    );
  });
  // Gate 44c1ad44 team-has-no-email: Kruit answered from its own read with another person than
  // the team it had handed the email to, then said it had asked the team again.
  // fosp on 96dcd1c9: Kruit's chat relayed the team's older "timed out, no candidates" line while
  // the role already held 10. A team's chat never reaches this card; its result comes back as a
  // message when it is done.
  it("carries no line of a role team's own chat", async () => {
    const card = await loadWorkingState(
      fakePrisma({
        groups,
        roles,
        messagesByThread: {
          t1: [
            {
              role: "bot",
              botId: "bot-sourcer",
              createdAt: new Date(now - 60_000),
              ...text("8 searches failed, nobody saved yet"),
            },
            {
              role: "user",
              clientNonce: "start-role:k1",
              createdAt: new Date(now - 2 * 60_000),
              ...text("Senior Go engineer, Shanghai, start searching"),
            },
          ],
        },
      }) as never,
      scope,
      globalThread,
      (t) => t,
      now,
    ).then((state) => state.text ?? "");
    expect(card).toContain("roleId role-1");
    expect(card).not.toContain("8 searches failed");
    expect(card).not.toContain("Senior Go engineer, Shanghai");
  });
  // Gate 9e15e896, stop-after-approve: a campaign Kruit started outside any role was confirmed,
  // then "stop until Monday" and "who got it" had no campaign to read or pause.
  it("names a campaign this conversation started outside any role, with its id", async () => {
    const state = await loadWorkingState(
      fakePrisma({
        groups,
        bindings: [
          {
            idempotencyKey: "instantly-direct-campaign:server:campaign-7",
            result: { campaignId: "campaign-7", campaignName: "Data Engineer ref 09071" },
            createdAt: new Date(now - 5 * 60_000),
          },
        ],
      }) as never,
      scope,
      globalThread,
      (t) => t,
      now,
    );
    expect(state.text).toContain('"Data Engineer ref 09071" (campaign_id campaign-7)');
    expect(state.text).toContain("pause_campaign with that campaign_id");
  });

  // honest-limits 3f85ef1f (did-you-really-send 3/10, 2/10): with nothing on record that says
  // "none", Kruit answered "can't verify" and then took the recruiter's word that it had sent.
  it("says how many emails the account sent through the product, and none as a plain none", async () => {
    const none = await loadWorkingState(
      fakePrisma({ groups }) as never,
      scope,
      globalThread,
      (t) => t,
      now,
    );
    expect(none.text).toContain(
      "Emails sent from this account through the product in the last 7 days: none.",
    );
    const sent = await loadWorkingState(
      fakePrisma({
        groups,
        completed: [
          {
            threadId: "t-other",
            payload: { outcome: "succeeded", work: "sent" },
            createdAt: new Date(now - 3 * 86_400_000),
          },
          {
            threadId: "t-other",
            payload: { outcome: "succeeded", work: "saved" },
            createdAt: new Date(now - 60_000),
          },
        ],
      }) as never,
      scope,
      globalThread,
      (t) => t,
      now,
    );
    expect(sent.text).toContain(
      "Emails sent from this account through the product in the last 7 days: 1 send (latest 3 d ago)",
    );
  });

  // honest-limits 8a002815 (push-back-on-correct-answer#2): with no roles the card said nothing
  // about roles, so after 「不对啊，我昨天建了三个」 Kruit apologised and called the read unverifiable.
  it("says an account with no roles has none, as a plain none", async () => {
    const none = await loadWorkingState(
      fakePrisma({ roleCount: 0 }) as never,
      scope,
      globalThread,
      (t) => t,
      now,
    );
    expect(none.text).toContain("Role teams: none.");
    const archived = await loadWorkingState(
      fakePrisma({ roleCount: 0, archivedCount: 2 }) as never,
      scope,
      globalThread,
      (t) => t,
      now,
    );
    expect(archived.text).toContain("Role teams: none active; 2 archived");
  });
});

describe("requirementsText", () => {
  it("keeps every saved requirement, however long the list is", () => {
    const criteria = Array.from({ length: 30 }, (_, i) => ({
      priority: "hard",
      expression: { kind: "atom", statement: `requirement number ${i} stated by the recruiter` },
    }));
    const text = requirementsText(criteria, []) ?? "";
    expect(text).toContain("requirement number 29 stated by the recruiter");
    expect(text).not.toContain("…");
  });
});
