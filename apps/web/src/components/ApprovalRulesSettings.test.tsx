// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn(), set: vi.fn(), autoReview: vi.fn() }));
vi.mock("../lib/rpc", () => ({
  rpc: {
    approvalRules: { list: api.list, set: api.set },
    autoReview: { get: api.autoReview },
  },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
  }) => <button type="button" {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor }: ComponentProps<"label">) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    onCheckedChange: _onChange,
    ...props
  }: ComponentProps<"input"> & {
    onCheckedChange?: (value: boolean) => void;
  }) => <input type="checkbox" {...props} />,
}));

import { ApprovalRulesSettings } from "./ApprovalRulesSettings";

afterEach(() => vi.unstubAllGlobals());

it("requires approval for an exact tool and keeps failed edits retryable without changing presets", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockReset().mockResolvedValue([]);
  api.autoReview.mockReset().mockResolvedValue({ enabled: false, checkerAvailable: false });
  api.set.mockReset().mockImplementation(async (input) => ({ id: input.matchValue, ...input }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApprovalRulesSettings />));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Tool name"]');
    expect(input).not.toBeNull();
    if (!input) throw new Error("Missing exact tool input");
    const button = (name: string) => {
      const found = [...container.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === name,
      );
      if (!found) throw new Error(`Missing button: ${name}`);
      return found;
    };
    const fill = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    expect(button("Ask first").disabled).toBe(true);
    await fill("   ");
    expect(button("Ask first").disabled).toBe(true);
    await fill("  mcp__service__research  ");
    api.set.mockRejectedValueOnce(new Error("Temporary save failure"));
    await act(async () => button("Ask first").click());
    expect(container.textContent).toContain("Temporary save failure");
    expect(input.value).toBe("  mcp__service__research  ");
    await act(async () => button("Ask first").click());
    expect(api.set).toHaveBeenLastCalledWith({
      effect: "require_approval",
      matchKind: "tool",
      matchValue: "mcp__service__research",
    });
    expect(input.value).toBe("");
    expect(container.textContent).toContain("Ask before mcp__service__research");
    await fill("mcp__service__research");
    await act(async () => button("Ask first").click());
    expect(api.set).toHaveBeenCalledTimes(2);
    await act(async () => button("Ask before sending external email").click());
    expect(api.set).toHaveBeenLastCalledWith({
      effect: "require_approval",
      matchKind: "category",
      matchValue: "email",
    });
    await act(async () => button("Ask before purchases").click());
    expect(api.set).toHaveBeenLastCalledWith({
      effect: "require_approval",
      matchKind: "category",
      matchValue: "purchase",
    });
    await fill("mcp__service__send_email");
    await act(async () => button("Block").click());
    expect(api.set).toHaveBeenLastCalledWith({
      effect: "block",
      matchKind: "tool",
      matchValue: "mcp__service__send_email",
    });
    expect(container.textContent).toContain("Block mcp__service__send_email");
    await fill("mcp__service__delete_record");
    await act(async () => button("Hide").click());
    expect(api.set).toHaveBeenLastCalledWith({
      effect: "hide",
      matchKind: "tool",
      matchValue: "mcp__service__delete_record",
    });
    expect(container.textContent).toContain("Hide mcp__service__delete_record");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("limits the computer to allowed sites and adds a site", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockReset().mockResolvedValue([
    { id: "lock", effect: "block", matchKind: "egress", matchValue: "*", createdAt: "" },
  ]);
  api.autoReview.mockReset().mockResolvedValue({ enabled: false, checkerAvailable: false });
  api.set.mockReset().mockImplementation(async (input) => ({ id: input.matchValue, ...input }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApprovalRulesSettings />));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Allowed site"]');
    if (!input) throw new Error("Missing allowed site input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "pypi.org",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const allow = [...container.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === "Allow",
    );
    await act(async () => allow?.click());
    expect(api.set).toHaveBeenLastCalledWith({
      effect: "always_allow",
      matchKind: "egress",
      matchValue: "pypi.org",
    });
    expect(container.textContent).toContain("Computer may reach pypi.org");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
