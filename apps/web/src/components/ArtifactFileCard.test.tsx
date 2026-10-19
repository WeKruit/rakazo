// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({
  fetchArtifactBytes: vi.fn(),
  downloadArtifact: vi.fn(),
  downloadArtifactBytes: vi.fn(),
}));
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
