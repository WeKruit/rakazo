// @vitest-environment jsdom
import type { InternalUsageCosts } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
const mocks = vi.hoisted(() => ({ internalCosts: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { usage: { internalCosts: mocks.internalCosts } } }));

import { InternalCostsSettingsPanel } from "./InternalCostsSettingsPanel";

const amount = {
  credits: 1.4,
  costUsd: 0.007,
  priced: true,
  calls: 1,
  tokens: 170,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 40,
  cacheWriteTokens: 10,
  cacheWrite1hTokens: 0,
  reasoningTokens: 5,
};
const vendor = {
  ...amount,
  vendor: "model-provider",
  models: [
    {
      ...amount,
      model: "model-fixture",
      unit: "tokens",
      quantity: 170,
      costSources: ["provider-reported"],
      averageUnitCostUsd: (0.007 / 170) * 1000000,
    },
  ],
};
const data: InternalUsageCosts = {
  total: amount,
  month: amount,
  pricing: { creditsPerUsd: 100, grossMargin: 0.5 },
  vendors: [vendor],
  accounts: [
    {
      ...amount,
      userId: "fixture-account",
      email: "recruiter@example.test",
      name: "Recruiter",
      vendors: [vendor],
    },
  ],
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("expands account vendor and model costs with every measured token bucket", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.internalCosts.mockResolvedValue(data);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<InternalCostsSettingsPanel />));
    expect(mocks.internalCosts).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("recruiter@example.test");
    expect(container.textContent).toContain("$0.007");
    const account = container.querySelector<HTMLDetailsElement>('[data-testid="cost-account"]');
    expect(account).not.toBeNull();
    await act(async () => account!.querySelector("summary")!.click());
    const provider = account!.querySelector<HTMLDetailsElement>('[data-testid="cost-vendor"]');
    await act(async () => provider!.querySelector("summary")!.click());
    expect(provider!.textContent).toContain("model-fixture");
    expect(provider!.textContent).toContain("Input");
    expect(provider!.textContent).toContain("Cache read");
    expect(provider!.textContent).toContain("Cache write");
    expect(provider!.textContent).toContain("Reasoning");
    expect(provider!.textContent).toContain("provider-reported");
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps unpriced cost unknown and retries a failed request", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.internalCosts
    .mockRejectedValueOnce(new Error("Forbidden"))
    .mockResolvedValueOnce({ ...data, total: { ...amount, costUsd: null, priced: false } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<InternalCostsSettingsPanel />));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load internal costs",
    );
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(mocks.internalCosts).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Unpriced usage");
  } finally {
    await act(async () => root.unmount());
  }
});
