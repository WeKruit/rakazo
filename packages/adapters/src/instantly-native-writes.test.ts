import { describe, expect, it, vi } from "vitest";
import {
  describeCampaignActivation,
  describeReplyToEmail,
  isNativeInstantlyWrite,
  nativeInstantlyWrites,
  runInstantlyWrite,
} from "./instantly-native-writes.js";

const ORIGINAL = {
  id: "7a0a8e6e-4c2a-4d5f-9d4e-2d1f3c4b5a69",
  subject: "Re: Founding Engineer",
  from_address_email: "ada@example.test",
  to_address_email_list: "team@example.test",
  eaccount: "team@example.test",
  timestamp_email: "2026-10-22T00:59:00Z",
  thread_id: "thread-1",
};
const context = { spaceId: "s", userId: "u", botId: "b" } as never;

describe("native reply_to_email", () => {
  it("is a registered sending write", () => {
    const tool = nativeInstantlyWrites.find((entry) => entry.name === "reply_to_email");
    expect(tool?.toolName).toBe("native_instantly_reply_to_email");
    expect(tool?.readOnly).toBe(false);
    expect(tool?.description).toContain("confirmation card");
    expect(isNativeInstantlyWrite("native_instantly_reply_to_email")).toBe(true);
    expect(isNativeInstantlyWrite("native_instantly_get_email")).toBe(true);
  });

  it("reads the original, checks the mailbox and posts the documented reply body", async () => {
    const rest = vi.fn(async (method: string, path: string) => {
      if (method === "GET" && path === `/emails/${ORIGINAL.id}`) return ORIGINAL;
      if (method === "GET" && path === "/accounts/team%40example.test")
        return { email: "team@example.test" };
      if (method === "POST" && path === "/emails/reply") return { id: "sent-1" };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const result = await runInstantlyWrite(
      {} as never,
      rest as never,
      context,
      "server",
      "native_instantly_reply_to_email",
      { reply_to_uuid: ORIGINAL.id, body: { text: "收到，谢谢" } },
    );
    expect(result).toEqual({ id: "sent-1" });
    expect(rest).toHaveBeenLastCalledWith("POST", "/emails/reply", {
      reply_to_uuid: ORIGINAL.id,
      eaccount: "team@example.test",
      subject: "Re: Founding Engineer",
      body: { text: "收到，谢谢" },
    });
  });

  it("refuses a mailbox that does not hold the original email", async () => {
    const rest = vi.fn(async (method: string, path: string) => {
      if (path === `/emails/${ORIGINAL.id}`) return ORIGINAL;
      if (path.startsWith("/accounts/")) return { email: "other@example.test" };
      throw new Error(`unexpected ${method} ${path}`);
    });
    await expect(
      runInstantlyWrite(
        {} as never,
        rest as never,
        context,
        "server",
        "native_instantly_reply_to_email",
        {
          reply_to_uuid: ORIGINAL.id,
          eaccount: "other@example.test",
          body: { text: "hi" },
        },
      ),
    ).rejects.toThrow("is not in the other@example.test mailbox");
    expect(rest).not.toHaveBeenCalledWith("POST", "/emails/reply", expect.anything());
  });

  it("describes the reply card without naming the vendor", async () => {
    const display = await describeReplyToEmail(async () => ORIGINAL, {
      reply_to_uuid: ORIGINAL.id,
      body: { text: "收到，谢谢" },
    });
    expect(display).toEqual({
      to: "ada@example.test",
      from: "team@example.test",
      subject: "Re: Founding Engineer",
      inReplyTo: "Re: Founding Engineer, 2026-10-22T00:59:00Z",
      body: "收到，谢谢",
    });
    expect(JSON.stringify(display)).not.toContain("Instantly");
  });
});

describe("activation card for one person's own first email", () => {
  const campaign = {
    id: "c-1",
    name: "Founding Engineer",
    status: 0,
    email_list: ["me@x.test"],
    sequences: [
      { steps: [{ variants: [{ subject: "{{rk_subject}}", body: "<p>{{rk_body}}</p>" }] }] },
    ],
  };
  const role = { subject: "Founding role", body: "Hi {{firstName}},\n\nOpen to a chat?" };
  const leads = [
    {
      id: "l1",
      email: "ada@x.test",
      first_name: "Ada",
      payload: { rk_subject: "Ada, your compiler work", rk_body: "Hi Ada,<br /><br />Just you." },
    },
    {
      id: "l2",
      email: "bob@x.test",
      first_name: "Bob",
      payload: { rk_subject: "Founding role", rk_body: "Hi Bob,<br /><br />Open to a chat?" },
    },
  ];
  const read = async (tool: string) =>
    tool === "native_instantly_get_campaign" ? campaign : { items: leads };
  const binding = { leads: {}, roleEmail: role, drafts: {} };

  it("shows that person's own email, which is what their variables hold", async () => {
    const display = await describeCampaignActivation(read, "c-1", null, binding, ["Ada"]);
    expect(display.recipients).toEqual([
      {
        name: "Ada",
        email: "ada@x.test",
        firstEmail: { subject: "Ada, your compiler work", body: "Hi Ada,<br /><br />Just you." },
      },
    ]);
    // Nobody on this card gets the role's email, so it is not shown.
    expect(display).not.toHaveProperty("firstEmail");
    expect(display.refusal).toBeUndefined();
  });

  it("shows the role's email for the people who keep it", async () => {
    const display = await describeCampaignActivation(read, "c-1", null, binding);
    expect(display.recipients.map((r) => r.firstEmail?.subject ?? null)).toEqual([
      "Ada, your compiler work",
      null,
    ]);
    expect(display.firstEmail).toEqual({
      subject: "Founding role",
      body: "<p>Hi {{firstName}},</p><p>Open to a chat?</p>",
    });
  });

  it("shows a waiting person the email the send will add for them", async () => {
    const display = await describeCampaignActivation(
      async (tool) =>
        tool === "native_instantly_get_campaign" ? { ...campaign, status: 1 } : { items: leads },
      "c-1",
      null,
      {
        ...binding,
        staged: { zoe: { email: "zoe@x.test", first_name: "Zoe" } },
        drafts: { "zoe@x.test": { subject: "Zoe, hello", body: "Hi Zoe" } },
      },
      ["zoe@x.test"],
    );
    expect(display.recipients).toEqual([
      {
        name: "Zoe",
        email: "zoe@x.test",
        firstEmail: { subject: "Zoe, hello", body: "Hi Zoe" },
      },
    ]);
  });

  it("refuses a card for someone whose variables hold no email", async () => {
    const display = await describeCampaignActivation(
      async (tool) =>
        tool === "native_instantly_get_campaign"
          ? campaign
          : { items: [...leads, { id: "l3", email: "cy@x.test", first_name: "Cy" }] },
      "c-1",
      null,
      binding,
      ["cy@x.test"],
    );
    expect(display.refusal).toMatch(/No first email is saved for Cy/);
    expect(display.recipients).toEqual([]);
  });
});

describe("native campaign analytics", () => {
  it("reads exact campaign totals through the existing read-only connection boundary", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const rest = vi.fn(async () => ({
      emails_sent_count: 3,
      open_count_unique: 2,
      reply_count_unique: 1,
    }));
    const tool = nativeInstantlyWrites.find(
      (tool) => tool.toolName === "native_instantly_get_campaign_analytics",
    );
    expect(tool?.readOnly).toBe(true);
    const result = await runInstantlyWrite(
      {} as never,
      rest,
      context,
      "server",
      "native_instantly_get_campaign_analytics",
      { campaign_id: id },
    );
    expect(rest).toHaveBeenCalledWith("GET", `/campaigns/analytics/overview?id=${id}`);
    expect(result).toEqual({ emails_sent_count: 3, open_count_unique: 2, reply_count_unique: 1 });
  });
});
