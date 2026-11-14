import { describe, expect, it } from "vitest";
import { signingName } from "./recruiter-name.js";

describe("the name a recruiter signs emails with", () => {
  it("uses a typed sign-up name", () => {
    expect(signingName({ name: " Jules  Martin ", email: "jm@example.test" })).toBe("Jules Martin");
    expect(signingName({ name: "刘诺", email: "n@example.test" })).toBe("刘诺");
  });

  it("skips the sign-up fallbacks and handles", () => {
    expect(signingName({ name: "jules", email: "jules@example.test" })).toBeUndefined();
    expect(signingName({ name: "User", email: "a@example.test" })).toBeUndefined();
    expect(signingName({ name: "admin1", email: "x@example.test" })).toBeUndefined();
    expect(signingName({ name: "a@b.test", email: "a@b.test" })).toBeUndefined();
    expect(signingName(null)).toBeUndefined();
  });
});
