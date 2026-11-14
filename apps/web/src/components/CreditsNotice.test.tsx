// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { rpc } from "../lib/rpc";
import { CreditsNotice } from "./CreditsNotice";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../lib/support", () => ({
  useSupportEmail: () => null,
  supportMailto: () => "",
}));
vi.mock("../lib/rpc", () => ({
  rpc: {
    usage: {
      remaining: vi.fn(async () => ({ remaining: 420.6 })),
      costs: vi.fn(),
    },
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

it("warns from the credits left alone, without reading the whole usage breakdown", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<CreditsNotice />));
  expect(container.textContent).toContain("420 credits left");
  expect(rpc.usage.remaining).toHaveBeenCalledOnce();
  // The breakdown is the slowest read on large accounts; the notice never needs it.
  expect(rpc.usage.costs).not.toHaveBeenCalled();
  act(() => root.unmount());
});
