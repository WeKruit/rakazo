// @vitest-environment jsdom
import type { ThreadMessage } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationDocument, loadConversationMessages } from "./conversation-export";
import { rpc, selectedSpaceId } from "./rpc";

vi.mock("./rpc", () => ({
  rpc: { threads: { messages: vi.fn() } },
  selectedSpaceId: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(selectedSpaceId).mockReturnValue("space");
});

function message(
  seq: number,
  blocks: ThreadMessage["blocks"],
  role: ThreadMessage["role"] = "bot",
): ThreadMessage {
  return {
    id: `m${seq}`,
    threadId: "private-thread",
    seq,
    role,
    botId: "private-bot",
    blocks,
    createdAt: "2026-10-18T12:00:00Z",
  };
}

describe("conversation export", () => {
  it("reads all native pages in the captured conversation, removes overlap and orders history", async () => {
    vi.mocked(rpc.threads.messages)
      .mockResolvedValueOnce({
        threadId: "t",
        messages: [message(3, []), message(4, [])],
        olderCursor: 3,
      })
      .mockResolvedValueOnce({
        threadId: "t",
        messages: [message(1, []), message(2, []), message(3, [])],
        olderCursor: null,
      });
    expect((await loadConversationMessages({ groupId: "g" })).map((m) => m.seq)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(rpc.threads.messages).toHaveBeenLastCalledWith({ groupId: "g", before: 3 });
  });

  it("rejects a stalled cursor, scope change and failed page instead of exporting incomplete history", async () => {
    vi.mocked(rpc.threads.messages).mockResolvedValue({
      threadId: "t",
      messages: [],
      olderCursor: 3,
    });
    await expect(loadConversationMessages({ botId: "b" })).rejects.toThrow();
    vi.mocked(rpc.threads.messages)
      .mockResolvedValueOnce({ threadId: "t", messages: [], olderCursor: 3 })
      .mockResolvedValueOnce({ threadId: "other", messages: [], olderCursor: null });
    await expect(loadConversationMessages({ botId: "b" })).rejects.toThrow();
    vi.mocked(rpc.threads.messages).mockRejectedValueOnce(new Error("unavailable"));
    await expect(loadConversationMessages({ botId: "b" })).rejects.toThrow("unavailable");
  });

  it("does not mix workspaces when the selection changes during a request", async () => {
    vi.mocked(selectedSpaceId)
      .mockReturnValueOnce("space")
      .mockReturnValueOnce("space")
      .mockReturnValue("other");
    vi.mocked(rpc.threads.messages).mockResolvedValueOnce({
      threadId: "t",
      messages: [],
      olderCursor: null,
    });
    await expect(loadConversationMessages({ groupId: "g" })).rejects.toThrow(
      "conversation changed",
    );
  });

  it("keeps every table row and native answers without tool data, secrets, scripts or live controls", () => {
    const rows = Array.from(
      { length: 35 },
      (_, i) => `| Person ${i + 1} | https://example.com/${i + 1} |`,
    ).join("\n");
    const html = conversationDocument({
      title: '<img src=x onerror="alert(1)"> Hiring',
      userName: "Recruiter",
      agentName: () => "Sourcer",
      locale: "en",
      messages: [
        message(1, [
          {
            kind: "text",
            text: `| Name | Source |\n|---|---|\n${rows}\n\n<script>alert(1)</script>\n[Bad](javascript:alert(1))`,
          },
        ]),
        message(2, [
          {
            kind: "ask",
            text: "Which direction?",
            actions: [{ id: "private-option", label: "Data platforms" }],
            answer: "More distributed systems",
            status: "answered",
          },
        ]),
        message(3, [
          {
            kind: "ask",
            text: "Enter key",
            input: "secret",
            answer: "never-export-this",
            credential: undefined,
          },
        ]),
        message(4, [{ kind: "text", text: "internal system content" }], "system"),
        message(5, [
          {
            kind: "file",
            artifactId: "private-artifact",
            name: "Role.pdf",
            mimeType: "application/pdf",
            size: 1,
          },
        ]),
      ],
    });
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelectorAll("tbody tr")).toHaveLength(35);
    expect(doc.body.textContent).toContain("Person 35");
    expect(doc.body.textContent).toContain("Data platforms");
    expect(doc.body.textContent).toContain("More distributed systems");
    expect(doc.body.textContent).toContain("Role.pdf");
    expect(doc.querySelector('a[href="https://example.com/35"]')).not.toBeNull();
    expect(doc.querySelector("script,button,input,form,iframe,img")).toBeNull();
    expect(doc.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(html).not.toMatch(
      /private-thread|private-bot|private-option|private-artifact|never-export-this|internal system content/,
    );
    expect(
      doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
    ).toContain("default-src 'none'");
  });

  it("shows the original choice label instead of its persisted internal answer ID", () => {
    const html = conversationDocument({
      title: "Hiring",
      userName: "Recruiter",
      agentName: () => "Main",
      locale: "en",
      messages: [
        message(1, [
          {
            kind: "ask",
            text: "Which direction?",
            actions: [{ id: "internal-answer-42", label: "Data infrastructure" }],
            answer: "internal-answer-42",
            status: "answered",
          },
        ]),
      ],
    });
    expect(html).not.toContain("internal-answer-42");
    expect(
      new DOMParser()
        .parseFromString(html, "text/html")
        .body.textContent?.match(/Data infrastructure/g),
    ).toHaveLength(2);
  });
});
