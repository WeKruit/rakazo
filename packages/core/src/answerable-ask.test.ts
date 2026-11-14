import { parseAskFormResponse } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  answerableAskMessageIds,
  askFormAnswerText,
  askFormContent,
  askFormDefaults,
  askFormOptions,
  closedAskAnswer,
  isOpenAskBlock,
  latestAnswerableAskMessageId,
  pendingInputAttention,
  reopenedAskMessageIds,
  resolveAskChoice,
  selectedAskActionLabel,
  timedOutAskMessageId,
  waitingApprovalCards,
  waitingApprovalNote,
} from "./answerable-ask.js";

it("unsets cleared optional fields while preserving required and explicit empty enum values", () => {
  const schema = {
    type: "object" as const,
    properties: {
      website: { type: "string" as const, format: "uri" as const },
      email: { type: "string" as const, format: "email" as const },
      date: { type: "string" as const, format: "date" as const },
      tags: {
        type: "array" as const,
        minItems: 1,
        items: { type: "string" as const, enum: ["a"] },
      },
      requiredUrl: { type: "string" as const, format: "uri" as const },
      requiredNumber: { type: "integer" as const },
      emptyChoice: { type: "string" as const, enum: [""] },
      presentText: { type: "string" as const },
    },
    required: ["requiredUrl", "requiredNumber", "presentText"],
  };
  const content = askFormContent(schema, {
    website: "",
    email: "",
    date: "",
    tags: [],
    requiredUrl: "https://example.com",
    requiredNumber: "2",
    emptyChoice: "",
    presentText: "",
  });
  expect(content).toEqual({
    requiredUrl: "https://example.com",
    requiredNumber: 2,
    emptyChoice: "",
    presentText: "",
  });
  expect(parseAskFormResponse(schema, { action: "accept", content })).toEqual({
    action: "accept",
    content,
  });
  expect(() =>
    parseAskFormResponse(schema, {
      action: "accept",
      content: askFormContent(schema, { requiredUrl: "", requiredNumber: "", presentText: "" }),
    }),
  ).toThrow();
});

it("shares standard form defaults, typed submission and display labels across surfaces", () => {
  const schema = {
    type: "object" as const,
    properties: {
      website: { type: "string" as const, format: "uri" as const },
      count: { type: "integer" as const, default: 2 },
      confirmed: { type: "boolean" as const },
      regions: {
        type: "array" as const,
        title: "Regions",
        items: {
          anyOf: [
            { const: "north", title: "North" },
            { const: "south", title: "South" },
          ],
        },
      },
    },
    required: ["confirmed", "regions"],
  };
  expect(askFormDefaults(schema)).toEqual({ count: 2, confirmed: false, regions: [] });
  expect(askFormContent(schema, { count: "3", website: "https://example.com" })).toEqual({
    count: 3,
    website: "https://example.com",
  });
  expect(askFormContent(schema, { count: "" })).toEqual({});
  expect(askFormContent(schema, { count: "  " })).toEqual({});
  expect(askFormOptions(schema.properties.regions)).toEqual([
    { value: "north", label: "North" },
    { value: "south", label: "South" },
  ]);
  expect(askFormOptions({ type: "string", enum: ["a"], enumNames: ["Option A"] })).toEqual([
    { value: "a", label: "Option A" },
  ]);
  expect(askFormAnswerText(schema, { action: "accept", content: { regions: ["south"] } })).toBe(
    "Regions: South",
  );
  expect(askFormAnswerText(schema, { action: "cancel" })).toBe("Cancelled");
  expect(askFormAnswerText(schema, { action: "decline" })).toBe("Declined");
});

it("keeps each waiting agent's latest question answerable in a group", () => {
  expect(
    answerableAskMessageIds({
      activeRuns: [
        { id: "main", status: "waiting_input" },
        { id: "sourcer", status: "waiting_input" },
        { id: "busy", status: "running" },
      ],
      messages: [
        { id: "main-old", runId: "main", blocks: [{ kind: "ask", status: "pending" }] },
        { id: "main-ask", runId: "main", blocks: [{ kind: "ask", status: "pending" }] },
        { id: "sourcer-ask", runId: "sourcer", blocks: [{ kind: "ask", status: "pending" }] },
        { id: "busy-ask", runId: "busy", blocks: [{ kind: "ask", status: "pending" }] },
      ],
    }),
  ).toEqual(["main-ask", "sourcer-ask"]);
});

describe("latestAnswerableAskMessageId", () => {
  it("finds a waiting prompt even when a newer group run is active", () => {
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-newer", status: "running" },
        activeRuns: [
          { id: "run-newer", status: "running" },
          { id: "run-waiting", status: "waiting_input" },
        ],
        messages: [
          {
            id: "ask-1",
            runId: "run-waiting",
            blocks: [{ kind: "ask", status: "pending" }],
          },
        ],
      }),
    ).toBe("ask-1");
  });

  it("ignores answered prompts and prompts from non-waiting runs", () => {
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-1", status: "running" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "pending" }] }],
      }),
    ).toBeNull();
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-1", status: "waiting_input" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "answered" }] }],
      }),
    ).toBeNull();
  });
});

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});

describe("resolveAskChoice", () => {
  const actions = [
    { id: "choice-1", label: "Berlin" },
    { id: "choice-2", label: "Seoul" },
  ];

  it("matches an offered choice by id or label", () => {
    expect(resolveAskChoice("choice-2", actions)).toEqual({ id: "choice-2", label: "Seoul" });
    expect(resolveAskChoice(" seoul ", actions)).toEqual({ id: "choice-2", label: "Seoul" });
  });

  it("leaves unmatched free-text as a custom answer", () => {
    expect(resolveAskChoice("Toronto", actions)).toBeUndefined();
  });
});

describe("pending input attention", () => {
  it("uses native approval metadata, not question wording", () => {
    const question = { kind: "ask", status: "pending", text: "Confirm location?" };
    expect(pendingInputAttention([question])).toBe("question");
    expect(pendingInputAttention([question, { ...question, approvalEffectId: "effect" }])).toBe(
      "approval",
    );
    expect(pendingInputAttention([{ ...question, status: "answered" }])).toBeNull();
    expect(pendingInputAttention(null)).toBeNull();
  });
});

describe("closed cards", () => {
  it("treats an expired card as closed everywhere an open card is looked for", () => {
    expect(isOpenAskBlock({ kind: "ask", status: "pending" })).toBe(true);
    expect(isOpenAskBlock({ kind: "ask" })).toBe(true);
    expect(isOpenAskBlock({ kind: "ask", status: "expired" })).toBe(false);
    expect(isOpenAskBlock({ kind: "ask", status: "answered" })).toBe(false);
    expect(
      answerableAskMessageIds({
        activeRuns: [{ id: "run-1", status: "waiting_input" }],
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "expired" }] }],
      }),
    ).toEqual([]);
  });

  it("turns a press on a closed question, choice or form into the message a person would type", () => {
    const actions = [
      { id: "remote", label: "Remote is fine" },
      { id: "onsite", label: "Onsite only" },
    ];
    expect(
      closedAskAnswer({ kind: "ask", text: "Which city?", status: "expired" }, "Paris"),
    ).toEqual({ text: "Paris", recorded: "Paris" });
    expect(
      closedAskAnswer({ kind: "ask", text: "Location?", status: "expired", actions }, "onsite"),
    ).toEqual({ text: "Onsite only", recorded: "onsite" });
    const requestedSchema = {
      type: "object" as const,
      properties: { seniority: { type: "string" as const, title: "Seniority" } },
      required: ["seniority"],
    };
    expect(
      closedAskAnswer(
        { kind: "ask", text: "Details", status: "expired", requestedSchema },
        { action: "accept", content: { seniority: "Staff" } },
      ),
    ).toEqual({
      text: "Seniority: Staff",
      recorded: "Seniority: Staff",
      formResponse: { action: "accept", content: { seniority: "Staff" } },
    });
    expect(
      closedAskAnswer(
        { kind: "ask", text: "Details", status: "expired", requestedSchema },
        { action: "cancel" },
      ),
    ).toBeNull();
  });

  it("never replays a stale approval or a secret as a message", () => {
    expect(
      closedAskAnswer(
        {
          kind: "ask",
          text: "Send the email?",
          status: "expired",
          approvalEffectId: "effect-1",
          actions: [
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
          ],
        },
        "allow",
      ),
    ).toBeNull();
    expect(
      closedAskAnswer({ kind: "ask", text: "API key", status: "expired", input: "secret" }, "sk"),
    ).toBeNull();
    expect(
      closedAskAnswer({ kind: "ask", text: "Which city?", status: "answered" }, "Paris"),
    ).toBeNull();
  });

  // 11-14 gate: the recruiter asked a question after the Connect Gmail card, and the card died.
  it("turns a sign-in on an ended connect card into a message, and only a sign-in", () => {
    const connect = {
      kind: "ask" as const,
      text: "Connect Gmail",
      status: "expired" as const,
      connection: { serverId: "server-1", name: "Gmail", reason: "Send the email" },
    };
    expect(closedAskAnswer(connect, "connected")).toEqual({
      text: "Connected Gmail.",
      recorded: "connected",
    });
    expect(closedAskAnswer(connect, "not_connected")).toBeNull();
  });
});

describe("waiting approval cards", () => {
  const approval = (text: string, status: string) => ({
    kind: "ask",
    text,
    status,
    approvalEffectId: "11111111-1111-4111-8111-111111111111",
  });

  it("lists only approval cards still waiting, once each, by their first line", () => {
    expect(
      waitingApprovalCards([
        [approval("Confirm interview booking → Adam Test\nTue 10:00", "pending")],
        [approval("Confirm interview booking → Adam Test", "pending")],
        [approval("Send email to Bo", "answered"), approval("Old card", "expired")],
        [{ kind: "ask", text: "Which city?", status: "pending" }],
        "not blocks",
      ]),
    ).toEqual(["Confirm interview booking → Adam Test"]);
  });

  it("says nothing when no card waits and forbids claiming an answer when one does", () => {
    expect(waitingApprovalNote([])).toBeUndefined();
    const note = waitingApprovalNote(["Confirm interview booking → Adam Test"]);
    expect(note).toContain('nobody has answered: "Confirm interview booking → Adam Test"');
    expect(note).toContain("Never say or imply the user approved");
    expect(note).toContain("Every other approval card is closed");
  });

  it("tells reply cards apart by recipient and body", () => {
    const reply = (body: string) => ({
      ...approval("Confirm reply", "pending"),
      mailReply: { to: ["bo@example.com"], body },
    });
    expect(
      waitingApprovalCards([[reply("Thanks,\n see you Tue")], [reply("Another note")]]),
    ).toEqual([
      'Confirm reply to bo@example.com: "Thanks, see you Tue"',
      'Confirm reply to bo@example.com: "Another note"',
    ]);
  });
});

describe("timedOutAskMessageId", () => {
  const card = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    role: "bot",
    runId: `run-${id}`,
    blocks: [{ kind: "ask", status: "expired", ...extra }],
  });

  it("reopens the newest timed-out question until the person says something", () => {
    expect(timedOutAskMessageId({ messages: [card("a"), card("b")] })).toBe("b");
    expect(
      timedOutAskMessageId({
        messages: [card("a"), { id: "c", role: "bot", blocks: [{ kind: "text" }] }],
      }),
    ).toBe("a");
    expect(
      timedOutAskMessageId({
        messages: [card("a"), { id: "u", role: "user", blocks: [{ kind: "text" }] }],
      }),
    ).toBeNull();
  });

  it("never reopens an approval, a secret, a connection or a card that was not timed out", () => {
    expect(timedOutAskMessageId({ messages: [card("a", { approvalEffectId: "e" })] })).toBeNull();
    expect(timedOutAskMessageId({ messages: [card("a", { input: "secret" })] })).toBeNull();
    expect(timedOutAskMessageId({ messages: [card("a", { connection: {} })] })).toBeNull();
    expect(timedOutAskMessageId({ messages: [card("a", { status: "pending" })] })).toBeNull();
    expect(timedOutAskMessageId({ messages: [card("a", { status: "answered" })] })).toBeNull();
  });

  it("leaves the choice to a card that still waits", () => {
    const waiting = {
      id: "w",
      role: "bot",
      runId: "run-w",
      blocks: [{ kind: "ask", status: "pending" }],
    };
    expect(
      timedOutAskMessageId({
        messages: [card("a"), waiting],
        activeRuns: [{ id: "run-w", status: "waiting_input" }],
      }),
    ).toBeNull();
  });
});

describe("reopenedAskMessageIds", () => {
  const connect = (id: string, status = "expired", serverId = "gmail") => ({
    id,
    role: "bot",
    runId: `run-${id}`,
    blocks: [{ kind: "ask", status, connection: { serverId } }],
  });
  const said = { id: "u", role: "user", blocks: [{ kind: "text" }] };

  it("keeps the newest connect card per service pressable after the recruiter writes", () => {
    expect(reopenedAskMessageIds({ messages: [connect("a"), said, connect("b")] })).toEqual(["b"]);
    expect(reopenedAskMessageIds({ messages: [connect("a"), said] })).toEqual(["a"]);
    expect(
      reopenedAskMessageIds({ messages: [connect("a"), connect("c", "expired", "calendar")] }),
    ).toEqual(["c", "a"]);
  });

  it("drops a connect card once it is answered, and defers to a card that still waits", () => {
    expect(reopenedAskMessageIds({ messages: [connect("a"), connect("b", "answered")] })).toEqual(
      [],
    );
    expect(
      reopenedAskMessageIds({
        messages: [
          connect("a"),
          { id: "w", role: "bot", runId: "run-w", blocks: [{ kind: "ask", status: "pending" }] },
        ],
        activeRuns: [{ id: "run-w", status: "waiting_input" }],
      }),
    ).toEqual([]);
  });

  it("still reopens the newest timed-out question", () => {
    const question = {
      id: "q",
      role: "bot",
      runId: "run-q",
      blocks: [{ kind: "ask", status: "expired" }],
    };
    expect(reopenedAskMessageIds({ messages: [question] })).toEqual(["q"]);
  });
});
