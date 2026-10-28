// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

const shell = readFileSync(
  path.join(import.meta.dirname, "../../public/html-preview.html"),
  "utf8",
);

async function render(html: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SandboxedHtmlViewer title="Notes" html={html} />);
  });
  const iframe = container.querySelector("iframe");
  const post = vi.fn();
  if (iframe?.contentWindow) iframe.contentWindow.postMessage = post;
  await act(async () => {
    iframe?.dispatchEvent(new Event("load"));
  });
  return {
    iframe,
    posted: String(post.mock.calls[0]?.[0] ?? ""),
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("keeps the shell opaque and sends it the preview only once it has loaded", async () => {
  const view = await render('<img src="https://example.invalid/pixel.png">');

  expect(view.iframe?.getAttribute("src")).toBe("/html-preview.html");
  expect(view.iframe?.getAttribute("sandbox")).toBe("allow-scripts");
  expect(view.iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(view.iframe?.hasAttribute("srcdoc")).toBe(false);
  expect(view.posted).toContain("img-src data:");
  expect(view.posted).not.toMatch(/img-src[^;]*https:/);
  expect(view.posted).toContain("https://example.invalid/pixel.png");

  await view.cleanup();
});

it("nests the preview in an opaque frame that cannot load remote images or fonts", () => {
  const inner = shell.match(/<iframe [^>]*>/)?.[0] ?? "";
  expect(inner).toContain('sandbox="allow-scripts"');
  expect(shell).not.toContain("allow-same-origin");
  expect(inner).toContain("img-src data:");
  expect(inner).toContain("font-src data:");
  expect(inner).not.toMatch(/(?:img|font)-src[^;]*https:/);
  // Only the embedding app may replace the preview.
  expect(shell).toContain("event.source === parent");
});

it("lets the shell load the nested srcdoc preview and rejects http(s) navigations", () => {
  const sources = operativeFrameSources(shellContentSecurityPolicy(shell));

  expect(shellContentSecurityPolicy(shell)).toContain("child-src 'none'");
  expect(frameSourceAllows(sources, "about:srcdoc")).toBe(true);
  expect(frameSourceAllows(sources, "https://example.invalid/nav")).toBe(false);
  expect(frameSourceAllows(sources, "http://example.invalid/nav")).toBe(false);
});

function shellContentSecurityPolicy(document: string): string {
  const match = document.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/);
  if (!match?.[1]) throw new Error("shell CSP missing");
  return match[1];
}

function directiveSources(policy: string, name: string): string[] | undefined {
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] !== name) continue;
    return tokens.slice(1);
  }
  return undefined;
}

function operativeFrameSources(policy: string): string[] {
  return (
    directiveSources(policy, "frame-src") ??
    directiveSources(policy, "child-src") ??
    directiveSources(policy, "default-src") ?? ["'none'"]
  );
}

function frameSourceAllows(sources: string[], rawUrl: string): boolean {
  if (sources.length === 0 || sources.includes("'none'")) return false;
  const url = new URL(rawUrl);
  return sources.some((source) => sourceAllows(source, url));
}

function sourceAllows(source: string, url: URL): boolean {
  if (source === "*") {
    return (
      url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "ws:" ||
      url.protocol === "wss:"
    );
  }
  if (source.startsWith("'")) return false;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return url.protocol === source;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const allowed = new URL(source);
    return url.protocol === allowed.protocol && url.hostname === allowed.hostname;
  }
  return false;
}
