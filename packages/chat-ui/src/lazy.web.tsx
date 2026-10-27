import { lazy, Suspense } from "react";
import type { ChatMarkdownProps } from "./markdown";
import { plainTextLinkParts } from "./markdown";
import "./markdown.web.css";

export { LinkFaviconsContext, RemoteImagesContext } from "./markdown";

const Markdown = lazy(() =>
  import("./markdown.web").then((module) => ({ default: module.ChatMarkdown })),
);
const Links = lazy(() =>
  import("./markdown.web").then((module) => ({ default: module.LinkifiedText })),
);
/** Keep message text visible while the renderer's first chunk loads. */
export function ChatMarkdown(props: ChatMarkdownProps) {
  // A single literal paragraph has no Markdown syntax to parse. Keep the exact
  // renderer classes/cursor; any syntax, link or multi-line text uses the full parser.
  if (
    /^[\p{L}\p{N} ,.!?，。！？、]+$/u.test(props.children) &&
    !/^ *\d+\. /.test(props.children) &&
    !/^ {4}/.test(props.children) &&
    !/(?:^| )www\./i.test(props.children)
  ) {
    return (
      <div
        className={
          props.streaming ? "rk-chat-markdown rk-chat-markdown-streaming" : "rk-chat-markdown"
        }
      >
        <p>{props.children.trim()}</p>
        {props.streaming ? <span aria-hidden="true" className="rk-chat-markdown-cursor" /> : null}
      </div>
    );
  }
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
  if (plainTextLinkParts(props.children).every((part) => part.type === "text"))
    return <>{props.children}</>;
  return (
    <Suspense fallback={<span aria-busy="true">{props.children}</span>}>
      <Links {...props} />
    </Suspense>
  );
}
