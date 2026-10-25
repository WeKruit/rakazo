// @vitest-environment jsdom

import type { AccountSecurity } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Field: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
  Label: ({ children, htmlFor }: { children?: ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & React.ComponentProps<"button">) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    />
  ),
  Toggle: ({
    children,
    onPressedChange,
    pressed: _pressed,
    variant: _variant,
    ...props
  }: {
    children?: ReactNode;
    onPressedChange?: () => void;
    pressed?: boolean;
    variant?: string;
  } & React.ComponentProps<"button">) => (
    <button type="button" onClick={() => onPressedChange?.()} {...props}>
      {children}
    </button>
  ),
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
}));

const accountPolicy = vi.hoisted(() => ({
  passwordChangeEnabled: undefined as boolean | undefined,
}));
vi.mock("../components/AccountAccess", () => ({
  AccountAccess: ({ onSecurity }: { onSecurity: (value: AccountSecurity) => void }) => {
    useEffect(
      () =>
        onSecurity({
          hasPassword: true,
          passwordChangeEnabled: accountPolicy.passwordChangeEnabled,
          freshOidcAuth: false,
          ssoLinked: false,
          emailDeletion: false,
          sso: null,
        }),
      [onSecurity],
    );
    return null;
  },
}));

vi.mock("../components/ApprovalRulesSettings", () => ({ ApprovalRulesSettings: () => null }));
vi.mock("../components/ai/primitives", () => ({ SuccessPop: () => null }));
vi.mock("../components/ComputersUnavailableHint", () => ({
  ComputersUnavailableHint: () => null,
}));
vi.mock("../components/DesktopUpdates", () => ({ DesktopUpdateSection: () => null }));
vi.mock("../components/SoftwareUpdateSection", () => ({ SoftwareUpdateSection: () => null }));
vi.mock("../lib/auth", () => ({ authClient: { changePassword: vi.fn() } }));
vi.mock("../lib/i18n", () => ({
  getActiveUiLocale: () => "en",
  setUiLocale: (locale: string) => Promise.resolve(locale),
}));
vi.mock("../lib/ui-appearance", () => ({
  getUiAppearancePreference: () => "system",
  setUiAppearance: vi.fn(),
}));
vi.mock("react-router-dom", () => ({ Link: ({ children }: { children?: ReactNode }) => children }));

import {
  COMPOSER_ENTER_TO_SEND_STORAGE_KEY,
  getComposerEnterToSend,
  setComposerEnterToSend,
} from "../lib/composer-enter-to-send-pref";
import { getRemoteImagesEnabled } from "../lib/remote-images-preference";
import { TOOL_ACTIVITY_STORAGE_KEY } from "../lib/tool-activity-preference";
import { GeneralSettingsPanels, UsageSettingsPanel } from "./AccountSettingsOverlay";

afterEach(() => {
  localStorage.clear();
});

it("lets a deployment owner opt in to developer diagnostics", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <GeneralSettingsPanels
          name="Jamie"
          avatarStyle="robot"
          onAvatarStyleChange={async () => undefined}
          isDeploymentOwner
        />,
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="tool-activity-toggle"]',
    );
    if (!toggle) throw new Error("Missing tool activity toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Developer diagnostics");

    await act(async () => {
      toggle.click();
    });

    expect(localStorage.getItem(TOOL_ACTIVITY_STORAGE_KEY)).toBe("on");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      toggle.click();
    });

    expect(localStorage.getItem(TOOL_ACTIVITY_STORAGE_KEY)).toBe("off");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("does not offer diagnostics to a non-owner with a saved enabled preference", async () => {
  localStorage.setItem(TOOL_ACTIVITY_STORAGE_KEY, "on");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <GeneralSettingsPanels
          name="Jamie"
          avatarStyle="robot"
          onAvatarStyleChange={async () => undefined}
          isDeploymentOwner={false}
        />,
      );
    });
    expect(container.querySelector('[data-testid="tool-activity-toggle"]')).toBeNull();
    expect(container.textContent).not.toContain("Developer diagnostics");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("turns loading web images on and off from the settings toggle", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <GeneralSettingsPanels
          name="Jamie"
          avatarStyle="robot"
          onAvatarStyleChange={async () => undefined}
        />,
      );
    });

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="remote-images-toggle"]',
    );
    if (!toggle) throw new Error("Missing remote images toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(getRemoteImagesEnabled()).toBe(false);

    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(getRemoteImagesEnabled()).toBe(true);

    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(getRemoteImagesEnabled()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([undefined, true, false])("respects the password-change policy (%s)", async (enabled) => {
  accountPolicy.passwordChangeEnabled = enabled;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <GeneralSettingsPanels
          name="Test"
          avatarStyle="robot"
          onAvatarStyleChange={async () => undefined}
        />,
      ),
    );
    expect(container.textContent?.includes("Change password")).toBe(enabled !== false);
  } finally {
    await act(async () => root.unmount());
    accountPolicy.passwordChangeEnabled = undefined;
    vi.unstubAllGlobals();
  }
});

it("updates the Enter preference from Settings and reflects external changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setComposerEnterToSend(true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <GeneralSettingsPanels
          name="Test"
          avatarStyle="robot"
          onAvatarStyleChange={async () => undefined}
        />,
      );
    });
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="composer-enter-to-send-toggle"]',
    );
    if (!toggle) throw new Error("Missing Enter preference");
    expect(container.querySelector(`label[for="${toggle.id}"]`)?.textContent).toBe(
      "Send with Enter",
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(getComposerEnterToSend()).toBe(false);
    expect(localStorage.getItem(COMPOSER_ENTER_TO_SEND_STORAGE_KEY)).toBe("0");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => setComposerEnterToSend(true));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("shows spend per role and round, with dollars and services only for the owner", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const amounts = { credits: 150, calls: 2, tokens: 1200 };
  const usage = {
    total: amounts,
    month: amounts,
    days: [{ day: "2026-10-25", ...amounts }],
    roles: [
      {
        roleId: "role-1",
        title: "Quality manager",
        ...amounts,
        rounds: [{ round: 1, scale: false, ...amounts }],
      },
    ],
  };
  try {
    await act(async () => root.render(<UsageSettingsPanel usage={usage} />));
    expect(container.textContent).toContain("Quality manager");
    expect(container.textContent).toContain("Search credits");
    expect(container.textContent).not.toContain("Estimated cost");
    expect(container.querySelector('[data-testid="usage-services"]')).toBeNull();

    const priced = { ...amounts, estimatedUsd: 1.28 };
    await act(async () =>
      root.render(
        <UsageSettingsPanel
          usage={{
            ...usage,
            total: priced,
            month: priced,
            services: [{ service: "people-search", unit: "calls", quantity: 2 }],
            accounts: [{ userId: "user-1", email: "owner@example.test", ...priced }],
          }}
        />,
      ),
    );
    expect(container.textContent).toContain("Estimated cost");
    expect(container.textContent).toContain("$1.28");
    expect(container.querySelector('[data-testid="usage-services"]')?.textContent).toContain(
      "people-search",
    );
    expect(container.textContent).toContain("owner@example.test");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
