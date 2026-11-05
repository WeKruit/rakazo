import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { deleteRecruitingRoles } from "./recruiting-role-delete.js";

const url = process.env.ROLE_DELETE_TEST_DATABASE_URL;
const suite = url ? describe.sequential : describe.skip;
suite("deleting a conversation that holds a role", () => {
  const db = createDb(url!);
  const prisma = db.prisma;
  afterAll(() => prisma.$disconnect());

  // A role whose saved search page points at a file in the role's conversation.
  async function seed() {
    const id = randomUUID().slice(0, 8);
    const k = (name: string) => `${name}-${id}`;
    const statements = [
      `insert into "user"(id,name,email,"updatedAt") values('${k("u")}','U','${k("u")}@example.test',now())`,
      `insert into organization(id,name,slug,"createdAt") values('${k("o")}','O','${k("o")}',now())`,
      `insert into spaces(id,"organizationId",name) values('${k("s")}','${k("o")}','S')`,
      `insert into bots(id,"spaceId","userId",name,color,"updatedAt") values('${k("b")}','${k("s")}','${k("u")}','Sourcer','x',now())`,
      `insert into chat_groups(id,"spaceId","userId",name,"updatedAt") values('${k("g")}','${k("s")}','${k("u")}','Role',now())`,
      `insert into threads(id,"spaceId","userId","groupId") values('${k("t")}','${k("s")}','${k("u")}','${k("g")}')`,
      `insert into tasks(id,"spaceId","botId","threadId","userId",prompt,status,"updatedAt") values('${k("k")}','${k("s")}','${k("b")}','${k("t")}','${k("u")}','p','done',now())`,
      `insert into runs(id,"spaceId","botId","threadId","taskId","userId",status,trigger,"updatedAt") values('${k("r")}','${k("s")}','${k("b")}','${k("t")}','${k("k")}','${k("u")}','completed','user',now())`,
      `insert into external_effects(id,"spaceId","runId",kind,"idempotencyKey",status,request,"updatedAt") values('${k("e")}','${k("s")}','${k("r")}','k','${k("i")}','committed','{}',now())`,
      `insert into artifacts(id,"spaceId","userId",name,"mimeType",size,hash,"storageKey","groupId") values('${k("a")}','${k("s")}','${k("u")}','page.json','application/json',1,'h','${k("key")}','${k("g")}')`,
      `with role as (insert into recruiting_roles(id,"spaceId","userId","sourceThreadId",title,revision,"currentRevisionId") values('${k("role")}','${k("s")}','${k("u")}','${k("t")}','Role',1,'${k("rev")}') returning id)
       insert into recruiting_role_revisions(id,"roleId",revision,"sourceRefs",criteria,preferences,"definitionQuestions") select '${k("rev")}',id,1,'[]','[]','[]','[]' from role`,
      `insert into recruiting_candidate_pages("effectId","roleId","roleRevisionId","artifactId","artifactHash","observedAt") values('${k("e")}','${k("role")}','${k("rev")}','${k("a")}','h',now())`,
    ];
    for (const statement of statements) await prisma.$executeRawUnsafe(statement);
    return { userId: k("u"), groupId: k("g") };
  }

  it("could not delete the conversation while the role's saved pages remained", async () => {
    const { groupId, userId } = await seed();
    await expect(prisma.chatGroup.delete({ where: { id: groupId } })).rejects.toMatchObject({
      code: "P2003",
    });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("deletes the conversation and the account once its roles are deleted first", async () => {
    const { groupId, userId } = await seed();
    await prisma.$transaction(async (tx) => {
      await deleteRecruitingRoles(tx, { sourceThread: { groupId } });
      await tx.chatGroup.delete({ where: { id: groupId } });
    });
    expect(await prisma.recruitingRole.count({ where: { userId } })).toBe(0);
    await prisma.user.delete({ where: { id: userId } });
    expect(await prisma.user.count({ where: { id: userId } })).toBe(0);
  });
});
