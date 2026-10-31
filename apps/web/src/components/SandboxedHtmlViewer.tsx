import type { CanvasJson } from "@rakazo/contracts";
import { canvasSaveState, HTML_PREVIEW_PATH } from "@rakazo/core";
import { useEffect, useRef, useState } from "react";

const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

const PREVIEW_GUARD = `<script>
document.addEventListener("click", (event) => {
  const target = event.target;
  const link = target instanceof Element ? target.closest("a[href]") : null;
  if (!link) return;
  const href = link.getAttribute("href") ?? "";
  event.preventDefault();
  if (href.startsWith("#")) location.hash = href;
}, true);
document.addEventListener("submit", (event) => event.preventDefault(), true);
</script>`;

function withPreviewDocument(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const referrer = `<meta name="referrer" content="no-referrer">`;
  return `${meta}${referrer}${PREVIEW_GUARD}${html}`;
}

export function SandboxedHtmlViewer({
  html,
  title,
  onCanvasSave,
}: {
  html: string;
  title: string;
  /** A canvas app saved its data; only messages from this frame count. */
  onCanvasSave?: (state: CanvasJson) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const preview = withPreviewDocument(html);
  useEffect(() => {
    // The shell is an opaque origin, so its origin cannot be named as the target.
    if (loaded) frame.current?.contentWindow?.postMessage(preview, "*");
  }, [loaded, preview]);
  useEffect(() => {
    if (!onCanvasSave) return;
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const saved = canvasSaveState(event.data);
      if (saved) onCanvasSave(saved.state);
    };
    addEventListener("message", listen);
    return () => removeEventListener("message", listen);
  }, [onCanvasSave]);
  return (
    <iframe
      ref={frame}
      title={title}
      src={HTML_PREVIEW_PATH}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
      className="h-full w-full border-0 bg-white"
    />
  );
}
