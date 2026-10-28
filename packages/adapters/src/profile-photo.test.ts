import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  encodeProfilePhoto,
  inlineProfilePhotos,
  linkedinPhotoUrl,
  PROFILE_PHOTO_MAX_LENGTH,
} from "./profile-photo.js";

const PHOTO = "https://media.licdn.com/dms/image/v2/A/profile-displayphoto-shrink_200_200/0/1?e=1";

describe("profile photos", () => {
  it("accepts only a person's own LinkedIn photo", () => {
    expect(linkedinPhotoUrl(PHOTO)).toBe(PHOTO);
    expect(linkedinPhotoUrl("https://static.licdn.com/aero-v1/sc/h/placeholder")).toBeUndefined();
    expect(
      linkedinPhotoUrl("https://media.licdn.com/dms/image/v2/A/company-logo_200_200/0/1"),
    ).toBeUndefined();
    expect(
      linkedinPhotoUrl("http://media.licdn.com/dms/image/v2/A/profile-displayphoto/0/1"),
    ).toBeUndefined();
    expect(linkedinPhotoUrl(42)).toBeUndefined();
  });

  it("shrinks a busy photo until it fits a saved profile", async () => {
    const noise = Buffer.from(Array.from({ length: 200 * 200 * 3 }, (_, i) => (i * 7919) % 251));
    const png = await sharp(noise, { raw: { width: 200, height: 200, channels: 3 } })
      .png()
      .toBuffer();
    const url = await encodeProfilePhoto(png);
    expect(url.length).toBeLessThanOrEqual(PROFILE_PHOTO_MAX_LENGTH);
  });

  it("keeps our own small copy and drops photos it cannot use", async () => {
    const png = await sharp({
      create: { width: 200, height: 200, channels: 3, background: "#888888" },
    })
      .png()
      .toBuffer();
    const rows: Array<{ name: string; profile_image_url?: string }> = [
      { name: "a", profile_image_url: PHOTO },
      { name: "b", profile_image_url: `${PHOTO}&broken` },
      { name: "c", profile_image_url: "https://example.test/x.png" },
      { name: "d" },
    ];
    const fetched: string[] = [];
    const saved = await inlineProfilePhotos(rows, async (url) => {
      fetched.push(url);
      if (url.includes("broken")) throw new Error("gone");
      return png;
    });
    expect(saved).toBe(1);
    expect(fetched).toEqual([PHOTO, `${PHOTO}&broken`]);
    expect(rows[0]!.profile_image_url).toMatch(/^data:image\/webp;base64,/);
    const meta = await sharp(
      Buffer.from(rows[0]!.profile_image_url!.split(",")[1]!, "base64"),
    ).metadata();
    expect([meta.width, meta.height]).toEqual([96, 96]);
    expect(rows.slice(1).map((row) => "profile_image_url" in row)).toEqual([false, false, false]);
  });
});
