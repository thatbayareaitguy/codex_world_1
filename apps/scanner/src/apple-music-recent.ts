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
  comparisonTitle: string;
  contentRating?: "clean" | "explicit";
  eligible: boolean;
  evidenceStrength: "explicit" | "relationship_confirmed" | "uncertain";
  granularity: "album" | "album_and_song" | "song";
  isrc?: string;
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
  const contentRating = input.song?.contentRating ?? input.album?.contentRating;
  const base: Omit<AppleMusicRecentCandidate, "classification" | "eligible" | "evidenceStrength"> =
    {
      ...(input.album?.albumId
        ? { albumId: input.album.albumId }
        : input.song?.albumId
          ? { albumId: input.song.albumId }
          : {}),
      albumTitle,
      appleArtistName: artistName,
      comparisonTitle: title,
      ...(contentRating ? { contentRating } : {}),
      granularity: input.song ? ("song" as const) : ("album" as const),
      ...(input.song?.isrc ? { isrc: input.song.isrc } : {}),
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
  if (/\b(?:live|in concert)\b/iu.test(normalizeText(`${title} ${albumTitle}`))) {
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
  const merged: AppleMusicRecentCandidate[] = [];
  for (const candidate of candidates) {
    const index = merged.findIndex((current) => sameCandidateIdentity(current, candidate));
    if (index < 0) {
      merged.push(candidate);
      continue;
    }
    merged[index] = mergeCandidateEvidence(merged[index]!, candidate);
  }
  return merged.sort(
    (left, right) =>
      (right.releaseDate ?? "").localeCompare(left.releaseDate ?? "") ||
      left.comparisonTitle.localeCompare(right.comparisonTitle),
  );
}

export function compareAppleMusicRecentCandidate(
  candidate: AppleMusicRecentCandidate,
  groundTruth: ItunesPilotGroundTruthRelease[],
):
  | "ambiguous_match"
  | "apple_only_candidate"
  | "exact_match"
  | "excluded"
  | "strong_probable_match" {
  if (!candidate.eligible) return "excluded";
  const candidateTitle = comparableReleaseTitle(
    candidate.comparisonTitle,
    candidateReleaseKind(candidate),
  );
  const sameTitle = groundTruth.filter((release) =>
    releaseComparisonTitles(candidate, release).some(
      (title) =>
        comparableReleaseTitle(
          title,
          release.releaseType === "ep"
            ? "ep"
            : release.releaseType === "single"
              ? "single"
              : undefined,
        ) === candidateTitle,
    ),
  );
  const compatible = sameTitle.filter((release) => releaseDirectionCompatible(candidate, release));
  if (compatible.some((release) => release.releaseDate === candidate.releaseDate)) {
    return "exact_match";
  }
  if (
    compatible.some(
      (release) =>
        candidate.releaseDate &&
        Math.abs(Date.parse(release.releaseDate) - Date.parse(candidate.releaseDate)) <= 86_400_000,
    )
  ) {
    return "strong_probable_match";
  }
  return compatible.length > 0 ? "ambiguous_match" : "apple_only_candidate";
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

function sameCandidateIdentity(
  left: AppleMusicRecentCandidate,
  right: AppleMusicRecentCandidate,
): boolean {
  if (!variantCompatible(left, right)) return false;
  const leftHasSong = left.granularity !== "album";
  const rightHasSong = right.granularity !== "album";
  if (left.songId && right.songId && left.songId === right.songId) return true;
  if (
    left.isrc &&
    right.isrc &&
    left.isrc === right.isrc &&
    left.releaseDate !== undefined &&
    left.releaseDate === right.releaseDate
  ) {
    return true;
  }
  if (left.upc && right.upc && left.upc === right.upc) return true;
  if (
    left.albumId &&
    right.albumId &&
    left.albumId === right.albumId &&
    (!leftHasSong || !rightHasSong)
  ) {
    return true;
  }
  return (
    left.releaseDate !== undefined &&
    left.releaseDate === right.releaseDate &&
    artistComparable(left.appleArtistName) === artistComparable(right.appleArtistName) &&
    comparableReleaseTitle(left.comparisonTitle, candidateReleaseKind(left)) ===
      comparableReleaseTitle(right.comparisonTitle, candidateReleaseKind(right))
  );
}

function mergeCandidateEvidence(
  left: AppleMusicRecentCandidate,
  right: AppleMusicRecentCandidate,
): AppleMusicRecentCandidate {
  const song =
    left.granularity === "song" ? left : right.granularity === "song" ? right : undefined;
  const preferred =
    [left, right].find((candidate) => candidate.eligible) ??
    [left, right].find((candidate) => candidate.evidenceStrength === "explicit") ??
    left;
  return {
    ...left,
    ...right,
    ...preferred,
    ...(left.albumId || right.albumId ? { albumId: left.albumId ?? right.albumId } : {}),
    albumTitle: song?.albumTitle ?? preferred.albumTitle,
    comparisonTitle: song?.comparisonTitle ?? preferred.comparisonTitle,
    ...(left.contentRating || right.contentRating
      ? { contentRating: left.contentRating ?? right.contentRating }
      : {}),
    granularity: left.granularity === right.granularity ? left.granularity : "album_and_song",
    ...(left.isrc || right.isrc ? { isrc: left.isrc ?? right.isrc } : {}),
    ...(left.songId || right.songId ? { songId: left.songId ?? right.songId } : {}),
    ...(left.songTitle || right.songTitle ? { songTitle: left.songTitle ?? right.songTitle } : {}),
    sources: [...new Set([...left.sources, ...right.sources])].sort(),
    ...(left.upc || right.upc ? { upc: left.upc ?? right.upc } : {}),
  };
}

function variantCompatible(
  left: AppleMusicRecentCandidate,
  right: AppleMusicRecentCandidate,
): boolean {
  if (left.contentRating && right.contentRating && left.contentRating !== right.contentRating) {
    return false;
  }
  const leftRemixer = left.namedRemixer ? artistComparable(left.namedRemixer) : undefined;
  const rightRemixer = right.namedRemixer ? artistComparable(right.namedRemixer) : undefined;
  if (leftRemixer && rightRemixer && leftRemixer !== rightRemixer) return false;
  if (isRemixClassification(left.classification) !== isRemixClassification(right.classification)) {
    return false;
  }
  return versionMarkers(left.comparisonTitle) === versionMarkers(right.comparisonTitle);
}

function releaseComparisonTitles(
  candidate: AppleMusicRecentCandidate,
  release: ItunesPilotGroundTruthRelease,
): string[] {
  if (candidate.granularity === "album") return [release.title];
  if (!["single", "ep", "feature", "remix"].includes(release.releaseType)) return [];
  return [release.title, ...release.tracks.map((track) => track.title)];
}

function releaseDirectionCompatible(
  candidate: AppleMusicRecentCandidate,
  release: ItunesPilotGroundTruthRelease,
): boolean {
  const candidateIsRemix = isRemixClassification(candidate.classification);
  const releaseRemixer = extractNamedRemixer(release.title);
  if (candidateIsRemix !== Boolean(releaseRemixer)) return false;
  if (!candidateIsRemix) return true;
  return Boolean(
    candidate.namedRemixer && releaseRemixer && sameArtist(candidate.namedRemixer, releaseRemixer),
  );
}

function isRemixClassification(classification: AppleMusicRecentClassification): boolean {
  return [
    "remix_by_watched_artist",
    "remix_of_watched_artist_by_other",
    "remix_direction_uncertain",
  ].includes(classification);
}

export function normalizeAppleMusicReleaseComparisonTitle(
  value: string,
  releaseKind?: "ep" | "single",
): string {
  const normalized = normalizeText(value)
    .replace(/\b(?:ft|feat|featuring)\b/gu, "feat")
    .replace(/\s+/gu, " ")
    .trim();
  if (releaseKind === "ep") return normalized.replace(/\s+ep$/u, "").trim();
  return normalized.replace(/\s+single$/u, "").trim();
}

function comparableReleaseTitle(value: string, releaseKind?: "ep" | "single"): string {
  return normalizeAppleMusicReleaseComparisonTitle(value, releaseKind);
}

function candidateReleaseKind(candidate: AppleMusicRecentCandidate): "ep" | "single" | undefined {
  if (candidate.classification === "primary_ep") return "ep";
  if (candidate.classification === "primary_single") return "single";
  return undefined;
}

function versionMarkers(value: string): string {
  return [
    /\bremix(?:es)?\b/iu.test(value) ? "remix" : "original",
    /\b(?:live|in concert)\b/iu.test(value) ? "live" : "studio",
  ].join(":");
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
