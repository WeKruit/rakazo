import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { readRecruitingImportedCorrespondence } from "./recruiting-history-import.js";
import { IsolationError } from "./scope.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
const scope = { threadId: "thread", roleId: "role" };
const at = "2026-01-02T10:00:00.000Z";
const email = {
  id: "original-mail",
  sourceName: "Email history",
  sourceId: "history",
  providerMessageId: "original-mail",
  providerThreadId: "original-thread",
  savedRead: null,
  sender: "candidate@example.test",
  recipients: ["recruiter@example.test"],
  subject: "Interview availability",
  body: "I can talk on Tuesday.",
  snippet: false,
  date: at,
  url: null,
};

function fixture() {
  const result = {
    version: 1,
    roleId: scope.roleId,
    sourceSha256: "a".repeat(64),
    importedAt: at,
    emails: [email],
    events: [],
    contacts: [],
    history: [],
  };
  const thread = { id: scope.threadId };
  const findThread = vi.fn(async ({ where }: { where: { userId: string; spaceId: string } }) =>
    where.userId === actor.userId && where.spaceId === actor.spaceId ? thread : null,
  );
  const effects = vi.fn(async () => [{ id: "import-effect", result }]);
  const prisma = {
    thread: { findFirst: findThread },
    externalEffect: { findMany: effects },
  } as unknown as PrismaClient;
  return { prisma, result, effects, findThread };
}

describe("imported recruiting correspondence", () => {
  it("reads actual owner-scoped imports without pretending to have live mail authority", async () => {
    const f = fixture();
    const saved = await readRecruitingImportedCorrespondence(f.prisma, actor, scope);
    expect(saved?.emails).toEqual([{ ...email, imported: true }]);
    expect(saved?.events).toEqual([]);
    expect(saved?.checkedAt).toBe(at);
    expect(f.effects).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: actor.spaceId,
          kind: "recruiting_history_import",
          status: "completed",
          run: expect.objectContaining({
            userId: actor.userId,
            spaceId: actor.spaceId,
            trigger: "tool_background",
            status: "completed",
            initialRecruitingRoleRevision: { roleId: scope.roleId },
          }),
        }),
      }),
    );
  });

  it("retains supplied contact details even without a LinkedIn profile", async () => {
    const f = fixture();
    const contact = {
      candidateKey: "source:person",
      linkedinUrl: null,
      emails: [{ address: "person@example.test", status: null }],
      phones: [{ number: "+12025550123", type: null }],
      source: "Contact history",
      checkedAt: at,
    };
    f.result.contacts.push(contact as never);
    const saved = await readRecruitingImportedCorrespondence(f.prisma, actor, scope);
    expect(saved?.contacts).toEqual([{ ...contact, imported: true }]);
  });

  it("does not expose another account's historical records", async () => {
    const f = fixture();
    await expect(
      readRecruitingImportedCorrespondence(f.prisma, { ...actor, userId: "other" }, scope),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(f.effects).not.toHaveBeenCalled();
  });

  it("rejects an import payload naming a different role", async () => {
    const f = fixture();
    f.result.roleId = "other-role";
    await expect(readRecruitingImportedCorrespondence(f.prisma, actor, scope)).rejects.toThrow();
  });

  it("rejects a malformed source receipt rather than showing incomplete history", async () => {
    const f = fixture();
    f.result.sourceSha256 = "unverified";
    await expect(readRecruitingImportedCorrespondence(f.prisma, actor, scope)).rejects.toThrow();
  });

  it("rechecks the role and account after reading the import", async () => {
    const f = fixture();
    f.findThread.mockResolvedValueOnce({ id: scope.threadId }).mockResolvedValueOnce(null);
    await expect(
      readRecruitingImportedCorrespondence(f.prisma, actor, scope),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});
