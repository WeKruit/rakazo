import { describe, expect, it, vi } from "vitest";
import {
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
