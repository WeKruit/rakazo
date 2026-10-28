import { fetchSafeWebBytes } from "./web-ssrf.js";

/** Small enough to keep inline in a saved row, sharp enough for a 56 px avatar on a 2x screen. */
export const PROFILE_PHOTO_SIZE = 96;
const MAX_SOURCE_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 2_500;
const CONCURRENCY = 8;

/** Only a person's own uploaded LinkedIn photo; the generic silhouette lives on another host. */
export function linkedinPhotoUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "media.licdn.com" &&
      !url.port &&
      url.pathname.startsWith("/dms/image/") &&
      /profile-displayphoto/.test(url.pathname)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export async function encodeProfilePhoto(bytes: Uint8Array): Promise<string> {
  const { default: sharp } = await import("sharp");
  const webp = await sharp(bytes, { limitInputPixels: 4096 * 4096, animated: false })
    .rotate()
    .resize(PROFILE_PHOTO_SIZE, PROFILE_PHOTO_SIZE, { fit: "cover", position: "centre" })
    .webp({ quality: 70 })
    .toBuffer();
  return `data:image/webp;base64,${webp.toString("base64")}`;
}

type PhotoFetch = (url: string) => Promise<Uint8Array>;

const fetchPhoto: PhotoFetch = async (url) =>
  (
    await fetchSafeWebBytes(url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_SOURCE_BYTES,
      headers: { accept: "image/*" },
    })
  ).body;

/**
 * Replace each row's photo link with our own small copy, so the page never loads the image from
 * the source site. A photo that cannot be fetched or decoded is dropped; the save carries on.
 */
export async function inlineProfilePhotos(
  rows: Array<{ profile_image_url?: string }>,
  fetch: PhotoFetch = fetchPhoto,
): Promise<number> {
  const pending = rows.filter((row) => row.profile_image_url !== undefined);
  let saved = 0;
  for (let start = 0; start < pending.length; start += CONCURRENCY)
    await Promise.all(
      pending.slice(start, start + CONCURRENCY).map(async (row) => {
        const url = linkedinPhotoUrl(row.profile_image_url);
        delete row.profile_image_url;
        if (!url) return;
        try {
          row.profile_image_url = await encodeProfilePhoto(await fetch(url));
          saved += 1;
        } catch {
          // Initials show instead.
        }
      }),
    );
  return saved;
}
