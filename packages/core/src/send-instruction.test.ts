import { describe, expect, it } from "vitest";
import { sendRecipients } from "./send-instruction.js";

describe("send recipients", () => {
  it("reads every recipient field", () => {
    expect(
      sendRecipients({
        to: "A <a@example.test>",
        cc: "b@example.test; c@example.test",
        bcc_address_email_list: "d@example.test",
        extra_recipients: ["e@example.test"],
        subject: "Re: f@example.test",
        eaccount: "recruiter@example.test",
      }).sort(),
    ).toEqual([
      "a@example.test",
      "b@example.test",
      "c@example.test",
      "d@example.test",
      "e@example.test",
      "f@example.test",
    ]);
  });
});
