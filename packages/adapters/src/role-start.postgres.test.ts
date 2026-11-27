import { randomUUID } from "node:crypto";
import { createDb, createThreadMessageInTransaction } from "@rakazo/db";
import { expect, it } from "vitest";
import { openRoleGroup } from "./role-start.js";

it.skipIf(process.env.VERIFY_DATABASE !== "1" || !process.env.DATABASE_URL)(
  "opens one role per title when one message asks for several in parallel (staging 11-16)",
  async () => {
    const db = createDb(process.env.DATABASE_URL!);
    const p = db.prisma;
    const id = `role-start-${randomUUID()}`;
    try {
      await p.user.create({ data: { id, name: "Synthetic owner", email: `${id}@test.invalid` } });
      await p.organization.create({ data: { id, name: id, slug: id, createdAt: new Date() } });
      await p.space.create({ data: { id, name: id, organizationId: id } });
      await p.member.create({
        data: { id, organizationId: id, userId: id, role: "member", createdAt: new Date() },
      });
      await p.spaceMember.create({
        data: { id, organizationId: id, spaceId: id, userId: id, createdAt: new Date() },
      });
      for (const bot of ["main", "reviewer"])
        await p.bot.create({
          data: { id: `${id}-${bot}`, spaceId: id, userId: id, name: bot, color: "purple" },
        });
      await p.thread.create({ data: { id, spaceId: id, userId: id, botId: `${id}-main` } });
      await p.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId: id,
          role: "user",
          blocks: [{ kind: "text", text: "Create these three: Java, Android, data engineer" }],
        }),
      );
      const open = (title: string) =>
        openRoleGroup(p, {
          spaceId: id,
          userId: id,
          threadId: id,
          title,
          fallback: `effect-${title}`,
          botIds: [`${id}-main`, `${id}-reviewer`],
          overruled: new Set(),
        });
      const opened = await Promise.all(["Java", "Android", "Data Engineer"].map(open));
      expect(new Set(opened.map((role) => role.group?.id)).size).toBe(3);
      expect(opened.map((role) => role.group?.name).sort()).toEqual([
        "Android",
        "Data Engineer",
        "Java",
      ]);
      // Asking again for one of them finds the same role.
      expect((await open("Java")).group?.id).toBe(opened[0]?.group?.id);
      // Staging 11-26: a second message arrived while the role was opening, and a call that
      // came after it opened the same title again with only the new words.
      await p.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId: id,
          role: "user",
          blocks: [{ kind: "text", text: "Remote is fine too" }],
        }),
      );
      const again = await open("Java");
      expect(again.group).toBeUndefined();
      expect(again.openHere?.groupId).toBe(opened[0]?.group?.id);
    } finally {
      await p.chatGroup.deleteMany({ where: { spaceId: id } }).catch(() => undefined);
      await p.thread.deleteMany({ where: { spaceId: id } }).catch(() => undefined);
      await p.bot.deleteMany({ where: { spaceId: id } }).catch(() => undefined);
      await p.spaceMember.deleteMany({ where: { spaceId: id } }).catch(() => undefined);
      await p.space.deleteMany({ where: { id } }).catch(() => undefined);
      await p.member.deleteMany({ where: { id } }).catch(() => undefined);
      await p.organization.deleteMany({ where: { id } }).catch(() => undefined);
      await p.user.deleteMany({ where: { id } }).catch(() => undefined);
      await p.$disconnect();
      await db.pool.end();
    }
  },
);
