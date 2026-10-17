import { describe, expect, it } from "vitest";
import {
  answerableAskMessageIds,
  latestAnswerableAskMessageId,
  resolveAskChoice,
  selectedAskActionLabel,
} from "./answerable-ask.js";

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
