import { lazy, Suspense } from "react";
import { plainTextLinkParts } from "./linkify";

const Links = lazy(() =>
  import("./markdown.web").then((module) => ({ default: module.LinkifiedText })),
);

/** Candidate punctuation is parsed by the unchanged canonical parser. */
export function PlainTextLinks({ children }: { children: string }) {
  if (plainTextLinkParts(children).every((part) => part.type === "text")) return <>{children}</>;
  return (
    <Suspense fallback={<span aria-busy="true">{children}</span>}>
      <Links>{children}</Links>
    </Suspense>
  );
}
