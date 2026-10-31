import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MessageBlock, ProductEventType } from "./events.js";

// Messages and events are stored forever and replayed into every later run. A change to their
// shape must keep old rows readable: when this hash changes, check that rows written before the
// change still parse (add them to OLD_ROWS), then update the hash.
const GOLDEN = "085f3288cbb63090f3a066df1cd15d1abb091e18b9a6096b26e5a0fe7be0cc12";

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
  { kind: "meta", text: "Dana stopped the assistant" },
];

describe("stored event shapes", () => {
  it("match the reviewed schema", () => {
    const schema = JSON.stringify({
      blocks: z.toJSONSchema(MessageBlock, { io: "input" }),
      events: ProductEventType.options,
    });
    expect(createHash("sha256").update(schema).digest("hex")).toBe(GOLDEN);
  });

  it.each(OLD_ROWS)("still read a row written before the last change: %j", (row) => {
    expect(MessageBlock.safeParse(row).success).toBe(true);
  });
});
