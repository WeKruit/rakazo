import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

function success(result, route) {
  assert.equal(
    result.status,
    200,
    `${route} must succeed for the fixture owner (status ${result.status})`,
  );
  return result.data;
}

/** Native bootstrap and duplicate, never an assembled crew or a customer mutation target. */
export async function withIsolationTestCopies(clients, run) {
  const copies = [];
  try {
    for (const owner of clients) {
      success(await owner.rpc("bootstrap", {}), "bootstrap");
      const home = success(
        await owner.rpc("onboarding/ensureRecruiting", {}),
        "onboarding/ensureRecruiting",
      );
      const group = success(await owner.rpc("groups/get", { groupId: home.groupId }), "groups/get");
      const names = new Set(group.members.map((member) => member.name.toLowerCase()));
      for (const name of ["main", "sourcer", "outreach", "reviewer"])
        assert.ok(
          names.has(name),
          "the native recruiting crew must include all four required roles",
        );
      const copy = success(
        await owner.rpc("groups/duplicate", { groupId: home.groupId }),
        "groups/duplicate",
      );
      assert.notEqual(
        copy.id,
        home.groupId,
        "native duplication must create a separate conversation",
      );
      assert.notEqual(
        copy.threadId,
        group.threadId,
        "native duplication must create a separate thread",
      );
      assert.equal(copy.spaceId, group.spaceId, "the copy must belong to the owner's workspace");
      copies.push({ owner, groupId: copy.id, threadId: copy.threadId });
      const fixture = copies.at(-1);
      fixture.name = `测试副本 · Isolation ${randomUUID().slice(0, 8)}`;
      success(
        await owner.rpc("groups/update", { groupId: copy.id, name: fixture.name }),
        "groups/update",
      );
      const duplicated = success(await owner.rpc("groups/get", { groupId: copy.id }), "groups/get");
      const copiedNames = new Set(duplicated.members.map((member) => member.name.toLowerCase()));
      for (const name of ["main", "sourcer", "outreach", "reviewer"])
        assert.ok(
          copiedNames.has(name),
          "the duplicated conversation must keep the full native crew",
        );
      const content = "Isolation test material.";
      const artifact = success(
        await owner.rpc("artifacts/create", {
          groupId: copy.id,
          name: "isolation-check.txt",
          mimeType: "text/plain",
          contentBase64: Buffer.from(content).toString("base64"),
        }),
        "artifacts/create",
      );
      fixture.artifactId = artifact.id;
      const workspace = success(
        await owner.rpc("recruiting/createRole", {
          sourceThreadId: copy.threadId,
          expectedRevision: 0,
          title: fixture.name,
          criteria: [],
          preferences: [],
          definitionQuestions: [],
          sourceRefs: [
            {
              id: "isolation-material",
              kind: "original_material",
              anchor: {
                kind: "artifact",
                artifact: {
                  artifactId: artifact.id,
                  sha256: createHash("sha256").update(content).digest("hex"),
                },
                locator: "text",
              },
              readState: "read",
              readAt: new Date().toISOString(),
              quote: content,
            },
          ],
        }),
        "recruiting/createRole",
      );
      fixture.roleId = workspace.role.id;
      fixture.roleRevision = workspace.role.revision;
    }
    return await run(copies);
  } finally {
    const archived = await Promise.allSettled(
      copies.map(async (copy) => {
        try {
          if (copy.roleId)
            success(
              await copy.owner.rpc("recruiting/archiveRole", {
                roleId: copy.roleId,
                expectedRevision: copy.roleRevision,
                archived: true,
              }),
              "recruiting/archiveRole",
            );
        } finally {
          success(
            await copy.owner.rpc("groups/archive", { groupId: copy.groupId }),
            "groups/archive",
          );
        }
      }),
    );
    assert.ok(
      archived.every((result) => result.status === "fulfilled"),
      "every isolation test copy must archive, including after a failed check",
    );
  }
}

/** Destructive probes are restricted to the copies made above; never pass collected customer ids. */
export async function checkCopyMutations(viewer, copy, record) {
  assert.ok(copy.name?.startsWith("测试副本 · "), "mutation probes require a designated test copy");
  const target = { groupId: copy.groupId };
  const operations = [
    ["groups/update", { ...target, name: "测试副本 · Unauthorized rename" }],
    ["threads/stop", { ...target, scope: "all" }],
    ["threads/cancelTask", { ...target, id: copy.groupId, kind: "research" }],
    ["threads/cancelTask", { ...target, id: copy.groupId, kind: "cloud_agent" }],
    ["threads/cancelTask", { ...target, id: copy.groupId, kind: "run" }],
    [
      "artifacts/create",
      {
        ...target,
        name: "foreign-check.txt",
        mimeType: "text/plain",
        contentBase64: Buffer.from("Isolation test").toString("base64"),
      },
    ],
    [
      "recruiting/archiveRole",
      { roleId: copy.roleId, expectedRevision: copy.roleRevision, archived: true },
    ],
  ];
  for (const [route, input] of operations) {
    const result = await viewer.rpc(route, input);
    // A server failure or input-validation error proves no ownership enforcement.
    const denied = result.status === 403 || result.status === 404;
    record({
      name: `${viewer.label} cannot change another account's test copy via ${route}`,
      verdict: denied ? "ok" : "leak",
      status: result.status,
      detail: denied ? "ownership refusal" : "ownership was not enforced",
    });
  }
  const unchanged = success(await copy.owner.rpc("groups/get", target), "groups/get");
  assert.equal(unchanged.name, copy.name, "the owner's test conversation must remain unchanged");
  assert.equal(
    unchanged.archivedAt,
    null,
    "the owner's test conversation must remain active until cleanup",
  );
}
