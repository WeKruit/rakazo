import { useLingui } from "@lingui/react/macro";
import { MarkdownLinkPromptProvider } from "@rakazo/chat-ui/web-contexts";
import type { ReactNode } from "react";

export function MarkdownLinkPrompt({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  return (
    <MarkdownLinkPromptProvider
      copy={{
        title: t`Open external link?`,
        loading: t`Loading…`,
        loadError: t`Something went wrong. Try again.`,
        retry: t`Refresh`,
        cancel: t`Cancel`,
        open: t`Open`,
      }}
    >
      {children}
    </MarkdownLinkPromptProvider>
  );
}
