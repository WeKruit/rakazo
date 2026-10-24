import type { ReactNode } from "react";
import { useState } from "react";
import { profileImageUrl } from "./profileAssets";

/** Failed/missing supplied assets remain honest initials, with no lookup or generated image. */
export function ProfileImage({
  src,
  fallback,
  className,
  photo = false,
}: {
  src?: string | null;
  fallback: ReactNode;
  className: string;
  photo?: boolean;
}) {
  const url = profileImageUrl(src);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span aria-hidden className={className}>
      {url && failedUrl !== url ? (
        <img
          key={url}
          src={url}
          alt=""
          className={`size-full ${photo ? "object-cover" : "object-contain"}`}
          referrerPolicy="no-referrer"
          loading="lazy"
          onError={() => setFailedUrl(url)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}
