// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { ReactNode } from "react";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  models: { list: vi.fn(), connect: vi.fn() },
  integrationSetup: { get: vi.fn() },
  onboarding: { ensureRecruiting: vi.fn() },
  mcp: { assignments: { approve: vi.fn() } },
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: api }));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("../lib/use-model-oauth-signin", () => ({ useModelOAuthSignIn: () => ({}) }));
vi.mock("../components/integrations/IntegrationSetup", () => ({ IntegrationSetup: () => null }));
vi.mock("../components/ModelConnectionPreflightNotice", () => ({
  ModelPreflightFeedback: () => null,
  modelPreflightTestingLabel: () => "Testing",
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children?: ReactNode }) => children,
  Plural: () => null,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ""), ""),
  }),
}));

import { OnboardingPage } from "./Onboarding";

let unmount: (() => Promise<void>) | undefined;
beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.me.mockResolvedValue({ needsModel: false, defaultProvider: "openai", defaultModel: "model" });
  api.models.list.mockResolvedValue([]);
  api.integrationSetup.get.mockResolvedValue({ needsSetup: false });
  api.onboarding.ensureRecruiting.mockResolvedValue({ botId: "my-main", groupId: "my-recruiting" });
});
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function open() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () =>
    root.render(
      <StrictMode>
        <OnboardingPage />
      </StrictMode>,
    ),
  );
  return host;
}

it("opens the provisioned recruiting conversation without a personal model or crew setup", async () => {
  const host = await open();
  expect(api.onboarding.ensureRecruiting).toHaveBeenCalledTimes(1);
  expect(api.onboarding.ensureRecruiting).toHaveBeenCalledWith({});
  expect(navigate).toHaveBeenCalledWith("/app/g/my-recruiting", { replace: true });
  expect(api.models.connect).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("Connect a model");
  expect(host.textContent).not.toContain("What do you want me on first?");
});

it("does not navigate a different account after the preparing page has unmounted", async () => {
  let finish!: (value: { botId: string; groupId: string }) => void;
  api.onboarding.ensureRecruiting.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await open();
  await unmount?.();
  unmount = undefined;
  await act(async () => finish({ botId: "previous-main", groupId: "previous-private-chat" }));
  expect(navigate).not.toHaveBeenCalled();
  expect(api.mcp.assignments.approve).not.toHaveBeenCalled();
});

it.each(["me", "models", "integrations"])(
  "retries a failed %s setup read without creating a workspace or skipping model setup",
  async (failed) => {
    const request =
      failed === "me" ? api.me : failed === "models" ? api.models.list : api.integrationSetup.get;
    request.mockRejectedValue(new Error("Setup read unavailable"));
    const host = await open();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Setup read unavailable");
    expect(api.onboarding.ensureRecruiting).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    api.me.mockResolvedValue({
      needsModel: true,
      defaultProvider: "openai",
      defaultModel: "model",
    });
    api.models.list.mockResolvedValue([]);
    api.integrationSetup.get.mockResolvedValue({ needsSetup: false });
    const reads = api.me.mock.calls.length;
    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    expect(api.me).toHaveBeenCalledTimes(reads + 1);
    expect(host.textContent).toContain("Connect a model");
    expect(api.onboarding.ensureRecruiting).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  },
);

it.each(["resolve", "reject"])(
  "ignores an older setup read that %ss while its retry is still loading",
  async (completion) => {
    let finishPrevious!: (value: { needsModel: boolean }) => void;
    let failPrevious!: (error: Error) => void;
    let finishRetry!: (value: { needsModel: boolean }) => void;
    api.me
      .mockReturnValueOnce(
        new Promise((resolve, reject) => {
          finishPrevious = resolve;
          failPrevious = reject;
        }),
      )
      .mockRejectedValueOnce(new Error("Setup read unavailable"))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishRetry = resolve;
        }),
      );
    const host = await open();
    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    await act(async () => {
      if (completion === "resolve") finishPrevious({ needsModel: false });
      else failPrevious(new Error("Previous setup read failed"));
    });
    expect(host.textContent).toContain("Loading…");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(api.onboarding.ensureRecruiting).not.toHaveBeenCalled();
    await act(async () => finishRetry({ needsModel: true }));
    expect(host.textContent).toContain("Connect a model");
    expect(api.onboarding.ensureRecruiting).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  },
);

it("ignores setup reads that complete after the account's onboarding has unmounted", async () => {
  let finish!: (value: { needsModel: boolean }) => void;
  api.me.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await open();
  await unmount?.();
  unmount = undefined;
  await act(async () => finish({ needsModel: false }));
  expect(api.onboarding.ensureRecruiting).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});
