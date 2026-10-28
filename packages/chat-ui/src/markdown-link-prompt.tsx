import type { ReactNode } from "react";
import { createContext, useContext } from "react";

type MarkdownLinkCopy = {
  title: string;
  cancel: string;
  open: string;
  loading?: string;
  loadError?: string;
  retry?: string;
  refreshWarning?: string;
};

const defaultMarkdownLinkCopy: MarkdownLinkCopy = {
  title: "Open external link?",
  cancel: "Cancel",
  open: "Open",
  loading: "Loading…",
  loadError: "Something went wrong. Try again.",
  retry: "Refresh",
  refreshWarning:
    "Refreshing closes this link confirmation and may discard unsaved messages, attachments, reply context and selections. Refresh anyway?",
};

const CopyContext = createContext<MarkdownLinkCopy>(defaultMarkdownLinkCopy);
const OriginContext = createContext<string | null>(null);

export function MarkdownLinkPromptProvider({
  copy = defaultMarkdownLinkCopy,
  appOrigin = null,
  children,
}: {
  copy?: MarkdownLinkCopy;
  appOrigin?: string | null;
  children: ReactNode;
}) {
  return (
    <CopyContext.Provider value={copy}>
      <OriginContext.Provider value={appOrigin}>{children}</OriginContext.Provider>
    </CopyContext.Provider>
  );
}

export function useMarkdownLinkCopy() {
  return { ...defaultMarkdownLinkCopy, ...useContext(CopyContext) };
}

export function useMarkdownLinkAppOrigin() {
  return useContext(OriginContext);
}
