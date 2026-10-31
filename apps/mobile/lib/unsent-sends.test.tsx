// @vitest-environment jsdom
import { resolveComposerSendPlan } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 1, rpc: vi.fn(), restore: vi.fn(() => []) }));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  AppState: { addEventListener: vi.fn() },
}));
vi.mock("./api", () => ({
  captureApiRequestContext: async () => ({ headers: {} }),
  currentApiBase: () => "https://api.example.test",
  selectedSpaceId: () => "space",
  isServerReachable: () => true,
  subscribeServerReachable: vi.fn(),
  rpc: state.rpc,
}));
vi.mock("./artifact-cache-session", () => ({ artifactCacheSession: async () => "cache" }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));
vi.mock("./integrations-cache", () => ({
  integrationsCacheScope: async () => ({ userId: "user", spaceId: "space" }),
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => state.generation,
  loadSessionToken: async () => "synthetic-token",
  loadVerifiedIntegrationsScope: async () => null,
}));
vi.mock("./outbox-disk", () => ({
  outboxDisk: {
    admit: () => true,
    hydrate: async () => undefined,
    forget: vi.fn(),
    save: vi.fn(),
    load: state.restore,
    clear: vi.fn(),
  },
}));
vi.mock("./user-error", () => ({ errorText: String }));

import { clearUnsentSends, useThreadFeedback } from "./thread-feedback";
import { prepareUnsentSends } from "./unsent-sends";

it("prepares a cold signed-in outbox before sending a failed-reply retry, without composer state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.rpc.mockResolvedValue({ seq: 3 });
  const container = document.createElement("div");
  const root = createRoot(container);
  let feedback!: ReturnType<typeof useThreadFeedback>;
  function Probe() {
    feedback = useThreadFeedback("bot", () => "retry-nonce");
    return null;
  }
  const retry = {
    queueMode: "steer" as const,
    originThreadKey: "bot",
    displayText: "Try again",
    replyPreview: null,
    initialBotTarget: "bot",
    botTarget: "bot",
    reroutedToGroup: false,
    plan: resolveComposerSendPlan({ text: "Try again", mentions: [], hasAttachments: false }),
    attachments: [],
    replyQuote: null,
  };
  try {
    act(() => root.render(<Probe />));
    expect(() => feedback.sendAttempt(retry)).toThrow("SESSION_CHANGED");
    await act(async () => prepareUnsentSends());
    const attempt = feedback.sendAttempt(retry);
    await act(async () => {
      expect(await feedback.send(attempt)).toBe(true);
    });
    expect(state.restore).toHaveBeenCalledOnce();
    expect(state.rpc).toHaveBeenCalledWith(
      "threads/send",
      expect.objectContaining({
        botId: "bot",
        text: "Try again",
        queueMode: "steer",
        clientNonce: "retry-nonce",
      }),
      expect.objectContaining({
        requestContext: expect.objectContaining({ headers: { "x-rakazo-space-id": "space" } }),
      }),
    );
    // A session change invalidates even this prepared scope; retry cannot move accounts.
    state.generation += 1;
    expect(() => feedback.sendAttempt(retry)).toThrow("SESSION_CHANGED");
  } finally {
    act(() => {
      clearUnsentSends();
      root.unmount();
    });
    vi.unstubAllGlobals();
  }
});
