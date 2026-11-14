import { describe, expect, it } from "vitest";
import { referredRole } from "./role-reference.js";

const roles = [
  { id: "r153", title: "Warehouse Manager (Ref 0153)" },
  { id: "r303", title: "Senior Data Engineer Seattle (ref 0303)" },
  { id: "acme", title: "Staff Backend Engineer, Northwind Pay" },
];

describe("referredRole", () => {
  // Sim 11-14 send-at-night: 「Ada现在就发」 for ref 0303 went to the role for 0153.
  it("follows the ref of the newest message that names one", () => {
    const texts = [
      "Ada现在就发，别等到明晚",
      "新岗位 Senior Data Engineer Seattle ref 0303，两个都发",
    ];
    expect(referredRole(texts, roles)).toMatchObject({ kind: "saved", role: { id: "r303" } });
  });

  // Sim 11-14: 「新岗位 … ref 0232」 went to the only saved role.
  it("names a new role by a ref no saved role has", () => {
    const text = "新岗位 Senior Data Engineer，Seattle，ref 0232，写首封邮件，两个都发";
    expect(referredRole([text], roles)).toEqual({ kind: "new", ref: "0232" });
    expect(referredRole(["ref 0232 怎么样了"], roles)).toBeUndefined();
  });

  it("matches a title by its distinctive words, not generic ones", () => {
    expect(referredRole(["How is the Northwind Pay search going?"], roles)).toMatchObject({
      role: { id: "acme" },
    });
    expect(referredRole(["any senior engineer updates?"], roles)).toBeUndefined();
    expect(referredRole(["Ada现在就发"], roles)).toBeUndefined();
  });
});
