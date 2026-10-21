// @vitest-environment jsdom

import type { ReadRecruitingSourceInput } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  fetchArtifactBytes: vi.fn(),
  downloadArtifact: vi.fn(),
  downloadArtifactBytes: vi.fn(),
}));
const readSource = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({ rpc: { recruiting: { readSource } } }));
vi.mock("../lib/artifact-open", () => files);
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <article>{children}</article>,
}));

import { ArtifactFileCard } from "./ArtifactFileCard";

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

async function openCsv(bytes: Uint8Array) {
  files.fetchArtifactBytes.mockResolvedValue(bytes);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () => {
    root.render(
      <ArtifactFileCard
        target={{ groupId: "group-1" }}
        artifactId="file-1"
        name="candidates.csv"
        mimeType="text/csv"
        size={bytes.length}
      />,
    );
  });
  const preview = container.querySelector<HTMLButtonElement>(
    '[aria-label="Preview candidates.csv"]',
  );
  expect(preview).not.toBeNull();
  expect(files.fetchArtifactBytes).not.toHaveBeenCalled();
  await act(async () => preview!.click());
  return document.body.querySelector<HTMLElement>('[role="dialog"]')!;
}

it("previews CSV as literal text and downloads the original bytes", async () => {
  const csv = 'Name,Notes\r\nExample Person,"<b>literal</b> **raw**,\r\ncontinued"\r\n';
  const bytes = new TextEncoder().encode(csv);
  const dialog = await openCsv(bytes);
  expect(dialog.querySelector("pre")?.textContent).toBe(csv);
  expect(dialog.querySelector("article, b")).toBeNull();
  expect(files.fetchArtifactBytes).toHaveBeenCalledExactlyOnceWith(
    { groupId: "group-1" },
    "file-1",
  );
  const download = dialog.querySelector<HTMLButtonElement>(
    '[aria-label="Download candidates.csv"]',
  );
  await act(async () => download!.click());
  expect(files.downloadArtifactBytes).toHaveBeenCalledExactlyOnceWith(
    "candidates.csv",
    "text/csv",
    bytes,
  );
  expect(files.downloadArtifact).not.toHaveBeenCalled();
});

it("keeps invalid UTF-8 CSV out of the preview", async () => {
  const dialog = await openCsv(new Uint8Array([0xff]));
  expect(dialog.textContent).toContain("This file is not valid UTF-8 text.");
  expect(dialog.querySelector("pre")).toBeNull();
  expect(dialog.querySelector('[aria-label="Download candidates.csv"]')).not.toBeNull();
});

const sourceRequest: ReadRecruitingSourceInput = {
  kind: "role",
  threadId: "thread-1",
  roleRevisionId: "revision-1",
  sourceRefId: "source-1",
};

async function sourceCard(source: ReadRecruitingSourceInput | null, diagnostics = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  const render = async (
    currentSource: ReadRecruitingSourceInput | null,
    currentDiagnostics = diagnostics,
  ) => {
    await act(async () => {
      root.render(
        <ArtifactFileCard
          target={{ groupId: "group-1", includeDiagnostics: currentDiagnostics }}
          artifactId="file-1"
          name="internal-material.json"
          mimeType="application/json"
          size={1200}
          preview={{ label: "Job description", source: currentSource }}
        />,
      );
    });
  };
  await render(source);
  return { container, render };
}

it("reads the approved source on demand without downloading its internal JSON", async () => {
  const text = "A saved job description.\nKeep <b>literal</b> and **plain** text.";
  readSource.mockResolvedValue({ kind: "text", text, start: 2, end: 7 });
  const { container } = await sourceCard(sourceRequest);
  expect(container.textContent).toContain("Job description");
  expect(container.textContent).not.toContain("internal-material");
  expect(container.textContent).not.toContain("application/json");
  expect(readSource).not.toHaveBeenCalled();
  const preview = container.querySelector<HTMLButtonElement>(
    '[aria-label="Preview Job description"]',
  );
  expect(preview).not.toBeNull();
  await act(async () => preview!.click());
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector('[role="document"]')?.textContent).toBe(text);
  expect(dialog.querySelector("mark")?.textContent).toBe(text.slice(2, 7));
  expect(dialog.querySelector("b, article")).toBeNull();
  expect(dialog.querySelector('[aria-label^="Download"]')).toBeNull();
  expect(container.querySelector('[aria-label^="Download"]')).toBeNull();
  expect(readSource).toHaveBeenCalledExactlyOnceWith(sourceRequest);
  expect(files.fetchArtifactBytes).not.toHaveBeenCalled();
  expect(files.downloadArtifact).not.toHaveBeenCalled();
});

it("keeps an unavailable approval source out of the raw download path", async () => {
  const { container } = await sourceCard(null);
  const preview = container.querySelector<HTMLButtonElement>(
    '[aria-label="Preview Job description"]',
  );
  expect(preview).not.toBeNull();
  expect(preview!.disabled).toBe(true);
  expect(container.textContent).toContain("Source unavailable");
  expect(container.textContent).not.toContain("internal-material");
  expect(readSource).not.toHaveBeenCalled();
  expect(files.fetchArtifactBytes).not.toHaveBeenCalled();
  expect(files.downloadArtifact).not.toHaveBeenCalled();
});

it("reports a source read failure without falling back to internal artifact access", async () => {
  readSource.mockRejectedValue(new Error("private-source-id"));
  const { container } = await sourceCard(sourceRequest);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Preview Job description"]')!.click(),
  );
  const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Source unavailable");
  expect(dialog.textContent).not.toContain("private-source-id");
  expect(dialog.querySelector('[aria-label^="Download"]')).toBeNull();
  expect(files.fetchArtifactBytes).not.toHaveBeenCalled();
  expect(files.downloadArtifact).not.toHaveBeenCalled();
});

it("never displays the previous role source while another target is loading", async () => {
  let resolveFirst!: (value: unknown) => void;
  let resolveSecond!: (value: unknown) => void;
  readSource
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
  const { container, render } = await sourceCard(sourceRequest);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Preview Job description"]')!.click(),
  );
  const nextSource: ReadRecruitingSourceInput = { ...sourceRequest, roleRevisionId: "revision-2" };
  await render(nextSource);
  await act(async () => resolveFirst({ kind: "text", text: "Old job", start: 0, end: 3 }));
  expect(document.body.querySelector('[role="dialog"]')?.textContent).not.toContain("Old job");
  await act(async () => resolveSecond({ kind: "text", text: "New job", start: 0, end: 3 }));
  expect(document.body.querySelector('[role="document"]')?.textContent).toBe("New job");
  expect(readSource).toHaveBeenNthCalledWith(2, nextSource);
  expect(files.fetchArtifactBytes).not.toHaveBeenCalled();
});

it("keeps owner diagnostics on the existing raw artifact path", async () => {
  const { container } = await sourceCard(sourceRequest, true);
  expect(container.textContent).toContain("internal-material.json");
  expect(container.textContent).not.toContain("Job description");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(files.downloadArtifact).toHaveBeenCalledExactlyOnceWith(
    { groupId: "group-1", includeDiagnostics: true },
    "file-1",
    "internal-material.json",
    "application/json",
  );
  expect(readSource).not.toHaveBeenCalled();
});

it("does not carry a late diagnostics download error into the business source card", async () => {
  let rejectDownload!: (error: Error) => void;
  files.downloadArtifact.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectDownload = reject;
      }),
  );
  const { container, render } = await sourceCard(sourceRequest, true);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  await render(sourceRequest, false);
  await act(async () => rejectDownload(new Error("private-id")));
  expect(container.textContent).toContain("Job description");
  expect(container.textContent).not.toContain("internal-material");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
