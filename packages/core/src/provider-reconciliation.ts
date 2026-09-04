import { createHash } from "node:crypto";
import { normalizeText } from "./normalize";

export type ProviderReconciliationStatus =
  "matched" | "apple_only" | "spotify_only" | "uncertain" | "missing_spotify_track";

export interface ProviderReleaseTrackObservation {
  canonicalTrackId: string | null;
  discNumber: number;
  normalizedTitle: string;
  playlistEligible: boolean;
  providerTrackId: string;
  trackNumber: number;
}

export interface ProviderReleaseReconciliationObservation {
  canonicalReleaseId: string | null;
  provider: "apple_music" | "spotify";
  providerReleaseId: string;
  releaseDate: string;
  releaseType: string;
  title: string;
  tracks: ProviderReleaseTrackObservation[];
}

export interface ProviderReleaseReconciliationResult {
  appleCanonicalReleaseId: string | null;
  appleProviderReleaseId: string | null;
  appleTrackCount: number;
  confidence: number;
  matchedTrackCount: number;
  missingSpotifyTrackCount: number;
  playlistEligible: boolean;
  playlistEligibleTrackCount: number;
  reasons: string[];
  reconciliationKey: string;
  releaseDate: string;
  releaseType: string;
  spotifyCanonicalReleaseId: string | null;
  spotifyProviderReleaseId: string | null;
  spotifyTrackCount: number;
  status: ProviderReconciliationStatus;
  title: string;
}

interface ScoredPair {
  apple: ProviderReleaseReconciliationObservation;
  confidence: number;
  reasons: string[];
  spotify: ProviderReleaseReconciliationObservation;
  plausible: boolean;
  strictMatch: boolean;
}

export function reconcileProviderReleases(
  observations: readonly ProviderReleaseReconciliationObservation[],
): ProviderReleaseReconciliationResult[] {
  const apple = observations
    .filter((release) => release.provider === "apple_music")
    .sort(compareReleaseObservations);
  const spotify = observations
    .filter((release) => release.provider === "spotify")
    .sort(compareReleaseObservations);
  const pairs = apple
    .flatMap((appleRelease) =>
      spotify.map((spotifyRelease) => scorePair(appleRelease, spotifyRelease)),
    )
    .filter((pair) => pair.plausible && pair.confidence >= 0.35)
    .sort(comparePairs);
  const pairsByApple = groupPairs(pairs, (pair) => pair.apple.providerReleaseId);
  const pairsBySpotify = groupPairs(pairs, (pair) => pair.spotify.providerReleaseId);
  const matchedApple = new Set<string>();
  const matchedSpotify = new Set<string>();
  const results: ProviderReleaseReconciliationResult[] = [];

  const strictPairs = pairs.filter(
    (pair) =>
      pair.strictMatch &&
      isUniqueLeader(pair, pairsByApple.get(pair.apple.providerReleaseId) ?? []) &&
      isUniqueLeader(pair, pairsBySpotify.get(pair.spotify.providerReleaseId) ?? []),
  );
  for (const pair of strictPairs) {
    if (
      matchedApple.has(pair.apple.providerReleaseId) ||
      matchedSpotify.has(pair.spotify.providerReleaseId)
    ) {
      continue;
    }
    matchedApple.add(pair.apple.providerReleaseId);
    matchedSpotify.add(pair.spotify.providerReleaseId);
    const trackCounts = compareTracks(pair.apple.tracks, pair.spotify.tracks);
    results.push(
      pairedResult(
        pair,
        trackCounts.missingSpotify > 0 ? "missing_spotify_track" : "matched",
        [
          ...pair.reasons,
          `${trackCounts.matched} track appearance(s) matched internally.`,
          ...(trackCounts.missingSpotify > 0
            ? [`${trackCounts.missingSpotify} Apple track(s) have no Spotify track match.`]
            : []),
        ],
        trackCounts,
      ),
    );
  }

  const uncertainApple = new Set<string>();
  const uncertainSpotify = new Set<string>();
  const uncertainPairs = pairs.filter(
    (pair) =>
      !matchedApple.has(pair.apple.providerReleaseId) &&
      !matchedSpotify.has(pair.spotify.providerReleaseId) &&
      (isComparableLeader(pair, pairsByApple.get(pair.apple.providerReleaseId) ?? []) ||
        isComparableLeader(pair, pairsBySpotify.get(pair.spotify.providerReleaseId) ?? [])),
  );
  for (const pair of uncertainPairs) {
    const appleAlternatives = comparableLeaders(
      pairsByApple.get(pair.apple.providerReleaseId) ?? [],
    );
    const spotifyAlternatives = comparableLeaders(
      pairsBySpotify.get(pair.spotify.providerReleaseId) ?? [],
    );
    uncertainApple.add(pair.apple.providerReleaseId);
    uncertainSpotify.add(pair.spotify.providerReleaseId);
    results.push(
      pairedResult(pair, "uncertain", [
        ...pair.reasons,
        ...(appleAlternatives.length > 1
          ? [
              "Multiple Spotify releases have comparable evidence; each candidate is preserved for review.",
            ]
          : []),
        ...(spotifyAlternatives.length > 1
          ? [
              "Multiple Apple releases have comparable evidence; each candidate is preserved for review.",
            ]
          : []),
        ...(appleAlternatives.length === 1 && spotifyAlternatives.length === 1
          ? ["Evidence did not meet the strict cross-provider threshold."]
          : []),
      ]),
    );
  }

  for (const appleRelease of apple) {
    if (
      !matchedApple.has(appleRelease.providerReleaseId) &&
      !uncertainApple.has(appleRelease.providerReleaseId)
    ) {
      results.push(singleProviderResult(appleRelease, "apple_only"));
    }
  }
  for (const spotifyRelease of spotify) {
    if (
      !matchedSpotify.has(spotifyRelease.providerReleaseId) &&
      !uncertainSpotify.has(spotifyRelease.providerReleaseId)
    ) {
      results.push(singleProviderResult(spotifyRelease, "spotify_only"));
    }
  }

  return results.sort(
    (left, right) =>
      right.releaseDate.localeCompare(left.releaseDate) ||
      left.reconciliationKey.localeCompare(right.reconciliationKey),
  );
}

function groupPairs(
  pairs: readonly ScoredPair[],
  key: (pair: ScoredPair) => string,
): Map<string, ScoredPair[]> {
  const grouped = new Map<string, ScoredPair[]>();
  for (const pair of pairs) {
    const values = grouped.get(key(pair)) ?? [];
    values.push(pair);
    grouped.set(key(pair), values);
  }
  return grouped;
}

function comparableLeaders(pairs: readonly ScoredPair[]): ScoredPair[] {
  const leader = pairs[0];
  return leader ? pairs.filter((pair) => leader.confidence - pair.confidence < 0.1) : [];
}

function isComparableLeader(pair: ScoredPair, pairs: readonly ScoredPair[]): boolean {
  return comparableLeaders(pairs).includes(pair);
}

function isUniqueLeader(pair: ScoredPair, pairs: readonly ScoredPair[]): boolean {
  const comparable = comparableLeaders(pairs);
  return comparable.length === 1 && comparable[0] === pair;
}

function comparePairs(left: ScoredPair, right: ScoredPair): number {
  return (
    right.confidence - left.confidence ||
    left.apple.providerReleaseId.localeCompare(right.apple.providerReleaseId) ||
    left.spotify.providerReleaseId.localeCompare(right.spotify.providerReleaseId)
  );
}

function compareReleaseObservations(
  left: ProviderReleaseReconciliationObservation,
  right: ProviderReleaseReconciliationObservation,
): number {
  return (
    right.releaseDate.localeCompare(left.releaseDate) ||
    left.providerReleaseId.localeCompare(right.providerReleaseId)
  );
}

function scorePair(
  apple: ProviderReleaseReconciliationObservation,
  spotify: ProviderReleaseReconciliationObservation,
): ScoredPair {
  const reasons: string[] = [];
  const sameCanonicalRelease =
    apple.canonicalReleaseId !== null &&
    spotify.canonicalReleaseId !== null &&
    apple.canonicalReleaseId === spotify.canonicalReleaseId;
  const sameTitle = normalizeText(apple.title) === normalizeText(spotify.title);
  const sameDate = apple.releaseDate === spotify.releaseDate;
  const sameType =
    normalizeReleaseType(apple.releaseType) === normalizeReleaseType(spotify.releaseType);
  const sameTrackCount = apple.tracks.length > 0 && apple.tracks.length === spotify.tracks.length;
  const trackCounts = compareTracks(apple.tracks, spotify.tracks);
  const contradictions = [
    ...(!sameTitle ? ["Normalized release titles conflict."] : []),
    ...(!sameDate ? ["Release dates conflict."] : []),
    ...(!sameType ? ["Release types conflict."] : []),
  ];

  let confidence = 0;
  if (sameCanonicalRelease) {
    confidence += 0.65;
    reasons.push("Both provider records resolve to the same canonical release.");
  }
  if (sameTitle) {
    confidence += 0.15;
    reasons.push("Normalized release titles agree.");
  }
  if (sameDate) {
    confidence += 0.1;
    reasons.push("Release dates agree.");
  }
  if (sameType) {
    confidence += 0.05;
    reasons.push("Release types agree.");
  }
  if (sameTrackCount) {
    confidence += 0.05;
    reasons.push("Provider track counts agree.");
  }
  if (trackCounts.matched > 0) {
    confidence += Math.min(0.25, trackCounts.matched / Math.max(apple.tracks.length, 1) / 4);
    reasons.push("Provider tracks share canonical identities or exact positions and titles.");
  }
  reasons.push(...contradictions);

  const strictMetadataMatch =
    sameTitle && sameDate && sameType && (sameTrackCount || trackCounts.matched > 0);
  return {
    apple,
    confidence: Math.min(1, confidence),
    plausible: sameCanonicalRelease || sameTitle || (sameDate && trackCounts.matched > 0),
    reasons,
    spotify,
    strictMatch: (sameCanonicalRelease && contradictions.length === 0) || strictMetadataMatch,
  };
}

function compareTracks(
  apple: readonly ProviderReleaseTrackObservation[],
  spotify: readonly ProviderReleaseTrackObservation[],
): { matched: number; missingSpotify: number } {
  const spotifyCanonical = new Set(
    spotify.flatMap((track) => (track.canonicalTrackId ? [track.canonicalTrackId] : [])),
  );
  const spotifySignatures = new Set(spotify.map(trackSignature));
  let matched = 0;
  for (const track of apple) {
    if (
      (track.canonicalTrackId && spotifyCanonical.has(track.canonicalTrackId)) ||
      spotifySignatures.has(trackSignature(track))
    ) {
      matched += 1;
    }
  }
  return { matched, missingSpotify: Math.max(0, apple.length - matched) };
}

function trackSignature(track: ProviderReleaseTrackObservation): string {
  return `${track.discNumber}:${track.trackNumber}:${normalizeText(track.normalizedTitle)}`;
}

function pairedResult(
  pair: ScoredPair,
  status: "matched" | "uncertain" | "missing_spotify_track",
  reasons: string[],
  trackCounts = compareTracks(pair.apple.tracks, pair.spotify.tracks),
): ProviderReleaseReconciliationResult {
  const playlistEligibleTrackCount = pair.spotify.tracks.filter(
    (track) => track.playlistEligible,
  ).length;
  return {
    appleCanonicalReleaseId: pair.apple.canonicalReleaseId,
    appleProviderReleaseId: pair.apple.providerReleaseId,
    appleTrackCount: pair.apple.tracks.length,
    confidence: pair.confidence,
    matchedTrackCount: trackCounts.matched,
    missingSpotifyTrackCount: trackCounts.missingSpotify,
    playlistEligible: playlistEligibleTrackCount > 0,
    playlistEligibleTrackCount,
    reasons,
    reconciliationKey: reconciliationKey(pair.apple, pair.spotify),
    releaseDate: pair.apple.releaseDate,
    releaseType: pair.apple.releaseType,
    spotifyCanonicalReleaseId: pair.spotify.canonicalReleaseId,
    spotifyProviderReleaseId: pair.spotify.providerReleaseId,
    spotifyTrackCount: pair.spotify.tracks.length,
    status,
    title: pair.apple.title,
  };
}

function singleProviderResult(
  release: ProviderReleaseReconciliationObservation,
  status: "apple_only" | "spotify_only",
): ProviderReleaseReconciliationResult {
  const playlistEligibleTrackCount =
    release.provider === "spotify"
      ? release.tracks.filter((track) => track.playlistEligible).length
      : 0;
  return {
    appleCanonicalReleaseId: release.provider === "apple_music" ? release.canonicalReleaseId : null,
    appleProviderReleaseId: release.provider === "apple_music" ? release.providerReleaseId : null,
    appleTrackCount: release.provider === "apple_music" ? release.tracks.length : 0,
    confidence: 1,
    matchedTrackCount: 0,
    missingSpotifyTrackCount: 0,
    playlistEligible: playlistEligibleTrackCount > 0,
    playlistEligibleTrackCount,
    reasons: [
      status === "apple_only"
        ? "No compatible independently ingested Spotify release was found."
        : "No compatible independently ingested Apple Music release was found.",
    ],
    reconciliationKey: reconciliationKey(
      release.provider === "apple_music" ? release : null,
      release.provider === "spotify" ? release : null,
    ),
    releaseDate: release.releaseDate,
    releaseType: release.releaseType,
    spotifyCanonicalReleaseId: release.provider === "spotify" ? release.canonicalReleaseId : null,
    spotifyProviderReleaseId: release.provider === "spotify" ? release.providerReleaseId : null,
    spotifyTrackCount: release.provider === "spotify" ? release.tracks.length : 0,
    status,
    title: release.title,
  };
}

function reconciliationKey(
  apple: ProviderReleaseReconciliationObservation | null,
  spotify: ProviderReleaseReconciliationObservation | null,
): string {
  return createHash("sha256")
    .update(`apple:${apple?.providerReleaseId ?? "-"}|spotify:${spotify?.providerReleaseId ?? "-"}`)
    .digest("hex");
}

function normalizeReleaseType(value: string): string {
  const normalized = normalizeText(value);
  return normalized === "full album" ? "album" : normalized;
}
