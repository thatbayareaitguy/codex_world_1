import { validateSoundCloudUrl } from "./soundcloud-links";

export interface ProviderUrlValidationResult {
  normalizedUrl?: string;
  reason?: string;
  valid: boolean;
}

const spotifyId = /^[A-Za-z0-9]{22}$/;
const mbid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateProviderEvidenceUrl(
  provider: string,
  value: string,
): ProviderUrlValidationResult {
  const parsed = parseSafeHttpsUrl(value);
  if (!parsed.url) return invalid(parsed.reason ?? "Evidence URL is invalid");
  const url = parsed.url;

  if (provider === "spotify") return validateSpotifyUrl(url);
  if (provider === "musicbrainz") return validateMusicBrainzUrl(url);
  if (provider === "reddit") return validateRedditUrl(url);
  if (provider === "soundcloud") {
    const soundcloud = validateSoundCloudUrl(url.toString(), "track");
    return soundcloud.valid && soundcloud.normalizedUrl
      ? { normalizedUrl: soundcloud.normalizedUrl, valid: true }
      : invalid(soundcloud.error ?? "SoundCloud evidence URL is invalid");
  }
  if (provider === "mock") return validateGenericEvidenceUrl(url);
  return invalid("Provider evidence links are not supported");
}

export function safeProviderEvidenceUrl(provider: string, value: string): string | null {
  const result = validateProviderEvidenceUrl(provider, value);
  return result.valid ? (result.normalizedUrl ?? null) : null;
}

function validateSpotifyUrl(url: URL): ProviderUrlValidationResult {
  if (url.hostname !== "open.spotify.com") return invalid("Spotify evidence host is not allowed");
  if (url.hash) return invalid("Spotify evidence fragments are not allowed");
  const segments = pathSegments(url);
  if (
    segments.length !== 2 ||
    !["artist", "album", "track"].includes(segments[0]!) ||
    !spotifyId.test(segments[1]!)
  ) {
    return invalid("Spotify evidence path or identifier is malformed");
  }
  return valid(url);
}

function validateMusicBrainzUrl(url: URL): ProviderUrlValidationResult {
  if (url.hostname !== "musicbrainz.org") {
    return invalid("MusicBrainz evidence host is not allowed");
  }
  if (url.search || url.hash) return invalid("MusicBrainz evidence query data is not allowed");
  const segments = pathSegments(url);
  if (
    segments.length !== 2 ||
    !["artist", "release", "release-group", "recording"].includes(segments[0]!) ||
    !mbid.test(segments[1]!)
  ) {
    return invalid("MusicBrainz evidence path or MBID is malformed");
  }
  return valid(url);
}

function validateRedditUrl(url: URL): ProviderUrlValidationResult {
  const redditHosts = new Set(["reddit.com", "www.reddit.com", "old.reddit.com", "redd.it"]);
  if (!redditHosts.has(url.hostname)) return invalid("Reddit evidence host is not allowed");
  const segments = pathSegments(url);
  const isShortLink = url.hostname === "redd.it" && segments.length === 1;
  const commentsIndex = segments.indexOf("comments");
  const isCommentsLink = commentsIndex >= 0 && Boolean(segments[commentsIndex + 1]);
  if (!isShortLink && !isCommentsLink) return invalid("Reddit evidence path is not supported");
  return valid(url);
}

function validateGenericEvidenceUrl(url: URL): ProviderUrlValidationResult {
  if (!url.hostname.includes(".") || isLocalOrIpHost(url.hostname)) {
    return invalid("Generic evidence must use a public hostname");
  }
  return valid(url);
}

function parseSafeHttpsUrl(value: string): { reason?: string; url?: URL } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { reason: "Evidence URL is malformed" };
  }
  if (url.protocol !== "https:") return { reason: "Evidence URL must use HTTPS" };
  if (url.username || url.password) return { reason: "Evidence URL credentials are not allowed" };
  if (url.port) return { reason: "Evidence URL ports are not allowed" };
  if (isLocalOrIpHost(url.hostname))
    return { reason: "Local and IP evidence hosts are not allowed" };
  return { url };
}

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

function isLocalOrIpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) ||
    normalized.includes(":")
  );
}

function valid(url: URL): ProviderUrlValidationResult {
  return { normalizedUrl: url.toString(), valid: true };
}

function invalid(reason: string): ProviderUrlValidationResult {
  return { reason, valid: false };
}
