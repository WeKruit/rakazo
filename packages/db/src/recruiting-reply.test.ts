import * as contracts from "@rakazo/contracts";
import { describe, expect, it } from "vitest";

const target = {
  roleId: "role",
  expectedRoleRevision: 1,
  crmImportEffectId: "crm-import",
  mcpServerId: "mail-server",
  serverRevision: 2,
  replyToEmailId: "inbound-email",
};

describe("recruiting reply contracts", () => {
  it("separates native references from provider-neutral content", () => {
    expect(contracts.RecruitingReplyTargetSchema).toBeDefined();
    expect(contracts.RecruitingReplyTargetSchema.parse(target)).toEqual(target);
    expect(
      contracts.RecruitingReplyInputSchema.parse({
        ...target,
        subject: "An exact subject",
        body: { text: "Exact text \n", html: "<p>Exact HTML</p>" },
        cc: "Second <second@example.test>",
        bcc: "audit@example.test",
      }),
    ).toEqual({
      ...target,
      subject: "An exact subject",
      body: { text: "Exact text \n", html: "<p>Exact HTML</p>" },
      cc: "Second <second@example.test>",
      bcc: "audit@example.test",
    });
  });
  it.each([
    { roleId: " " },
    { expectedRoleRevision: 0 },
    { crmImportEffectId: "" },
    { mcpServerId: " " },
    { serverRevision: 1.5 },
    { replyToEmailId: " " },
    { eaccount: "model@example.test" },
    { to: "model@example.test" },
  ])("rejects invalid reference or model-supplied identity %j", (change) => {
    expect(contracts.RecruitingReplyTargetSchema.safeParse({ ...target, ...change }).success).toBe(
      false,
    );
  });
  it.each([
    { body: {} },
    { body: { text: " ", html: "\t" } },
    { body: { text: "ok", files: [] } },
    { subject: "Subject\r\nInjected: yes" },
    { cc: "second@example.test\nInjected: yes" },
    { bcc: "audit@example.test\0" },
    { account: "model@example.test" },
  ])("rejects incomplete content or header injection %j", (change) => {
    expect(
      contracts.RecruitingReplyInputSchema.safeParse({
        ...target,
        subject: "Exact subject",
        body: { html: "<p>HTML only</p>" },
        ...change,
      }).success,
    ).toBe(false);
  });
});
