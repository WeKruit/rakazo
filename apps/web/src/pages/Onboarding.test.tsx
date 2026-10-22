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
