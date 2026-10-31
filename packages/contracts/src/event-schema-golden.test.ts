import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EVENT_FORMAT_VERSION,
  MessageBlock,
  PRODUCT_EVENT_PAYLOAD_SCHEMAS,
  ProductEventType,
} from "./events.js";

// Messages and events are stored forever and replayed into every later run. A change to their
// shape must keep old rows readable: when the hash changes, check that rows written before the
// change still parse (add them to OLD_ROWS), bump EVENT_FORMAT_VERSION and add its hash here.
// Earlier versions stay listed so a hash can never be reused under a new number.
const GOLDEN_BY_VERSION: Record<number, string> = {
  1: "086577d14d7f578e997849d69416dfb8f7d0282c59cfbcf192e2a77c28f047fa",
  2: "531ad276e3d4642ccb095e1d219940e85021bb4946c73eac42a3a2afc49c7152",
  // 3: bot_message_received may name the conversation its outcome returns to (role team delegation).
  3: "fa2f7a5998cb406ab33cf7a0a7c99df8eea287fc1a4a44535c82b8b095c3c910",
};

const OLD_ROWS: unknown[] = [
  { kind: "text", text: "Found ten people for the role." },
  { kind: "handoff", fromBotId: "bot-a", toBotId: "bot-b", text: "Find ten people." },
  { kind: "handoff", fromBotId: "bot-a", toBotId: "bot-b", text: "Next stage.", hop: 2 },
  {
    kind: "handoff",
    fromBotId: "bot-b",
    toBotId: "bot-a",
    text: "Finished the stage.",
    hop: 2,
    report: "completed",
  },
  { kind: "ask", text: "Remote or onsite?", status: "pending" },
  { kind: "ask", text: "Remote or onsite?", status: "answered", answer: "Remote" },
  { kind: "steps", steps: [{ label: "Searching candidates", count: 2 }], durationMs: 4200 },
  {
    kind: "bot_message_received",
    fromBotId: "bot-a",
    fromBotName: "Main",
    text: "Find ten people.",
    intent: "request",
    returnToMessageId: "message-a",
    hop: 1,
  },
];

describe("stored event shapes", () => {
  it("match the reviewed schema of the current format version", () => {
    const payloads = Object.fromEntries(
      Object.entries(PRODUCT_EVENT_PAYLOAD_SCHEMAS)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, schema]) => [type, z.toJSONSchema(schema, { io: "input" })]),
    );
    const schema = JSON.stringify({
      blocks: z.toJSONSchema(MessageBlock, { io: "input" }),
      events: ProductEventType.options,
      payloads,
    });
    const hash = createHash("sha256").update(schema).digest("hex");
    expect(Math.max(...Object.keys(GOLDEN_BY_VERSION).map(Number))).toBe(EVENT_FORMAT_VERSION);
    expect(hash, "event format changed: bump EVENT_FORMAT_VERSION").toBe(
      GOLDEN_BY_VERSION[EVENT_FORMAT_VERSION],
    );
  });

  it.each(OLD_ROWS)("still read a row written before the last change: %j", (row) => {
    expect(MessageBlock.safeParse(row).success).toBe(true);
  });
});
