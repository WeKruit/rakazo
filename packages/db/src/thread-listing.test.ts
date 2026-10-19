import { describe, expect, it } from "vitest";
import { previewFromBlocks } from "./thread-listing.js";

describe("previewFromBlocks", () => {
  it.each(["bot_message_sent", "bot_message_received"])(
    "keeps %s instructions out of conversation previews",
    (kind) => {
      const internal = { kind, text: "Internal delegation instructions" };
      expect(previewFromBlocks([internal])).toBe("");
      expect(previewFromBlocks([internal, { kind: "text", text: "Your results are saved" }])).toBe(
        "Your results are saved",
      );
    },
  );

  it.each(["ask", "computer"])("preserves a pending %s input in previews", (kind) => {
    expect(previewFromBlocks([{ kind, text: "Which role should I use?" }])).toBe(
      "Which role should I use?",
    );
  });

  it("preserves literal URL paths in autolinks", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Open <https://example.test/_draft_>" }])).toBe(
      "Open https://example.test/_draft_",
    );
  });
  it("preserves filenames while removing surrounding Markdown", () => {
    expect(previewFromBlocks([{ kind: "text", text: "Saved **monthly_sales_report.csv**" }])).toBe(
      "Saved monthly_sales_report.csv",
    );
  });
  it("returns the first text block with Markdown stripped", () => {
    expect(
      previewFromBlocks([
        { kind: "steps", steps: [{ label: "Read file", count: 1 }] },
        { kind: "text", text: "Created **Projects-CoS** as a **Project**" },
      ]),
    ).toBe("Created Projects-CoS as a Project");
  });

  it("returns empty when there is no text block", () => {
    expect(previewFromBlocks([{ kind: "steps", steps: [] }])).toBe("");
    expect(previewFromBlocks(undefined)).toBe("");
  });
});
