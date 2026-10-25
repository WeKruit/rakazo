import { describe, expect, it } from "vitest";
import { createVendorNameStream, hideVendorNames, isVendorUrl } from "./vendor-names.js";

describe("hideVendorNames", () => {
  it("replaces the search provider in Chinese without stray spaces", () => {
    expect(hideVendorNames("回复到同一个 Autumn 任务，由它处理反馈")).toBe(
      "回复到同一个人才搜索任务，由它处理反馈",
    );
    expect(hideVendorNames("Autumn 返回了 10 人。")).toBe("人才搜索返回了 10 人。");
  });

  it("replaces providers in English and keeps sentence case", () => {
    expect(hideVendorNames("Autumn returned 10 people. I asked Autumn's task again.")).toBe(
      "The search returned 10 people. I asked the search's task again.",
    );
    expect(hideVendorNames("Saved via Coresignal and Instantly.")).toBe(
      "Saved via profile data and email.",
    );
  });

  it("keeps a candidate named Autumn and the season", () => {
    expect(hideVendorNames("Autumn Lee is a strong match")).toBe("Autumn Lee is a strong match");
    expect(hideVendorNames("starts in autumn")).toBe("starts in autumn");
  });

  it("drops provider links and keeps other links", () => {
    expect(
      hideVendorNames(
        "Logo ![x](https://autumn-assets.s3.amazonaws.com/a.png) see [profile](https://app.coresignal.com/p/1) and https://www.linkedin.com/in/jane",
      ),
    ).toBe("Logo  see profile and https://www.linkedin.com/in/jane");
    expect(hideVendorNames("source: https://files.autumn.ai/x.csv")).toBe("source: ");
  });

  it("returns text without a provider unchanged", () => {
    const text = "  indented\ncode  block with 2  spaces ";
    expect(hideVendorNames(text)).toBe(text);
  });

  it("recognizes provider hosts", () => {
    expect(isVendorUrl("https://api.autumn.ai/mcp")).toBe(true);
    expect(isVendorUrl("https://instantly.ai/app")).toBe(true);
    expect(isVendorUrl("https://s3.us-east-1.amazonaws.com/autumn-logos/acme.png")).toBe(true);
    expect(isVendorUrl("https://example.com/autumn")).toBe(false);
  });
});

describe("createVendorNameStream", () => {
  const stream = (chunks: string[]) => {
    const filter = createVendorNameStream();
    return chunks.map((chunk) => filter.push(chunk)).join("") + filter.finish();
  };

  it("hides a brand split across chunks", () => {
    const out = stream(["我已经把反馈发给 Aut", "umn", " 了，", "它会找 10 位新人。"]);
    expect(out).not.toMatch(/Autumn|Aut|umn/);
    expect(out).toContain("人才搜索");
  });

  it("hides multi-word brands and keeps a candidate's name", () => {
    expect(stream(["Checked People ", "Data", " Labs for ", "Autumn", " Lee."])).toBe(
      "Checked profile data for Autumn Lee.",
    );
  });

  it("holds an unfinished provider link", () => {
    const out = stream(["see https://autumn", "-assets.s3.amazonaws.com/a.png ok"]);
    expect(out).toBe("see  ok");
  });
});
