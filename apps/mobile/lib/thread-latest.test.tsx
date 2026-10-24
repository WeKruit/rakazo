// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { parseAskFormResponse } from "@rakazo/contracts";
import type { ThreadScrollState } from "@rakazo/core";
import {
  answerableAskMessageIds,
  appendNewerThreadPage,
  askFormContent,
  askFormDefaults,
  askFormOptions,
  isApprovalAskBlock,
  isSecretAskBlock,
  leaveThreadWindow,
  openThreadWindow,
  reconcileThreadScrollState,
  selectedAskActionLabel,
} from "@rakazo/core";
import React, { act, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { MobileMessage, MobileSnapshot } from "./api";
import { isInlineImageMimeType } from "./inline-image";
import { ThreadJumpAnchor } from "./thread-jump";
import { ThreadScrollBehavior } from "./thread-scroll";

// Exercise the screen's actual handler without importing its native dependencies.
// Keep Vitest's jsdom URL transform from replacing the file URL with self.location.
const testFileUrl = import.meta.url;
const source = readFileSync(new URL("../app/thread.tsx", testFileUrl), "utf8");
const handler = source.slice(
  source.indexOf("  function showLatest() {"),
  source.indexOf("  async function loadOlderMessages() {"),
);

const formatterSource = source.slice(
  source.indexOf("function formatApprovalAnswer("),
  source.indexOf("\nfunction formatAttachmentSkip("),
);
const compiledFormatter = ts.transpileModule(`${formatterSource}\nreturn formatApprovalAnswer;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const formatApprovalAnswer = new Function("t", "selectedAskActionLabel", compiledFormatter)(
  (text: string, values?: { answer: string }) =>
    text.replace("{answer}", values?.answer ?? "{answer}"),
  selectedAskActionLabel,
);

it("preserves server approval labels in completed mobile answers and retains native outcomes", () => {
  const cases = [
    { id: "allow", label: "Confirm requirements", expected: "Answered: Confirm requirements" },
    { id: "allow", label: "Approve documents", expected: "Answered: Approve documents" },
    { id: "allow", label: "Approve calibration", expected: "Answered: Approve calibration" },
    {
      id: "always",
      label: "Approve future documents",
      expected: "Answered: Approve future documents",
    },
    {
      id: "deny",
      label: "Keep the current documents",
      expected: "Answered: Keep the current documents",
    },
    { id: "allow", label: "Allow once", expected: "Allowed once" },
    { id: "always", label: "Always allow this tool", expected: "Always allowed" },
    { id: "always", label: "Always allow", expected: "Always allowed" },
    { id: "deny", label: "Deny", expected: "Denied" },
    { id: "allow", label: "Create space", outcome: "created", expected: "Created" },
    { id: "deny", label: "Cancel", outcome: "cancelled", expected: "Cancelled" },
  ];
  for (const { expected, ...action } of cases) {
    expect(formatApprovalAnswer(action.id, [action], true)).toBe(expected);
  }
  for (const [answer, expected] of [
    ["allow", "Allowed once"],
    ["always", "Always allowed"],
    ["deny", "Denied"],
  ]) {
    expect(formatApprovalAnswer(answer, undefined, true)).toBe(expected);
    expect(formatApprovalAnswer(answer, [{ id: "other", label: "Other" }], true)).toBe(expected);
  }
});

it.each(["pending", "answered", "plain ask", "attachments"])(
  "keeps native files and image previews beside %s mobile asks",
  async (scenario) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const surface = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
    const pressable = ({
      children,
      onPress,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
    }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    );
    const openMobileArtifact = vi.fn().mockResolvedValue(undefined);
    const onPreviewMarkdown = vi.fn();
    const onPreviewImage = vi.fn();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    const scope = {
      React,
      memo: React.memo,
      useState,
      useResolvedAppearance: () => "light",
      mobileTokens: () => ({}),
      useI18n: () => ({ t: (text: string) => text }),
      isApprovalAskBlock,
      isSecretAskBlock,
      isInlineImageMimeType,
      formatApprovalAnswer,
      openMobileArtifact,
      formatFileSize: () => "",
      memberName: () => undefined,
      speakerColorFor: () => undefined,
      View: surface,
      Text: surface,
      Pressable: pressable,
      AskBlock: ({ ask }: { ask: { text: string } }) => <p>{ask.text}</p>,
      AskActions: ({
        actions,
        onAnswer,
      }: {
        actions: { id: string; label: string }[];
        onAnswer: (answer: string) => Promise<void>;
      }) =>
        actions.map((action) => (
          <button key={action.id} type="button" onClick={() => void onAnswer(action.id)}>
            {action.label}
          </button>
        )),
      InlineImageAttachment: ({ name, onOpen }: { name: string; onOpen: () => void }) => (
        <button type="button" onClick={onOpen}>
          {name}
        </button>
      ),
    };
    const bubbleSource = source.slice(
      source.indexOf("const MessageBubble = memo(function MessageBubble("),
      source.indexOf("\nfunction MessageTextCard("),
    );
    const compiled = ts.transpileModule(`${bubbleSource}\nreturn MessageBubble;`, {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const MessageBubble = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
    const attachments: Extract<MobileMessage["blocks"][number], { kind: "image" | "file" }>[] = [
      {
        kind: "file",
        artifactId: "pdf",
        name: "requirements.pdf",
        mimeType: "application/pdf",
        size: 40,
      },
      {
        kind: "file",
        artifactId: "markdown",
        name: "requirements.md",
        mimeType: "text/markdown",
        size: 20,
      },
      {
        kind: "file",
        artifactId: "jd-source",
        name: "internal-material.json",
        mimeType: "application/json",
        size: 60,
        preview: {
          label: "Job description",
          source: {
            kind: "role",
            threadId: "group-thread",
            roleRevisionId: "revision",
            sourceRefId: "jd",
          },
        },
      },
      {
        kind: "file",
        artifactId: "unavailable-source",
        name: "unavailable-material.json",
        mimeType: "application/json",
        size: 60,
        preview: { label: "Previous job description", source: null },
      },
      { kind: "image", artifactId: "image", name: "diagram.png", mimeType: "image/png" },
      { kind: "image", artifactId: "vector", name: "diagram.svg", mimeType: "image/svg+xml" },
    ];
    const message: MobileMessage = {
      id: "approval-message",
      threadId: "group-thread",
      botId: "bot-1",
      role: "bot",
      blocks: [
        ...(scenario === "attachments"
          ? []
          : [
              {
                kind: "ask" as const,
                text: "Review the attached documents",
                ...(scenario === "plain ask"
                  ? {}
                  : {
                      approvalEffectId: "effect-1",
                      actions: [
                        { id: "allow", label: "Approve documents" },
                        { id: "deny", label: "Deny" },
                      ],
                    }),
                status: scenario === "answered" ? ("answered" as const) : ("pending" as const),
                ...(scenario === "answered" ? { answer: "allow" } : {}),
              },
            ]),
        ...attachments,
      ],
    };
    const original = JSON.stringify(message);
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <MessageBubble
            botId="bot-1"
            groupId="group-1"
            bots={[]}
            message={message}
            canAnswer={scenario !== "answered"}
            onAnswer={onAnswer}
            onPreviewMarkdown={onPreviewMarkdown}
            onPreviewImage={onPreviewImage}
            actionProps={{}}
          />,
        ),
      );
      for (const attachment of attachments) {
        const label =
          attachment.kind === "file"
            ? (attachment.preview?.label ?? attachment.name)
            : attachment.name;
        const buttons = [...container.querySelectorAll("button")].filter((button) =>
          button.textContent?.includes(label),
        );
        expect(buttons).toHaveLength(1);
        await act(async () => buttons[0]!.click());
      }
      expect(openMobileArtifact.mock.calls).toEqual([
        [{ groupId: "group-1" }, "pdf", "requirements.pdf", "application/pdf"],
        [{ groupId: "group-1" }, "vector", "diagram.svg", "image/svg+xml"],
      ]);
      expect(onPreviewMarkdown.mock.calls).toEqual([
        [
          {
            artifactId: "markdown",
            name: "requirements.md",
            mimeType: "text/markdown",
          },
        ],
        ...attachments
          .filter((attachment) => attachment.kind === "file" && attachment.preview)
          .map((attachment) => [
            {
              artifactId: attachment.artifactId,
              name: attachment.name,
              mimeType: attachment.mimeType,
              preview: attachment.kind === "file" ? attachment.preview : undefined,
              messageId: message.id,
            },
          ]),
      ]);
      expect(container.textContent).not.toContain("internal-material.json");
      expect(container.textContent).not.toContain("unavailable-material.json");
      expect(onPreviewImage).toHaveBeenCalledExactlyOnceWith({
        artifactId: "image",
        name: "diagram.png",
        mimeType: "image/png",
      });
      if (scenario === "pending") {
        await act(async () =>
          [...container.querySelectorAll("button")]
            .find((button) => button.textContent === "Approve documents")!
            .click(),
        );
        expect(onAnswer).toHaveBeenCalledExactlyOnceWith(message, "allow");
      } else {
        expect(onAnswer).not.toHaveBeenCalled();
        if (scenario === "answered")
          expect(container.textContent).toContain("Answered: Approve documents");
      }
      expect(JSON.stringify(message)).toBe(original);
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);

it("reads a trusted JD in the native preview, isolates targets, and never shares its raw artifact", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const surface = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const rpc = vi.fn();
  const readMobileArtifactText = vi.fn().mockResolvedValue("# Original Markdown");
  const openMobileArtifact = vi.fn().mockResolvedValue(undefined);
  const scope = {
    React,
    useEffect,
    useState,
    rpc,
    readMobileArtifactText,
    openMobileArtifact,
    mobileTokens: () => ({}),
    useI18n: () => ({ t: (text: string) => text }),
    useResolvedAppearance: () => "light",
    iosAtLeast: () => false,
    errorText: (error: Error) => error.message,
    Modal: surface,
    SafeAreaView: surface,
    ScrollView: surface,
    View: surface,
    Text: ({ children, selectable }: { children?: React.ReactNode; selectable?: boolean }) => (
      <span data-selectable={selectable || undefined}>{children}</span>
    ),
    ChatMarkdown: ({ children }: { children?: React.ReactNode }) => <article>{children}</article>,
    GlassIconButton: ({
      accessibilityLabel,
      onPress,
    }: {
      accessibilityLabel: string;
      onPress: () => void;
    }) => <button type="button" aria-label={accessibilityLabel} onClick={onPress} />,
  };
  const previewSource = readFileSync(
    new URL("../components/markdown-artifact-preview.tsx", testFileUrl),
    "utf8",
  );
  const compiled = ts.transpileModule(
    `${previewSource.slice(previewSource.indexOf("export function MarkdownArtifactPreview(")).replace("export function", "function")}\nreturn MarkdownArtifactPreview;`,
    {
      compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const Preview = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  const target = {
    artifactId: "jd-source",
    name: "internal-material.json",
    mimeType: "application/json",
    messageId: "message-1",
    preview: {
      label: "Job description",
      source: {
        kind: "role",
        threadId: "thread-1",
        roleRevisionId: "revision-1",
        sourceRefId: "jd",
      },
    },
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (value: unknown, groupId = "group-1") =>
    act(() => root.render(<Preview threadTarget={{ groupId }} target={value} onClose={vi.fn()} />));
  let resolveFirst!: (value: unknown) => void;
  rpc.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveFirst = resolve;
    }),
  );
  try {
    render(target);
    expect(container.textContent).toContain("Job description");
    expect(container.textContent).not.toContain(target.name);
    expect(container.textContent).toContain("Loading preview…");
    expect(rpc).toHaveBeenCalledExactlyOnceWith("recruiting/readSource", target.preview.source);
    const fullText = "Full **literal** JD\n\nFinal requirement.";
    await act(async () => resolveFirst({ kind: "text", text: fullText, start: 0, end: 4 }));
    expect(container.querySelector('[data-selectable="true"]')?.textContent).toBe(fullText);
    expect(container.querySelector("article")).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);

    let resolveOld!: (value: unknown) => void;
    rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    const next = {
      ...target,
      messageId: "message-2",
      preview: {
        ...target.preview,
        source: { ...target.preview.source, roleRevisionId: "revision-2" },
      },
    };
    render(next);
    expect(container.textContent).not.toContain(fullText);
    expect(container.textContent).toContain("Loading preview…");
    let resolveNew!: (value: unknown) => void;
    rpc.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveNew = resolve;
      }),
    );
    render(next, "group-2");
    await act(async () => resolveOld({ kind: "text", text: "Stale source", start: 0, end: 5 }));
    expect(container.textContent).not.toContain("Stale source");
    await act(async () => resolveNew({ kind: "text", text: "Current source", start: 0, end: 7 }));
    expect(container.textContent).toContain("Current source");

    render({ ...target, preview: { label: "Job description", source: null } });
    expect(container.textContent).toContain("Source unavailable");
    expect(container.textContent).not.toContain("Current source");
    expect(rpc).toHaveBeenCalledTimes(3);
    rpc.mockRejectedValueOnce(new Error("internal provider details"));
    await act(async () => render({ ...target, messageId: "failed" }));
    expect(container.textContent).toContain("Source unavailable");
    expect(container.textContent).not.toContain("internal provider details");
    expect(readMobileArtifactText).not.toHaveBeenCalled();
    expect(openMobileArtifact).not.toHaveBeenCalled();

    await act(async () =>
      render({ artifactId: "markdown", name: "notes.md", mimeType: "text/markdown" }),
    );
    expect(container.querySelector("article")?.textContent).toBe("# Original Markdown");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label")?.startsWith("Share"))!
        .click(),
    );
    expect(openMobileArtifact).toHaveBeenCalledExactlyOnceWith(
      { groupId: "group-1" },
      "markdown",
      "notes.md",
      "text/markdown",
    );
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("renders and answers the actual mobile multi-field card with typed multi-select and URL validation", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const surface = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const scope = {
    React,
    useState,
    askFormContent,
    askFormDefaults,
    askFormOptions,
    parseAskFormResponse,
    isSecretAskBlock,
    formatApprovalAnswer,
    useMobileTokens: () => ({}),
    useI18n: () => ({
      t: (text: string, values?: { answer: string }) =>
        text.replace("{answer}", values?.answer ?? "{answer}"),
    }),
    errorText: (error: Error) => error.message,
    View: surface,
    Text: surface,
    askInputStyles: { field: {} },
    TextInput: ({
      accessibilityLabel,
      value,
      onChangeText,
      editable,
      multiline,
      keyboardType,
    }: {
      accessibilityLabel: string;
      value: string;
      onChangeText: (text: string) => void;
      editable: boolean;
      multiline?: boolean;
      keyboardType?: string;
    }) => {
      const Input = multiline ? "textarea" : "input";
      return (
        <Input
          aria-label={accessibilityLabel}
          data-keyboard-type={keyboardType}
          value={value}
          disabled={!editable}
          onChange={(event) => onChangeText(event.target.value)}
        />
      );
    },
    NativeSwitch: ({
      accessibilityLabel,
      value,
      onValueChange,
      disabled,
    }: {
      accessibilityLabel: string;
      value: boolean;
      onValueChange: (value: boolean) => void;
      disabled: boolean;
    }) => (
      <input
        type="checkbox"
        aria-label={accessibilityLabel}
        checked={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.checked)}
      />
    ),
    NativeActionButton: ({
      label,
      disabled,
      onPress,
    }: {
      label: string;
      disabled: boolean;
      onPress: () => void;
    }) => (
      <button type="button" disabled={disabled} onClick={onPress}>
        {label}
      </button>
    ),
  };
  const blockSource = source.slice(
    source.indexOf("function AskBlock("),
    source.indexOf("\nconst askInputStyles"),
  );
  const compiled = ts.transpileModule(`${blockSource}\nreturn AskBlock;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const AskBlock = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
  const container = document.createElement("div");
  const root = createRoot(container);
  const onAnswer = vi.fn().mockResolvedValue(undefined);
  const ask = {
    kind: "ask",
    text: "Details?",
    requestedSchema: {
      type: "object",
      properties: {
        website: { type: "string", title: "Website", format: "uri" },
        guidance: { type: "string", title: "Guidance", maxLength: 12000 },
        count: { type: "integer", default: 2 },
        regions: {
          type: "array",
          title: "Regions",
          minItems: 1,
          items: { type: "string", enum: ["north", "south"] },
        },
      },
      required: ["website", "regions"],
    },
  };
  try {
    act(() => root.render(<AskBlock ask={ask} canAnswer onAnswer={onAnswer} actionProps={{}} />));
    const guidance = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Guidance"]',
    )!;
    expect(guidance).not.toBeNull();
    const guidanceText = "Keep confirmed evidence.\nFlag missing evidence.";
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        guidance,
        guidanceText,
      );
      guidance.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Website"]')!;
    expect(input.dataset.keyboardType).toBe("url");
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="count"]')!.dataset.keyboardType,
    ).toBe("numbers-and-punctuation");
    const setWebsite = (value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    act(() =>
      container.querySelector<HTMLInputElement>('input[aria-label="Regions: north"]')!.click(),
    );
    act(() =>
      container.querySelector<HTMLInputElement>('input[aria-label="Regions: south"]')!.click(),
    );
    setWebsite("invalid");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Send answer")!
        .click(),
    );
    expect(onAnswer).not.toHaveBeenCalled();
    setWebsite("https://example.com");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Send answer")!
        .click(),
    );
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith({
      action: "accept",
      content: {
        count: 2,
        regions: ["north", "south"],
        website: "https://example.com",
        guidance: guidanceText,
      },
    });
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Cancel")!
        .click(),
    );
    expect(onAnswer).toHaveBeenLastCalledWith({ action: "cancel" });
    act(() =>
      root.render(
        <AskBlock
          ask={{ ...ask, status: "answered", answer: "Saved details" }}
          canAnswer={false}
          onAnswer={onAnswer}
          actionProps={{}}
        />,
      ),
    );
    expect(container.querySelector("input")).toBeNull();
    for (const [answer, expected] of [
      ["allow", "Allowed once"],
      ["always", "Always allowed"],
      ["deny", "Denied"],
    ]) {
      act(() =>
        root.render(
          <AskBlock
            ask={{
              kind: "ask",
              text: "Review this decision",
              approvalEffectId: "effect-test",
              status: "answered",
              answer,
            }}
            canAnswer={false}
            onAnswer={onAnswer}
            actionProps={{}}
          />,
        ),
      );
      expect(container.textContent).toContain(expected);
      expect(container.textContent).not.toContain(`Answered: ${answer}`);
    }
  } finally {
    act(() => root.unmount());
  }
});

function page(seqs: number[]) {
  return {
    threadId: "thread-1",
    olderCursor: 1,
    messages: seqs.map((seq) => ({ id: `message-${seq}`, seq })),
  };
}

describe("mobile jump to latest", () => {
  it.each(["no newer gap", "newer pages closed the gap"])(
    "leaves a pinned page with %s",
    (scenario) => {
      const latest = page([4, 5]);
      const opened = openThreadWindow(latest, page([1, 2]));
      const window =
        scenario === "no newer gap"
          ? openThreadWindow(latest, latest)
          : appendNewerThreadPage(opened.snapshot, opened.newerCursor!, page([2, 3, 4, 5]));
      expect(window.newerCursor).toBeNull();
      expect(leaveThreadWindow(window.snapshot, window.newerCursor)).toBe(window.snapshot);

      function Probe() {
        const [snap, setSnap] = useState(window.snapshot);
        const snapRef = useRef(snap);
        const pinnedAroundRef = useRef<{ newerCursor: number | null } | null>(window);
        const jumpScrollTarget = useRef<string | null>("message-4");
        const [scrollState, setThreadScrollState] = useState<ThreadScrollState>({
          detached: false,
          unread: false,
        });
        const scope = {
          pinnedAroundRef,
          joinPinnedAfterLayout: useRef<number | null>(0),
          jumpScrollTarget,
          jumpAnchor: useRef(new ThreadJumpAnchor()),
          expandedHistoryThread: useRef<string | null>("thread-1"),
          scrollBehavior: useRef(new ThreadScrollBehavior()),
          setThreadScrollState,
          publishThreadScrollState: (next: ThreadScrollState) =>
            setThreadScrollState((previous) => reconcileThreadScrollState(previous, next)),
          snapRef,
          commitSnap: setSnap,
          leaveThreadWindow,
        };
        const showLatest = new Function(...Object.keys(scope), `${handler}; return showLatest;`)(
          ...Object.values(scope),
        );
        const pinned = pinnedAroundRef.current != null || jumpScrollTarget.current != null;
        return (
          <>
            <div data-list={pinned ? "pinned" : "live"}>{snap.messages.length}</div>
            {pinned || scrollState.detached ? (
              <button type="button" onClick={showLatest}>
                Jump to latest
              </button>
            ) : null}
          </>
        );
      }

      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const container = document.createElement("div");
      const root = createRoot(container);
      try {
        act(() => root.render(<Probe />));
        expect(container.querySelector('[data-list="pinned"]')).not.toBeNull();
        act(() => container.querySelector("button")!.click());
        expect(container.querySelector('[data-list="live"]')).not.toBeNull();
        expect(container.querySelector("button")).toBeNull();
      } finally {
        act(() => root.unmount());
        vi.unstubAllGlobals();
      }
    },
  );
});

it("keeps each waiting agent's original question enabled in a mobile group", () => {
  const snapshot: MobileSnapshot = {
    threadId: "group-thread",
    cursor: 10,
    olderCursor: null,
    run: null,
    activeRuns: [
      { id: "main", status: "waiting_input" },
      { id: "sourcer", status: "waiting_input" },
      { id: "busy", status: "running" },
    ],
    messages: [
      { id: "main-old", runId: "main" },
      { id: "main-ask", runId: "main" },
      { id: "sourcer-ask", runId: "sourcer" },
      { id: "busy-ask", runId: "busy" },
    ].map((message) => ({
      ...message,
      role: "bot",
      blocks: [{ kind: "ask", text: "Which priority?", status: "pending" }],
    })),
  };
  const selection = source.match(/^ {2}const answerableAsk\w+ = .*;/m)![0];
  const rows = source.slice(
    source.indexOf("  const renderMessageRow = useCallback("),
    source.indexOf("  const renderItem = useCallback("),
  );
  const compiled = ts.transpileModule(`${selection}\n${rows}\nreturn renderMessageRow;`, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  function Probe({ readOnly = false }: { readOnly?: boolean }) {
    const scope = {
      React,
      useCallback,
      answerableAskMessageIds,
      snap: snapshot,
      readOnly,
      messagesById: new Map(),
      memberName: () => undefined,
      mentionBots: [],
      displayName: "Main",
      reactionView: { reactions: new Map() },
      inGroup: true,
      botId: undefined,
      groupId: "group-1",
      currentBot: null,
      currentBotStatus: "idle",
      rowActions: {},
      onCall: false,
      highlightedMessageId: null,
      separatorIds: new Set(),
      windowWidth: 393,
      t: (text: string) => text,
      locale: "en",
      MessageRow: ({ message, canAnswer }: { message: MobileMessage; canAnswer: boolean }) => (
        <button type="button" data-message={message.id} disabled={!canAnswer} />
      ),
    };
    const renderRow = new Function(...Object.keys(scope), compiled)(...Object.values(scope));
    return snapshot.messages.map((message) => renderRow(message));
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<Probe />));
    expect(
      [...container.querySelectorAll<HTMLButtonElement>("button:enabled")].map(
        (button) => button.dataset.message,
      ),
    ).toEqual(["main-ask", "sourcer-ask"]);
    act(() => root.render(<Probe readOnly />));
    expect(container.querySelector("button:enabled")).toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
