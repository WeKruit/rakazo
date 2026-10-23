import { describe, expect, it } from "vitest";
import { activityNotificationsEnabled, activityPromptSnippet } from "./runs.js";

describe("run activity copy", () => {
  it("keeps canonical CRM locator IDs out of ordinary activity", () => {
    expect(
      activityPromptSnippet({
        trigger: "follow_up",
        prompt: "internal CRM locator",
        sourceBlocks: [
          {
            kind: "text",
            text: "Read the existing contacts.",
            crmRoleReference: {
              sourceId: "crm",
              serverRevision: 1,
              organizationId: "10000000-0000-4000-8000-000000000001",
              crmRoleId: "20000000-0000-4000-8000-000000000002",
            },
          },
        ],
      }),
    ).toBe("Read the existing contacts.");
  });
  it.each(["user", "follow_up"])(
    "shows original %s words instead of selected email metadata",
    (trigger) => {
      const sourceBlocks = [
        {
          kind: "text",
          text: "Read this reply; don't send.",
          correspondenceReference: {
            threadId: "thread",
            roleId: "role",
            emailId: "display-id",
            sourceId: "source-id",
            providerMessageId: "provider-id",
            savedRead: null,
            sourceName: "Mailbox",
            sender: null,
            subject: "Selected reply",
            date: null,
            snippet: true,
          },
        },
      ];
      expect(
        activityPromptSnippet({
          trigger,
          prompt: "internal selected email reference",
          sourceBlocks,
        }),
      ).toBe(sourceBlocks[0]!.text);
    },
  );
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toBe("Maya asked: Please check the release workflow.");
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toBe("Message from another agent");
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});
