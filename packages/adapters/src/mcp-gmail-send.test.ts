import { afterEach, describe, expect, it, vi } from "vitest";
import { gmailRawMessage, McpConnector } from "./mcp-connector.js";

const GMAIL = {
  id: "gmail-1",
  slug: "gmail",
  name: "Gmail",
  transport: "streamable_http",
  endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
  secretId: "secret-1",
  args: [],
  revision: 3,
};
const context = {
  spaceId: "w1",
  userId: "u1",
  botId: "outreach",
  signal: new AbortController().signal,
};
const route = {
  connectorId: "mcp",
  resourceId: GMAIL.id,
  resourceRevision: GMAIL.revision,
  toolName: "send_message",
};
const network = {
  fetch: (input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
};

function decode(raw: string) {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [head, body] = text.split("\r\n\r\n");
  return {
    head: head!,
    body: Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8"),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Gmail send from the recruiter's own mailbox", () => {
  it("writes a plain-text email to one person, with a non-ASCII subject intact", () => {
    const mail = decode(
      gmailRawMessage({
        to: "a@example.test",
        subject: "职位 · Hello",
        body: "Hi Ada,\n\nThanks.",
      }),
    );
    expect(mail.head).toContain("To: a@example.test");
    expect(mail.head).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("职位 · Hello").toString("base64")}?=`,
    );
    expect(mail.body).toBe("Hi Ada,\n\nThanks.");
    expect(mail.head).not.toContain("In-Reply-To");
  });

  it("offers send_message on a Gmail grant that allows it and sends it over Gmail's REST API", async () => {
    const requests: { url: string; body?: unknown; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        requests.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          auth: new Headers(init?.headers).get("authorization"),
        });
        if (url.includes("/threads/"))
          return Response.json({
            messages: [{ payload: { headers: [{ name: "Message-ID", value: "<m1@mail.test>" }] } }],
          });
        return Response.json({ id: "sent-1", threadId: "t1" });
      }),
    );
    const assignment = {
      botId: "outreach",
      serverId: GMAIL.id,
      spaceId: "w1",
      userId: "u1",
      allowAllTools: false,
      allowedTools: ["get_message", "send_message"],
      server: GMAIL,
    };
    const prisma = {
      mcpServer: { count: vi.fn(async () => 1) },
      botMcpServer: { findFirst: vi.fn(async () => assignment) },
    };
    const connector = new McpConnector(prisma as never, {} as never, { network }, {
      providerFor: vi.fn(async () => ({ tokens: async () => ({ access_token: "tok-1" }) })),
    } as never);
    const run = async (args: Record<string, unknown>) => {
      const events = [];
      for await (const event of connector.execute(
        { tool: "mcp__gmail__send_message", route, args, executionId: "send" },
        context as never,
      ))
        events.push(event);
      return events;
    };

    expect(
      await run({ to: ["a@example.test", "b@example.test"], subject: "Hi", body: "Hello" }),
    ).toEqual([{ type: "error", message: expect.stringMatching(/^Email not sent\. Invalid/) }]);
    expect(requests).toHaveLength(0);

    const [sent] = await run({
      to: ["a@example.test"],
      subject: "Re: Hi",
      body: "Following up.",
      replyThreadId: "18c2f0a1b2",
    });
    expect(sent).toEqual({
      type: "result",
      data: {
        structuredContent: {
          sent: true,
          to: "a@example.test",
          messageId: "sent-1",
          threadId: "t1",
        },
      },
    });
    const send = requests.find((request) => request.url.endsWith("/messages/send"))!;
    expect(send.auth).toBe("Bearer tok-1");
    expect(send.body).toMatchObject({ threadId: "18c2f0a1b2" });
    const mail = decode((send.body as { raw: string }).raw);
    expect(mail.head).toContain("In-Reply-To: <m1@mail.test>");
    expect(mail.body).toBe("Following up.");
    expect(JSON.stringify(sent)).not.toContain("tok-1");
  });
});
