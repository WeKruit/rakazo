import { describe, expect, it } from "vitest";
import { isFixedAck, progressInOtherLanguage, withoutLeadingAck } from "./quick-reply.js";

describe("progressInOtherLanguage", () => {
  it("drops a one-line progress note that left the person's language (simulated 2026-11-14)", () => {
    expect(
      progressInOtherLanguage(
        "I’ll revise the template to show a RMB 700,000–900,000 base and that Fridays are remote.",
        "zh",
      ),
    ).toBe(true);
    expect(progressInOtherLanguage("我先改模板里的薪资和远程安排。", "zh")).toBe(false);
    expect(progressInOtherLanguage("Hi {{firstName}},\n\nI'm reaching out…", "zh")).toBe(false);
  });
});

// Gate 51d043cc, one-off-email: 「好，这就处理。」 stayed above the connect card that took its place.
describe("isFixedAck", () => {
  it("counts the going-ahead line as a fixed line", () => {
    expect(isFixedAck("好，这就处理。")).toBe(true);
    expect(isFixedAck("好，我会把薪资改为70–90万。")).toBe(false);
  });
});

describe("withoutLeadingAck", () => {
  it("drops the run's own opening acknowledgement after the fixed line", () => {
    expect(withoutLeadingAck("收到：地点范围改为西雅图优先，同时接受美国境内远程。")).toBe(
      "地点范围改为西雅图优先，同时接受美国境内远程。",
    );
    expect(withoutLeadingAck("Got it — remote in the US works too.")).toBe(
      "Remote in the US works too.",
    );
    expect(withoutLeadingAck("好的，我会更新搜寻范围。")).toBe("我会更新搜寻范围。");
    expect(withoutLeadingAck("네, 영어 버전으로 작성했어요.")).toBe("영어 버전으로 작성했어요.");
  });

  it("keeps a line that is only an acknowledgement, or opens otherwise", () => {
    expect(withoutLeadingAck("收到。")).toBe("收到。");
    expect(withoutLeadingAck("Okayama is in scope.")).toBe("Okayama is in scope.");
    expect(withoutLeadingAck("地点已更新。")).toBe("地点已更新。");
  });
});
