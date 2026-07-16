const SOUNDCLOUD_ROOT = "soundcloud.com";

export type SoundCloudUrlKind = "profile" | "track";

export interface UrlValidationResult {
  error?: string;
  normalizedUrl?: string;
  valid: boolean;
}

export function validateSoundCloudUrl(value: string, kind: SoundCloudUrlKind): UrlValidationResult {
  const trimmed = value.trim();
  if (!trimmed) return { valid: false, error: "Enter a SoundCloud URL." };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { valid: false, error: "Enter a valid absolute URL." };
  }

  const hostname = url.hostname.toLocaleLowerCase("en-US");
  if (url.protocol !== "https:") {
    return { valid: false, error: "SoundCloud links must use HTTPS." };
  }
  if (hostname !== SOUNDCLOUD_ROOT && !hostname.endsWith(`.${SOUNDCLOUD_ROOT}`)) {
    return { valid: false, error: "Only SoundCloud domains are allowed." };
  }
  if (url.username || url.password) {
    return { valid: false, error: "SoundCloud links cannot contain credentials." };
  }

  const pathSegments = url.pathname.split("/").filter(Boolean);
  if (kind === "profile" && pathSegments.length !== 1) {
    return { valid: false, error: "Enter a SoundCloud artist profile URL." };
  }
  if (
    kind === "track" &&
    (pathSegments.length < 2 || pathSegments[0]?.toLocaleLowerCase("en-US") === "search")
  ) {
    return { valid: false, error: "Enter an exact SoundCloud track URL." };
  }

  url.hash = "";
  return { valid: true, normalizedUrl: url.toString() };
}

export function buildSoundCloudSearchUrl(input: {
  artist: string;
  featuredArtists?: string[];
  title: string;
  version?: string;
}): string {
  const query = [input.artist, ...(input.featuredArtists ?? []), input.title, input.version]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" ");
  const url = new URL("https://soundcloud.com/search/sounds");
  url.searchParams.set("q", query);
  return url.toString();
}
