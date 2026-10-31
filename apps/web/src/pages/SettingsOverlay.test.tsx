// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("./AccountSettingsOverlay", () => ({
  GeneralSettingsPanels: () => <p>Account preferences</p>,
  ComputerSettingsPanel: () => null,
  UpdatesSettingsPanel: () => <p>Software updates</p>,
  UsageSettingsPanel: () => null,
}));
vi.mock("./VoiceSettingsOverlay", () => ({ VoiceSettingsOverlay: () => <p>Voice controls</p> }));
vi.mock("./MemorySettingsOverlay", () => ({ MemorySettingsOverlay: () => null }));
vi.mock("./BillingSettingsPanel", () => ({ BillingSettingsPanel: () => null }));
vi.mock("./InternalCostsSettingsPanel", () => ({ InternalCostsSettingsPanel: () => null }));
vi.mock("./ModelSettingsOverlay", () => ({ ModelSettingsOverlay: () => <p>Model controls</p> }));
vi.mock("../components/ErrorBoundary", () => ({ lazyPanel: () => () => <p>Model controls</p> }));

import { SettingsOverlay, type SettingsSection } from "./SettingsOverlay";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
async function mount(isDeploymentOwner: boolean, initialSection: SettingsSection = "general") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <SettingsOverlay
        name="Example user"
        avatarStyle="organic"
        onAvatarStyleChange={async () => {}}
        onUsageOpen={() => {}}
        memoryConfig={null}
        onMemoryConfigChange={() => {}}
        onClose={() => {}}
        isDeploymentOwner={isDeploymentOwner}
        initialSection={initialSection}
      />,
    ),
  );
  return document.querySelector('[data-testid="user-settings"]')!;
}
it.each(["models", "voice", "updates"] as const)(
  "hides %s and rejects its initial section for ordinary users",
  async (section) => {
    const view = await mount(false, section);
    expect(view.getAttribute("data-settings-section")).toBe("general");
    for (const hidden of ["models", "voice", "updates"])
      expect(view.querySelector(`[data-testid="settings-nav-${hidden}"]`)).toBeNull();
    expect(view.textContent).toContain("Account preferences");
    expect(view.querySelector('[data-testid="settings-nav-memory"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="settings-nav-usage"]')).not.toBeNull();
  },
);
it("retains the three sections for the deployment owner", async () => {
  const view = await mount(true, "updates");
  for (const section of ["models", "voice", "updates"])
    expect(view.querySelector(`[data-testid="settings-nav-${section}"]`)).not.toBeNull();
  expect(view.getAttribute("data-settings-section")).toBe("updates");
  expect(view.textContent).toContain("Software updates");
});
