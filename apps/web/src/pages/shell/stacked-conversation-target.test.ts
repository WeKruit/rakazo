import { describe, expect, it } from "vitest";
import { stackedConversationTarget } from "./stacked-conversation-target";

const origin = "https://app.example";

describe("stackedConversationTarget", () => {
  it("reads a group conversation link and its message", () => {
    expect(stackedConversationTarget("/app/g/g-1?m=msg-9", origin)).toEqual({
      groupId: "g-1",
      messageId: "msg-9",
    });
    expect(stackedConversationTarget(`${origin}/app/g/g%201`, origin)).toEqual({ groupId: "g 1" });
  });

  it("ignores other sites and other app pages", () => {
    expect(stackedConversationTarget("https://other.example/app/g/g-1?m=x", origin)).toBeNull();
    expect(stackedConversationTarget("/app/bot-1?m=x", origin)).toBeNull();
    expect(stackedConversationTarget("/app/g/g-1/settings", origin)).toBeNull();
  });
});
