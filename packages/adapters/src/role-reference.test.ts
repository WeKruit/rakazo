import { describe, expect, it } from "vitest";
import { referredRole, titleWithRef } from "./role-reference.js";

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

  // Sim 11-15 send-at-night: 「…Senior Data Engineer 02311…」 gave the number without "ref", so a
  // follow-up 「为啥还没发」 was answered for another Seattle data engineer role (Ref 21351).
  it("finds a role by its ref number written without the word ref", () => {
    const texts = [
      "为啥还没发 现在就发",
      "新岗位 西雅图 Senior Data Engineer 0303 客户在西雅图 hybrid 一周三天",
    ];
    expect(referredRole(texts, roles)).toMatchObject({ kind: "saved", role: { id: "r303" } });
  });

  // Sim 11-14: 「新岗位 … ref 0232」 went to the only saved role.
  it("names a new role by a ref no saved role has", () => {
    const text = "新岗位 Senior Data Engineer，Seattle，ref 0232，写首封邮件，两个都发";
    expect(referredRole([text], roles)).toEqual({ kind: "new", ref: "0232" });
    expect(referredRole(["ref 0232 怎么样了"], roles)).toBeUndefined();
    // Sim 11-14 2bb9124c: 「编号0733」 went into the saved Seattle role (ref 0303 here).
    const numbered = "新岗位，西雅图Senior Data Engineer，编号0733。两个都发";
    expect(referredRole([numbered], roles)).toEqual({ kind: "new", ref: "0733" });
    expect(referredRole(["编号 0303 发了几封"], roles)).toMatchObject({ role: { id: "r303" } });
    // Sim 11-16 d06ea499: 「新岗位 … 西雅图 07151」 gave the new ref as a bare number and went to
    // the saved "Senior Data Engineer — Seattle", whose campaign had already sent for another ref.
    const bare = "新岗位 Senior Data Engineer Seattle 07151，hybrid每周3天，6年+，base 180-220k";
    expect(referredRole([bare], roles)).toEqual({ kind: "new", ref: "07151" });
    expect(
      referredRole(["新岗位 Senior Data Engineer Seattle，2026年开始"], roles),
    ).toBeUndefined();
  });

  it("matches a title by its distinctive words, not generic ones", () => {
    expect(referredRole(["How is the Northwind Pay search going?"], roles)).toMatchObject({
      role: { id: "acme" },
    });
    expect(referredRole(["any senior engineer updates?"], roles)).toBeUndefined();
    expect(referredRole(["Ada现在就发"], roles)).toBeUndefined();
  });
});

describe("titleWithRef", () => {
  it("keeps the ref the recruiter gave in a new role's title (staging 11-14)", () => {
    // start_role dropped ref 21271, so every later handoff to the role was refused as "a new
    // role (ref 21271)", and a second role was opened.
    const asked = "新岗位 Senior Data Engineer 西雅图 ref 21271，first email写好发";
    expect(titleWithRef("Senior Data Engineer — Seattle", asked)).toBe(
      "Senior Data Engineer — Seattle (Ref 21271)",
    );
    expect(titleWithRef("Senior Data Engineer (Ref 21271)", asked)).toBe(
      "Senior Data Engineer (Ref 21271)",
    );
    expect(titleWithRef("Senior Data Engineer", "新岗位 Senior Data Engineer")).toBe(
      "Senior Data Engineer",
    );
  });
});
