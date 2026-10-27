import { lazy, Suspense } from "react";
import type { ChatMarkdownProps } from "./markdown";

export { LinkFaviconsContext, RemoteImagesContext } from "./markdown";

const Markdown = lazy(() =>
  import("./markdown.web").then((module) => ({ default: module.ChatMarkdown })),
);
const Links = lazy(() =>
  import("./markdown.web").then((module) => ({ default: module.LinkifiedText })),
);
/** Keep message text visible while the renderer's first chunk loads. */
export function ChatMarkdown(props: ChatMarkdownProps) {
  return (
    <Suspense
      fallback={
        <div className="whitespace-pre-wrap" aria-busy="true">
          {props.children}
        </div>
      }
    >
      <Markdown {...props} />
    </Suspense>
  );
}
export function LinkifiedText(props: { children: string }) {
  return (
    <Suspense fallback={<span aria-busy="true">{props.children}</span>}>
      <Links {...props} />
    </Suspense>
  );
}
