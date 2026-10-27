import type { ReactNode } from "react";
import { useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { lazyPanel } from "./ErrorBoundary";

const DesktopUpdates = lazyPanel(() =>
  import("./DesktopUpdates").then((module) => module.DesktopUpdatesProvider),
);

/** The preload bridge exists before React mounts; keep the provider boundary stable thereafter. */
export function PlatformDesktopUpdates({ children }: { children: ReactNode }) {
  const [hasUpdates] = useState(() => Boolean(desktopBridge()?.update));
  return hasUpdates ? <DesktopUpdates>{children}</DesktopUpdates> : children;
}
