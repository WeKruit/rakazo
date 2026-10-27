import { lazy, Suspense } from "react";
import { mayContainExplicitLink } from "./link-candidates";
import type { ChatMarkdownProps } from "./markdown-shared";
import "./markdown.web.css";

export { LinkFaviconsContext, RemoteImagesContext } from "./markdown-shared";

const Markdown = lazy(() =>
  import("./markdown.web").then((module) => ({ default: module.ChatMarkdown })),
);
const Links = lazy(() =>
  import("./plain-text-links.web").then((module) => ({ default: module.PlainTextLinks })),
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
  if (!mayContainExplicitLink(props.children)) return <>{props.children}</>;
  return (
    <Suspense fallback={<span aria-busy="true">{props.children}</span>}>
      <Links {...props} />
    </Suspense>
  );
}
