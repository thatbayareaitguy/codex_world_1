import { normalizeText } from "@radar/core";
import type { AppleMusicAlbum, AppleMusicSong } from "@radar/providers";
import type {
  ItunesPilotGroundTruthRelease,
  ItunesPilotSnapshot,
  ItunesPilotSnapshotArtist,
} from "./itunes-pilot-snapshot";

export const appleMusicRecentConfirmation = "APPLE_RECENT_MVP_SAMPLE";
export const appleMusicRecentEvaluationTime = "2026-07-29T23:59:59Z";
export const appleMusicRecentSample = [
  "NURKO",
  "G-Space",
  "BUNT.",
  "SampliFire",
  "Vibe Chemistry",
  "BARELY ALIVE",
  "Habstrakt",
  "MUST DIE!",
  "1788-L",
  "3LAU",
] as const;

export type AppleMusicRecentClassification =
  | "primary_single"
  | "primary_ep"
  | "primary_album"
  | "remix_by_watched_artist"
  | "remix_of_watched_artist_by_other"
  | "remix_direction_uncertain"
  | "feature_only"
  | "compilation_only"
  | "live_release"
  | "date_out_of_scope"
  | "date_uncertain"
  | "unsupported";

export type AppleMusicRecentSource =
  | "latest-release"
  | "artist-albums"
  | "singles"
  | "full-albums"
  | "appears-on-albums"
  | "top-songs"
  | "catalog-search-album"
  | "catalog-search-song";

export interface AppleMusicRecentWindow {
  effectiveEnd: Date;
  effectiveStart: Date;
}

export interface AppleMusicRecentCandidate {
  albumId?: string;
  albumTitle: string;
  appleArtistName: string;
  classification: AppleMusicRecentClassification;
  eligible: boolean;
  evidenceStrength: "explicit" | "relationship_confirmed" | "uncertain";
  namedRemixer?: string;
  releaseDate?: string;
  songId?: string;
  songTitle?: string;
  sources: AppleMusicRecentSource[];
  upc?: string;
  watchedArtist: string;
}

export function appleMusicRecentWindow(
  now: Date,
  previousSuccessfulCompletedAt?: Date,
): AppleMusicRecentWindow {
  const maximumStart = new Date(now.getTime() - 30 * 86_400_000);
  const overlapStart = previousSuccessfulCompletedAt
    ? new Date(previousSuccessfulCompletedAt.getTime() - 48 * 3_600_000)
    : maximumStart;
  return {
    effectiveEnd: new Date(now),
    effectiveStart: new Date(Math.max(maximumStart.getTime(), overlapStart.getTime())),
  };
}

export function classifyAppleMusicRecentCandidate(input: {
  aliases: string[];
  album?: AppleMusicAlbum;
  confirmedArtistAssociation: boolean;
  song?: AppleMusicSong;
  source: AppleMusicRecentSource;
  watchedArtist: string;
  window: AppleMusicRecentWindow;
}): AppleMusicRecentCandidate {
  const title = input.song?.title ?? input.album?.title ?? "";
  const albumTitle = input.album?.title ?? input.song?.albumName ?? input.song?.title ?? "";
  const releaseDate = input.song?.releaseDate ?? input.album?.releaseDate;
  const artistName = input.song?.artistName ?? input.album?.artistName ?? "";
  const base: Omit<AppleMusicRecentCandidate, "classification" | "eligible" | "evidenceStrength"> =
    {
      ...(input.album?.albumId
        ? { albumId: input.album.albumId }
        : input.song?.albumId
          ? { albumId: input.song.albumId }
          : {}),
      albumTitle,
      appleArtistName: artistName,
      ...(releaseDate ? { releaseDate } : {}),
      ...(input.song?.songId ? { songId: input.song.songId, songTitle: input.song.title } : {}),
      sources: [input.source],
      ...(input.album?.upc ? { upc: input.album.upc } : {}),
      watchedArtist: input.watchedArtist,
    };
  if (!releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    return rejected(base, "date_uncertain");
  }
  const timestamp = Date.parse(`${releaseDate}T00:00:00Z`);
  if (
    !Number.isFinite(timestamp) ||
    timestamp < input.window.effectiveStart.getTime() ||
    timestamp > input.window.effectiveEnd.getTime()
  ) {
    return rejected(base, "date_out_of_scope");
  }
  if (input.album?.isCompilation) return rejected(base, "compilation_only");
  if (/\b(?:live|in concert)\b/iu.test(normalizeText(albumTitle))) {
    return rejected(base, "live_release");
  }

  const eligibleNames = [input.watchedArtist, ...input.aliases];
  const remixEvidence = [title, albumTitle]
    .map(extractNamedRemixer)
    .find((value): value is string => Boolean(value));
  const hasGenericRemix = /\bremix(?:es)?\b/iu.test(`${title} ${albumTitle}`);
  const watchedIsNamedRemixer =
    remixEvidence !== undefined && eligibleNames.some((name) => sameArtist(remixEvidence, name));
  const watchedAssociated =
    input.confirmedArtistAssociation || containsArtistName(artistName, eligibleNames);

  if (watchedIsNamedRemixer) {
    return {
      ...base,
      classification: "remix_by_watched_artist",
      eligible: true,
      evidenceStrength: "explicit",
      namedRemixer: remixEvidence,
    };
  }
  if (remixEvidence && watchedAssociated) {
    return {
      ...base,
      classification: "remix_of_watched_artist_by_other",
      eligible: true,
      evidenceStrength: "explicit",
      namedRemixer: remixEvidence,
    };
  }
  if (hasGenericRemix) {
    return {
      ...base,
      classification: "remix_direction_uncertain",
      eligible: false,
      evidenceStrength: "uncertain",
      ...(remixEvidence ? { namedRemixer: remixEvidence } : {}),
    };
  }
  if (!watchedAssociated) return rejected(base, "feature_only");
  if (input.song && !input.album) {
    if (input.source !== "top-songs") return rejected(base, "unsupported");
    const classification = classifySongRelease(input.song);
    if (!classification) return rejected(base, "unsupported");
    return {
      ...base,
      classification,
      eligible: true,
      evidenceStrength: "relationship_confirmed",
    };
  }

  const classification = classifyOrdinaryRelease(input.album);
  if (!classification) return rejected(base, "unsupported");
  return {
    ...base,
    classification,
    eligible: true,
    evidenceStrength: "relationship_confirmed",
  };
}

function classifySongRelease(song: AppleMusicSong): "primary_single" | "primary_ep" | undefined {
  const albumName = song.albumName?.normalize("NFKC") ?? "";
  if (/(?:^|\s|[-([])single(?:$|\s|[\])])/iu.test(albumName)) return "primary_single";
  if (/(?:^|\s|[-([])ep(?:$|\s|[\])])/iu.test(albumName)) return "primary_ep";
  return undefined;
}

export function mergeAppleMusicRecentCandidates(
  candidates: AppleMusicRecentCandidate[],
): AppleMusicRecentCandidate[] {
  const merged = new Map<string, AppleMusicRecentCandidate>();
  for (const candidate of candidates) {
    const key =
      candidate.albumId ??
      candidate.songId ??
      [
        normalizeText(candidate.appleArtistName),
        normalizeText(candidate.albumTitle),
        candidate.releaseDate ?? "",
      ].join(":");
    const current = merged.get(key);
    if (!current) {
      merged.set(key, candidate);
      continue;
    }
    merged.set(key, {
      ...current,
      ...candidate,
      sources: [...new Set([...current.sources, ...candidate.sources])].sort(),
    });
  }
  return [...merged.values()].sort(
    (left, right) =>
      (right.releaseDate ?? "").localeCompare(left.releaseDate ?? "") ||
      left.albumTitle.localeCompare(right.albumTitle),
  );
}

export function scopedAppleMusicRecentGroundTruth(
  snapshot: ItunesPilotSnapshot,
  artist: ItunesPilotSnapshotArtist,
  evaluationEnd: Date,
): ItunesPilotGroundTruthRelease[] {
  const window = appleMusicRecentWindow(evaluationEnd);
  return snapshot.groundTruthReleases.filter((release) => {
    if (release.canonicalArtistId !== artist.canonicalArtistId) return false;
    const timestamp = Date.parse(`${release.releaseDate}T00:00:00Z`);
    if (
      !Number.isFinite(timestamp) ||
      timestamp < window.effectiveStart.getTime() ||
      timestamp > evaluationEnd.getTime()
    ) {
      return false;
    }
    if (["single", "ep", "album"].includes(release.releaseType)) return true;
    if (!["feature", "remix"].includes(release.releaseType)) return false;
    return Boolean(extractNamedRemixer(release.title));
  });
}

export function extractNamedRemixer(value: string): string | undefined {
  const normalized = value.normalize("NFKC");
  const bracketed = /(?:\(|\[)\s*([^()[\]]+?)\s+remix\s*(?:\)|\])/iu.exec(normalized)?.[1];
  if (bracketed && !/^the$/iu.test(bracketed.trim())) return bracketed.trim();
  const dashed = /-\s*([^()[\]-]+?)\s+remix\s*$/iu.exec(normalized)?.[1];
  if (dashed) return dashed.trim();
  const by = /\bremix\s+by\s+([^()[\],-]+)\s*$/iu.exec(normalized)?.[1];
  return by?.trim();
}

function classifyOrdinaryRelease(
  album: AppleMusicAlbum | undefined,
): "primary_single" | "primary_ep" | "primary_album" | undefined {
  if (!album) return undefined;
  const title = album.title.normalize("NFKC");
  if (album.isSingle || /(?:^|\s|[-([])single(?:$|\s|[\])])/iu.test(title)) {
    return "primary_single";
  }
  if (/(?:^|\s|[-([])ep(?:$|\s|[\])])/iu.test(title)) return "primary_ep";
  return album.title.trim() ? "primary_album" : undefined;
}

function containsArtistName(value: string, names: string[]): boolean {
  const normalized = artistComparable(value);
  return names.some((name) => {
    const candidate = artistComparable(name);
    return (
      normalized === candidate ||
      normalized.startsWith(`${candidate} and `) ||
      normalized.endsWith(` and ${candidate}`) ||
      normalized.includes(` and ${candidate} and `)
    );
  });
}

function sameArtist(left: string, right: string): boolean {
  return artistComparable(left) === artistComparable(right);
}

function artistComparable(value: string): string {
  return normalizeText(value.normalize("NFKC"))
    .replace(/\b(?:feat|featuring|with|x)\b/gu, " and ")
    .replace(/[&,/+]+/gu, " and ")
    .replace(/\s+/gu, " ")
    .trim();
}

function rejected(
  base: Omit<AppleMusicRecentCandidate, "classification" | "eligible" | "evidenceStrength">,
  classification: AppleMusicRecentClassification,
): AppleMusicRecentCandidate {
  return { ...base, classification, eligible: false, evidenceStrength: "uncertain" };
}
