import type { AppleMusicReleaseArtwork } from "./types";

const appleArtworkHosts = [
  "is1-ssl.mzstatic.com",
  "is2-ssl.mzstatic.com",
  "is3-ssl.mzstatic.com",
  "is4-ssl.mzstatic.com",
  "is5-ssl.mzstatic.com",
];

export function normalizeAppleMusicAlbumUrl(value: string, albumId: string): string | null {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "music.apple.com" ||
      url.username ||
      url.password ||
      url.port ||
      !/^[a-z]{2}$/i.test(segments[0] ?? "") ||
      segments[1] !== "album" ||
      !segments.includes(albumId)
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeAppleMusicArtworkUrl(
  value: string,
  width = 300,
  height = 300,
): string | null {
  try {
    const expanded = value.replaceAll("{w}", String(width)).replaceAll("{h}", String(height));
    const url = new URL(expanded);
    if (
      url.protocol !== "https:" ||
      !appleArtworkHosts.includes(url.hostname.toLowerCase()) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function parseAppleMusicReleaseArtwork(value: unknown): AppleMusicReleaseArtwork | null {
  if (!isRecord(value) || value.sourceProvider !== "apple_music") return null;
  if (typeof value.albumId !== "string" || typeof value.albumUrl !== "string") return null;
  if (!isRecord(value.image)) return null;
  if (
    typeof value.image.url !== "string" ||
    typeof value.image.width !== "number" ||
    typeof value.image.height !== "number" ||
    typeof value.lastObservedAt !== "string"
  ) {
    return null;
  }
  const albumUrl = normalizeAppleMusicAlbumUrl(value.albumUrl, value.albumId);
  const imageUrl = normalizeAppleMusicArtworkUrl(
    value.image.url,
    value.image.width,
    value.image.height,
  );
  if (!albumUrl || !imageUrl || Number.isNaN(Date.parse(value.lastObservedAt))) return null;
  return {
    albumId: value.albumId,
    albumUrl,
    image: {
      height: value.image.height,
      url: imageUrl,
      width: value.image.width,
    },
    lastObservedAt: new Date(value.lastObservedAt).toISOString(),
    sourceProvider: "apple_music",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
