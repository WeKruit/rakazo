import { describe, expect, it } from "vitest";
import { promptShape } from "./pi-runtime.js";

describe("promptShape", () => {
  const base = {
    systemPrompt: "You are Kruit.",
    tools: [{ name: "read_memory", description: "Read memory", parameters: {} }],
    messages: [
      { role: "user", content: "summary", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
    ],
  };

  it("hashes only what the provider sees, so replayed history keeps its hash", () => {
    const later = {
      ...base,
      messages: base.messages.map((message) => ({ ...message, timestamp: 99 })),
    };
    expect(promptShape(later)).toEqual(promptShape(base));
  });

  it("shows the first message that changed", () => {
    const shape = promptShape(base);
    const changed = promptShape({
      ...base,
      messages: [base.messages[0]!, { role: "assistant", content: "different" }],
    });
    expect(changed.system).toBe(shape.system);
    expect(changed.tools).toBe(shape.tools);
    expect(changed.messages.split(" ")[0]).toBe(shape.messages.split(" ")[0]);
    expect(changed.messages.split(" ")[1]).not.toBe(shape.messages.split(" ")[1]);
    expect(JSON.stringify(shape)).not.toContain("Kruit");
  });
});
