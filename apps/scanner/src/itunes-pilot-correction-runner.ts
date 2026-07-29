import {
  compareItunesToSpotify,
  decideItunesArtistMapping,
  dedupeItunesTracks,
  mergeItunesCollections,
  normalizeArtistIdentity,
  resolveItunesArtistFromCatalogEvidence,
  type ItunesArtistCandidate,
  type ItunesIdentityCandidateCatalog,
  type ItunesMappingDecision,
  type SpotifyGroundTruthRelease,
} from "@radar/core";
import {
  createItunesRequestPersistence,
  ItunesPilotGateError,
  type RadarDatabase,
} from "@radar/db";
import {
  ItunesClient,
  ItunesClientError,
  type ItunesArtist,
  type ProviderConfiguration,
} from "@radar/providers";
import {
  finishItunesRun,
  pilotArtists,
  pilotGroundTruth,
  saveItunesCollections,
  saveItunesComparisons,
  saveItunesMapping,
  saveItunesTracks,
  startItunesRun,
  updateItunesRunMetrics,
} from "./itunes-pilot-repository";
import {
  collectionsFromTracks,
  toCollectionCandidate,
  toTrackCandidate,
  validateLiveConfiguration,
} from "./itunes-pilot-runner";

const maximumCandidateCatalogs = 75;

interface PendingAmbiguousArtist {
  aliases: string[];
  canonicalArtistId: string;
  canonicalName: string;
  candidates: ItunesArtist[];
  groundTruth: SpotifyGroundTruthRelease[];
}

export async function runCorrectedItunesPilot(input: {
  configuration: ProviderConfiguration;
  db: RadarDatabase;
  runId: string;
}): Promise<{ status: string; stopReason: string }> {
  validateLiveConfiguration(input.configuration);
  const run = await startItunesRun(input.db, input.runId);
  const artists = await pilotArtists(input.db, run.snapshotId);
  if (artists.length !== 50) throw new Error("Correction rerun requires the frozen 50 artists.");
  const client = new ItunesClient({
    enabled: input.configuration.itunes.enabled,
    language: input.configuration.itunes.language,
    maxRequestsPerRun: input.configuration.itunes.maxRequestsPerRun,
    maxResponseBytes: input.configuration.itunes.maxResponseBytes,
    minRequestIntervalMs: input.configuration.itunes.minRequestIntervalMs,
    persistence: createItunesRequestPersistence(input.db),
    requestTimeoutMs: input.configuration.itunes.requestTimeoutMs,
    storefront: input.configuration.itunes.storefront,
  });
  const metrics = {
    ambiguousWithoutGroundTruth: 0,
    candidateCatalogsExamined: 0,
    candidateCatalogsSkippedForBudget: 0,
    correctedAmbiguous: 0,
    evidenceConfirmed: 0,
    exactConfirmed: 0,
    invalidMatches: 0,
    remainingAmbiguous: 0,
  };
  try {
    const pending: PendingAmbiguousArtist[] = [];
    for (const artist of artists) {
      const search = await client.searchArtists(run.id, artist.canonicalName);
      const aliases = stringArray(artist.aliases);
      const firstStage = decideItunesArtistMapping({
        aliases,
        candidates: search.artists.map(toArtistCandidate),
        canonicalName: artist.canonicalName,
      });
      const groundTruthRows = await pilotGroundTruth(input.db, run.snapshotId, [
        artist.canonicalArtistId,
      ]);
      const groundTruth = groundTruthRows.map(toGroundTruthRelease);
      if (
        ["exact_confirmed", "evidence_confirmed"].includes(firstStage.status) &&
        firstStage.selected
      ) {
        if (firstStage.status === "exact_confirmed") metrics.exactConfirmed += 1;
        else metrics.evidenceConfirmed += 1;
        const catalog = await loadCandidateCatalog(client, run.id, firstStage.selected);
        const comparisons = await persistSelectedCatalog(
          input.db,
          run.id,
          artist.canonicalArtistId,
          groundTruth,
          catalog,
        );
        metrics.invalidMatches += comparisons.filter(
          (comparison) => comparison.classification === "invalid_match",
        ).length;
        await saveItunesMapping(input.db, {
          candidates: search.artists,
          canonicalArtistId: artist.canonicalArtistId,
          decision: firstStage,
          runId: run.id,
        });
        continue;
      }
      const exactCandidates = search.artists.filter(
        (candidate) =>
          normalizeArtistIdentity(candidate.artistName) ===
          normalizeArtistIdentity(artist.canonicalName),
      );
      if (groundTruth.length === 0) {
        metrics.ambiguousWithoutGroundTruth += 1;
        metrics.remainingAmbiguous += 1;
        await saveItunesMapping(input.db, {
          candidates: search.artists,
          canonicalArtistId: artist.canonicalArtistId,
          decision: notExaminedDecision(
            firstStage,
            exactCandidates,
            "No frozen releases exist for deterministic catalog-overlap confirmation.",
          ),
          runId: run.id,
        });
        continue;
      }
      pending.push({
        aliases,
        candidates: exactCandidates,
        canonicalArtistId: artist.canonicalArtistId,
        canonicalName: artist.canonicalName,
        groundTruth,
      });
    }

    pending.sort(
      (left, right) =>
        left.candidates.length - right.candidates.length ||
        left.canonicalName.localeCompare(right.canonicalName),
    );
    for (const artist of pending) {
      if (metrics.candidateCatalogsExamined + artist.candidates.length > maximumCandidateCatalogs) {
        metrics.candidateCatalogsSkippedForBudget += artist.candidates.length;
        metrics.remainingAmbiguous += 1;
        await saveItunesMapping(input.db, {
          candidates: artist.candidates,
          canonicalArtistId: artist.canonicalArtistId,
          decision: notExaminedDecision(
            {
              ambiguityReason: "Multiple candidates share the exact normalized canonical name.",
              confidence: 0,
              evidence: [],
              reason: "Exact name is not unique.",
              status: "ambiguous",
            },
            artist.candidates,
            "Candidate catalogs were not started because the complete artist would exceed the 150-request correction budget.",
          ),
          runId: run.id,
        });
        await saveIdentityFailures(
          input.db,
          run.id,
          artist.canonicalArtistId,
          artist.groundTruth,
          "Catalog evidence was not examined within the correction request budget.",
        );
        continue;
      }
      const catalogs: ItunesIdentityCandidateCatalog[] = [];
      for (const candidate of artist.candidates) {
        catalogs.push(await loadCandidateCatalog(client, run.id, toArtistCandidate(candidate)));
        metrics.candidateCatalogsExamined += 1;
      }
      const decision = resolveItunesArtistFromCatalogEvidence({
        aliases: artist.aliases,
        candidates: catalogs,
        canonicalName: artist.canonicalName,
        groundTruth: artist.groundTruth,
      });
      await saveItunesMapping(input.db, {
        candidates: artist.candidates,
        canonicalArtistId: artist.canonicalArtistId,
        decision,
        runId: run.id,
      });
      if (decision.status === "evidence_confirmed" && decision.selected) {
        const selected = catalogs.find(
          (catalog) => catalog.candidate.artistId === decision.selected?.artistId,
        );
        if (!selected) throw new Error("Selected catalog evidence is missing.");
        metrics.correctedAmbiguous += 1;
        metrics.evidenceConfirmed += 1;
        const comparisons = await persistSelectedCatalog(
          input.db,
          run.id,
          artist.canonicalArtistId,
          artist.groundTruth,
          selected,
        );
        metrics.invalidMatches += comparisons.filter(
          (comparison) => comparison.classification === "invalid_match",
        ).length;
      } else {
        metrics.remainingAmbiguous += 1;
        await saveIdentityFailures(
          input.db,
          run.id,
          artist.canonicalArtistId,
          artist.groundTruth,
          "Catalog evidence remained ambiguous after individual candidate lookups.",
        );
      }
    }
    const controlledPartial = metrics.candidateCatalogsSkippedForBudget > 0;
    const status = controlledPartial ? "controlled_partial" : "completed";
    const stopReason = controlledPartial
      ? "correction_candidate_budget_prioritization_complete"
      : "correction_workflow_completed";
    await updateItunesRunMetrics(input.db, run.id, metrics);
    await finishItunesRun(input.db, run.id, { status, stopReason });
    return { status, stopReason };
  } catch (error) {
    await updateItunesRunMetrics(input.db, run.id, metrics);
    const controlled =
      error instanceof ItunesPilotGateError ||
      (error instanceof ItunesClientError && error.status === 429);
    const stopReason =
      error instanceof ItunesPilotGateError
        ? error.classification
        : error instanceof ItunesClientError
          ? error.classification
          : "data_integrity_failure";
    await finishItunesRun(input.db, run.id, {
      status: controlled ? "controlled_partial" : "failed",
      stopReason,
    });
    if (!controlled) throw error;
    return { status: "controlled_partial", stopReason };
  }
}

async function loadCandidateCatalog(
  client: ItunesClient,
  runId: string,
  candidate: ItunesArtistCandidate,
): Promise<ItunesIdentityCandidateCatalog> {
  const albums = await client.lookupAlbums(runId, [candidate.artistId]);
  const songs = await client.lookupSongs(runId, [candidate.artistId]);
  const albumCollections = albums.collections.map(toCollectionCandidate);
  const songCollections = collectionsFromTracks(songs.tracks);
  return {
    candidate,
    collections: mergeItunesCollections(albumCollections, songCollections),
    tracks: dedupeItunesTracks(songs.tracks.map(toTrackCandidate)),
  };
}

async function persistSelectedCatalog(
  db: RadarDatabase,
  runId: string,
  canonicalArtistId: string,
  groundTruth: SpotifyGroundTruthRelease[],
  catalog: ItunesIdentityCandidateCatalog,
) {
  await saveItunesCollections(db, {
    canonicalArtistId,
    collections: catalog.collections,
    runId,
  });
  await saveItunesTracks(db, {
    canonicalArtistId,
    mappedArtistId: catalog.candidate.artistId,
    runId,
    tracks: catalog.tracks,
  });
  const comparisons = compareItunesToSpotify(groundTruth, catalog.collections);
  await saveItunesComparisons(db, { canonicalArtistId, comparisons, runId });
  return comparisons;
}

async function saveIdentityFailures(
  db: RadarDatabase,
  runId: string,
  canonicalArtistId: string,
  groundTruth: SpotifyGroundTruthRelease[],
  reason: string,
) {
  await saveItunesComparisons(db, {
    canonicalArtistId,
    comparisons: groundTruth.map((release) => ({
      classification: "identity_mapping_failure",
      reasons: [reason],
      spotifyReleaseId: release.spotifyReleaseId,
    })),
    runId,
  });
}

function notExaminedDecision(
  firstStage: ItunesMappingDecision,
  candidates: ItunesArtist[],
  reason: string,
): ItunesMappingDecision {
  return {
    ...(firstStage.ambiguityReason ? { ambiguityReason: firstStage.ambiguityReason } : {}),
    candidateEvidence: candidates.map((candidate) => ({
      artistId: candidate.artistId,
      confidence: 0,
      conflictingReleases: [],
      creditCompatible: false,
      decision: "not_examined",
      decisionReason: reason,
      evidenceExamined: ["cached artist-search identity only"],
      exactReleaseTitleMatches: 0,
      matchedReleases: [],
      score: 0,
      trackTitleOverlap: 0,
    })),
    confidence: 0,
    evidence: [],
    reason,
    status: "ambiguous",
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

function toGroundTruthRelease(
  release: Awaited<ReturnType<typeof pilotGroundTruth>>[number],
): SpotifyGroundTruthRelease {
  return {
    canonicalReleaseId: release.canonicalReleaseId,
    normalizedTitle: release.normalizedTitle,
    releaseDate: release.releaseDate,
    releaseType: release.releaseType,
    spotifyReleaseId: release.spotifyReleaseId,
    title: release.title,
    ...(release.trackCount === null ? {} : { trackCount: release.trackCount }),
    tracks: groundTruthTracks(release.tracks),
    ...(release.version ? { version: release.version } : {}),
  };
}

function groundTruthTracks(value: unknown): NonNullable<SpotifyGroundTruthRelease["tracks"]> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.normalizedTitle !== "string") return [];
    return [
      {
        ...(typeof record.durationMs === "number" ? { durationMs: record.durationMs } : {}),
        normalizedTitle: record.normalizedTitle,
        title: record.title,
      },
    ];
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
