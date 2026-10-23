import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  formatToolActivityDuration,
  isToolOnlyNarration,
  latestNativeToolActivity,
  messageHasVisibleBlocks,
  renderableMessageBlocks,
  shouldRenderToolCard,
  toolStepCount,
} from "./tool-activity-view";

const stepsBlock: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
const stepsNoDuration: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 2 }] };
const textBlock: MessageBlock = { kind: "text", text: "Here you go." };
const liveActivity: MessageBlock = { kind: "progress", text: "Using shell", activity: true };
const narration: MessageBlock = { kind: "progress", text: "Let me check that." };

describe("safe native activity", () => {
  const live = (blocks: MessageBlock[], seq = 1, runId = "run") => ({
    id: `progress:${runId}`,
    runId,
    seq,
    blocks,
  });
  it("uses closed native names rather than raw text, arguments or unknown tool names", () => {
    expect(
      latestNativeToolActivity(
        [
          live([
            {
              kind: "progress",
              activity: true,
              text: "private command/token/path",
              pendingToolNames: ["read_file"],
            },
          ]),
        ],
        ["run"],
      ),
    ).toBe("files");
    expect(
      latestNativeToolActivity(
        [
          live([
            {
              kind: "progress",
              activity: true,
              text: "Reading saved candidates",
              pendingToolNames: ["mcp__private__send_email"],
            },
          ]),
        ],
        ["run"],
      ),
    ).toBe("working");
    expect(
      latestNativeToolActivity(
        [live([{ kind: "progress", activity: true, text: "Reading candidate records" }])],
        ["run"],
      ),
    ).toBe("working");
  });
  it("shows only the latest running native marker and never revives historical tool steps", () => {
    const blocks: MessageBlock[] = [
      { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
      { kind: "progress", activity: true, text: "" },
    ];
    expect(latestNativeToolActivity([live(blocks)], ["run"])).toBe("search");
    expect(latestNativeToolActivity([live(blocks.slice(0, 1))], ["run"])).toBeNull();
    expect(latestNativeToolActivity([live(blocks)], [])).toBeNull();
    expect(
      latestNativeToolActivity(
        [live(blocks), live([{ kind: "progress", activity: true, text: "Unknown" }], 2, "other")],
        ["run", "other"],
      ),
    ).toBe("working");
    expect(
      latestNativeToolActivity([{ ...live(blocks), id: "saved-history" }], ["run"]),
    ).toBeNull();
  });
  it.each([
    ["mcp__personal-mail__get_email", "emails"],
    ["instantly__personal-mail__search_contact_emails", "emails"],
    ["mcp__calendar__get_availability", "availability"],
    ["Mcp personal-mail get email", "emails"],
    ["Instantly personal-mail search contact emails", "emails"],
    ["Mcp calendar get availability", "availability"],
    ["mcp__private__reply_to_email", "working"],
    ["mcp__private__create_booking", "working"],
  ])(
    "maps the actual native name %s without exposing its source or claiming completion",
    (name, expected) => {
      expect(
        latestNativeToolActivity(
          [
            live([
              { kind: "steps", steps: [{ label: name, count: 1 }] },
              { kind: "progress", activity: true, text: "" },
            ]),
          ],
          ["run"],
        ),
      ).toBe(expected);
    },
  );
});

describe("formatToolActivityDuration", () => {
  it.each([
    [0, "0ms"],
    [850, "850ms"],
    [999, "999ms"],
    [1000, "1s"],
    [4200, "4.2s"],
    [12000, "12s"],
    [19179, "19s"],
    [60000, "1m 00s"],
    [65000, "1m 05s"],
    [103000, "1m 43s"],
  ])("formats %ims as %s", (ms, expected) => {
    expect(formatToolActivityDuration(ms)).toBe(expected);
  });

  it("omits unusable durations", () => {
    expect(formatToolActivityDuration(undefined)).toBeNull();
    expect(formatToolActivityDuration(null)).toBeNull();
    expect(formatToolActivityDuration(Number.NaN)).toBeNull();
    expect(formatToolActivityDuration(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatToolActivityDuration(-1)).toBeNull();
  });
});

describe("tool step count", () => {
  it("sums each row's count", () => {
    expect(toolStepCount([{ count: 1 }, { count: 3 }])).toBe(4);
    expect(toolStepCount([])).toBe(0);
  });
});

describe("tool card render decisions", () => {
  it("renders only steps blocks, and only when the preference is on", () => {
    expect(shouldRenderToolCard(stepsBlock, true)).toBe(true);
    expect(shouldRenderToolCard(stepsBlock, false)).toBe(false);
    expect(shouldRenderToolCard(textBlock, true)).toBe(false);
    expect(shouldRenderToolCard(liveActivity, true)).toBe(false);
  });

  it("keeps text order and drops hidden activity per preference", () => {
    const blocks = [textBlock, stepsBlock, liveActivity, narration];
    expect(renderableMessageBlocks(blocks, true)).toEqual([textBlock, stepsBlock, narration]);
    expect(renderableMessageBlocks(blocks, false)).toEqual([textBlock, narration]);
  });

  it("keeps native approval cards visible when diagnostics are hidden", () => {
    const approval: MessageBlock = {
      kind: "ask",
      text: "Send the displayed draft to the selected recipient?",
      detail: "Recipient and message body remain visible.",
      approvalEffectId: "approval-effect",
      status: "pending",
      actions: [{ id: "allow", label: "Allow once" }],
    };
    expect(renderableMessageBlocks([stepsBlock, approval], false)).toEqual([approval]);
    expect(messageHasVisibleBlocks([approval], false)).toBe(true);
  });

  it("hides native delegation chrome while preserving mixed business results and exact consent", () => {
    const approval: MessageBlock = {
      kind: "ask",
      text: "Send this exact draft?",
      approvalEffectId: "effect-original",
      detail: "To: person@example.test\nBody: Original draft",
      actions: [{ id: "allow", label: "Allow once" }],
    };
    const internal: MessageBlock[] = [
      { kind: "handoff", fromBotId: "main", toBotId: "specialist", text: "internal handoff" },
      {
        kind: "bot_message_sent",
        toBotId: "specialist",
        toBotName: "Specialist",
        text: "internal payload",
      },
      {
        kind: "subagent",
        agentId: "internal-agent",
        name: "Internal work",
        task: "internal task",
        status: "completed",
      },
    ];
    expect(renderableMessageBlocks([...internal, textBlock, approval], false)).toEqual([
      textBlock,
      approval,
    ]);
    expect(renderableMessageBlocks([...internal, textBlock, approval], true)).toEqual([
      ...internal,
      textBlock,
      approval,
    ]);
    expect(messageHasVisibleBlocks(internal, false)).toBe(false);
  });

  it("never surfaces a progress block marked as activity", () => {
    expect(messageHasVisibleBlocks([liveActivity], true)).toBe(false);
    expect(messageHasVisibleBlocks([liveActivity], false)).toBe(false);
  });

  it("keeps a steps-only message visible only when the preference is on", () => {
    expect(messageHasVisibleBlocks([stepsNoDuration], true)).toBe(true);
    expect(messageHasVisibleBlocks([stepsNoDuration], false)).toBe(false);
    expect(messageHasVisibleBlocks([textBlock], false)).toBe(true);
  });
});

describe("tool-only narration", () => {
  it("is true for a live run that has only called tools, and for a steps-only message", () => {
    expect(isToolOnlyNarration([liveActivity, stepsBlock], true)).toBe(true);
    expect(isToolOnlyNarration([stepsBlock], true)).toBe(true);
    expect(isToolOnlyNarration([stepsBlock, stepsNoDuration], true)).toBe(true);
  });

  it("is false once the bot has written something, or when tool cards are hidden", () => {
    expect(isToolOnlyNarration([stepsBlock, textBlock], true)).toBe(false);
    expect(isToolOnlyNarration([narration, liveActivity, stepsBlock], true)).toBe(false);
    expect(isToolOnlyNarration([liveActivity, stepsBlock], false)).toBe(false);
    expect(isToolOnlyNarration([liveActivity], true)).toBe(false);
  });
});
