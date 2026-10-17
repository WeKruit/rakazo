// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import { BOT_DESCRIPTION_MAX_LENGTH, BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/rpc", () => ({
  rpc: {
    voice: { voices: vi.fn().mockResolvedValue([]) },
    models: {
      credentials: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
    },
    me: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
  Input: (props: ComponentProps<"input">) => <input {...props} />,
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    onCheckedChange: _onCheckedChange,
    checked: _checked,
    ...props
  }: ComponentProps<"button"> & {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => <button type="button" {...props} />,
  Toggle: ({
    onPressedChange: _onPressedChange,
    pressed,
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & {
    variant?: string;
    size?: string;
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
  }) => (
    <button type="button" aria-pressed={pressed} {...props}>
      {props.children}
    </button>
  ),
}));
vi.mock("./avatar-studio-popover", () => ({ AvatarStudioPopover: () => null }));
vi.mock("./bot-credentials", () => ({ BotCredentialsSection: () => null }));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({ KnowledgeSection: () => null }));

import { rpc } from "../../lib/rpc";
import { BotSettings } from "./bot-panel";

const longInstructions = "I".repeat(BOT_DESCRIPTION_MAX_LENGTH + 3_500);

function bot(description = "Billing"): Bot {
  return {
    id: "bot-1",
    spaceId: "space-1",
    name: "Ada",
    title: "Helper",
    description,
    instructions: longInstructions,
    color: "ink",
    notifyOnFinish: true,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread-1",
    preview: "",
    status: "idle",
    runErrorId: null,
    computerMode: "team",
    updatedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: null,
  };
}

let container: HTMLDivElement;
let root: Root;
const onSave = vi.fn(
  async (_patch: Parameters<ComponentProps<typeof BotSettings>["onSave"]>[0]): Promise<void> =>
    undefined,
);

async function render(description = "Billing", instructions = longInstructions) {
  await act(async () => {
    root.render(
      <BotSettings
        bot={{ ...bot(description), instructions }}
        memoryProviderConfigured={false}
        onSkillsChange={() => undefined}
        onSave={onSave}
        onExport={async () => undefined}
        onClear={() => undefined}
      />,
    );
  });
}

function descriptionField(): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[id$="-description"]');
  if (!textarea) throw new Error("Missing description field");
  return textarea;
}

function instructionsField(): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>('textarea[id$="-instructions"]');
  if (!textarea) throw new Error("Missing instructions field");
  return textarea;
}

function saveButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Save",
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("Missing Save button");
  return found;
}

async function setDescription(value: string) {
  await setText(descriptionField(), value);
}

async function setText(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickSave() {
  const before = onSave.mock.calls.length;
  await act(async () => {
    saveButton().click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  if (onSave.mock.calls.length === before) throw new Error("save did not run");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSave.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("BotSettings model choices", () => {
  it("submits DeepSeek API ids and does not offer a display label", async () => {
    vi.mocked(rpc.models.credentials).mockResolvedValueOnce([
      {
        id: "cred-deepseek",
        provider: "deepseek",
        label: "DeepSeek",
        hasKey: true,
        isDefault: true,
        modelId: "DeepSeek-V4.1-Flash",
      },
    ]);
    vi.mocked(rpc.models.list).mockResolvedValueOnce([
      {
        provider: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-flash",
        label: "DeepSeek V4.1 Flash",
        billing: "",
      },
      {
        provider: "deepseek",
        providerName: "DeepSeek",
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        billing: "",
      },
    ]);
    await render();
    await act(async () => {
      await Promise.resolve();
    });
    const model = container.querySelector("select");
    if (!(model instanceof HTMLSelectElement)) throw new Error("Missing model select");
    const values = [...model.options].map((option) => option.value);
    expect(values).toContain("deepseek::deepseek-flash");
    expect(values).toContain("deepseek::deepseek-v4-pro");
    expect(values).not.toContain("deepseek::DeepSeek-V4.1-Flash");
    expect(values.some((value) => value.includes("DeepSeek"))).toBe(false);
  });
});

describe("BotSettings description saves", () => {
  it("leaves instructions off a save that does not edit the description", async () => {
    await render();
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("instructions");
  });

  it("does not resend instructions when the bot prop stays on the old description", async () => {
    await render();
    await setDescription("Invoices");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      description: "Invoices",
    });
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("instructions");

    // The parent still passes the description from when the panel opened.
    await render();
    await clickSave();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("instructions");
  });

  it("still saves a description edited back to the stale prop value", async () => {
    await render();
    await setDescription("Invoices");
    await clickSave();
    await render();
    await setDescription("Billing");
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Billing",
    });
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("instructions");
  });

  it("keeps the previous description as the baseline when a save fails", async () => {
    onSave.mockRejectedValueOnce(new Error("offline"));
    await render();
    await setDescription("Invoices");
    await clickSave();
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      description: "Invoices",
    });
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("instructions");
  });
});

describe("BotSettings instructions", () => {
  it("loads the full instructions in a separately labelled Advanced field", async () => {
    await render();
    const field = instructionsField();
    expect(field.value).toBe(longInstructions);
    expect(field.maxLength).toBe(BOT_INSTRUCTIONS_MAX_LENGTH);
    expect(field.labels?.[0]?.firstChild?.textContent).toBe("Instructions");
    expect(field.closest("details")?.dataset.testid).toBe("bot-settings-advanced");
    expect(descriptionField().value).toBe("Billing");
    expect(descriptionField().maxLength).toBe(BOT_DESCRIPTION_MAX_LENGTH);
  });

  it("saves only the edited instructions without truncating to the description limit", async () => {
    await render();
    const next = `${longInstructions}\nAsk only about missing hiring constraints.`;
    await setText(instructionsField(), next);
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toHaveProperty("instructions", next);
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("description");

    await render();
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("instructions");
    expect(instructionsField().value).toBe(next);

    await setText(instructionsField(), longInstructions);
    await clickSave();
    expect(onSave.mock.calls[2]?.[0]).toHaveProperty("instructions", longInstructions);
  });

  it("can clear instructions without clearing the description", async () => {
    await render();
    await setText(instructionsField(), "");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toHaveProperty("instructions", "");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("description");
    expect(descriptionField().value).toBe("Billing");
  });

  it("refreshes clean profile fields after another client updates the same bot", async () => {
    await render();
    await render("Updated by another client", "New server instructions");
    expect(descriptionField().value).toBe("Updated by another client");
    expect(instructionsField().value).toBe("New server instructions");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("instructions");
  });

  it("preserves an unsaved instructions draft during a server refresh", async () => {
    await render();
    await setText(instructionsField(), "My unsaved instructions");
    await render("Updated description", "Instructions from another client");
    expect(descriptionField().value).toBe("Updated description");
    expect(instructionsField().value).toBe("My unsaved instructions");
    await clickSave();
    expect(onSave.mock.calls[0]?.[0]).toHaveProperty("instructions", "My unsaved instructions");
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty("description");
  });

  it("does not resend a server refresh received during an unrelated pending save", async () => {
    let finish!: () => void;
    onSave.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await clickSave();
    await render("Refreshed description", "Refreshed instructions");
    await act(async () => finish());
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("description");
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("instructions");
  });

  it.each(["description", "instructions"] as const)(
    "keeps a newer %s revert when the pending save refreshes the bot",
    async (fieldName) => {
      let finish!: () => void;
      onSave.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      await render();
      const field = fieldName === "description" ? descriptionField() : instructionsField();
      const original = field.value;
      await setText(field, "Pending edit");
      await clickSave();
      await setText(field, original);
      await render(
        fieldName === "description" ? "Pending edit" : "Billing",
        fieldName === "instructions" ? "Pending edit" : longInstructions,
      );
      expect(field.value).toBe(original);
      await act(async () => finish());
      await clickSave();
      expect(onSave.mock.calls[1]?.[0]).toHaveProperty(fieldName, original);
    },
  );

  it("retains the instructions draft and retries after a failed save", async () => {
    onSave.mockRejectedValueOnce(new Error("offline"));
    await render();
    await setText(instructionsField(), "Keep candidate claims tied to source evidence.");
    await clickSave();
    expect(container.textContent).toContain("offline");
    expect(instructionsField().value).toBe("Keep candidate claims tied to source evidence.");
    await clickSave();
    expect(onSave.mock.calls[1]?.[0]).toHaveProperty(
      "instructions",
      "Keep candidate claims tied to source evidence.",
    );
    expect(onSave.mock.calls[1]?.[0]).not.toHaveProperty("description");
  });
});
