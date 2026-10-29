import { useLinkFavicon } from "@rakazo/chat-ui/web-contexts";
import { memo, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
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

type Site = { host: string | null; icon?: string };
const companySites = new Map<string, Site>();
const pendingSites = new Map<string, Promise<Site>>();
const NO_SITE: Site = { host: null };

const SITE_ATTEMPTS = 5;

function lookupCompanySite(name: string, attempt = 0): Promise<Site> {
  const key = name.trim().toLowerCase();
  if (companySites.has(key)) return Promise.resolve(companySites.get(key)!);
  const pending = pendingSites.get(key);
  if (pending) return pending;
  // A logo is decoration: any failure, even a missing client, leaves the initials. A busy
  // server is not a miss, so it is asked again later and never remembered as one.
  const lookup = Promise.resolve()
    .then(() => rpc.links.companySite({ name: name.trim().slice(0, 200) }))
    .then(async ({ host, icon, retry }) => {
      pendingSites.delete(key);
      if (!retry) {
        const site = { host, ...(icon ? { icon } : {}) };
        companySites.set(key, site);
        return site;
      }
      if (attempt + 1 >= SITE_ATTEMPTS) return NO_SITE;
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
      return lookupCompanySite(name, attempt + 1);
    })
    .catch(() => {
      pendingSites.delete(key);
      return NO_SITE;
    });
  pendingSites.set(key, lookup);
  return lookup;
}

/** The organization's own site host (and logo, when found with it) our API found from its name. */
function useCompanySite(name: string, enabled: boolean): Site {
  const key = name.trim().toLowerCase();
  const [found, setFound] = useState<{ key: string; site: Site }>();
  useEffect(() => {
    if (!enabled || !key) return;
    let current = true;
    void lookupCompanySite(name).then((site) => current && setFound({ key, site }));
    return () => {
      current = false;
    };
  }, [key, enabled]);
  if (!enabled) return NO_SITE;
  return companySites.get(key) ?? (found?.key === key ? found.site : NO_SITE);
}

/**
 * A supplied company/school image, or the icon of its own website (looked up by our API, which
 * reads the site's declared icon, so the browser never contacts the site); otherwise initials.
 * Without a returned website, our API looks for the organization's own site by its name.
 */
export const CompanyLogo = memo(function CompanyLogo({
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
  const found = useCompanySite(name, !supplied && !host);
  const site = host ?? found.host;
  const logo = supplied ?? found.icon;
  const { icon, unusable } = useLinkFavicon(!logo && site ? `https://${site}/` : "");
  return (
    <ProfileImage
      src={logo ?? icon}
      onUnusable={logo ? undefined : unusable}
      fallback={logoInitials(name)}
      className={`flex shrink-0 items-center justify-center overflow-hidden bg-muted font-medium text-muted-foreground ${
        small ? "size-4 rounded-sm text-[8px]" : "size-10 rounded-md text-xs"
      }`}
    />
  );
});
