import type { MouseEvent, ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { loadExternalLinkAlert } from "./external-link-alert-loader";
import { GlobeIcon } from "./icons";
import { plainTextLinkParts } from "./linkify";
import { useMarkdownLinkCopy } from "./markdown-link-prompt";
import {
  linkFaviconOrigin,
  linkLabel,
  markdownLinkRequiresConfirmation,
  useLinkFavicon,
} from "./markdown-shared";
export const ConfirmLinkContext = createContext<(url: string) => void>(() => undefined);

function pageOrigin() {
  if (typeof window === "undefined") return null;
  const origin = window.location.origin;
  return origin && origin !== "null" ? origin : null;
}

function holdExternalLink(event: MouseEvent<HTMLAnchorElement>, request: (url: string) => void) {
  if (event.button !== 0 && event.button !== 1) return;
  const destination = event.currentTarget.href;
  if (!destination || !markdownLinkRequiresConfirmation(destination, pageOrigin())) return;
  event.preventDefault();
  request(destination);
}

function DeferredExternalLinkAlert({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  const copy = useMarkdownLinkCopy();
  const [Alert, setAlert] = useState<
    typeof import("./external-link-alert.web").ExternalLinkAlert | null
  >(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    loadExternalLinkAlert().then(
      (module) => {
        if (active) setAlert(() => module.ExternalLinkAlert);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  if (Alert) return <Alert url={url} onDismiss={onDismiss} />;
  return (
    <div role={failed ? "alert" : "status"} aria-busy={!failed}>
      <span>{failed ? copy.loadError : copy.loading}</span>
      {failed ? (
        <button
          type="button"
          onClick={() => {
            if (window.confirm(copy.refreshWarning)) window.location.reload();
          }}
        >
          {copy.retry}
        </button>
      ) : null}
      <button type="button" onClick={onDismiss}>
        {copy.cancel}
      </button>
    </div>
  );
}

export function useExternalLinkConfirm() {
  const [url, setUrl] = useState<string | null>(null);
  const request = useCallback((destination: string) => {
    setUrl(destination);
  }, []);
  const dialog = url ? (
    <DeferredExternalLinkAlert url={url} onDismiss={() => setUrl(null)} />
  ) : null;
  return { request, dialog };
}

export function ConfirmableAnchor({ href, ...props }: React.ComponentPropsWithoutRef<"a">) {
  const request = useContext(ConfirmLinkContext);
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => holdExternalLink(event, request)}
      onAuxClick={(event) => holdExternalLink(event, request)}
    />
  );
}

function LinkFavicon({ href }: { href: string }) {
  const { icon, unusable } = useLinkFavicon(href);
  return (
    <span
      aria-hidden="true"
      className={icon ? "rk-chat-link-tile rk-chat-link-tile-icon" : "rk-chat-link-tile"}
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          draggable={false}
          onLoad={(event) => {
            // A 1×1 image is a tracking pixel, not an icon.
            const image = event.currentTarget;
            if (image.naturalWidth <= 1 || image.naturalHeight <= 1) unusable();
          }}
          onError={unusable}
        />
      ) : (
        <GlobeIcon />
      )}
    </span>
  );
}

/** A link to a website, drawn with its site icon before the label. */
export function WebsiteLink({
  href,
  children,
  ...props
}: React.ComponentPropsWithoutRef<"a"> & { href: string; children: ReactNode }) {
  return (
    <ConfirmableAnchor {...props} href={href} className="rk-chat-link">
      <LinkFavicon href={href} />
      {/* bdi: direction characters in a label cannot reorder the text around the link. */}
      <bdi className="rk-chat-link-label">{children}</bdi>
    </ConfirmableAnchor>
  );
}

export function LinkifiedText({ children }: { children: string }) {
  const { request, dialog } = useExternalLinkConfirm();
  return (
    <ConfirmLinkContext.Provider value={request}>
      {plainTextLinkParts(children).map((part, index) =>
        part.type === "text" ? (
          part.value
        ) : linkFaviconOrigin(part.href) ? (
          <WebsiteLink key={index} href={part.href}>
            {linkLabel(part.value, part.href)}
          </WebsiteLink>
        ) : (
          <ConfirmableAnchor key={index} href={part.href} className="text-link underline">
            {part.value}
          </ConfirmableAnchor>
        ),
      )}
      {dialog}
    </ConfirmLinkContext.Provider>
  );
}
