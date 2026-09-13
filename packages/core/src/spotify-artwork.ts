import type { SpotifyArtworkImage, SpotifyReleaseArtwork } from "./types";

export const spotifyArtworkHosts = ["i.scdn.co"] as const;

export function normalizeSpotifyArtworkUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !spotifyArtworkHosts.some((host) => host === url.hostname.toLowerCase()) ||
      !/^\/image\/[A-Za-z0-9]+$/.test(url.pathname)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeSpotifyAlbumUrl(value: string, albumId: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "open.spotify.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== `/album/${encodeURIComponent(albumId)}`
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function selectClosestSpotifyArtwork(
  images: readonly SpotifyArtworkImage[],
  targetSize = 300,
): SpotifyArtworkImage | undefined {
  return images
    .map((image, index) => ({ image, index, score: artworkDistance(image, targetSize) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)[0]?.image;
}

export function createSpotifyReleaseArtwork(input: {
  albumId: string;
  albumUrl: string;
  images: readonly SpotifyArtworkImage[];
  observedAt: Date;
}): SpotifyReleaseArtwork | null {
  const albumUrl = normalizeSpotifyAlbumUrl(input.albumUrl, input.albumId);
  const image = selectClosestSpotifyArtwork(input.images);
  if (!albumUrl || !image) return null;
  const imageUrl = normalizeSpotifyArtworkUrl(image.url);
  if (!imageUrl) return null;
  return {
    albumId: input.albumId,
    albumUrl,
    image: { ...image, url: imageUrl },
    lastObservedAt: input.observedAt.toISOString(),
    sourceProvider: "spotify",
  };
}

export function parseSpotifyReleaseArtwork(value: unknown): SpotifyReleaseArtwork | null {
  if (!isRecord(value) || value.sourceProvider !== "spotify" || !isRecord(value.image)) return null;
  if (typeof value.albumId !== "string" || value.albumId.length === 0) return null;
  if (typeof value.lastObservedAt !== "string" || !validDate(value.lastObservedAt)) return null;
  if (typeof value.image.url !== "string") return null;
  const albumUrl =
    typeof value.albumUrl === "string"
      ? normalizeSpotifyAlbumUrl(value.albumUrl, value.albumId)
      : null;
  const imageUrl = normalizeSpotifyArtworkUrl(value.image.url);
  const width = nullableDimension(value.image.width);
  const height = nullableDimension(value.image.height);
  if (!albumUrl || !imageUrl || width === undefined || height === undefined) return null;
  return {
    albumId: value.albumId,
    albumUrl,
    image: { height, url: imageUrl, width },
    lastObservedAt: new Date(value.lastObservedAt).toISOString(),
    sourceProvider: "spotify",
  };
}

function artworkDistance(image: SpotifyArtworkImage, targetSize: number): number {
  if (image.width === null || image.height === null) return Number.MAX_SAFE_INTEGER;
  return Math.abs(image.width - targetSize) + Math.abs(image.height - targetSize);
}

function nullableDimension(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function validDate(value: string): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
