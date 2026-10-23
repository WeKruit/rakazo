import { parseAskFormResponse } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  answerableAskMessageIds,
  askFormAnswerText,
  askFormContent,
  askFormDefaults,
  askFormOptions,
  latestAnswerableAskMessageId,
  resolveAskChoice,
  selectedAskActionLabel,
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
