import { useLinkFavicon } from "@rakazo/chat-ui/web-contexts";
import { ProfileImage } from "./ProfileImage";
import { profileImageUrl } from "./profileAssets";

function logoInitials(name: string) {
  const letters = [...name].filter((char) => /\p{L}|\p{N}/u.test(char));
  const words = name.split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word));
  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => [...word][0] ?? "")
      .join("")
      .toUpperCase();
  }
  return letters.slice(0, 2).join("").toUpperCase();
}

/**
 * A supplied company/school image, or the icon of its own returned website (looked up by our API,
 * which reads the site's declared icon, so the browser never contacts the site); otherwise initials.
 */
export function CompanyLogo({
  name,
  src,
  host,
  small = false,
}: {
  name: string;
  src?: string | null;
  host?: string | null;
  small?: boolean;
}) {
  const supplied = profileImageUrl(src);
  const { icon, unusable } = useLinkFavicon(!supplied && host ? `https://${host}/` : "");
  return (
    <ProfileImage
      src={supplied ?? icon}
      onUnusable={supplied ? undefined : unusable}
      fallback={logoInitials(name)}
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-muted font-medium text-muted-foreground ${
        small ? "size-4 rounded-sm text-[8px]" : "size-10 rounded-md text-xs"
      }`}
    />
  );
}
