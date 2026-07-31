import {
  evaluateItunesReleasePair,
  type ItunesCollectionCandidate,
  type SpotifyGroundTruthRelease,
} from "./itunes-pilot";
import { normalizeText } from "./normalize";

export type AppleMusicMappingStatus =
  | "existing_id_confirmed"
  | "search_confirmed"
  | "evidence_confirmed"
  | "ambiguous"
  | "no_match"
  | "rejected";

export interface AppleMusicArtistCandidate {
  artistId: string;
  evidenceUrl?: string;
  genreNames?: string[];
  name: string;
}

export interface AppleMusicAlbumCandidate {
  albumId: string;
  artistIds: string[];
  artistName: string;
  evidenceUrl?: string;
  isCompilation?: boolean;
  isSingle?: boolean;
  paginationPath: string;
  pageNumber: number;
  releaseDate?: string;
  sourceView:
    | "latest-release"
    | "singles"
    | "full-albums"
    | "live-albums"
    | "compilation-albums"
    | "appears-on-albums"
    | "album";
  title: string;
  trackCount?: number;
  upc?: string;
}

export interface AppleMusicSongCandidate {
  albumId?: string;
  artistIds: string[];
  artistName: string;
  discNumber?: number;
  durationMs?: number;
  evidenceUrl?: string;
  isrc?: string;
  paginationPath: string;
  pageNumber: number;
  releaseDate?: string;
  songId: string;
  title: string;
  trackNumber?: number;
}

export interface AppleMusicMappingEvidence {
  artistId: string;
  conflictingReleaseTitles: string[];
  exactReleaseTitles: string[];
  exactTrackTitles: string[];
  reasons: string[];
  score: number;
}

export interface AppleMusicMappingDecision {
  candidates: AppleMusicArtistCandidate[];
  confidence: number;
  evidence: AppleMusicMappingEvidence[];
  reason: string;
  selected?: AppleMusicArtistCandidate;
  status: AppleMusicMappingStatus;
}

export function decideAppleMusicArtistMapping(input: {
  aliases: string[];
  canonicalName: string;
  existingArtist?: AppleMusicArtistCandidate;
  existingArtistId?: string;
  searchCandidates: AppleMusicArtistCandidate[];
}): AppleMusicMappingDecision {
  const canonical = normalizeArtist(input.canonicalName);
  const aliases = new Set(input.aliases.map(normalizeArtist));
  if (input.existingArtistId && input.existingArtist) {
    if (input.existingArtist.artistId !== input.existingArtistId) {
      return decision(
        "rejected",
        "The resolved catalog artist ID differs from the inherited ID.",
        input.searchCandidates,
      );
    }
    const existingName = normalizeArtist(input.existingArtist.name);
    if (existingName === canonical || aliases.has(existingName)) {
      return {
        candidates: [input.existingArtist, ...input.searchCandidates],
        confidence: 1,
        evidence: [],
        reason: "The inherited iTunes artist ID resolved to a compatible Apple catalog artist.",
        selected: input.existingArtist,
        status: "existing_id_confirmed",
      };
    }
    return decision(
      "rejected",
      "The inherited iTunes artist ID resolved to an incompatible catalog identity.",
      [input.existingArtist, ...input.searchCandidates],
    );
  }

  const exact = input.searchCandidates.filter(
    (candidate) => normalizeArtist(candidate.name) === canonical,
  );
  if (exact.length === 1) {
    return {
      candidates: input.searchCandidates,
      confidence: 1,
      evidence: [],
      reason: "One unique exact normalized artist-name match was found.",
      selected: exact[0]!,
      status: "search_confirmed",
    };
  }
  if (exact.length > 1) {
    return decision(
      "ambiguous",
      "Multiple exact normalized artist-name matches require catalog evidence.",
      input.searchCandidates,
    );
  }

  const aliasMatches = input.searchCandidates.filter((candidate) =>
    aliases.has(normalizeArtist(candidate.name)),
  );
  if (aliasMatches.length === 1) {
    return {
      candidates: input.searchCandidates,
      confidence: 0.95,
      evidence: [],
      reason: "One unique exact stored-alias match was found.",
      selected: aliasMatches[0]!,
      status: "evidence_confirmed",
    };
  }
  if (input.searchCandidates.length === 0) {
    return decision("no_match", "No Apple catalog artist candidate was returned.", []);
  }
  return decision(
    "ambiguous",
    "Search candidates did not provide a unique exact name or alias match.",
    input.searchCandidates,
  );
}

export function resolveAppleMusicArtistFromCatalogEvidence(input: {
  aliases: string[];
  candidateCatalogs: Array<{
    albums: AppleMusicAlbumCandidate[];
    artist: AppleMusicArtistCandidate;
    songs: AppleMusicSongCandidate[];
  }>;
  canonicalName: string;
  groundTruth: SpotifyGroundTruthRelease[];
}): AppleMusicMappingDecision {
  const eligibleNames = new Set([
    normalizeArtist(input.canonicalName),
    ...input.aliases.map(normalizeArtist),
  ]);
  const evidence = input.candidateCatalogs.map((catalog) =>
    catalogEvidence(catalog.artist.artistId, catalog.albums, catalog.songs, input.groundTruth),
  );
  const ranked = input.candidateCatalogs
    .map((catalog, index) => ({ catalog, evidence: evidence[index]! }))
    .filter(({ catalog }) => eligibleNames.has(normalizeArtist(catalog.artist.name)))
    .sort(
      (left, right) =>
        right.evidence.score - left.evidence.score ||
        left.catalog.artist.artistId.localeCompare(right.catalog.artist.artistId),
    );
  const strongest = ranked[0];
  const second = ranked[1];
  if (
    strongest &&
    strongest.evidence.score >= 3 &&
    strongest.evidence.conflictingReleaseTitles.length === 0 &&
    (!second || strongest.evidence.score - second.evidence.score >= 2)
  ) {
    return {
      candidates: input.candidateCatalogs.map((catalog) => catalog.artist),
      confidence: 0.9,
      evidence,
      reason: "One compatible same-name candidate has uniquely strong catalog overlap.",
      selected: strongest.catalog.artist,
      status: "evidence_confirmed",
    };
  }
  return {
    candidates: input.candidateCatalogs.map((catalog) => catalog.artist),
    confidence: 0,
    evidence,
    reason:
      input.candidateCatalogs.length === 0
        ? "No Apple catalog evidence was available."
        : "Catalog evidence did not uniquely identify one compatible artist.",
    status: input.candidateCatalogs.length === 0 ? "no_match" : "ambiguous",
  };
}

export function selectAppleMusicCatalogEvidenceCandidates(input: {
  aliases: string[];
  candidates: AppleMusicArtistCandidate[];
  canonicalName: string;
  maximumCandidates?: number;
}): AppleMusicArtistCandidate[] {
  const eligibleNames = new Set([
    normalizeArtist(input.canonicalName),
    ...input.aliases.map(normalizeArtist),
  ]);
  const maximumCandidates = input.maximumCandidates ?? 2;
  if (!Number.isInteger(maximumCandidates) || maximumCandidates < 1) {
    throw new Error("Apple catalog-evidence candidate limit must be a positive integer.");
  }
  return input.candidates
    .filter((candidate) => eligibleNames.has(normalizeArtist(candidate.name)))
    .slice(0, maximumCandidates);
}

export function compareAppleMusicToGroundTruth(
  groundTruth: SpotifyGroundTruthRelease[],
  albums: AppleMusicAlbumCandidate[],
): AppleMusicReleaseComparison[] {
  const results: AppleMusicReleaseComparison[] = [];
  for (const spotify of groundTruth) {
    const evaluations = albums
      .filter((album) => album.releaseDate)
      .map((album) => evaluateItunesReleasePair(spotify, appleAlbumAsItunesCollection(album)))
      .filter((evaluation) => evaluation !== undefined)
      .sort(
        (left, right) => comparisonRank(right.classification) - comparisonRank(left.classification),
      );
    const best = evaluations[0];
    results.push(
      best
        ? { spotifyReleaseId: spotify.spotifyReleaseId, ...best }
        : {
            classification: "spotify_ground_truth_missed_by_apple_music",
            reasons: ["No compatible Apple Music catalog album was available for comparison."],
            spotifyReleaseId: spotify.spotifyReleaseId,
          },
    );
  }
  return results;
}

export interface AppleMusicReleaseComparison {
  apple?: ItunesCollectionCandidate;
  classification:
    | "exact_match"
    | "strong_probable_match"
    | "ambiguous_match"
    | "invalid_match"
    | "spotify_ground_truth_missed_by_apple_music";
  dateDifferenceDays?: number;
  reasons: string[];
  spotifyReleaseId: string;
  trackCountAgreement?: boolean;
}

export function appleMusicCandidateInWindow(
  releaseDate: string,
  snapshotTimestamp: string,
  days: 7 | 14 | 30 | 60,
): boolean {
  const release = Date.parse(`${releaseDate.slice(0, 10)}T00:00:00Z`);
  const snapshot = Date.parse(`${snapshotTimestamp.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(release) || !Number.isFinite(snapshot)) return false;
  const start = snapshot - (days - 1) * 86_400_000;
  return release >= start && release <= snapshot;
}

export function compareAppleViewCompleteness(input: {
  batchAlbums: AppleMusicAlbumCandidate[];
  directAlbums: AppleMusicAlbumCandidate[];
}): { missingFromBatch: string[]; missingFromDirect: string[]; safe: boolean } {
  const batch = new Set(input.batchAlbums.map((album) => album.albumId));
  const direct = new Set(input.directAlbums.map((album) => album.albumId));
  const missingFromBatch = [...direct].filter((id) => !batch.has(id)).sort();
  const missingFromDirect = [...batch].filter((id) => !direct.has(id)).sort();
  return {
    missingFromBatch,
    missingFromDirect,
    safe: missingFromBatch.length === 0 && missingFromDirect.length === 0,
  };
}

export function classifyAppleMusicAlbum(album: AppleMusicAlbumCandidate): string {
  const title = normalizeText(album.title);
  if (album.sourceView === "appears-on-albums") return "feature";
  if (album.sourceView === "live-albums" || /\blive\b/.test(title)) return "live";
  if (album.sourceView === "compilation-albums" || album.isCompilation) return "compilation";
  if (/\bremix(?:es)?\b/.test(title)) return "remix";
  if (album.sourceView === "singles" || album.isSingle || (album.trackCount ?? 0) <= 3)
    return "single";
  if ((album.trackCount ?? 0) <= 6 || /\bep\b/.test(title)) return "ep";
  return "album";
}

function catalogEvidence(
  artistId: string,
  albums: AppleMusicAlbumCandidate[],
  songs: AppleMusicSongCandidate[],
  groundTruth: SpotifyGroundTruthRelease[],
): AppleMusicMappingEvidence {
  const releaseTitles = new Set(albums.map((album) => normalizeText(album.title)));
  const trackTitles = new Set(songs.map((song) => normalizeText(song.title)));
  const exactReleaseTitles = groundTruth
    .filter((release) => releaseTitles.has(normalizeText(release.title)))
    .map((release) => release.title);
  const exactTrackTitles = groundTruth
    .flatMap((release) => release.tracks ?? [])
    .filter((track) => trackTitles.has(normalizeText(track.title)))
    .map((track) => track.title);
  const conflictingReleaseTitles = groundTruth
    .filter((release) =>
      albums.some((album) => {
        if (!album.releaseDate || normalizeText(album.title) !== normalizeText(release.title))
          return false;
        return (
          Math.abs(Date.parse(album.releaseDate) - Date.parse(release.releaseDate)) >
          30 * 86_400_000
        );
      }),
    )
    .map((release) => release.title);
  const score = exactReleaseTitles.length * 3 + Math.min(2, exactTrackTitles.length);
  return {
    artistId,
    conflictingReleaseTitles,
    exactReleaseTitles,
    exactTrackTitles,
    reasons: [
      `${exactReleaseTitles.length} exact release-title overlap(s).`,
      `${exactTrackTitles.length} exact track-title overlap(s).`,
      `${conflictingReleaseTitles.length} conflicting release-date overlap(s).`,
    ],
    score,
  };
}

function appleAlbumAsItunesCollection(album: AppleMusicAlbumCandidate): ItunesCollectionCandidate {
  const artistId = album.artistIds[0];
  return {
    ...(artistId ? { artistId } : {}),
    artistName: album.artistName,
    ...(artistId ? { collectionArtistId: artistId } : {}),
    collectionArtistName: album.artistName,
    collectionId: album.albumId,
    collectionName: album.title,
    releaseDate: `${album.releaseDate!.slice(0, 10)}T00:00:00Z`,
    source: "album_lookup",
    ...(album.trackCount === undefined ? {} : { trackCount: album.trackCount }),
    ...(album.evidenceUrl ? { viewUrl: album.evidenceUrl } : {}),
  };
}

function normalizeArtist(value: string): string {
  return normalizeText(value)
    .replace(/&/g, " and ")
    .replace(/\b(?:feat|featuring|with|x)\b/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

function decision(
  status: AppleMusicMappingStatus,
  reason: string,
  candidates: AppleMusicArtistCandidate[],
): AppleMusicMappingDecision {
  return { candidates, confidence: 0, evidence: [], reason, status };
}

function comparisonRank(classification: string): number {
  if (classification === "exact_match") return 4;
  if (classification === "strong_probable_match") return 3;
  if (classification === "ambiguous_match") return 2;
  return 1;
}
