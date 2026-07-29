import {
  resolveItunesArtistFromCatalogEvidence,
  type ItunesIdentityCandidateCatalog,
  type SpotifyGroundTruthRelease,
} from "./itunes-pilot";

export type ItunesMappingProvenance =
  "independent_exact" | "historical_evidence" | "target_window_assisted" | "unresolved";

export interface ItunesTemporalMapping {
  provenance: ItunesMappingProvenance;
  selectedArtistId?: string;
  historicalEvidenceReleaseIds: string[];
  reason: string;
}

export interface ItunesArtistCandidateOutcome {
  appleCandidate: boolean;
  artistId: string;
  artistName: string;
  safelyMapped: boolean;
  spotifyPositive: boolean;
  spotifyReleaseIds: string[];
}

export interface ItunesArtistConfusionMatrix {
  falseNegativeArtists: string[];
  falseNegatives: number;
  falsePositiveArtists: string[];
  falsePositives: number;
  precision: number | null;
  recall: number | null;
  specificity: number | null;
  trueNegativeArtists: string[];
  trueNegatives: number;
  truePositiveArtists: string[];
  truePositives: number;
}

export interface ItunesFallbackSimulation {
  appleCandidateArtistsSent: string[];
  falsePositiveConfirmationArtists: string[];
  incorrectlySkippedArtists: string[];
  incorrectlySkippedReleaseIds: string[];
  queriedArtistIds: string[];
  queriedArtists: string[];
  spotifyPositiveArtistsQueried: string[];
  spotifyQueriesAvoided: number;
  spotifyQueryReduction: number;
  totalArtists: number;
  totalSpotifyQueries: number;
  unresolvedArtistsSent: string[];
}

export function assertItunesOfflineEvidenceIntegrity(input: {
  cacheRows: number;
  correctedCacheHits: number;
  correctedMappings: number;
  correctedNetworkRequests: number;
  correctedRequestEvents: number;
  firstCacheHits: number;
  firstMappings: number;
  firstNetworkRequests: number;
  firstRequestEvents: number;
}): void {
  const expected = {
    cacheRows: 258,
    correctedCacheHits: 102,
    correctedMappings: 50,
    correctedNetworkRequests: 150,
    correctedRequestEvents: 252,
    firstCacheHits: 0,
    firstMappings: 50,
    firstNetworkRequests: 108,
    firstRequestEvents: 108,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (input[key as keyof typeof input] !== value) {
      throw new Error(`Persisted iTunes pilot evidence changed at ${key}.`);
    }
  }
}

export function freezeItunesMappingForWindow(input: {
  aliases: string[];
  candidateCatalogs: ItunesIdentityCandidateCatalog[];
  canonicalName: string;
  correctedSelectedArtistId?: string;
  correctedStatus: string;
  groundTruth: SpotifyGroundTruthRelease[];
  targetWindowStart: string;
}): ItunesTemporalMapping {
  if (input.correctedStatus === "exact_confirmed" && input.correctedSelectedArtistId) {
    return {
      historicalEvidenceReleaseIds: [],
      provenance: "independent_exact",
      reason: "The artist identity was selected by one unique exact normalized name.",
      selectedArtistId: input.correctedSelectedArtistId,
    };
  }
  if (input.correctedStatus !== "evidence_confirmed" || !input.correctedSelectedArtistId) {
    return {
      historicalEvidenceReleaseIds: [],
      provenance: "unresolved",
      reason: "The corrected run did not establish one selected artist identity.",
    };
  }
  const historicalGroundTruth = input.groundTruth.filter(
    (release) => release.releaseDate < input.targetWindowStart,
  );
  if (historicalGroundTruth.length === 0) {
    return {
      historicalEvidenceReleaseIds: [],
      provenance: "target_window_assisted",
      reason: "No frozen Spotify release predates the target window.",
    };
  }
  const historicalDecision = resolveItunesArtistFromCatalogEvidence({
    aliases: input.aliases,
    candidates: input.candidateCatalogs,
    canonicalName: input.canonicalName,
    groundTruth: historicalGroundTruth,
  });
  if (
    historicalDecision.status === "evidence_confirmed" &&
    historicalDecision.selected?.artistId === input.correctedSelectedArtistId
  ) {
    const selectedEvidence = historicalDecision.candidateEvidence?.find(
      (evidence) => evidence.artistId === input.correctedSelectedArtistId,
    );
    return {
      historicalEvidenceReleaseIds: selectedEvidence?.matchedReleases ?? [],
      provenance: "historical_evidence",
      reason: "Pre-window Spotify evidence independently selects the corrected Apple artist.",
      selectedArtistId: input.correctedSelectedArtistId,
    };
  }
  return {
    historicalEvidenceReleaseIds: [],
    provenance: "target_window_assisted",
    reason:
      historicalDecision.selected &&
      historicalDecision.selected.artistId !== input.correctedSelectedArtistId
        ? "Pre-window evidence selects a different Apple artist."
        : "Pre-window evidence cannot uniquely select the corrected Apple artist.",
  };
}

export function buildItunesArtistConfusionMatrix(
  outcomes: ItunesArtistCandidateOutcome[],
): ItunesArtistConfusionMatrix {
  const safe = dedupeOutcomes(outcomes).filter((outcome) => outcome.safelyMapped);
  const truePositive = safe.filter((outcome) => outcome.appleCandidate && outcome.spotifyPositive);
  const falsePositive = safe.filter(
    (outcome) => outcome.appleCandidate && !outcome.spotifyPositive,
  );
  const trueNegative = safe.filter(
    (outcome) => !outcome.appleCandidate && !outcome.spotifyPositive,
  );
  const falseNegative = safe.filter(
    (outcome) => !outcome.appleCandidate && outcome.spotifyPositive,
  );
  return {
    falseNegativeArtists: names(falseNegative),
    falseNegatives: falseNegative.length,
    falsePositiveArtists: names(falsePositive),
    falsePositives: falsePositive.length,
    precision: safeRatio(truePositive.length, truePositive.length + falsePositive.length),
    recall: safeRatio(truePositive.length, truePositive.length + falseNegative.length),
    specificity: safeRatio(trueNegative.length, trueNegative.length + falsePositive.length),
    trueNegativeArtists: names(trueNegative),
    trueNegatives: trueNegative.length,
    truePositiveArtists: names(truePositive),
    truePositives: truePositive.length,
  };
}

export function simulateItunesFallbackPolicy(
  outcomes: ItunesArtistCandidateOutcome[],
): ItunesFallbackSimulation {
  const artists = dedupeOutcomes(outcomes);
  const unresolved = artists.filter((outcome) => !outcome.safelyMapped);
  const appleCandidates = artists.filter(
    (outcome) => outcome.safelyMapped && outcome.appleCandidate,
  );
  const queried = new Map(
    [...unresolved, ...appleCandidates].map((outcome) => [outcome.artistId, outcome]),
  );
  const incorrectlySkipped = artists.filter(
    (outcome) => outcome.safelyMapped && !outcome.appleCandidate && outcome.spotifyPositive,
  );
  const falsePositiveConfirmations = appleCandidates.filter((outcome) => !outcome.spotifyPositive);
  const spotifyPositiveQueried = [...queried.values()].filter((outcome) => outcome.spotifyPositive);
  return {
    appleCandidateArtistsSent: names(appleCandidates),
    falsePositiveConfirmationArtists: names(falsePositiveConfirmations),
    incorrectlySkippedArtists: names(incorrectlySkipped),
    incorrectlySkippedReleaseIds: [
      ...new Set(incorrectlySkipped.flatMap((outcome) => outcome.spotifyReleaseIds)),
    ].sort(),
    queriedArtistIds: [...queried.keys()].sort(),
    queriedArtists: names([...queried.values()]),
    spotifyPositiveArtistsQueried: names(spotifyPositiveQueried),
    spotifyQueriesAvoided: artists.length - queried.size,
    spotifyQueryReduction: ratio(artists.length - queried.size, artists.length),
    totalArtists: artists.length,
    totalSpotifyQueries: queried.size,
    unresolvedArtistsSent: names(unresolved),
  };
}

export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function safeRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function dedupeOutcomes(outcomes: ItunesArtistCandidateOutcome[]): ItunesArtistCandidateOutcome[] {
  const deduped = new Map<string, ItunesArtistCandidateOutcome>();
  for (const outcome of outcomes) {
    const existing = deduped.get(outcome.artistId);
    if (!existing) {
      deduped.set(outcome.artistId, {
        ...outcome,
        spotifyReleaseIds: [...new Set(outcome.spotifyReleaseIds)].sort(),
      });
      continue;
    }
    deduped.set(outcome.artistId, {
      ...existing,
      appleCandidate: existing.appleCandidate || outcome.appleCandidate,
      safelyMapped: existing.safelyMapped || outcome.safelyMapped,
      spotifyPositive: existing.spotifyPositive || outcome.spotifyPositive,
      spotifyReleaseIds: [
        ...new Set([...existing.spotifyReleaseIds, ...outcome.spotifyReleaseIds]),
      ].sort(),
    });
  }
  return [...deduped.values()].sort(
    (left, right) =>
      left.artistName.localeCompare(right.artistName) ||
      left.artistId.localeCompare(right.artistId),
  );
}

function names(outcomes: ItunesArtistCandidateOutcome[]): string[] {
  return outcomes
    .map((outcome) => outcome.artistName)
    .sort((left, right) => left.localeCompare(right));
}
