import { extractVersion, normalizeText } from "./normalize";

export type ItunesMappingStatus =
  "exact_confirmed" | "evidence_confirmed" | "ambiguous" | "no_match" | "rejected";

export interface ItunesArtistCandidate {
  artistId: string;
  artistName: string;
  primaryGenreName?: string;
  viewUrl?: string;
}

export interface ItunesMappingDecision {
  ambiguityReason?: string;
  confidence: number;
  evidence: string[];
  reason: string;
  selected?: ItunesArtistCandidate;
  status: ItunesMappingStatus;
}

export interface ItunesCollectionCandidate {
  artistId?: string;
  artistName?: string;
  collectionArtistId?: string;
  collectionArtistName?: string;
  collectionId: string;
  collectionName: string;
  explicitness?: string;
  primaryGenreName?: string;
  releaseDate: string;
  source: "album_lookup" | "song_lookup" | "both";
  trackCount?: number;
  viewUrl?: string;
}

export interface ItunesTrackCandidate {
  artistId?: string;
  artistName: string;
  collectionArtistId?: string;
  collectionArtistName?: string;
  collectionId?: string;
  collectionName?: string;
  discCount?: number;
  discNumber?: number;
  explicitness?: string;
  releaseDate: string;
  trackCount?: number;
  trackId: string;
  trackName: string;
  trackNumber?: number;
  trackTimeMillis?: number;
  viewUrl?: string;
}

export interface SpotifyGroundTruthRelease {
  canonicalReleaseId: string;
  normalizedTitle: string;
  releaseDate: string;
  releaseType: string;
  spotifyReleaseId: string;
  title: string;
  trackCount?: number;
  tracks?: Array<{
    durationMs?: number;
    normalizedTitle: string;
    title: string;
  }>;
  version?: string;
}

export type ItunesComparisonClassification =
  | "exact_match"
  | "strong_probable_match"
  | "ambiguous_match"
  | "apple_only_or_spotify_missing"
  | "spotify_ground_truth_missed_by_itunes"
  | "identity_mapping_failure";

export interface ItunesReleaseComparison {
  appleCollectionId?: string;
  classification: ItunesComparisonClassification;
  dateDifferenceDays?: number;
  reasons: string[];
  spotifyReleaseId?: string;
  trackCountAgreement?: boolean;
}

export function decideItunesArtistMapping(input: {
  aliases: string[];
  candidates: ItunesArtistCandidate[];
  canonicalName: string;
}): ItunesMappingDecision {
  const canonical = normalizeArtistIdentity(input.canonicalName);
  const exact = input.candidates.filter(
    (candidate) => normalizeArtistIdentity(candidate.artistName) === canonical,
  );
  if (exact.length === 1) {
    return {
      confidence: 1,
      evidence: ["one exact normalized canonical-name match"],
      reason: "Unique exact normalized artist-name match.",
      selected: exact[0]!,
      status: "exact_confirmed",
    };
  }
  if (exact.length > 1) {
    return {
      ambiguityReason: "Multiple candidates share the exact normalized canonical name.",
      confidence: 0,
      evidence: exact.map((candidate) => `competing:${candidate.artistId}`),
      reason: "Exact name is not unique.",
      status: "ambiguous",
    };
  }
  const aliases = new Set(input.aliases.map(normalizeArtistIdentity).filter(Boolean));
  const aliasMatches = input.candidates.filter((candidate) =>
    aliases.has(normalizeArtistIdentity(candidate.artistName)),
  );
  if (aliasMatches.length === 1) {
    return {
      confidence: 0.95,
      evidence: [`stored_alias:${aliasMatches[0]!.artistName}`],
      reason: "One candidate exactly matches a stored artist alias.",
      selected: aliasMatches[0]!,
      status: "evidence_confirmed",
    };
  }
  if (aliasMatches.length > 1) {
    return {
      ambiguityReason: "Multiple candidates match stored aliases.",
      confidence: 0,
      evidence: aliasMatches.map((candidate) => `competing_alias:${candidate.artistId}`),
      reason: "Alias evidence is not unique.",
      status: "ambiguous",
    };
  }
  if (input.candidates.length === 0) {
    return {
      confidence: 0,
      evidence: [],
      reason: "Artist search returned no candidates.",
      status: "no_match",
    };
  }
  return {
    ambiguityReason: "Search returned candidates but none had an exact canonical or alias match.",
    confidence: 0,
    evidence: [],
    reason: "Similar spelling, genre, rank, and partial words are insufficient.",
    status: "ambiguous",
  };
}

export function normalizeArtistIdentity(value: string): string {
  return normalizeText(value)
    .replace(/\b(feat|featuring|with|vs|versus)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function mergeItunesCollections(
  albumCollections: ItunesCollectionCandidate[],
  songCollections: ItunesCollectionCandidate[],
): ItunesCollectionCandidate[] {
  const merged = new Map<string, ItunesCollectionCandidate>();
  for (const candidate of albumCollections) {
    merged.set(candidate.collectionId, { ...candidate, source: "album_lookup" });
  }
  for (const candidate of songCollections) {
    const existing = merged.get(candidate.collectionId);
    merged.set(candidate.collectionId, {
      ...(existing ?? candidate),
      ...candidate,
      source: existing ? "both" : "song_lookup",
    });
  }
  return [...merged.values()].sort(compareDateThenId);
}

export function dedupeItunesTracks(tracks: ItunesTrackCandidate[]): ItunesTrackCandidate[] {
  return [...new Map(tracks.map((track) => [track.trackId, track])).values()].sort((a, b) => {
    const date = b.releaseDate.localeCompare(a.releaseDate);
    return date || a.trackId.localeCompare(b.trackId);
  });
}

export function classifyItunesCollectionType(
  collection: Pick<ItunesCollectionCandidate, "collectionName" | "trackCount">,
): string {
  const normalized = normalizeText(collection.collectionName);
  if (normalized.includes("remix")) return "remix";
  if (normalized.includes("live")) return "live";
  if (normalized.includes("compilation") || normalized.includes("various artists")) {
    return "compilation";
  }
  const count = collection.trackCount ?? 0;
  if (count <= 3) return "single";
  if (count <= 6) return "ep";
  return "album";
}

export function isItunesAppearance(mappedArtistId: string, track: ItunesTrackCandidate): boolean {
  return (
    track.artistId === mappedArtistId &&
    Boolean(track.collectionArtistId && track.collectionArtistId !== mappedArtistId)
  );
}

export function candidateInWindow(
  releaseDate: string,
  snapshotTimestamp: string,
  days: 7 | 14 | 30 | 60,
): boolean {
  const snapshot = new Date(snapshotTimestamp);
  const release = new Date(releaseDate);
  if (Number.isNaN(snapshot.getTime()) || Number.isNaN(release.getTime())) return false;
  const difference = snapshot.getTime() - release.getTime();
  return difference >= 0 && difference <= days * 86_400_000;
}

export function compareItunesToSpotify(
  groundTruth: SpotifyGroundTruthRelease[],
  collections: ItunesCollectionCandidate[],
): ItunesReleaseComparison[] {
  const comparisons: ItunesReleaseComparison[] = [];
  const matchedCollections = new Set<string>();
  for (const spotify of groundTruth) {
    const scored = collections
      .map((apple) => scoreReleasePair(spotify, apple))
      .filter((value) => value.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.apple.collectionId.localeCompare(b.apple.collectionId),
      );
    const best = scored[0];
    const tied = best && scored[1]?.score === best.score;
    if (!best) {
      comparisons.push({
        classification: "spotify_ground_truth_missed_by_itunes",
        reasons: ["No title-compatible iTunes collection was found."],
        spotifyReleaseId: spotify.spotifyReleaseId,
      });
      continue;
    }
    const classification: ItunesComparisonClassification =
      tied || best.versionConflict
        ? "ambiguous_match"
        : best.score >= 0.9
          ? "exact_match"
          : best.score >= 0.65
            ? "strong_probable_match"
            : "ambiguous_match";
    if (classification !== "ambiguous_match") matchedCollections.add(best.apple.collectionId);
    comparisons.push({
      appleCollectionId: best.apple.collectionId,
      classification,
      ...(best.dateDifferenceDays === undefined
        ? {}
        : { dateDifferenceDays: best.dateDifferenceDays }),
      reasons: [
        ...best.reasons,
        ...(tied ? ["Another collection has the same score."] : []),
        ...(best.versionConflict ? ["Version markers conflict."] : []),
      ],
      spotifyReleaseId: spotify.spotifyReleaseId,
      ...(best.trackCountAgreement === undefined
        ? {}
        : { trackCountAgreement: best.trackCountAgreement }),
    });
  }
  for (const apple of collections) {
    if (!matchedCollections.has(apple.collectionId)) {
      comparisons.push({
        appleCollectionId: apple.collectionId,
        classification: "apple_only_or_spotify_missing",
        reasons: ["No confirmed frozen Spotify ground-truth match was assigned."],
      });
    }
  }
  return comparisons;
}

export function batchEquivalentToIndividuals(input: {
  batchCollections: ItunesCollectionCandidate[];
  batchTracks: ItunesTrackCandidate[];
  expectedArtistIds: string[];
  individualCollections: ItunesCollectionCandidate[];
  individualTracks: ItunesTrackCandidate[];
}): { reasons: string[]; safe: boolean } {
  const reasons: string[] = [];
  const expected = new Set(input.expectedArtistIds);
  const represented = new Set(
    [...input.batchCollections, ...input.batchTracks]
      .flatMap((item) => [item.artistId, item.collectionArtistId])
      .filter((value): value is string => Boolean(value)),
  );
  for (const artistId of expected) {
    if (!represented.has(artistId)) reasons.push(`missing_artist:${artistId}`);
  }
  const missingCollections = difference(
    input.individualCollections.map((item) => item.collectionId),
    input.batchCollections.map((item) => item.collectionId),
  );
  const missingTracks = difference(
    input.individualTracks.map((item) => item.trackId),
    input.batchTracks.map((item) => item.trackId),
  );
  if (missingCollections.length > 0)
    reasons.push(`missing_collections:${missingCollections.length}`);
  if (missingTracks.length > 0) reasons.push(`missing_tracks:${missingTracks.length}`);
  const unattributed = [...input.batchCollections, ...input.batchTracks].filter(
    (item) =>
      !item.artistId ||
      (!expected.has(item.artistId) &&
        (!item.collectionArtistId || !expected.has(item.collectionArtistId))),
  );
  if (unattributed.length > 0) reasons.push(`misattributed:${unattributed.length}`);
  return { reasons, safe: reasons.length === 0 };
}

function scoreReleasePair(spotify: SpotifyGroundTruthRelease, apple: ItunesCollectionCandidate) {
  const spotifyTitle = normalizeText(spotify.title);
  const appleTitle = normalizeText(apple.collectionName);
  const titleEqual = spotifyTitle === appleTitle;
  const contained =
    !titleEqual && (spotifyTitle.includes(appleTitle) || appleTitle.includes(spotifyTitle));
  const versionBaseEqual = baseTitle(spotifyTitle) === baseTitle(appleTitle);
  if (!titleEqual && !contained && !versionBaseEqual) {
    return {
      apple,
      dateDifferenceDays: undefined,
      reasons: [] as string[],
      score: 0,
      trackCountAgreement: undefined,
      versionConflict: false,
    };
  }
  let score = titleEqual ? 0.55 : versionBaseEqual ? 0.45 : 0.3;
  const reasons = [
    titleEqual
      ? "Normalized titles are identical."
      : versionBaseEqual
        ? "Base titles agree after isolating version markers."
        : "One normalized title contains the other.",
  ];
  const spotifyVersion = spotify.version ?? extractVersion(spotify.title);
  const appleVersion = extractVersion(apple.collectionName);
  const versionConflict = Boolean(
    spotifyVersion && appleVersion && spotifyVersion !== appleVersion,
  );
  if (!versionConflict && spotifyVersion === appleVersion) {
    score += 0.15;
    reasons.push("Version markers agree.");
  }
  const dateDifferenceDays = Math.abs(
    Math.round((Date.parse(spotify.releaseDate) - Date.parse(apple.releaseDate)) / 86_400_000),
  );
  if (dateDifferenceDays <= 1) {
    score += 0.2;
    reasons.push("Release dates differ by at most one day.");
  } else if (dateDifferenceDays <= 7) {
    score += 0.1;
    reasons.push("Release dates differ by at most seven days.");
  }
  const trackCountAgreement =
    spotify.trackCount !== undefined && apple.trackCount !== undefined
      ? spotify.trackCount === apple.trackCount
      : undefined;
  if (trackCountAgreement) {
    score += 0.1;
    reasons.push("Track counts agree.");
  }
  return {
    apple,
    dateDifferenceDays,
    reasons,
    score: Math.min(1, score),
    trackCountAgreement,
    versionConflict,
  };
}

function baseTitle(value: string): string {
  return value
    .replace(
      /\b(remix|live|radio edit|extended mix|clean|explicit|demo|acoustic|instrumental|remaster)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value));
}

function compareDateThenId(a: ItunesCollectionCandidate, b: ItunesCollectionCandidate): number {
  const date = b.releaseDate.localeCompare(a.releaseDate);
  return date || a.collectionId.localeCompare(b.collectionId);
}
