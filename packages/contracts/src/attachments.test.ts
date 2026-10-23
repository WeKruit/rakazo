import { describe, expect, it } from "vitest";
import { appContract, MessageBlock, validateThreadsSendInput } from "./index.js";

describe("attachment contracts", () => {
  it("retains a bounded selected email reference without making it a message or approval", () => {
    const reference = {
      threadId: "thread-1",
      roleId: "role-1",
      emailId: "email-1",
      sourceId: "mailbox-1",
      providerMessageId: "provider-message-1",
      savedRead: null,
      sourceName: "Mailbox",
      sender: null,
      subject: "A reply",
      date: null,
      snippet: true,
    };
    expect(
      MessageBlock.parse({
        kind: "text",
        text: "Original words",
        correspondenceReference: reference,
      }),
    ).toEqual({ kind: "text", text: "Original words", correspondenceReference: reference });
    expect(
      appContract.threads.send["~orpc"].inputSchema!.safeParse({
        groupId: "group",
        text: "Read this",
        correspondenceReference: { ...reference, subject: "x".repeat(4097) },
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "text",
        text: "Original",
        correspondenceReference: {
          ...reference,
          emailId: "x".repeat(1600),
          providerMessageId: "y".repeat(1600),
          subject: "z".repeat(1000),
        },
      }).success,
    ).toBe(false);
    expect(
      appContract.threads.send["~orpc"].inputSchema!.safeParse({
        groupId: "group",
        correspondenceReference: reference,
      }).success,
    ).toBe(false);
  });
  it("parses image and file message blocks", () => {
    expect(
      MessageBlock.parse({
        kind: "image",
        artifactId: "art_1",
        mimeType: "image/png",
        name: "shot.png",
      }),
    ).toMatchObject({ kind: "image", name: "shot.png" });
    expect(
      MessageBlock.parse({
        kind: "file",
        artifactId: "art_2",
        mimeType: "application/pdf",
        name: "brief.pdf",
        size: 1234,
      }),
    ).toMatchObject({ kind: "file", size: 1234 });
  });

  it("requires text or attachments for threads.send", () => {
    expect(validateThreadsSendInput({ text: "hello" })).toBe(true);
    expect(validateThreadsSendInput({ artifactIds: ["art_1"] })).toBe(true);
    expect(validateThreadsSendInput({})).toBe(false);
    expect(validateThreadsSendInput({ artifactIds: ["a", "b", "c", "d", "e"] })).toBe(true);
  });
});
