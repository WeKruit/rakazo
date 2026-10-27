// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PlatformDesktopUpdates } from "./PlatformDesktopUpdates";

const platform = vi.hoisted(() => ({
  desktop: false,
  loads: 0,
  ready: undefined as undefined | (() => void),
}));
vi.mock("../lib/desktop", () => ({
  desktopBridge: () => (platform.desktop ? { update: {} } : undefined),
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./DesktopUpdates", async () => {
  platform.loads++;
  await new Promise<void>((resolve) => {
    platform.ready = resolve;
  });
  return {
    DesktopUpdatesProvider: ({ children }: { children: ReactNode }) => (
      <section data-desktop-updates>{children}</section>
    ),
  };
});
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
});
function setup() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
}

it("renders the web app immediately without importing desktop updates", async () => {
  setup();
  await act(async () =>
    root?.render(
      <PlatformDesktopUpdates>
        <main>Web app</main>
      </PlatformDesktopUpdates>,
    ),
  );
  expect(container?.textContent).toBe("Web app");
  expect(platform.loads).toBe(0);
  expect(container?.querySelector("[aria-busy]")).toBeNull();
});

it("waits for the desktop provider before mounting the app once and retains its boundary", async () => {
  platform.desktop = true;
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function App() {
    useEffect(() => {
      mounted();
      return unmounted;
    }, []);
    return <main>Desktop app</main>;
  }
  setup();
  await act(async () =>
    root?.render(
      <PlatformDesktopUpdates>
        <App />
      </PlatformDesktopUpdates>,
    ),
  );
  await vi.waitFor(() => expect(platform.loads).toBe(1));
  expect(container?.querySelector("[aria-busy=true]")).not.toBeNull();
  expect(mounted).not.toHaveBeenCalled();
  await act(async () => {
    platform.ready?.();
    await vi.dynamicImportSettled();
  });
  expect(container?.querySelector("[data-desktop-updates] main")?.textContent).toBe("Desktop app");
  expect(mounted).toHaveBeenCalledTimes(1);
  // A disappearing preload bridge during shutdown must not swap the mounted app tree.
  platform.desktop = false;
  await act(async () =>
    root?.render(
      <PlatformDesktopUpdates>
        <App />
      </PlatformDesktopUpdates>,
    ),
  );
  expect(container?.querySelector("[data-desktop-updates] main")).not.toBeNull();
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(unmounted).not.toHaveBeenCalled();
});
