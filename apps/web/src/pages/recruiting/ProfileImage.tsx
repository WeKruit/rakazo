import type { ReactNode } from "react";
import { useState } from "react";
import { initials } from "./profile";
import { profileImageUrl } from "./profileAssets";

/** Failed/missing supplied assets remain honest initials, with no lookup or generated image. */
export function ProfileImage({
  src,
  fallback,
  className,
  photo = false,
  onUnusable,
}: {
  src?: string | null;
  fallback: ReactNode;
  className: string;
  photo?: boolean;
  /** Called when the image fails to load. */
  onUnusable?: () => void;
}) {
  // A data: image is an icon our own API already fetched and re-encoded.
  const url = src?.startsWith("data:image/") ? src : profileImageUrl(src);
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
          onError={() => {
            setFailedUrl(url);
            onUnusable?.();
          }}
        />
      ) : (
        fallback
      )}
    </span>
  );
}

export function PersonAvatar({
  name,
  src,
  size = "md",
}: {
  name: string;
  src?: string | null;
  size?: "sm" | "md";
}) {
  return (
    <ProfileImage
      src={src}
      photo
      fallback={initials(name)}
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground ${
        size === "sm" ? "size-8 text-[11px]" : "size-14 text-base"
      }`}
    />
  );
}
