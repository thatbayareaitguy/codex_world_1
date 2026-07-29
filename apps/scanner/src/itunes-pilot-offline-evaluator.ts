import {
  assertItunesOfflineEvidenceIntegrity,
  buildItunesArtistConfusionMatrix,
  compareItunesToSpotify,
  freezeItunesMappingForWindow,
  mergeItunesCollections,
  normalizeArtistIdentity,
  normalizeText,
  resolveItunesArtistFromCatalogEvidence,
  simulateItunesFallbackPolicy,
  type ItunesArtistCandidate,
  type ItunesArtistCandidateOutcome,
  type ItunesIdentityCandidateCatalog,
  type ItunesMappingProvenance,
  type SpotifyGroundTruthRelease,
} from "@radar/core";
import {
  itunesPilotArtistMappings,
  itunesPilotCollections,
  itunesPilotGroundTruthReleases,
  itunesPilotMatches,
  itunesPilotRequestEvents,
  itunesPilotResponseCache,
  itunesPilotRuns,
  itunesPilotSnapshotArtists,
  itunesPilotSnapshots,
  itunesPilotTracks,
  type RadarDatabase,
} from "@radar/db";
import type { ItunesArtist, ItunesNormalizedResponse } from "@radar/providers";
import { asc, eq, inArray } from "drizzle-orm";
import {
  collectionsFromTracks,
  toCollectionCandidate,
  toTrackCandidate,
} from "./itunes-pilot-runner";

export const firstItunesPilotRunId = "e51a57f6-2f95-4e6d-868b-f30ed43f90fd";
export const correctedItunesPilotRunId = "0f719ae6-bb42-48a0-b24c-557a0c2facb5";
export const frozenItunesSnapshotHash =
  "48259f7e2016aa8bbbabf4baa7e3baf8d4f9e9b53b413dab56f9d4fc70e1278a";
export const offlineWindows = [7, 14, 30, 60] as const;

type OfflineWindowDays = (typeof offlineWindows)[number];
type GroundTruthTrack = NonNullable<SpotifyGroundTruthRelease["tracks"]>[number] & {
  spotifyTrackId?: string;
};
type GroundTruthRelease = Omit<SpotifyGroundTruthRelease, "tracks"> & {
  canonicalArtistId: string;
  tracks: GroundTruthTrack[];
};

interface CachedCatalog {
  albumResultCount: number;
  catalog: ItunesIdentityCandidateCatalog;
  songResultCount: number;
}

interface EvidenceItem {
  appleId: string;
  appleTitle: string;
  evidenceDate: string;
  evidenceKind: "release" | "track";
  spotifyId: string;
  spotifyTitle: string;
  targetWindowPlacement: Record<string, "inside" | "before">;
}

interface IdentityProvenanceRow {
  canonicalArtist: string;
  canonicalArtistId: string;
  competingAppleArtistIds: string[];
  evidenceItems: EvidenceItem[];
  fullDecisionMargin: number;
  fullDecisionScore: number;
  provenanceByWindow: Record<string, ItunesMappingProvenance>;
  resolvableWithoutTargetWindowByWindow: Record<string, boolean>;
  selectedAppleArtistId: string;
}

interface MatchReviewRow {
  appleCollectionId: string;
  appleDate: string;
  appleNormalizedTitle: string;
  appleReleaseType: string;
  appleTitle: string;
  appleTrackCount: number | null;
  appleVersion: string;
  artistCreditCompatible: boolean;
  canonicalArtist: string;
  dateDifferenceDays: number;
  matchReason: string;
  matchState: string;
  riskFlags: string;
  spotifyDate: string;
  spotifyNormalizedTitle: string;
  spotifyReleaseId: string;
  spotifyReleaseType: string;
  spotifyTitle: string;
  spotifyTrackCount: number | null;
  spotifyVersion: string;
  trackTitleOverlap: number;
}

export interface ItunesOfflineEvaluation {
  baseline: {
    corrected: ReturnType<typeof summarizeRun>;
    first: ReturnType<typeof summarizeRun>;
  };
  epRegressions: Array<{
    canonicalArtist: string;
    correctedClassification: string;
    correctedReasons: string[];
    explanation: string;
    firstClassification: string;
    spotifyReleaseId: string;
    spotifyTitle: string;
  }>;
  identityProvenance: IdentityProvenanceRow[];
  integrity: {
    cacheRows: number;
    correctedCacheHits: number;
    correctedNetworkRequests: number;
    correctedRequestBudget: number;
    correctedRequestEvents: number;
    firstCacheHits: number;
    firstNetworkRequests: number;
    firstRequestBudget: number;
    firstRequestEvents: number;
    totalRequestEvents: number;
  };
  requestCeilingSemantics: string;
  retrievalOutcomes: {
    lookupTruncationPossible: number;
    mappedCatalogContainedNoCompatibleTitle: number;
    matcherAmbiguous: number;
    matcherRejected: number;
    notRetrievedByTestedWorkflow: number;
    unresolvedIdentity: number;
  };
  snapshot: {
    artistCount: number;
    hash: string;
    id: string;
    releaseCount: number;
    windowEnd: string;
    windowStart: string;
  };
  windows: Array<{
    appleCandidateArtists: number;
    confusion: ReturnType<typeof buildItunesArtistConfusionMatrix> & {
      falseNegativeRate: number | null;
      falsePositiveRate: number | null;
    };
    days: OfflineWindowDays;
    fallback: ReturnType<typeof simulateItunesFallbackPolicy>;
    independentlyMappedArtists: string[];
    historicallyMappedArtists: string[];
    spotifyPositiveArtistCount: number;
    spotifyPositiveArtists: string[];
    targetWindowAssistedArtists: string[];
    targetWindowEnd: string;
    targetWindowStart: string;
    unresolvedArtists: string[];
  }>;
}

export async function evaluateStoredItunesPilot(db: RadarDatabase): Promise<{
  evaluation: ItunesOfflineEvaluation;
  identityProvenanceCsv: string;
  matchReviewCsv: string;
}> {
  const [
    snapshots,
    runs,
    artists,
    releases,
    mappings,
    matches,
    collections,
    tracks,
    requests,
    cache,
  ] = await Promise.all([
    db.select().from(itunesPilotSnapshots),
    db
      .select()
      .from(itunesPilotRuns)
      .where(inArray(itunesPilotRuns.id, [firstItunesPilotRunId, correctedItunesPilotRunId])),
    db
      .select()
      .from(itunesPilotSnapshotArtists)
      .orderBy(asc(itunesPilotSnapshotArtists.canonicalName)),
    db
      .select()
      .from(itunesPilotGroundTruthReleases)
      .orderBy(
        asc(itunesPilotGroundTruthReleases.canonicalArtistId),
        asc(itunesPilotGroundTruthReleases.releaseDate),
      ),
    db
      .select()
      .from(itunesPilotArtistMappings)
      .where(
        inArray(itunesPilotArtistMappings.runId, [
          firstItunesPilotRunId,
          correctedItunesPilotRunId,
        ]),
      ),
    db
      .select()
      .from(itunesPilotMatches)
      .where(inArray(itunesPilotMatches.runId, [firstItunesPilotRunId, correctedItunesPilotRunId])),
    db
      .select()
      .from(itunesPilotCollections)
      .where(eq(itunesPilotCollections.runId, correctedItunesPilotRunId)),
    db
      .select()
      .from(itunesPilotTracks)
      .where(eq(itunesPilotTracks.runId, correctedItunesPilotRunId)),
    db
      .select()
      .from(itunesPilotRequestEvents)
      .where(
        inArray(itunesPilotRequestEvents.runId, [firstItunesPilotRunId, correctedItunesPilotRunId]),
      ),
    db.select().from(itunesPilotResponseCache),
  ]);
  const snapshot = snapshots.find((row) => row.snapshotHash === frozenItunesSnapshotHash);
  if (!snapshot) throw new Error("The frozen iTunes snapshot is missing.");
  if (artists.length !== 50 || releases.length !== 106) {
    throw new Error("The frozen 50-artist, 106-release cohort is incomplete.");
  }
  const firstRun = runs.find((run) => run.id === firstItunesPilotRunId);
  const correctedRun = runs.find((run) => run.id === correctedItunesPilotRunId);
  if (
    !firstRun ||
    firstRun.status !== "completed" ||
    firstRun.requestCount !== 108 ||
    !correctedRun ||
    correctedRun.status !== "controlled_partial" ||
    correctedRun.requestCount !== 150
  ) {
    throw new Error("The persisted first or corrected pilot run is incomplete.");
  }
  const firstMappings = mappings.filter((mapping) => mapping.runId === firstItunesPilotRunId);
  const correctedMappings = mappings.filter(
    (mapping) => mapping.runId === correctedItunesPilotRunId,
  );
  if (firstMappings.length !== 50 || correctedMappings.length !== 50) {
    throw new Error("Both runs must retain exactly 50 mapping records.");
  }
  const firstMatches = matches.filter((match) => match.runId === firstItunesPilotRunId);
  const correctedMatches = matches.filter((match) => match.runId === correctedItunesPilotRunId);
  const groundTruth: GroundTruthRelease[] = releases.map(toGroundTruthRelease);
  const groundTruthByArtist = groupBy(groundTruth, (release) => release.canonicalArtistId);
  const artistById = new Map(artists.map((artist) => [artist.canonicalArtistId, artist]));
  const catalogs = buildCachedCatalogs(cache, correctedMappings);
  const mappingByArtist = new Map(
    correctedMappings.map((mapping) => [mapping.canonicalArtistId, mapping]),
  );
  const identityProvenance = correctedMappings
    .filter((mapping) => mapping.status === "evidence_confirmed")
    .map((mapping) =>
      buildIdentityProvenance({
        artist: required(artistById.get(mapping.canonicalArtistId), "Snapshot artist is missing."),
        catalogs,
        groundTruth: groundTruthByArtist.get(mapping.canonicalArtistId) ?? [],
        mapping,
        windowEnd: snapshot.windowEnd,
      }),
    )
    .sort((left, right) => left.canonicalArtist.localeCompare(right.canonicalArtist));
  if (identityProvenance.length !== 13) {
    throw new Error("The corrected run must retain 13 evidence-confirmed mappings.");
  }
  const provenanceByArtist = new Map(identityProvenance.map((row) => [row.canonicalArtistId, row]));
  const windowResults = offlineWindows.map((days) => {
    const targetWindowStart = subtractCalendarDays(snapshot.windowEnd, days);
    const outcomes: ItunesArtistCandidateOutcome[] = [];
    const independentlyMappedArtists: string[] = [];
    const historicallyMappedArtists: string[] = [];
    const targetWindowAssistedArtists: string[] = [];
    const unresolvedArtists: string[] = [];
    for (const artist of artists) {
      const mapping = required(
        mappingByArtist.get(artist.canonicalArtistId),
        "Corrected mapping is missing.",
      );
      const candidateCatalogs = catalogsForMapping(mapping, catalogs);
      const frozen = freezeItunesMappingForWindow({
        aliases: stringArray(artist.aliases),
        candidateCatalogs: candidateCatalogs.map((entry) => entry.catalog),
        canonicalName: artist.canonicalName,
        ...(mapping.selectedArtistId
          ? { correctedSelectedArtistId: mapping.selectedArtistId }
          : {}),
        correctedStatus: mapping.status,
        groundTruth: groundTruthByArtist.get(artist.canonicalArtistId) ?? [],
        targetWindowStart,
      });
      const safelyMapped =
        frozen.provenance === "independent_exact" || frozen.provenance === "historical_evidence";
      if (frozen.provenance === "independent_exact") {
        independentlyMappedArtists.push(artist.canonicalName);
      } else if (frozen.provenance === "historical_evidence") {
        historicallyMappedArtists.push(artist.canonicalName);
      } else if (frozen.provenance === "target_window_assisted") {
        targetWindowAssistedArtists.push(artist.canonicalName);
      } else {
        unresolvedArtists.push(artist.canonicalName);
      }
      const selectedCatalog = frozen.selectedArtistId
        ? catalogs.get(frozen.selectedArtistId)
        : undefined;
      const spotifyReleases = (groundTruthByArtist.get(artist.canonicalArtistId) ?? []).filter(
        (release) => inDateWindow(release.releaseDate, targetWindowStart, snapshot.windowEnd),
      );
      outcomes.push({
        appleCandidate: Boolean(
          selectedCatalog &&
          hasAppleCandidate(
            selectedCatalog.catalog,
            frozen.selectedArtistId!,
            targetWindowStart,
            snapshot.windowEnd,
          ),
        ),
        artistId: artist.canonicalArtistId,
        artistName: artist.canonicalName,
        safelyMapped,
        spotifyPositive: spotifyReleases.length > 0,
        spotifyReleaseIds: spotifyReleases.map((release) => release.spotifyReleaseId),
      });
    }
    const confusionBase = buildItunesArtistConfusionMatrix(outcomes);
    const fallback = simulateItunesFallbackPolicy(outcomes);
    return {
      appleCandidateArtists: outcomes.filter(
        (outcome) => outcome.safelyMapped && outcome.appleCandidate,
      ).length,
      confusion: {
        ...confusionBase,
        falseNegativeRate: complement(confusionBase.recall),
        falsePositiveRate: complement(confusionBase.specificity),
      },
      days,
      fallback,
      independentlyMappedArtists: independentlyMappedArtists.sort(),
      historicallyMappedArtists: historicallyMappedArtists.sort(),
      spotifyPositiveArtistCount: outcomes.filter((outcome) => outcome.spotifyPositive).length,
      spotifyPositiveArtists: outcomes
        .filter((outcome) => outcome.spotifyPositive)
        .map((outcome) => outcome.artistName)
        .sort(),
      targetWindowAssistedArtists: targetWindowAssistedArtists.sort(),
      targetWindowEnd: snapshot.windowEnd,
      targetWindowStart,
      unresolvedArtists: unresolvedArtists.sort(),
    };
  });
  const matchReviewRows = buildMatchReviewRows({
    artists: artistById,
    catalogs,
    collections,
    correctedMatches,
    groundTruth,
    mappings: mappingByArtist,
    provenance: provenanceByArtist,
    tracks,
  });
  if (matchReviewRows.length !== 80) {
    throw new Error(`Expected 80 corrected review rows, found ${matchReviewRows.length}.`);
  }
  const epRegressions = buildEpRegressions({
    artistById,
    correctedMatches,
    firstMatches,
    groundTruth,
  });
  if (epRegressions.length !== 2) {
    throw new Error(`Expected two EP regressions, found ${epRegressions.length}.`);
  }
  const evaluation: ItunesOfflineEvaluation = {
    baseline: {
      corrected: summarizeRun(correctedMappings, correctedMatches, groundTruth, snapshot.windowEnd),
      first: summarizeRun(firstMappings, firstMatches, groundTruth, snapshot.windowEnd),
    },
    epRegressions,
    identityProvenance,
    integrity: buildIntegrity({
      cacheRows: cache.length,
      correctedRun,
      firstRun,
      requests,
    }),
    requestCeilingSemantics:
      "The ceiling is configurable per run. The database gate increments only the active run's network requestCount and permits a request only while requestCount is below the lesser of the persisted run budget and the client maximum. Cache hits create telemetry rows but do not increment requestCount. The provider-state requestCount is cumulative telemetry and is not the enforcement ceiling.",
    retrievalOutcomes: buildRetrievalOutcomes({
      catalogs,
      correctedMatches,
      mappings: mappingByArtist,
    }),
    snapshot: {
      artistCount: artists.length,
      hash: snapshot.snapshotHash,
      id: snapshot.id,
      releaseCount: releases.length,
      windowEnd: snapshot.windowEnd,
      windowStart: snapshot.windowStart,
    },
    windows: windowResults,
  };
  return {
    evaluation,
    identityProvenanceCsv: identityRowsToCsv(identityProvenance),
    matchReviewCsv: matchRowsToCsv(matchReviewRows),
  };
}

function buildRetrievalOutcomes(input: {
  catalogs: Map<string, CachedCatalog>;
  correctedMatches: Array<typeof itunesPilotMatches.$inferSelect>;
  mappings: Map<string, typeof itunesPilotArtistMappings.$inferSelect>;
}) {
  const notRetrieved = input.correctedMatches.filter(
    (match) => match.classification === "spotify_ground_truth_missed_by_itunes",
  );
  const truncationPossible = notRetrieved.filter((match) => {
    const mapping = input.mappings.get(match.canonicalArtistId);
    const catalog = mapping?.selectedArtistId
      ? input.catalogs.get(mapping.selectedArtistId)
      : undefined;
    return Boolean(catalog && (catalog.albumResultCount >= 200 || catalog.songResultCount >= 200));
  });
  return {
    lookupTruncationPossible: truncationPossible.length,
    mappedCatalogContainedNoCompatibleTitle: notRetrieved.length,
    matcherAmbiguous: input.correctedMatches.filter(
      (match) => match.classification === "ambiguous_match",
    ).length,
    matcherRejected: input.correctedMatches.filter(
      (match) => match.classification === "invalid_match",
    ).length,
    notRetrievedByTestedWorkflow: notRetrieved.length,
    unresolvedIdentity: input.correctedMatches.filter(
      (match) => match.classification === "identity_mapping_failure",
    ).length,
  };
}

export function serializeOfflineEvaluation(evaluation: ItunesOfflineEvaluation): string {
  return `${JSON.stringify(evaluation, null, 2)}\n`;
}

function summarizeRun(
  mappings: Array<typeof itunesPilotArtistMappings.$inferSelect>,
  matches: Array<typeof itunesPilotMatches.$inferSelect>,
  groundTruth: GroundTruthRelease[],
  windowEnd: string,
) {
  const accepted = matches.filter((match) =>
    ["exact_match", "strong_probable_match"].includes(match.classification),
  );
  const acceptedIds = new Set(
    accepted.flatMap((match) => (match.spotifyReleaseId ? [match.spotifyReleaseId] : [])),
  );
  const releaseTypes = [...new Set(groundTruth.map((release) => release.releaseType))].sort();
  return {
    mapping: {
      ambiguous: mappings.filter((mapping) => mapping.status === "ambiguous").length,
      evidenceConfirmed: mappings.filter((mapping) => mapping.status === "evidence_confirmed")
        .length,
      exactConfirmed: mappings.filter((mapping) => mapping.status === "exact_confirmed").length,
      noMatch: mappings.filter((mapping) => mapping.status === "no_match").length,
      rejected: mappings.filter((mapping) => mapping.status === "rejected").length,
    },
    matches: {
      accepted: acceptedIds.size,
      ambiguous: matches.filter((match) => match.classification === "ambiguous_match").length,
      exact: matches.filter((match) => match.classification === "exact_match").length,
      invalid: matches.filter((match) => match.classification === "invalid_match").length,
      probable: matches.filter((match) => match.classification === "strong_probable_match").length,
      totalGroundTruth: groundTruth.length,
    },
    recallByReleaseType: Object.fromEntries(
      releaseTypes.map((releaseType) => {
        const eligible = groundTruth.filter((release) => release.releaseType === releaseType);
        const matched = eligible.filter((release) => acceptedIds.has(release.spotifyReleaseId));
        return [releaseType, { matched: matched.length, total: eligible.length }];
      }),
    ),
    recallByWindow: Object.fromEntries(
      offlineWindows.map((days) => {
        const start = subtractCalendarDays(windowEnd, days);
        const eligible = groundTruth.filter((release) =>
          inDateWindow(release.releaseDate, start, windowEnd),
        );
        return [
          String(days),
          {
            matched: eligible.filter((release) => acceptedIds.has(release.spotifyReleaseId)).length,
            total: eligible.length,
          },
        ];
      }),
    ),
  };
}

function buildIdentityProvenance(input: {
  artist: typeof itunesPilotSnapshotArtists.$inferSelect;
  catalogs: Map<string, CachedCatalog>;
  groundTruth: GroundTruthRelease[];
  mapping: typeof itunesPilotArtistMappings.$inferSelect;
  windowEnd: string;
}): IdentityProvenanceRow {
  const selectedArtistId = required(
    input.mapping.selectedArtistId,
    "Evidence-confirmed mapping has no selected artist.",
  );
  const candidateCatalogs = catalogsForMapping(input.mapping, input.catalogs).map(
    (entry) => entry.catalog,
  );
  const decision = resolveItunesArtistFromCatalogEvidence({
    aliases: stringArray(input.artist.aliases),
    candidates: candidateCatalogs,
    canonicalName: input.artist.canonicalName,
    groundTruth: input.groundTruth,
  });
  if (
    decision.status !== "evidence_confirmed" ||
    decision.selected?.artistId !== selectedArtistId
  ) {
    throw new Error(
      `Stored identity decision cannot be reproduced for ${input.artist.canonicalName}.`,
    );
  }
  const evidence = decision.candidateEvidence ?? [];
  const selected = required(
    evidence.find((item) => item.artistId === selectedArtistId),
    "Selected candidate evidence is missing.",
  );
  const nextScore = Math.max(
    0,
    ...evidence.filter((item) => item.artistId !== selectedArtistId).map((item) => item.score),
  );
  const selectedCatalog = required(
    input.catalogs.get(selectedArtistId),
    "Selected candidate catalog is missing.",
  ).catalog;
  const comparisons = compareItunesToSpotify(input.groundTruth, selectedCatalog.collections);
  const evidenceItems: EvidenceItem[] = comparisons
    .filter((comparison) =>
      ["exact_match", "strong_probable_match"].includes(comparison.classification),
    )
    .flatMap((comparison) => {
      const spotify = input.groundTruth.find(
        (release) => release.spotifyReleaseId === comparison.spotifyReleaseId,
      );
      const apple = selectedCatalog.collections.find(
        (collection) => collection.collectionId === comparison.appleCollectionId,
      );
      if (!spotify || !apple) return [];
      return [
        {
          appleId: apple.collectionId,
          appleTitle: apple.collectionName,
          evidenceDate: spotify.releaseDate,
          evidenceKind: "release" as const,
          spotifyId: spotify.spotifyReleaseId,
          spotifyTitle: spotify.title,
          targetWindowPlacement: placementByWindow(spotify.releaseDate, input.windowEnd),
        },
      ];
    });
  const appleTracksByTitle = new Map(
    selectedCatalog.tracks.map((track) => [normalizeText(track.trackName), track]),
  );
  for (const release of input.groundTruth) {
    for (const track of release.tracks ?? []) {
      const apple = appleTracksByTitle.get(normalizeText(track.normalizedTitle || track.title));
      if (!apple) continue;
      evidenceItems.push({
        appleId: apple.trackId,
        appleTitle: apple.trackName,
        evidenceDate: release.releaseDate,
        evidenceKind: "track",
        spotifyId: track.spotifyTrackId ?? track.title,
        spotifyTitle: track.title,
        targetWindowPlacement: placementByWindow(release.releaseDate, input.windowEnd),
      });
    }
  }
  const provenanceByWindow: Record<string, ItunesMappingProvenance> = {};
  const resolvableWithoutTargetWindowByWindow: Record<string, boolean> = {};
  for (const days of offlineWindows) {
    const frozen = freezeItunesMappingForWindow({
      aliases: stringArray(input.artist.aliases),
      candidateCatalogs,
      canonicalName: input.artist.canonicalName,
      correctedSelectedArtistId: selectedArtistId,
      correctedStatus: input.mapping.status,
      groundTruth: input.groundTruth,
      targetWindowStart: subtractCalendarDays(input.windowEnd, days),
    });
    provenanceByWindow[String(days)] = frozen.provenance;
    resolvableWithoutTargetWindowByWindow[String(days)] =
      frozen.provenance === "historical_evidence";
  }
  return {
    canonicalArtist: input.artist.canonicalName,
    canonicalArtistId: input.artist.canonicalArtistId,
    competingAppleArtistIds: candidateCatalogs
      .map((catalog) => catalog.candidate.artistId)
      .filter((artistId) => artistId !== selectedArtistId)
      .sort(),
    evidenceItems: uniqueEvidenceItems(evidenceItems),
    fullDecisionMargin: selected.score - nextScore,
    fullDecisionScore: selected.score,
    provenanceByWindow,
    resolvableWithoutTargetWindowByWindow,
    selectedAppleArtistId: selectedArtistId,
  };
}

function buildMatchReviewRows(input: {
  artists: Map<string, typeof itunesPilotSnapshotArtists.$inferSelect>;
  catalogs: Map<string, CachedCatalog>;
  collections: Array<typeof itunesPilotCollections.$inferSelect>;
  correctedMatches: Array<typeof itunesPilotMatches.$inferSelect>;
  groundTruth: GroundTruthRelease[];
  mappings: Map<string, typeof itunesPilotArtistMappings.$inferSelect>;
  provenance: Map<string, IdentityProvenanceRow>;
  tracks: Array<typeof itunesPilotTracks.$inferSelect>;
}): MatchReviewRow[] {
  const eligibleMatches = input.correctedMatches.filter((match) =>
    ["exact_match", "strong_probable_match", "ambiguous_match", "invalid_match"].includes(
      match.classification,
    ),
  );
  return eligibleMatches
    .map((match): MatchReviewRow => {
      const artist = required(input.artists.get(match.canonicalArtistId), "Artist is missing.");
      const mapping = required(input.mappings.get(match.canonicalArtistId), "Mapping is missing.");
      const spotify = required(
        input.groundTruth.find(
          (release) =>
            release.canonicalArtistId === match.canonicalArtistId &&
            release.spotifyReleaseId === match.spotifyReleaseId,
        ),
        "Ground-truth release is missing.",
      );
      const apple = required(
        input.collections.find(
          (collection) =>
            collection.canonicalArtistId === match.canonicalArtistId &&
            collection.collectionId === match.appleCollectionId,
        ),
        "Matched Apple collection is missing.",
      );
      const appleTracks = input.tracks.filter(
        (track) =>
          track.canonicalArtistId === match.canonicalArtistId &&
          track.collectionId === match.appleCollectionId,
      );
      const spotifyTrackTitles = new Set(
        (spotify.tracks ?? []).map((track) => normalizeText(track.normalizedTitle || track.title)),
      );
      const trackTitleOverlap = new Set(
        appleTracks
          .map((track) => normalizeText(track.trackName))
          .filter((title) => spotifyTrackTitles.has(title)),
      ).size;
      const artistCreditCompatible =
        apple.artistId === mapping.selectedArtistId ||
        apple.collectionArtistId === mapping.selectedArtistId ||
        appleTracks.some(
          (track) =>
            track.artistId === mapping.selectedArtistId ||
            track.collectionArtistId === mapping.selectedArtistId,
        );
      const selectedCache = mapping.selectedArtistId
        ? input.catalogs.get(mapping.selectedArtistId)
        : undefined;
      const riskFlags: string[] = [];
      if (normalizeText(spotify.title) !== normalizeText(apple.collectionName)) {
        riskFlags.push("non-exact normalized title");
      }
      if ((match.dateDifferenceDays ?? 0) > 1) {
        riskFlags.push("date difference greater than one day");
      }
      if ((spotify.version ?? "") !== (apple.version ?? "")) {
        riskFlags.push("version-marker transformation");
      }
      if (spotify.releaseType === "feature") riskFlags.push("credited appearance");
      if (
        (spotify.releaseType === "single" && ["album", "ep"].includes(apple.releaseType)) ||
        (apple.releaseType === "single" && ["album", "ep"].includes(spotify.releaseType))
      ) {
        riskFlags.push("single-versus-album relationship");
      }
      if (
        spotify.trackCount !== undefined &&
        apple.trackCount !== null &&
        spotify.trackCount !== apple.trackCount
      ) {
        riskFlags.push("track-count difference");
      }
      if (
        selectedCache &&
        (selectedCache.albumResultCount >= 200 || selectedCache.songResultCount >= 200)
      ) {
        riskFlags.push("incomplete or truncated Apple catalog");
      }
      if (!artistCreditCompatible) {
        riskFlags.push("collection-level artist-credit incompatibility");
      }
      if (
        input.provenance.get(match.canonicalArtistId)?.provenanceByWindow["60"] ===
        "target_window_assisted"
      ) {
        riskFlags.push("identity mapping target-window-assisted");
      }
      return {
        appleCollectionId: apple.collectionId,
        appleDate: apple.releaseDate.toISOString().slice(0, 10),
        appleNormalizedTitle: apple.normalizedTitle,
        appleReleaseType: apple.releaseType,
        appleTitle: apple.collectionName,
        appleTrackCount: apple.trackCount,
        appleVersion: apple.version ?? "",
        artistCreditCompatible,
        canonicalArtist: artist.canonicalName,
        dateDifferenceDays: match.dateDifferenceDays ?? 0,
        matchReason: stringArray(match.reasons).join("; "),
        matchState: match.classification,
        riskFlags: riskFlags.join("; "),
        spotifyDate: spotify.releaseDate,
        spotifyNormalizedTitle: spotify.normalizedTitle,
        spotifyReleaseId: spotify.spotifyReleaseId,
        spotifyReleaseType: spotify.releaseType,
        spotifyTitle: spotify.title,
        spotifyTrackCount: spotify.trackCount ?? null,
        spotifyVersion: spotify.version ?? "",
        trackTitleOverlap,
      };
    })
    .sort(
      (left, right) =>
        left.canonicalArtist.localeCompare(right.canonicalArtist) ||
        left.spotifyDate.localeCompare(right.spotifyDate) ||
        left.spotifyReleaseId.localeCompare(right.spotifyReleaseId),
    );
}

function buildEpRegressions(input: {
  artistById: Map<string, typeof itunesPilotSnapshotArtists.$inferSelect>;
  correctedMatches: Array<typeof itunesPilotMatches.$inferSelect>;
  firstMatches: Array<typeof itunesPilotMatches.$inferSelect>;
  groundTruth: GroundTruthRelease[];
}) {
  const accepted = new Set(["exact_match", "strong_probable_match"]);
  return input.groundTruth
    .filter((release) => release.releaseType === "ep")
    .flatMap((release) => {
      const first = input.firstMatches.find(
        (match) =>
          match.canonicalArtistId === release.canonicalArtistId &&
          match.spotifyReleaseId === release.spotifyReleaseId,
      );
      const corrected = input.correctedMatches.find(
        (match) =>
          match.canonicalArtistId === release.canonicalArtistId &&
          match.spotifyReleaseId === release.spotifyReleaseId,
      );
      if (
        !first ||
        !accepted.has(first.classification) ||
        (corrected && accepted.has(corrected.classification))
      ) {
        return [];
      }
      const correctedClassification = corrected?.classification ?? "missing";
      const reasons = corrected ? stringArray(corrected.reasons) : [];
      const explanation =
        correctedClassification === "identity_mapping_failure"
          ? "identity remapping or unresolved identity"
          : correctedClassification === "invalid_match"
            ? reasons.some((reason) => reason.includes("Track counts"))
              ? "track-count rule"
              : reasons.some((reason) => reason.includes("more than 30 days"))
                ? "date rule correcting the former false match"
                : reasons.some((reason) => reason.includes("Version markers conflict"))
                  ? "version conflict"
                  : "matcher rejected for a documented compatibility rule"
            : correctedClassification === "ambiguous_match"
              ? "stricter but uncertain matching"
              : correctedClassification === "spotify_ground_truth_missed_by_itunes"
                ? "mapped catalog contained no compatible title"
                : "another documented cause";
      return [
        {
          canonicalArtist:
            input.artistById.get(release.canonicalArtistId)?.canonicalName ??
            release.canonicalArtistId,
          correctedClassification,
          correctedReasons: reasons,
          explanation,
          firstClassification: first.classification,
          spotifyReleaseId: release.spotifyReleaseId,
          spotifyTitle: release.title,
        },
      ];
    })
    .sort((left, right) => left.canonicalArtist.localeCompare(right.canonicalArtist));
}

function buildIntegrity(input: {
  cacheRows: number;
  correctedRun: typeof itunesPilotRuns.$inferSelect;
  firstRun: typeof itunesPilotRuns.$inferSelect;
  requests: Array<typeof itunesPilotRequestEvents.$inferSelect>;
}) {
  const first = input.requests.filter((request) => request.runId === firstItunesPilotRunId);
  const corrected = input.requests.filter((request) => request.runId === correctedItunesPilotRunId);
  assertItunesOfflineEvidenceIntegrity({
    cacheRows: input.cacheRows,
    correctedCacheHits: corrected.filter((request) => request.cacheHit).length,
    correctedMappings: 50,
    correctedNetworkRequests: corrected.filter((request) => !request.cacheHit).length,
    correctedRequestEvents: corrected.length,
    firstCacheHits: first.filter((request) => request.cacheHit).length,
    firstMappings: 50,
    firstNetworkRequests: first.filter((request) => !request.cacheHit).length,
    firstRequestEvents: first.length,
  });
  return {
    cacheRows: input.cacheRows,
    correctedCacheHits: corrected.filter((request) => request.cacheHit).length,
    correctedNetworkRequests: corrected.filter((request) => !request.cacheHit).length,
    correctedRequestBudget: input.correctedRun.requestBudget,
    correctedRequestEvents: corrected.length,
    firstCacheHits: first.filter((request) => request.cacheHit).length,
    firstNetworkRequests: first.filter((request) => !request.cacheHit).length,
    firstRequestBudget: input.firstRun.requestBudget,
    firstRequestEvents: first.length,
    totalRequestEvents: first.length + corrected.length,
  };
}

function buildCachedCatalogs(
  cacheRows: Array<typeof itunesPilotResponseCache.$inferSelect>,
  mappings: Array<typeof itunesPilotArtistMappings.$inferSelect>,
): Map<string, CachedCatalog> {
  const albums = new Map<string, ItunesNormalizedResponse>();
  const songs = new Map<string, ItunesNormalizedResponse>();
  for (const row of cacheRows) {
    const parsed = new URL(row.requestIdentity, "https://itunes.apple.com");
    if (parsed.pathname !== "/lookup") continue;
    const artistId = parsed.searchParams.get("id");
    const entity = parsed.searchParams.get("entity");
    if (!artistId || artistId.includes(",")) continue;
    const response = normalizedResponse(row.response);
    if (entity === "album") albums.set(artistId, response);
    if (entity === "song") songs.set(artistId, response);
  }
  const candidates = new Map<string, ItunesArtistCandidate>();
  for (const mapping of mappings) {
    for (const candidate of artistArray(mapping.candidates)) {
      candidates.set(candidate.artistId, toArtistCandidate(candidate));
    }
  }
  const result = new Map<string, CachedCatalog>();
  for (const [artistId, candidate] of candidates) {
    const album = albums.get(artistId);
    const song = songs.get(artistId);
    if (!album || !song) continue;
    const albumCollections = album.collections.map(toCollectionCandidate);
    const songCollections = collectionsFromTracks(song.tracks);
    result.set(artistId, {
      albumResultCount: album.collections.length,
      catalog: {
        candidate,
        collections: mergeItunesCollections(albumCollections, songCollections),
        tracks: song.tracks.map(toTrackCandidate),
      },
      songResultCount: song.tracks.length,
    });
  }
  return result;
}

function catalogsForMapping(
  mapping: typeof itunesPilotArtistMappings.$inferSelect,
  catalogs: Map<string, CachedCatalog>,
): CachedCatalog[] {
  return artistArray(mapping.candidates)
    .filter(
      (candidate) =>
        normalizeArtistIdentity(candidate.artistName) ===
        normalizeArtistIdentity(mapping.selectedArtistName ?? candidate.artistName),
    )
    .flatMap((candidate) => {
      const catalog = catalogs.get(candidate.artistId);
      return catalog ? [catalog] : [];
    });
}

function hasAppleCandidate(
  catalog: ItunesIdentityCandidateCatalog,
  selectedArtistId: string,
  start: string,
  end: string,
): boolean {
  return (
    catalog.collections.some(
      (collection) =>
        inDateWindow(collection.releaseDate.slice(0, 10), start, end) &&
        (collection.artistId === selectedArtistId ||
          collection.collectionArtistId === selectedArtistId),
    ) ||
    catalog.tracks.some(
      (track) =>
        inDateWindow(track.releaseDate.slice(0, 10), start, end) &&
        (track.artistId === selectedArtistId || track.collectionArtistId === selectedArtistId),
    )
  );
}

function identityRowsToCsv(rows: IdentityProvenanceRow[]): string {
  const header = [
    "canonical_artist",
    "selected_apple_artist_id",
    "competing_apple_artist_ids",
    "full_decision_score",
    "full_decision_margin",
    "provenance_7_day",
    "resolvable_without_7_day_target",
    "provenance_14_day",
    "resolvable_without_14_day_target",
    "provenance_30_day",
    "resolvable_without_30_day_target",
    "provenance_60_day",
    "resolvable_without_60_day_target",
    "evidence_items_json",
  ];
  return csv([
    header,
    ...rows.map((row) => [
      row.canonicalArtist,
      row.selectedAppleArtistId,
      row.competingAppleArtistIds.join(";"),
      row.fullDecisionScore,
      row.fullDecisionMargin,
      row.provenanceByWindow["7"],
      row.resolvableWithoutTargetWindowByWindow["7"],
      row.provenanceByWindow["14"],
      row.resolvableWithoutTargetWindowByWindow["14"],
      row.provenanceByWindow["30"],
      row.resolvableWithoutTargetWindowByWindow["30"],
      row.provenanceByWindow["60"],
      row.resolvableWithoutTargetWindowByWindow["60"],
      JSON.stringify(row.evidenceItems),
    ]),
  ]);
}

function matchRowsToCsv(rows: MatchReviewRow[]): string {
  const keys = [
    "canonicalArtist",
    "spotifyReleaseId",
    "spotifyTitle",
    "spotifyNormalizedTitle",
    "spotifyReleaseType",
    "spotifyVersion",
    "spotifyDate",
    "spotifyTrackCount",
    "appleCollectionId",
    "appleTitle",
    "appleNormalizedTitle",
    "appleReleaseType",
    "appleVersion",
    "appleDate",
    "appleTrackCount",
    "dateDifferenceDays",
    "trackTitleOverlap",
    "artistCreditCompatible",
    "matchState",
    "matchReason",
    "riskFlags",
  ] as const;
  return csv([keys.map(toSnakeCase), ...rows.map((row) => keys.map((key) => row[key]))]);
}

function csv(rows: Array<Array<boolean | number | string | null | undefined>>): string {
  return `${rows
    .map((row) =>
      row
        .map((value) => {
          const text = value === null || value === undefined ? "" : String(value);
          return `"${text.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\n")}\n`;
}

function normalizedResponse(value: unknown): ItunesNormalizedResponse {
  if (!value || typeof value !== "object") throw new Error("Cached response is not an object.");
  const response = value as Partial<ItunesNormalizedResponse>;
  if (
    !Array.isArray(response.artists) ||
    !Array.isArray(response.collections) ||
    !Array.isArray(response.tracks) ||
    typeof response.declaredResultCount !== "number" ||
    typeof response.unknownResultCount !== "number"
  ) {
    throw new Error("Cached response is not a normalized iTunes response.");
  }
  return response as ItunesNormalizedResponse;
}

function artistArray(value: unknown): ItunesArtist[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    if (typeof record.artistId !== "string" || typeof record.artistName !== "string") return [];
    return [
      {
        artistId: record.artistId,
        artistLinkUrl: typeof record.artistLinkUrl === "string" ? record.artistLinkUrl : undefined,
        artistName: record.artistName,
        artistViewUrl: typeof record.artistViewUrl === "string" ? record.artistViewUrl : undefined,
        wrapperType: "artist" as const,
        ...(typeof record.primaryGenreName === "string"
          ? { primaryGenreName: record.primaryGenreName }
          : {}),
      },
    ];
  });
}

function toGroundTruthRelease(
  row: typeof itunesPilotGroundTruthReleases.$inferSelect,
): GroundTruthRelease {
  return {
    canonicalArtistId: row.canonicalArtistId,
    canonicalReleaseId: row.canonicalReleaseId,
    normalizedTitle: row.normalizedTitle,
    releaseDate: row.releaseDate,
    releaseType: row.releaseType,
    spotifyReleaseId: row.spotifyReleaseId,
    title: row.title,
    ...(row.trackCount === null ? {} : { trackCount: row.trackCount }),
    tracks: groundTruthTracks(row.tracks),
    ...(row.version ? { version: row.version } : {}),
  };
}

function toArtistCandidate(candidate: ItunesArtist): ItunesArtistCandidate {
  const viewUrl = candidate.artistViewUrl ?? candidate.artistLinkUrl;
  return {
    artistId: candidate.artistId,
    artistName: candidate.artistName,
    ...(candidate.primaryGenreName ? { primaryGenreName: candidate.primaryGenreName } : {}),
    ...(viewUrl ? { viewUrl } : {}),
  };
}

function groundTruthTracks(value: unknown): GroundTruthTrack[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.normalizedTitle !== "string") return [];
    return [
      {
        normalizedTitle: record.normalizedTitle,
        title: record.title,
        ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
        ...(typeof record.spotifyTrackId === "string"
          ? { spotifyTrackId: record.spotifyTrackId }
          : {}),
      },
    ];
  });
}

function placementByWindow(date: string, end: string): Record<string, "inside" | "before"> {
  return Object.fromEntries(
    offlineWindows.map((days) => [
      String(days),
      inDateWindow(date, subtractCalendarDays(end, days), end) ? "inside" : "before",
    ]),
  );
}

function uniqueEvidenceItems(items: EvidenceItem[]): EvidenceItem[] {
  return [
    ...new Map(
      items.map((item) => [
        `${item.evidenceKind}:${item.spotifyId}:${item.appleId}:${item.evidenceDate}`,
        item,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.evidenceDate.localeCompare(right.evidenceDate) ||
      left.evidenceKind.localeCompare(right.evidenceKind) ||
      left.spotifyId.localeCompare(right.spotifyId),
  );
}

function subtractCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function inDateWindow(value: string, start: string, end: string): boolean {
  return value >= start && value <= end;
}

function complement(value: number | null): number | null {
  return value === null ? null : 1 - value;
}

function groupBy<T, K>(values: T[], key: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const group = groups.get(key(value)) ?? [];
    group.push(value);
    groups.set(key(value), group);
  }
  return groups;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLocaleLowerCase("en-US");
}
