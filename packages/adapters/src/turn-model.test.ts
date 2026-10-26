import { describe, expect, it } from "vitest";
import { chooseTurnModel, type TurnModelInput } from "./turn-model.js";

const base: TurnModelInput = {
  configured: { provider: "openai-codex", id: "gpt-6.1-sol" },
  trigger: "user",
  answersQuestion: false,
  userText: "Can you move that call to Thursday?",
  hasAttachments: false,
  pendingToolLoop: false,
  env: {},
};
const fast = { provider: "openai-codex", id: "gpt-6-luna" };

describe("chooseTurnModel", () => {
  it("routes a short user message to the fast model on the bot's provider", () => {
    expect(chooseTurnModel(base)).toEqual({
      model: fast,
      routed: "fast",
      reason: "short_user_message",
    });
  });
  it("routes a clarifying answer fast regardless of trigger", () => {
    expect(chooseTurnModel({ ...base, trigger: "resume", answersQuestion: true })).toMatchObject({
      routed: "fast",
      reason: "clarifying_answer",
    });
  });
  it("routes a pasted JD that starts a recruiting role fast", () => {
    expect(
      chooseTurnModel({
        ...base,
        trigger: "follow_up",
        userText: "x".repeat(3000),
        recruitingIntake: true,
      }),
    ).toMatchObject({ routed: "fast", reason: "recruiting_intake" });
  });
  it("routes status/fyi peer wakes fast", () => {
    expect(
      chooseTurnModel({ ...base, trigger: "bot_message", peerIntent: "status" }),
    ).toMatchObject({
      routed: "fast",
      reason: "status_turn",
    });
  });
  it("keeps the configured model for long messages, attachments, tool loops and other triggers", () => {
    expect(chooseTurnModel({ ...base, userText: "x".repeat(300) })).toMatchObject({
      model: base.configured,
      routed: "configured",
      reason: "long_message",
    });
    expect(chooseTurnModel({ ...base, hasAttachments: true }).reason).toBe("attachments");
    expect(chooseTurnModel({ ...base, pendingToolLoop: true, answersQuestion: true }).reason).toBe(
      "pending_tool_loop",
    );
    expect(chooseTurnModel({ ...base, trigger: "routine" }).reason).toBe("trigger:routine");
  });
  it("honours the env off-switch and provider override", () => {
    expect(chooseTurnModel({ ...base, env: { RAKAZO_FAST_MODEL: "" } })).toEqual({
      model: base.configured,
      routed: "configured",
      reason: "fast_model_disabled",
    });
    expect(
      chooseTurnModel({
        ...base,
        env: { RAKAZO_FAST_MODEL: "gpt-5.6-luna", RAKAZO_FAST_MODEL_PROVIDER: "openrouter" },
      }).model,
    ).toEqual({ provider: "openrouter", id: "gpt-5.6-luna" });
  });
  it("does not re-route a bot already on the fast model", () => {
    expect(chooseTurnModel({ ...base, configured: fast }).reason).toBe("already_fast");
  });
});
