import {
  log,
  matchCandidate,
  normalizeIdentifier,
  normalizeText,
  parseAppleMusicReleaseArtwork,
  parseSpotifyReleaseArtwork,
  type CanonicalTrack,
  type MatchDecision,
  type TrackCandidate,
} from "@radar/core";
import {
  artistAliases,
  artistExternalIds,
  artistFollows,
  artists,
  attachSpotifyBatchScanRun,
  createDatabase,
  createMusicBrainzRequestGate,
  createMusicBrainzBatch,
  loadMusicBrainzBatchArtistIds,
  startMusicBrainzArtist,
  recordMusicBrainzStage,
  finishMusicBrainzBatch,
  attachMusicBrainzBatchScanRun,
  createSpotifyRequestGate,
  deferSpotifyRequests,
  claimNextSpotifyArtist,
  acquireOperationLock,
  expireDetailedScanData,
  feedItems,
  providerCursors,
  releaseCandidates,
  releaseExternalIds,
  releaseTrackAppearances,
  releaseTrackAppearanceSources,
  releases,
  scanLocks,
  scanRuns,
  sourceEvidence,
  trackAvailabilities,
  trackCredits,
  trackExternalIds,
  tracks,
  upcomingAnnouncements,
  upcomingDateHistory,
  users,
  ensureLocalOwner,
  SpotifyTokenManager,
  finishSpotifyArtistScan,
  heartbeatOperationLock,
  operationCancellationRequested,
  releaseOperationLock,
  type RadarDatabase,
  SpotifyCooldownError,
  markSpotifyCoverageInterrupted,
  markSpotifyReleaseTrackInterrupted,
  pauseSpotifyArtistForBudget,
  queueSpotifyReleaseDetailWork,
  recordSpotifyPage,
  recordSpotifyReleaseTrackPage,
  requestSpotifyBatchPause,
  spotifyScanBatches,
  startSpotifyReleaseTrackRetrieval,
} from "@radar/db";
import {
  loadProviderConfiguration,
  MockProvider,
  MusicBrainzClient,
  MusicBrainzProvider,
  SpotifyClient,
  SpotifyOAuthClient,
  SpotifyProvider,
  SpotifyHttpError,
  type CanonicalArtistMappingInput,
  type DiscoveryProvider,
  type ProviderReleaseObservation,
  type ProviderScanPage,
  type ProviderReleaseTrackPage,
  type SpotifyArtistMapping,
  type SpotifyRequestTelemetry,
  type SpotifyRequestGate,
} from "@radar/providers";
import { mockProviderFixture } from "@radar/testing";
import { and, eq, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ScannerOptions } from "./args";
import { runAppleMusicScan } from "./apple-music-scan";
import {
  buildDryRunReport,
  candidateKey,
  type DryRunPageReport,
  type DryRunReport,
} from "./dry-run-report";
import { runRedditScan } from "./reddit-scan";
import { prepareSpotifyWork, type PreparedSpotifyWork } from "./spotify-scan-plan";

export interface ScanSummary {
  discovered: number;
  inserted: number;
  skipped: number;
  needsReview: number;
  dryRun: boolean;
  dryRunReport?: DryRunReport;
  providerResults?: Record<string, { error?: string; inserted: number; discovered: number }>;
}

export class DryRunOperationalError extends Error {
  constructor(
    message: string,
    readonly classification: string,
    readonly summary: ScanSummary,
  ) {
    super(message);
    this.name = "DryRunOperationalError";
  }
}

export class SpotifyRequestBudgetError extends Error {
  constructor(readonly maximumRequests: number) {
    super(`Spotify request budget of ${maximumRequests} requests was reached.`);
    this.name = "SpotifyRequestBudgetError";
  }
}

interface PreparedMusicBrainzWork {
  batchId: string;
  mappings: CanonicalArtistMappingInput[];
}

type DatabaseExecutor = Pick<RadarDatabase, "insert" | "query" | "select">;

export interface ScanRuntime {
  deadlineAt?: number;
  deferSpotifyReleaseDetails?: boolean;
  reportProgress: (metadata: Record<string, unknown>, force?: boolean) => Promise<void>;
  requestGateWrapper?: (gate: SpotifyRequestGate) => SpotifyRequestGate;
  schedulerContext?: {
    campaignId?: string;
    campaignMemberId?: string | null;
    workId: string;
    workType: "base_artist" | "release_detail" | "release_tracks" | "artist_reconciliation";
  };
  signal: AbortSignal;
}

export interface PersistRunContext {
  artistsProcessedCount: number;
  cumulativeBase: ScanSummary;
  id: string;
  status: "running" | "completed" | "partial" | "paused" | "cancelled" | "rate_limited";
}

const scanHeartbeatTtlMs = 30_000;

export async function runScan(options: ScannerOptions): Promise<ScanSummary> {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) return runScanUnlocked(options, configuration);
  const lockDatabase = createDatabase(configuration.databaseUrl);
  await expireDetailedScanData(lockDatabase.db);
  const handle = await acquireOperationLock(lockDatabase.db, {
    lockKey: "scan:global",
    metadata: {
      artistId: options.artistId ?? null,
      dryRun: options.dryRun,
      provider: options.provider ?? "all",
      source: options.source ?? null,
    },
    operationType: options.provider ? "provider_scan" : "normal_scan",
  });
  const controller = new AbortController();
  const progressMetadata: Record<string, unknown> = {
    artistId: options.artistId ?? null,
    completedUnits: 0,
    currentProvider: null,
    dryRun: options.dryRun,
    phase: "starting",
    provider: options.provider ?? "all",
    providersCompleted: [],
    providersFailed: [],
    requests: 0,
    rateLimitWaitMs: 0,
    source: options.source ?? null,
    totalUnits: 0,
  };
  let lastHeartbeatAt = 0;
  let heartbeatBusy = false;
  const reportProgress = async (metadata: Record<string, unknown>, force = false) => {
    Object.assign(progressMetadata, metadata);
    if (
      force &&
      !controller.signal.aborted &&
      (await operationCancellationRequested(lockDatabase.db, handle))
    ) {
      const error = new Error("Scan cancelled by the user.");
      controller.abort(error);
      throw error;
    }
    const now = Date.now();
    if (heartbeatBusy || (!force && now - lastHeartbeatAt < 2_000)) return;
    heartbeatBusy = true;
    try {
      const active = await heartbeatOperationLock(
        lockDatabase.db,
        handle,
        progressMetadata,
        scanHeartbeatTtlMs,
      );
      if (!active) {
        const error = new Error("The scan operation lock was lost.");
        controller.abort(error);
        throw error;
      }
      lastHeartbeatAt = now;
    } finally {
      heartbeatBusy = false;
    }
  };
  await reportProgress({}, true);
  let monitorTask = Promise.resolve();
  const monitor = setInterval(() => {
    monitorTask = monitorTask.then(async () => {
      try {
        if (await operationCancellationRequested(lockDatabase.db, handle)) {
          controller.abort(new Error("Scan cancelled by the user."));
          return;
        }
        await reportProgress({}, true);
      } catch (error) {
        log("warn", "scan.heartbeat_failed", { message: safeScanError(error) });
      }
    });
  }, 5_000);
  monitor.unref();
  try {
    return await runScanUnlocked(options, configuration, {
      reportProgress,
      signal: controller.signal,
    });
  } finally {
    clearInterval(monitor);
    await monitorTask;
    await releaseOperationLock(lockDatabase.db, handle);
    await lockDatabase.client.end();
  }
}

export async function runScanUnlocked(
  options: ScannerOptions,
  configuration: ReturnType<typeof loadProviderConfiguration>,
  runtime?: ScanRuntime,
): Promise<ScanSummary> {
  const requested = options.provider;
  if (
    requested &&
    !["mock", "spotify", "musicbrainz", "reddit", "apple_music"].includes(requested)
  ) {
    throw new Error(`Provider ${requested} is excluded from the current milestone`);
  }

  if (requested === "apple_music") {
    if (!configuration.databaseUrl) {
      throw new Error("DATABASE_URL is required for Apple Music scans");
    }
    const { db, client } = createDatabase(configuration.databaseUrl);
    try {
      return await runAppleMusicScan(
        db,
        configuration,
        options,
        (candidates, context) =>
          persistCandidates(
            db,
            candidates,
            { ...options, provider: "apple_music" },
            undefined,
            undefined,
            context,
          ),
        runtime ?? {},
      );
    } finally {
      await client.end();
    }
  }

  if (requested === "reddit") {
    if (!configuration.databaseUrl) {
      throw new Error("DATABASE_URL is required for Reddit scans");
    }
    const { db, client } = createDatabase(configuration.databaseUrl);
    try {
      return await runRedditScan(db, configuration, options);
    } finally {
      await client.end();
    }
  }

  let selected: Array<"mock" | "spotify" | "musicbrainz"> = requested
    ? [requested as "mock" | "spotify" | "musicbrainz"]
    : [
        ...(configuration.spotify.configured ? (["spotify"] as const) : []),
        ...(configuration.musicbrainz.configured ? (["musicbrainz"] as const) : []),
      ];
  if (selected.length === 0) selected.push("mock");
  await runtime?.reportProgress({ providersRequested: selected }, true);

  if (selected.length === 1 && selected[0] === "mock") {
    const result = await new MockProvider(mockProviderFixture).scan({
      filter: {
        ...(options.full ? { full: true } : {}),
        provider: "mock",
        ...(options.since ? { since: options.since } : {}),
      },
    });
    const summary: ScanSummary = {
      discovered: result.candidates.length,
      inserted: 0,
      skipped: 0,
      needsReview: 0,
      dryRun: options.dryRun,
    };
    if (options.dryRun) {
      log("info", "scan.dry_run_completed", summary);
      return summary;
    }
    const { db, client } = createDatabase();
    try {
      return await persistCandidates(db, result.candidates, options, result.nextCursor);
    } finally {
      await client.end();
    }
  }

  if (!configuration.databaseUrl) {
    throw new Error("DATABASE_URL is required for configured provider scans");
  }
  const { db, client } = createDatabase(configuration.databaseUrl);
  const aggregate: ScanSummary = {
    discovered: 0,
    inserted: 0,
    skipped: 0,
    needsReview: 0,
    dryRun: options.dryRun,
    providerResults: {},
  };
  const backfillStart =
    options.since ??
    new Date(Date.now() - configuration.initialBackfillDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
  try {
    let spotifyWork: PreparedSpotifyWork | undefined;
    let musicBrainzWork: PreparedMusicBrainzWork | undefined;
    if (selected.includes("spotify")) {
      spotifyWork = await prepareSpotifyWork(db, await spotifyMappings(db), configuration, options);
      if (spotifyWork.paused) {
        const pausedRunId = options.dryRun
          ? undefined
          : await createProviderScanRun(db, "spotify", options);
        if (pausedRunId) {
          await attachSpotifyBatchScanRun(db, spotifyWork.batchId, pausedRunId);
          await db
            .update(scanRuns)
            .set({
              metadata: { batchId: spotifyWork.batchId, mode: spotifyWork.mode },
              status: "paused",
            })
            .where(eq(scanRuns.id, pausedRunId));
        }
        aggregate.providerResults!.spotify = { discovered: 0, inserted: 0 };
        await runtime?.reportProgress(
          {
            currentProvider: null,
            phase: "spotify_batch_confirmation_required",
            spotifyBatchId: spotifyWork.batchId,
          },
          true,
        );
        selected = selected.filter((provider) => provider !== "spotify");
        if (requested === "spotify") return aggregate;
      }
    }
    if (selected.includes("musicbrainz")) {
      const availableMappings = await musicBrainzMappings(db);
      const requestedMappings = options.artistId
        ? availableMappings.filter((mapping) => mapping.artistId === options.artistId)
        : availableMappings;
      if (options.artistId && requestedMappings.length === 0) {
        throw new Error("The selected artist does not have a confirmed MusicBrainz mapping.");
      }
      const batchId =
        options.musicbrainzBatchId ??
        (await createMusicBrainzBatch(
          db,
          requestedMappings.map((mapping) => mapping.artistId),
        ));
      const pendingArtistIds = options.musicbrainzBatchId
        ? await loadMusicBrainzBatchArtistIds(db, batchId)
        : requestedMappings.map((mapping) => mapping.artistId);
      const pending = new Set(pendingArtistIds);
      musicBrainzWork = {
        batchId,
        mappings: requestedMappings.filter((mapping) => pending.has(mapping.artistId)),
      };
    }
    const providers = await buildProviders(
      db,
      selected,
      configuration,
      spotifyWork,
      musicBrainzWork,
      runtime
        ? (telemetry) => runtime.reportProgress(spotifyTelemetryMetadata(telemetry))
        : undefined,
      runtime,
    );
    const failures: Error[] = [];
    const providersCompleted: string[] = [];
    const providersFailed: string[] = [];
    for (const provider of providers) {
      let providerRunId: string | undefined;
      let currentSpotifyArtistScan: Awaited<ReturnType<typeof claimNextSpotifyArtist>> | undefined;
      let previousSpotifyRequestCount = 0;
      let spotifyArtistRequestBase = 0;
      let spotifyPageRequestBase = 0;
      let currentSpotifyPagesScanned = 0;
      let currentSpotifyCandidateCount = 0;
      let musicBrainzArtistRequestBase = 0;
      let previousMusicBrainzRequestCount = 0;
      const dryRunCandidates: TrackCandidate[] = [];
      const dryRunReleases: ProviderReleaseObservation[] = [];
      const dryRunPages: DryRunPageReport[] = [];
      let dryRunPagesScanned = 0;
      let dryRunPartial = false;
      try {
        await runtime?.reportProgress(
          {
            completedUnits: 0,
            currentProvider: provider.name,
            currentUnit: null,
            phase: "provider_start",
            totalUnits: 0,
          },
          true,
        );
        if (provider.name === "musicbrainz") {
          await new Promise((resolve) =>
            setTimeout(resolve, 100 + Math.floor(Math.random() * 400)),
          );
        }
        providerRunId = options.dryRun
          ? undefined
          : await createProviderScanRun(db, provider.name, options);
        if (provider.name === "spotify" && providerRunId && spotifyWork) {
          await attachSpotifyBatchScanRun(db, spotifyWork.batchId, providerRunId);
        }
        if (provider.name === "musicbrainz" && providerRunId && musicBrainzWork) {
          await attachMusicBrainzBatchScanRun(db, musicBrainzWork.batchId, providerRunId);
        }
        let incrementalSummary = emptyScanSummary(false);
        let batchPersisted = false;
        let artistsProcessedCount = 0;
        const result = await provider.scan({
          filter: {
            ...(options.artistId ? { artistId: options.artistId } : {}),
            ...(options.full ? { full: true } : {}),
            provider: provider.name,
            since: backfillStart,
          },
          ...(provider.name === "spotify"
            ? {
                onUnitStart: async (unit) => {
                  currentSpotifyArtistScan = await claimNextSpotifyArtist(db, spotifyWork!.batchId);
                  if (!currentSpotifyArtistScan) return false;
                  if (currentSpotifyArtistScan.artistId !== unit.currentUnitId) {
                    throw new Error(
                      "Spotify batch order no longer matches the provider work list.",
                    );
                  }
                  spotifyArtistRequestBase = previousSpotifyRequestCount;
                  spotifyPageRequestBase = previousSpotifyRequestCount;
                  currentSpotifyPagesScanned = 0;
                  currentSpotifyCandidateCount = 0;
                  await runtime?.reportProgress(
                    {
                      completedUnits: unit.position,
                      currentUnit: unit.currentUnit,
                      phase: "scanning",
                      spotifyBatchId: spotifyWork!.batchId,
                      totalUnits: unit.totalUnits,
                    },
                    true,
                  );
                  return true;
                },
                onPage: async (page: ProviderScanPage) => {
                  if (!currentSpotifyArtistScan) {
                    throw new Error("Spotify page completed without claimed artist progress.");
                  }
                  batchPersisted = true;
                  currentSpotifyPagesScanned += 1;
                  if (options.dryRun) currentSpotifyCandidateCount += page.candidates.length;
                  const pageRequestCount = Math.max(
                    0,
                    page.providerMetrics.requests - spotifyPageRequestBase,
                  );
                  spotifyPageRequestBase = page.providerMetrics.requests;
                  if (options.dryRun) {
                    dryRunCandidates.push(...page.candidates);
                    dryRunReleases.push(...page.releases);
                    dryRunPagesScanned += 1;
                    dryRunPartial = page.nextOffset !== null;
                    dryRunPages.push({
                      albumDetailRequests: page.albumDetailRequests,
                      candidateTracks: page.candidates.length,
                      durationMs: page.durationMs,
                      nextOffset: page.nextOffset,
                      offset: page.offset,
                      pageNumber: page.pageNumber,
                      releases: page.releases,
                      requestCount: pageRequestCount,
                      totalItems: page.totalItems,
                    });
                    incrementalSummary = addScanSummaries(incrementalSummary, {
                      discovered: page.candidates.length,
                      dryRun: true,
                      inserted: 0,
                      needsReview: 0,
                      skipped: 0,
                    });
                  }
                  await recordSpotifyPage(db, {
                    albumDetailRequests: page.albumDetailRequests,
                    artistId: page.currentUnitId,
                    artistScanId: currentSpotifyArtistScan.id,
                    backfillReleaseCount: page.releases.filter(
                      (release) => release.backfillEligible,
                    ).length,
                    batchId: spotifyWork!.batchId,
                    candidateCount: page.candidates.length,
                    cycleId: spotifyWork!.reconciliationCycleIds.get(page.currentUnitId) ?? null,
                    dryRun: options.dryRun,
                    durationMs: page.durationMs,
                    finishedAt: page.finishedAt,
                    itemCount: page.itemCount,
                    mode: spotifyWork!.mode,
                    nextOffset: page.nextOffset,
                    offset: page.offset,
                    pageNumber: page.pageNumber,
                    releases: page.releases.map((release) => ({
                      detailsFetched:
                        release.selectedForDetails && !runtime?.deferSpotifyReleaseDetails,
                      externalReleaseId: release.externalReleaseId,
                      releaseDate: release.releaseDate,
                      releaseDatePrecision: release.releaseDatePrecision,
                      releaseType: release.releaseType,
                      title: release.title,
                      totalTracks: release.totalTracks,
                    })),
                    requestCount: pageRequestCount,
                    startedAt: page.startedAt,
                    totalItems: page.totalItems,
                  });
                  if (!options.dryRun && runtime?.deferSpotifyReleaseDetails) {
                    for (const release of page.releases.filter(
                      (candidate) => candidate.selectedForDetails,
                    )) {
                      await queueSpotifyReleaseDetailWork(db, {
                        artistId: page.currentUnitId,
                        ...(runtime.schedulerContext?.campaignId
                          ? {
                              campaignId: runtime.schedulerContext.campaignId,
                              campaignMemberId: runtime.schedulerContext.campaignMemberId ?? null,
                            }
                          : {}),
                        dueAt: page.finishedAt,
                        spotifyAlbumId: release.externalReleaseId,
                      });
                    }
                  }
                  await runtime?.reportProgress(
                    {
                      currentStage: `page_${page.pageNumber}_persisted`,
                      currentUnit: page.currentUnit,
                      lastPersistedResult: `${page.itemCount} release summaries at offset ${page.offset}`,
                      phase: "scanning",
                      requests: page.providerMetrics.requests,
                    },
                    true,
                  );
                },
                onReleaseTrackStart: async (release) => {
                  if (options.dryRun) return;
                  await startSpotifyReleaseTrackRetrieval(db, {
                    expectedTotalTracks: release.expectedTotalTracks,
                    reconciliationCycleId:
                      spotifyWork!.reconciliationCycleIds.get(release.currentUnitId) ?? null,
                    spotifyAlbumId: release.externalReleaseId,
                  });
                },
                onReleaseTrackPage: async (releasePage: ProviderReleaseTrackPage) => {
                  if (options.dryRun) return;
                  if (!currentSpotifyArtistScan) {
                    throw new Error(
                      "Spotify album track page completed without claimed artist progress.",
                    );
                  }
                  const pageSummary = await persistCandidates(
                    db,
                    releasePage.candidates,
                    { ...options, provider: "spotify" },
                    undefined,
                    undefined,
                    {
                      artistsProcessedCount,
                      cumulativeBase: incrementalSummary,
                      id: providerRunId!,
                      status: "running",
                    },
                  );
                  incrementalSummary = addScanSummaries(incrementalSummary, pageSummary);
                  currentSpotifyCandidateCount += releasePage.candidates.length;
                  await recordSpotifyReleaseTrackPage(db, {
                    ...(releasePage.errorClassification
                      ? { errorClassification: releasePage.errorClassification }
                      : {}),
                    expectedTotalTracks: releasePage.expectedTotalTracks,
                    finishedAt: releasePage.finishedAt,
                    items: releasePage.items,
                    nextOffset: releasePage.nextOffset,
                    offset: releasePage.offset,
                    reconciliationCycleId:
                      spotifyWork!.reconciliationCycleIds.get(releasePage.currentUnitId) ?? null,
                    spotifyAlbumId: releasePage.externalReleaseId,
                    startedAt: releasePage.startedAt,
                    terminal: releasePage.terminal,
                  });
                  batchPersisted = true;
                  await runtime?.reportProgress(
                    {
                      currentStage: `album_tracks_${releasePage.offset}_persisted`,
                      lastPersistedResult: `${releasePage.items.length} album tracks persisted`,
                      phase: "scanning",
                    },
                    true,
                  );
                },
                onReleaseTrackError: async (releaseError) => {
                  if (options.dryRun) return;
                  await markSpotifyReleaseTrackInterrupted(db, {
                    errorClassification: releaseError.classification,
                    spotifyAlbumId: releaseError.externalReleaseId,
                    status: releaseError.status,
                  });
                },
                onBatch: async (batch) => {
                  batchPersisted = true;
                  artistsProcessedCount = batch.completedUnits;
                  if (currentSpotifyArtistScan) {
                    const requestCount = Math.max(
                      0,
                      (batch.providerMetrics?.requests ?? spotifyArtistRequestBase) -
                        spotifyArtistRequestBase,
                    );
                    previousSpotifyRequestCount = batch.providerMetrics?.requests ?? 0;
                    await finishSpotifyArtistScan(db, {
                      artistScanId: currentSpotifyArtistScan.id,
                      ...spotifyReleaseTelemetry(batch.releases),
                      candidateCount: batch.candidates.length,
                      pagesScanned: batch.pagesScanned ?? 0,
                      requestCount,
                      status: batch.partial ? "partial" : "completed",
                    });
                    currentSpotifyArtistScan = undefined;
                  }
                  await runtime?.reportProgress(
                    {
                      completedUnits: batch.completedUnits,
                      currentUnit: batch.currentUnit,
                      phase: "scanning",
                      rateLimitWaitMs: batch.providerMetrics?.waitMs ?? 0,
                      requests: batch.providerMetrics?.requests ?? 0,
                      totalUnits: batch.totalUnits,
                    },
                    true,
                  );
                },
              }
            : provider.name === "musicbrainz"
              ? {
                  onUnitStart: async (unit) => {
                    if (!musicBrainzWork) return false;
                    const claimed = await startMusicBrainzArtist(
                      db,
                      musicBrainzWork.batchId,
                      unit.currentUnitId,
                    );
                    if (!claimed) return false;
                    musicBrainzArtistRequestBase = previousMusicBrainzRequestCount;
                    await runtime?.reportProgress(
                      {
                        completedUnits: unit.position,
                        currentUnit: unit.currentUnit,
                        currentUnitId: unit.currentUnitId,
                        currentStage: "artist_start",
                        phase: "scanning",
                        totalUnits: unit.totalUnits,
                      },
                      true,
                    );
                    return !runtime?.signal.aborted;
                  },
                  onBatch: async (batch) => {
                    batchPersisted = true;
                    artistsProcessedCount = batch.completedUnits;
                    const batchSummary = options.dryRun
                      ? {
                          discovered: batch.candidates.length,
                          dryRun: true,
                          inserted: 0,
                          needsReview: 0,
                          skipped: 0,
                        }
                      : await persistCandidates(
                          db,
                          batch.candidates,
                          { ...options, provider: provider.name },
                          undefined,
                          batch.providerMetrics,
                          {
                            artistsProcessedCount: batch.completedUnits,
                            cumulativeBase: incrementalSummary,
                            id: providerRunId!,
                            status: "running",
                          },
                        );
                    incrementalSummary = addScanSummaries(incrementalSummary, batchSummary);
                    if (musicBrainzWork && batch.currentUnitId && batch.stage) {
                      await recordMusicBrainzStage(db, {
                        artistId: batch.currentUnitId,
                        batchId: musicBrainzWork.batchId,
                        candidateCount: batch.candidates.length,
                        ...(batch.releaseCount === undefined
                          ? {}
                          : { releaseCount: batch.releaseCount }),
                        ...(batch.releaseGroupCount === undefined
                          ? {}
                          : { releaseGroupCount: batch.releaseGroupCount }),
                        requestCount: Math.max(
                          0,
                          (batch.providerMetrics?.requests ?? 0) - musicBrainzArtistRequestBase,
                        ),
                        stage: batch.stage as
                          | "artist_start"
                          | "release_groups"
                          | "primary_releases"
                          | "track_appearances",
                      });
                      if (batch.stage === "track_appearances") {
                        previousMusicBrainzRequestCount = batch.providerMetrics?.requests ?? 0;
                      }
                    }
                    await runtime?.reportProgress(
                      {
                        completedUnits: batch.completedUnits,
                        currentStage: batch.stage ?? "scanning",
                        currentUnit: batch.currentUnit,
                        currentUnitId: batch.currentUnitId ?? null,
                        lastPersistedResult: batch.lastPersistedResult ?? null,
                        phase: "scanning",
                        rateLimitWaitMs: batch.providerMetrics?.waitMs ?? 0,
                        requests: batch.providerMetrics?.requests ?? 0,
                        totalUnits: batch.totalUnits,
                      },
                      true,
                    );
                  },
                }
              : {}),
          ...(runtime ? { signal: runtime.signal } : {}),
        });
        if (provider.name === "spotify" && spotifyWork && spotifyWork.deferredArtistCount > 0) {
          const paused = await requestSpotifyBatchPause(db, spotifyWork.batchId);
          if (!paused) {
            const batch = await db.query.spotifyScanBatches.findFirst({
              where: eq(spotifyScanBatches.id, spotifyWork.batchId),
              columns: { status: true },
            });
            if (batch?.status !== "paused") {
              throw new Error("Spotify batch could not be paused after its bounded artist chunk.");
            }
          }
        }
        const persistedBatchStatus =
          provider.name === "spotify" && spotifyWork
            ? await db.query.spotifyScanBatches.findFirst({
                where: eq(spotifyScanBatches.id, spotifyWork.batchId),
                columns: { status: true },
              })
            : null;
        const providerOutcome =
          persistedBatchStatus?.status === "paused" ||
          persistedBatchStatus?.status === "cancelled" ||
          persistedBatchStatus?.status === "rate_limited"
            ? persistedBatchStatus.status
            : "completed";
        if (options.dryRun && provider.name === "spotify") {
          aggregate.dryRunReport = await createSpotifyDryRunReport(db, {
            backfillStart,
            candidates: dryRunCandidates,
            pagesScanned: dryRunPagesScanned,
            partial: dryRunPartial,
            releases: dryRunReleases,
            pages: dryRunPages,
            requestCount: result.providerMetrics?.requests ?? 0,
          });
        }
        const summary = batchPersisted
          ? options.dryRun
            ? incrementalSummary
            : (await persistCandidates(
                db,
                [],
                { ...options, provider: provider.name },
                result.nextCursor,
                result.providerMetrics,
                {
                  artistsProcessedCount,
                  cumulativeBase: incrementalSummary,
                  id: providerRunId!,
                  status: providerOutcome,
                },
              ),
              incrementalSummary)
          : options.dryRun
            ? {
                discovered: result.candidates.length,
                dryRun: true,
                inserted: 0,
                needsReview: 0,
                skipped: 0,
              }
            : await persistCandidates(
                db,
                result.candidates,
                { ...options, provider: provider.name },
                result.nextCursor,
                result.providerMetrics,
                {
                  artistsProcessedCount: new Set(
                    result.candidates.map((candidate) => candidate.artistExternalId),
                  ).size,
                  cumulativeBase: emptyScanSummary(false),
                  id: providerRunId!,
                  status: providerOutcome,
                },
              );
        aggregate.discovered += summary.discovered;
        aggregate.inserted += summary.inserted;
        aggregate.skipped += summary.skipped;
        aggregate.needsReview += summary.needsReview;
        aggregate.providerResults![provider.name] = {
          discovered: summary.discovered,
          inserted: summary.inserted,
        };
        if (providerOutcome === "completed") providersCompleted.push(provider.name);
        if (provider.name === "musicbrainz" && musicBrainzWork) {
          await finishMusicBrainzBatch(db, musicBrainzWork.batchId, "completed");
        }
        if (provider.name === "spotify" && providerOutcome === "completed") {
          const defer = () =>
            deferSpotifyRequests(
              db,
              spotifyBatchPauseMilliseconds(configuration.spotify.batchPauseSeconds),
            );
          if (options.dryRun && aggregate.dryRunReport) {
            await runDryRunFinalOperationalStep(aggregate, "request_deferral_failed", defer);
          } else {
            await defer();
          }
        }
        const reportCompletion = () =>
          runtime?.reportProgress(
            {
              currentProvider: null,
              phase: providerOutcome === "completed" ? "provider_completed" : providerOutcome,
              providersCompleted,
            },
            true,
          ) ?? Promise.resolve();
        if (options.dryRun && aggregate.dryRunReport) {
          await runDryRunFinalOperationalStep(
            aggregate,
            "progress_telemetry_failed",
            reportCompletion,
          );
          aggregate.dryRunReport.finalOperationalStep = { status: "completed" };
        } else {
          await reportCompletion();
        }
      } catch (error) {
        const outcomeStatus = scanOutcomeStatus(error, runtime?.signal);
        if (provider.name === "musicbrainz" && musicBrainzWork) {
          await finishMusicBrainzBatch(
            db,
            musicBrainzWork.batchId,
            outcomeStatus === "cancelled" ? "cancelled" : "failed",
          );
        }
        if (provider.name === "spotify" && currentSpotifyArtistScan) {
          const rateLimited = outcomeStatus === "rate_limited";
          const cancelled = outcomeStatus === "cancelled";
          if (outcomeStatus === "paused") {
            await requestSpotifyBatchPause(db, spotifyWork!.batchId);
            await pauseSpotifyArtistForBudget(db, currentSpotifyArtistScan.id);
          } else {
            await finishSpotifyArtistScan(db, {
              artistScanId: currentSpotifyArtistScan.id,
              candidateCount: currentSpotifyCandidateCount,
              errorClassification: rateLimited
                ? "rate_limited"
                : cancelled
                  ? "cancelled_by_user"
                  : "provider_failure",
              pagesScanned: currentSpotifyPagesScanned,
              requestCount: Math.max(0, spotifyPageRequestBase - spotifyArtistRequestBase),
              ...(error instanceof SpotifyCooldownError && error.cooldownUntil
                ? { retryEligibleAt: error.cooldownUntil }
                : error instanceof SpotifyHttpError && error.retryAfter?.cooldownUntil
                  ? { retryEligibleAt: error.retryAfter.cooldownUntil }
                  : {}),
              status: rateLimited ? "rate_limited" : cancelled ? "cancelled" : "failed",
            });
            await markSpotifyCoverageInterrupted(db, {
              artistId: currentSpotifyArtistScan.artistId,
              error: safeScanError(error),
              status: rateLimited ? "rate_limited" : "failed",
            });
          }
          currentSpotifyArtistScan = undefined;
        }
        const failure =
          error instanceof DryRunOperationalError ? error : new Error(safeScanError(error));
        aggregate.providerResults![provider.name] = {
          discovered:
            options.dryRun && aggregate.dryRunReport
              ? aggregate.dryRunReport.trackCandidates.length
              : 0,
          error: failure.message,
          inserted: 0,
        };
        if (outcomeStatus !== "paused") failures.push(failure);
        if (outcomeStatus === "failed") providersFailed.push(provider.name);
        await recordProviderFailure(
          db,
          provider.name,
          options,
          failure,
          providerRunId,
          outcomeStatus,
          aggregate,
        );
        await runtime?.reportProgress(
          {
            currentProvider: null,
            phase: outcomeStatus,
            providersFailed,
          },
          true,
        );
        log("error", "scan.provider_failed", {
          message: failure.message,
          provider: provider.name,
        });
      }
    }
    if (!requested && configuration.reddit.configured) {
      try {
        const result = await runRedditScan(db, configuration, { ...options, provider: "reddit" });
        aggregate.discovered += result.discovered;
        aggregate.inserted += result.inserted;
        aggregate.skipped += result.skipped;
        aggregate.needsReview += result.needsReview;
        aggregate.providerResults!.reddit = {
          discovered: result.discovered,
          inserted: result.inserted,
        };
      } catch (error) {
        const failure = new Error(safeScanError(error));
        failures.push(failure);
        aggregate.providerResults!.reddit = {
          discovered: 0,
          error: failure.message,
          inserted: 0,
        };
      }
    }
    if (!requested && configuration.appleMusic.configured) {
      try {
        const result = await runAppleMusicScan(
          db,
          configuration,
          { ...options, provider: "apple_music" },
          (candidates, context) =>
            persistCandidates(
              db,
              candidates,
              { ...options, provider: "apple_music" },
              undefined,
              undefined,
              context,
            ),
          runtime ?? {},
        );
        aggregate.discovered += result.discovered;
        aggregate.inserted += result.inserted;
        aggregate.skipped += result.skipped;
        aggregate.needsReview += result.needsReview;
        aggregate.providerResults!.apple_music = result.providerResults.apple_music ?? {
          discovered: result.discovered,
          inserted: result.inserted,
        };
      } catch (error) {
        const failure = new Error(safeScanError(error));
        failures.push(failure);
        aggregate.providerResults!.apple_music = {
          discovered: 0,
          error: failure.message,
          inserted: 0,
        };
      }
    }
    const attemptedProviders =
      providers.length +
      (!requested && configuration.reddit.configured ? 1 : 0) +
      (!requested && configuration.appleMusic.configured ? 1 : 0);
    if (
      (attemptedProviders > 0 && failures.length === attemptedProviders) ||
      (requested && failures.length > 0)
    ) {
      const dryRunFailure = failures.find(
        (failure): failure is DryRunOperationalError => failure instanceof DryRunOperationalError,
      );
      throw dryRunFailure ?? new Error(failures.map((failure) => failure.message).join("; "));
    }
    log("info", options.dryRun ? "scan.dry_run_completed" : "scan.completed", aggregate);
    return aggregate;
  } finally {
    await client.end();
  }
}

async function buildProviders(
  db: RadarDatabase,
  selected: Array<"mock" | "spotify" | "musicbrainz">,
  configuration: ReturnType<typeof loadProviderConfiguration>,
  spotifyWork?: PreparedSpotifyWork,
  musicBrainzWork?: PreparedMusicBrainzWork,
  onSpotifyTelemetry?: (telemetry: SpotifyRequestTelemetry) => Promise<void>,
  runtime?: ScanRuntime,
): Promise<DiscoveryProvider[]> {
  const providers: DiscoveryProvider[] = [];
  for (const provider of selected) {
    if (provider === "mock") {
      providers.push(new MockProvider(mockProviderFixture));
      continue;
    }
    if (provider === "spotify") {
      if (
        !configuration.spotify.configured ||
        !configuration.spotify.clientId ||
        !configuration.spotify.clientSecret ||
        !configuration.appEncryptionKey
      ) {
        throw new Error(
          "Spotify is not configured. Set its client credentials and APP_ENCRYPTION_KEY.",
        );
      }
      const ownerId = await ensureLocalOwner(db);
      if (!spotifyWork) throw new Error("Spotify scan work was not prepared.");
      const baseGate = createSpotifyRequestGate(
        db,
        configuration.spotify.minRequestIntervalMs,
        runtime?.schedulerContext,
      );
      const requestGate = runtime?.requestGateWrapper
        ? runtime.requestGateWrapper(
            budgetSpotifyRequestGate(baseGate, spotifyWork.maxRequestsPerRun),
          )
        : budgetSpotifyRequestGate(baseGate, spotifyWork.maxRequestsPerRun);
      const oauthClient = new SpotifyOAuthClient({
        clientId: configuration.spotify.clientId,
        clientSecret: configuration.spotify.clientSecret,
        redirectUri: configuration.spotify.redirectUri,
        requestGate,
      });
      const tokenManager = new SpotifyTokenManager(
        db,
        ownerId,
        configuration.appEncryptionKey,
        oauthClient,
      );
      const client = new SpotifyClient({
        accessToken: () => tokenManager.getAccessToken(),
        onUnauthorized: () => tokenManager.refresh().then(() => undefined),
        requestGate,
        ...(onSpotifyTelemetry ? { onTelemetry: onSpotifyTelemetry } : {}),
      });
      providers.push(
        new SpotifyProvider({
          client,
          ...(runtime?.deferSpotifyReleaseDetails ? { deferReleaseDetails: true } : {}),
          incompleteReleaseIds: spotifyWork.incompleteReleaseIds,
          knownReleaseIds: spotifyWork.knownReleaseIds,
          knownReleaseSummaries: spotifyWork.knownReleaseSummaries,
          mappings: spotifyWork.mappings,
          maxPagesPerArtist: spotifyWork.maxPagesPerArtist,
          releaseTrackResume: spotifyWork.releaseTrackResume,
          startOffsets: spotifyWork.startOffsets,
        }),
      );
      continue;
    }
    if (!configuration.musicbrainz.configured || !configuration.musicbrainz.contactEmail) {
      throw new Error("MusicBrainz is not configured. Set MUSICBRAINZ_CONTACT_EMAIL.");
    }
    providers.push(
      new MusicBrainzProvider(
        new MusicBrainzClient({
          contactEmail: configuration.musicbrainz.contactEmail,
          requestGate: createMusicBrainzRequestGate(db),
        }),
        musicBrainzWork?.mappings ?? (await musicBrainzMappings(db)),
      ),
    );
  }
  return providers;
}

export function budgetSpotifyRequestGate(
  gate: SpotifyRequestGate,
  maximumRequests: number,
): SpotifyRequestGate {
  if (!Number.isInteger(maximumRequests) || maximumRequests < 1) {
    throw new Error("Spotify request budget must be a positive integer.");
  }
  let issued = 0;
  return {
    acquire: async (input) => {
      if (issued >= maximumRequests) throw new SpotifyRequestBudgetError(maximumRequests);
      const permit = await gate.acquire(input);
      issued += 1;
      return permit;
    },
    complete: (permit, result) => gate.complete(permit, result),
  };
}

async function spotifyMappings(db: RadarDatabase): Promise<SpotifyArtistMapping[]> {
  const mappings = await db
    .select({
      artistId: artistExternalIds.artistId,
      name: artists.name,
      spotifyArtistId: artistExternalIds.externalId,
    })
    .from(artistExternalIds)
    .innerJoin(artists, eq(artists.id, artistExternalIds.artistId))
    .innerJoin(artistFollows, eq(artistFollows.artistId, artists.id))
    .where(
      and(
        eq(artistExternalIds.provider, "spotify"),
        eq(artistExternalIds.confirmed, true),
        eq(artistFollows.active, true),
      ),
    );
  return mappings;
}

async function musicBrainzMappings(db: RadarDatabase): Promise<CanonicalArtistMappingInput[]> {
  const mappings = await db
    .select({
      artistId: artistExternalIds.artistId,
      mbid: artistExternalIds.externalId,
      name: artists.name,
    })
    .from(artistExternalIds)
    .innerJoin(artists, eq(artists.id, artistExternalIds.artistId))
    .where(
      and(eq(artistExternalIds.provider, "musicbrainz"), eq(artistExternalIds.confirmed, true)),
    );
  const aliases = await db.select().from(artistAliases);
  return mappings.map((mapping) => ({
    ...mapping,
    aliases: aliases
      .filter((alias) => alias.artistId === mapping.artistId)
      .map((alias) => alias.name),
  }));
}

async function recordProviderFailure(
  db: RadarDatabase,
  provider: TrackCandidate["provider"],
  options: ScannerOptions,
  error: Error,
  runId?: string,
  status: "failed" | "cancelled" | "paused" | "rate_limited" = "failed",
  summary?: ScanSummary,
): Promise<void> {
  const errorEvidence = {
    message: safeScanError(error),
    ...(error instanceof DryRunOperationalError ? { classification: error.classification } : {}),
  };
  if (runId) {
    await db
      .update(scanRuns)
      .set({
        completedAt: new Date(),
        errors: [errorEvidence],
        providersFailed: status === "failed" ? [provider] : [],
        status,
      })
      .where(eq(scanRuns.id, runId));
    return;
  }
  await db.insert(scanRuns).values({
    provider,
    status,
    dryRun: options.dryRun,
    providersRequested: [provider],
    providersFailed: status === "failed" ? [provider] : [],
    triggerType: options.provider ? "provider_manual" : "manual",
    ...(options.artistId ? { artistFilter: options.artistId } : {}),
    completedAt: new Date(),
    errors: [errorEvidence],
    ...(summary?.dryRunReport ? { metadata: { dryRunReport: summary.dryRunReport } } : {}),
  });
}

export async function runDryRunFinalOperationalStep(
  summary: ScanSummary,
  classification: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = safeScanError(error);
    if (summary.dryRunReport) {
      summary.dryRunReport.finalOperationalStep = {
        classification,
        message,
        status: "failed",
      };
    }
    throw new DryRunOperationalError(message, classification, summary);
  }
}

function scanOutcomeStatus(
  error: unknown,
  signal?: AbortSignal,
): "failed" | "cancelled" | "paused" | "rate_limited" {
  if (signal?.aborted) return "cancelled";
  if (error instanceof SpotifyRequestBudgetError) return "paused";
  if (
    error instanceof SpotifyCooldownError ||
    (error instanceof SpotifyHttpError && error.status === 429)
  ) {
    return "rate_limited";
  }
  return "failed";
}

export function spotifyBatchPauseMilliseconds(
  pauseSeconds: number,
  random: () => number = Math.random,
): number {
  const base = Math.max(1, Math.floor(pauseSeconds)) * 1_000;
  const maximumJitter = Math.max(1_000, Math.min(10_000, Math.floor(base * 0.2)));
  return base + Math.floor(Math.max(0, Math.min(random(), 0.999_999)) * maximumJitter);
}

export function spotifyReleaseTelemetry(
  releases: ProviderReleaseObservation[] | undefined,
): { backfillReleaseCount: number; releaseCount: number } | Record<string, never> {
  if (!releases) return {};
  return {
    backfillReleaseCount: releases.filter((release) => release.backfillEligible).length,
    releaseCount: releases.length,
  };
}

export async function persistCandidates(
  db: RadarDatabase,
  candidates: TrackCandidate[],
  options: ScannerOptions,
  nextCursor?: string,
  providerMetrics?: { failures: number; requests: number; waitMs: number },
  runContext?: PersistRunContext,
): Promise<ScanSummary> {
  const provider = candidates[0]?.provider ?? options.provider ?? "mock";
  return withScanLock(db, provider, () =>
    persistCandidatesUnlocked(
      db,
      candidates,
      options,
      nextCursor,
      provider,
      providerMetrics,
      runContext,
    ),
  );
}

async function persistCandidatesUnlocked(
  db: RadarDatabase,
  candidates: TrackCandidate[],
  options: ScannerOptions,
  nextCursor: string | undefined,
  provider: TrackCandidate["provider"],
  providerMetrics?: { failures: number; requests: number; waitMs: number },
  runContext?: PersistRunContext,
): Promise<ScanSummary> {
  const run = runContext ?? {
    artistsProcessedCount: 0,
    cumulativeBase: emptyScanSummary(false),
    id: await createProviderScanRun(db, provider, options, providerMetrics),
    status: "completed" as const,
  };

  const summary: ScanSummary = {
    discovered: candidates.length,
    inserted: 0,
    skipped: 0,
    needsReview: 0,
    dryRun: false,
  };

  try {
    await db.transaction(async (tx) => {
      const userId = await ensureOwner(tx);
      const canonicalTracks = await loadCanonicalTracks(tx);

      for (const candidate of candidates) {
        const existing = await tx.query.releaseCandidates.findFirst({
          where: and(
            eq(releaseCandidates.provider, candidate.provider),
            eq(releaseCandidates.providerReleaseId, candidate.externalReleaseId),
            eq(releaseCandidates.providerTrackId, candidate.externalTrackId),
          ),
          columns: { id: true, matchedTrackId: true },
        });
        if (existing) {
          const artwork =
            candidate.provider === "spotify"
              ? parseSpotifyReleaseArtwork(candidate.spotifyRelease)
              : candidate.provider === "apple_music"
                ? parseAppleMusicReleaseArtwork(candidate.appleMusicRelease)
                : null;
          if (artwork) {
            const existingReleaseExternalId = await tx.query.releaseExternalIds.findFirst({
              where: and(
                eq(releaseExternalIds.provider, candidate.provider),
                eq(releaseExternalIds.externalId, candidate.externalReleaseId),
              ),
            });
            let existingReleaseId = existingReleaseExternalId?.releaseId;
            if (!existingReleaseId && existing.matchedTrackId) {
              const matchedTrack = await tx.query.tracks.findFirst({
                where: eq(tracks.id, existing.matchedTrackId),
                columns: { releaseId: true },
              });
              existingReleaseId = matchedTrack?.releaseId ?? undefined;
            }
            if (existingReleaseId) {
              await tx
                .insert(releaseExternalIds)
                .values({
                  externalId: candidate.externalReleaseId,
                  provider: candidate.provider,
                  providerFields: releaseProviderFields(
                    candidate,
                    existingReleaseExternalId?.providerFields,
                  ),
                  providerUrl: artwork.albumUrl,
                  releaseId: existingReleaseId,
                })
                .onConflictDoUpdate({
                  target: [releaseExternalIds.provider, releaseExternalIds.externalId],
                  set: {
                    providerFields: releaseProviderFields(
                      candidate,
                      existingReleaseExternalId?.providerFields,
                    ),
                    providerUrl: artwork.albumUrl,
                    updatedAt: new Date(),
                  },
                });
              await tx
                .update(feedItems)
                .set({ updatedAt: new Date() })
                .where(eq(feedItems.candidateId, existing.id));
            }
          }
          summary.skipped += 1;
          continue;
        }

        const primaryArtistId = await ensureArtist(tx, candidate);
        await tx
          .insert(artistFollows)
          .values({ userId, artistId: primaryArtistId })
          .onConflictDoNothing();

        const releaseId = await resolveCanonicalRelease(tx, candidate);

        const providerMatch = await tx.query.trackExternalIds.findFirst({
          where: and(
            eq(trackExternalIds.provider, candidate.provider),
            eq(trackExternalIds.externalId, candidate.externalTrackId),
          ),
          columns: { trackId: true },
        });
        const decision: MatchDecision = providerMatch
          ? {
              canonicalTrackId: providerMatch.trackId,
              confidence: 1,
              kind: "automatic",
              reasons: ["Provider track identifier is identical"],
              rule: "exact_provider_id",
            }
          : matchCandidate(candidate, canonicalTracks);
        const trackId = await resolveTrack(
          tx,
          candidate,
          decision,
          primaryArtistId,
          canonicalTracks,
          releaseId,
        );
        if (decision.kind === "review") summary.needsReview += 1;

        const [candidateRow] = await tx
          .insert(releaseCandidates)
          .values({
            scanRunId: run.id,
            provider: candidate.provider,
            providerReleaseId: candidate.externalReleaseId,
            providerTrackId: candidate.externalTrackId,
            artistExternalId: candidate.artistExternalId,
            title: candidate.title,
            normalizedTitle: normalizeText(candidate.title),
            releaseDate: candidate.releaseDate,
            rawPayload: candidate,
            payloadHash: candidate.payloadHash,
            matchStatus:
              decision.kind === "review"
                ? "needs_review"
                : decision.kind === "new"
                  ? "new"
                  : "matched",
            ...(trackId ? { matchedTrackId: trackId } : {}),
            matchRule: decision.rule,
            matchConfidence: decision.confidence.toFixed(3),
            matchReasons: decision.reasons,
            matchingAlgorithmVersion: "v2-real-providers",
            firstSeenAt: new Date(candidate.firstSeenAt),
          })
          .returning({ id: releaseCandidates.id });
        if (!candidateRow) throw new Error("Failed to insert candidate");

        await tx
          .insert(sourceEvidence)
          .values({
            candidateId: candidateRow.id,
            provider: candidate.provider,
            evidenceType: candidate.evidenceType,
            externalId: candidate.externalTrackId,
            sourceUrl: candidate.evidenceUrl,
            payloadHash: candidate.payloadHash,
            retrievedAt: new Date(candidate.firstSeenAt),
          })
          .onConflictDoNothing();

        await upsertReleaseExternalId(tx, candidate, releaseId);

        const appearanceId =
          trackId && decision.kind !== "review"
            ? await upsertReleaseAppearance(tx, candidate, candidateRow.id, releaseId, trackId)
            : undefined;

        if (trackId && decision.kind !== "review") {
          await tx
            .insert(trackAvailabilities)
            .values({
              trackId,
              provider: candidate.provider,
              providerTrackId: candidate.externalTrackId,
              region: candidate.region,
              state: candidate.availability,
              providerUrl: candidate.providerUrl,
            })
            .onConflictDoNothing();
          await tx
            .insert(trackExternalIds)
            .values({
              externalId: candidate.externalTrackId,
              provider: candidate.provider,
              providerFields: {
                availability: candidate.availability,
                region: candidate.region,
                sourceLabel: candidate.sourceLabel,
              },
              providerUrl: candidate.providerUrl,
              trackId,
            })
            .onConflictDoUpdate({
              target: [trackExternalIds.provider, trackExternalIds.externalId],
              set: {
                providerFields: {
                  availability: candidate.availability,
                  region: candidate.region,
                  sourceLabel: candidate.sourceLabel,
                },
                providerUrl: candidate.providerUrl,
                updatedAt: new Date(),
              },
            });
        }

        if (candidate.isUpcoming && releaseId) {
          const [announcement] = await tx
            .insert(upcomingAnnouncements)
            .values({
              artistId: primaryArtistId,
              confidence: candidate.provider === "musicbrainz" ? "0.700" : "0.850",
              datePrecision: candidate.releaseDatePrecision,
              evidenceUrl: candidate.evidenceUrl,
              externalId: candidate.externalReleaseId,
              firstSeenAt: new Date(candidate.firstSeenAt),
              provider: candidate.provider,
              releaseId,
              scheduledFor: candidate.releaseDate,
              title: candidate.releaseTitle,
            })
            .onConflictDoUpdate({
              target: [upcomingAnnouncements.provider, upcomingAnnouncements.externalId],
              set: {
                datePrecision: candidate.releaseDatePrecision,
                evidenceUrl: candidate.evidenceUrl,
                releaseId,
                scheduledFor: candidate.releaseDate,
              },
            })
            .returning({ id: upcomingAnnouncements.id });
          if (announcement) {
            await tx
              .insert(upcomingDateHistory)
              .values({
                announcementId: announcement.id,
                datePrecision: candidate.releaseDatePrecision,
                scheduledFor: candidate.releaseDate,
              })
              .onConflictDoNothing();
          }
        }

        await tx
          .insert(feedItems)
          .values({
            userId,
            candidateId: candidateRow.id,
            ...(trackId ? { trackId } : {}),
            releaseId,
            ...(appearanceId ? { appearanceId } : {}),
            state: candidate.isUpcoming
              ? "upcoming"
              : decision.kind === "review"
                ? "needs_review"
                : "new",
            dedupeKey: `${candidate.provider}:${candidate.externalReleaseId}:${candidate.externalTrackId}`,
            firstSeenAt: new Date(candidate.firstSeenAt),
          })
          .onConflictDoNothing();
        summary.inserted += 1;
      }

      if (nextCursor) {
        await tx
          .insert(providerCursors)
          .values({
            provider,
            cursorScope: "global",
            scopeId: "default",
            cursorValue: nextCursor,
          })
          .onConflictDoUpdate({
            target: [
              providerCursors.provider,
              providerCursors.cursorScope,
              providerCursors.scopeId,
            ],
            set: { cursorValue: nextCursor, updatedAt: new Date() },
          });
      }
    });

    const cumulative = addScanSummaries(run.cumulativeBase, summary);
    await db
      .update(scanRuns)
      .set({
        status: run.status,
        completedAt: run.status === "running" ? null : new Date(),
        discoveredCount: cumulative.discovered,
        insertedCount: cumulative.inserted,
        skippedCount: cumulative.skipped,
        reviewCount: cumulative.needsReview,
        artistsProcessedCount: run.artistsProcessedCount,
        providerResults: {
          [provider]: {
            discovered: cumulative.discovered,
            inserted: cumulative.inserted,
            skipped: cumulative.skipped,
            status: run.status,
          },
        },
        providersCompleted: run.status === "completed" ? [provider] : [],
        providersFailed: [],
        duplicatesIgnoredCount: cumulative.skipped,
        metadata: scanRunMetadata(provider, providerMetrics),
      })
      .where(eq(scanRuns.id, run.id));
    return summary;
  } catch (error) {
    await db
      .update(scanRuns)
      .set({
        status: "failed",
        completedAt: new Date(),
        errors: [{ message: safeScanError(error) }],
        providersFailed: [provider],
      })
      .where(eq(scanRuns.id, run.id));
    throw error;
  }
}

function releaseProviderFields(
  candidate: TrackCandidate,
  currentFields: unknown,
): Record<string, unknown> {
  const current = isRecord(currentFields) ? currentFields : {};
  const spotifyArtwork = parseSpotifyReleaseArtwork(candidate.spotifyRelease);
  const appleMusicArtwork = parseAppleMusicReleaseArtwork(candidate.appleMusicRelease);
  return {
    ...current,
    releaseDate: candidate.releaseDate,
    releaseDatePrecision: candidate.releaseDatePrecision,
    releaseType: candidate.releaseType,
    sourceLabel: candidate.sourceLabel,
    ...(candidate.provider === "spotify" && spotifyArtwork ? { spotify: spotifyArtwork } : {}),
    ...(candidate.provider === "apple_music" && appleMusicArtwork
      ? { apple_music: appleMusicArtwork }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createProviderScanRun(
  db: RadarDatabase,
  provider: TrackCandidate["provider"],
  options: ScannerOptions,
  providerMetrics?: { failures: number; requests: number; waitMs: number },
): Promise<string> {
  const [run] = await db
    .insert(scanRuns)
    .values({
      provider,
      dryRun: false,
      detailedExpiresAt: new Date(
        Date.now() + loadProviderConfiguration().scanDetailRetentionDays * 86_400_000,
      ),
      providersRequested: [provider],
      triggerType: options.full
        ? "full_reconciliation"
        : options.provider
          ? "provider_manual"
          : "manual",
      metadata: scanRunMetadata(provider, providerMetrics),
      ...(options.artistId ? { artistFilter: options.artistId } : {}),
    })
    .returning({ id: scanRuns.id });
  if (!run) throw new Error("Failed to create scan run");
  return run.id;
}

function scanRunMetadata(
  provider: TrackCandidate["provider"],
  providerMetrics?: { failures: number; requests: number; waitMs: number },
): Record<string, unknown> {
  if (provider !== "spotify") return providerMetrics ? { providerMetrics } : {};
  const spotify = loadProviderConfiguration().spotify;
  return {
    effectiveSpotifyConfiguration: {
      artistsPerBatch: spotify.artistsPerBatch,
      maxConcurrency: spotify.maxConcurrency,
      maxRequestsPerRun: spotify.maxRequestsPerRun,
      minRequestIntervalMs: spotify.minRequestIntervalMs,
    },
    ...(providerMetrics ? { providerMetrics } : {}),
  };
}

function emptyScanSummary(dryRun: boolean): ScanSummary {
  return { discovered: 0, dryRun, inserted: 0, needsReview: 0, skipped: 0 };
}

function addScanSummaries(left: ScanSummary, right: ScanSummary): ScanSummary {
  return {
    discovered: left.discovered + right.discovered,
    dryRun: left.dryRun || right.dryRun,
    inserted: left.inserted + right.inserted,
    needsReview: left.needsReview + right.needsReview,
    skipped: left.skipped + right.skipped,
  };
}

function spotifyTelemetryMetadata(telemetry: SpotifyRequestTelemetry): Record<string, unknown> {
  return {
    phase: telemetry.phase,
    rateLimitWaitMs: telemetry.rateLimitWaitMs,
    requests: telemetry.requests,
    retryAfterMs: telemetry.retryAfterMs ?? null,
  };
}

function safeScanError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown scan error";
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[DATABASE_URL REDACTED]")
    .replace(/(?:Bearer|Basic)\s+\S+/gi, "[AUTHORIZATION REDACTED]")
    .replace(/(?:access|refresh|client)[_-]?token[=:]\s*\S+/gi, "token=[REDACTED]")
    .replace(/client[_-]?secret[=:]\s*\S+/gi, "client_secret=[REDACTED]")
    .slice(0, 1_000);
}

async function withScanLock<T>(
  db: RadarDatabase,
  provider: TrackCandidate["provider"],
  operation: () => Promise<T>,
): Promise<T> {
  const ownerToken = randomUUID();
  const now = new Date();
  await db
    .delete(scanLocks)
    .where(and(eq(scanLocks.provider, provider), lt(scanLocks.expiresAt, now)));
  const [lock] = await db
    .insert(scanLocks)
    .values({
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + 30 * 60_000),
      ownerToken,
      provider,
    })
    .onConflictDoNothing()
    .returning({ provider: scanLocks.provider });
  if (!lock) throw new Error(`A ${provider} scan is already running`);
  try {
    return await operation();
  } finally {
    await db
      .delete(scanLocks)
      .where(and(eq(scanLocks.provider, provider), eq(scanLocks.ownerToken, ownerToken)));
  }
}

function providerReleaseUrl(candidate: TrackCandidate): string {
  if (candidate.provider === "spotify") {
    return `https://open.spotify.com/album/${encodeURIComponent(candidate.externalReleaseId)}`;
  }
  if (candidate.provider === "musicbrainz") {
    return `https://musicbrainz.org/release/${encodeURIComponent(candidate.externalReleaseId)}`;
  }
  return candidate.evidenceUrl;
}

async function ensureOwner(db: DatabaseExecutor): Promise<string> {
  const [owner] = await db
    .insert(users)
    .values({ email: "owner@local.invalid", displayName: "TS" })
    .onConflictDoUpdate({ target: users.email, set: { displayName: "TS", updatedAt: new Date() } })
    .returning({ id: users.id });
  if (!owner) throw new Error("Failed to ensure local owner");
  return owner.id;
}

async function ensureArtist(db: DatabaseExecutor, candidate: TrackCandidate): Promise<string> {
  const existing = await db.query.artistExternalIds.findFirst({
    where: and(
      eq(artistExternalIds.provider, candidate.provider),
      eq(artistExternalIds.externalId, candidate.artistExternalId),
    ),
    columns: { artistId: true },
  });
  if (existing) return existing.artistId;

  const [artist] = await db
    .insert(artists)
    .values({ name: candidate.artistName, normalizedName: normalizeText(candidate.artistName) })
    .returning({ id: artists.id });
  if (!artist) throw new Error("Failed to create artist");
  await db.insert(artistExternalIds).values({
    artistId: artist.id,
    provider: candidate.provider,
    externalId: candidate.artistExternalId,
    providerUrl: candidate.providerUrl,
    confirmed: true,
  });
  return artist.id;
}

export async function createSpotifyDryRunReport(
  db: RadarDatabase,
  input: {
    backfillStart: string;
    candidates: TrackCandidate[];
    pagesScanned: number;
    pages?: DryRunPageReport[];
    partial: boolean;
    releases: ProviderReleaseObservation[];
    requestCount: number;
  },
): Promise<DryRunReport> {
  const [canonicalTracks, existingCandidates, providerMatches] = await Promise.all([
    loadCanonicalTracks(db),
    db
      .select({
        provider: releaseCandidates.provider,
        providerReleaseId: releaseCandidates.providerReleaseId,
        providerTrackId: releaseCandidates.providerTrackId,
      })
      .from(releaseCandidates)
      .where(eq(releaseCandidates.provider, "spotify")),
    db
      .select({ externalId: trackExternalIds.externalId, trackId: trackExternalIds.trackId })
      .from(trackExternalIds)
      .where(eq(trackExternalIds.provider, "spotify")),
  ]);
  return buildDryRunReport({
    ...input,
    canonicalTracks,
    existingCandidateKeys: new Set(
      existingCandidates.map((candidate) =>
        candidateKey({
          externalReleaseId: candidate.providerReleaseId,
          externalTrackId: candidate.providerTrackId,
          provider: candidate.provider,
        }),
      ),
    ),
    providerTrackMatches: new Map(
      providerMatches.map((match) => [match.externalId, match.trackId]),
    ),
  });
}

async function loadCanonicalTracks(db: DatabaseExecutor): Promise<CanonicalTrack[]> {
  const trackRows = await db
    .select({ release: releases, track: tracks })
    .from(tracks)
    .leftJoin(releases, eq(releases.id, tracks.releaseId));
  const creditRows = await db.select().from(trackCredits);
  return trackRows.map(({ release, track }) => ({
    id: track.id,
    title: track.title,
    normalizedTitle: track.normalizedTitle,
    credits: creditRows
      .filter((credit) => credit.trackId === track.id)
      .sort((a, b) => a.creditOrder - b.creditOrder)
      .map((credit) => ({ name: credit.creditedName, role: credit.role as "primary" })),
    ...(track.durationMs !== null ? { durationMs: track.durationMs } : {}),
    ...(track.isrc !== null ? { isrc: track.isrc } : {}),
    ...(release?.upc ? { upc: release.upc } : {}),
    ...(release?.ean ? { ean: release.ean } : {}),
    ...(track.discNumber !== null ? { discNumber: track.discNumber } : {}),
    ...(track.trackNumber !== null ? { trackNumber: track.trackNumber } : {}),
    ...(track.musicbrainzRecordingId !== null
      ? { musicbrainzRecordingId: track.musicbrainzRecordingId }
      : {}),
    ...(track.musicbrainzReleaseGroupId !== null
      ? { musicbrainzReleaseGroupId: track.musicbrainzReleaseGroupId }
      : {}),
    ...(track.version !== null ? { version: track.version } : {}),
  }));
}

async function resolveTrack(
  db: DatabaseExecutor,
  candidate: TrackCandidate,
  decision: MatchDecision,
  primaryArtistId: string,
  canonicalTracks: CanonicalTrack[],
  releaseId: string,
): Promise<string | undefined> {
  if (decision.kind === "automatic") return decision.canonicalTrackId;
  if (decision.kind === "review") return decision.canonicalTrackId;

  const [track] = await db
    .insert(tracks)
    .values({
      releaseId,
      title: candidate.title,
      normalizedTitle: normalizeText(candidate.title),
      ...(candidate.durationMs ? { durationMs: candidate.durationMs } : {}),
      ...(candidate.isrc ? { isrc: normalizeIdentifier(candidate.isrc) } : {}),
      ...(candidate.discNumber ? { discNumber: candidate.discNumber } : {}),
      ...(candidate.trackNumber ? { trackNumber: candidate.trackNumber } : {}),
      ...(candidate.musicbrainzRecordingId
        ? { musicbrainzRecordingId: candidate.musicbrainzRecordingId }
        : {}),
      ...(candidate.musicbrainzReleaseGroupId
        ? { musicbrainzReleaseGroupId: candidate.musicbrainzReleaseGroupId }
        : {}),
      ...(candidate.version ? { version: candidate.version } : {}),
    })
    .returning({ id: tracks.id });
  if (!track) throw new Error("Failed to create track");

  const credits = candidate.credits.length
    ? candidate.credits
    : [{ name: candidate.artistName, role: "primary" as const }];
  for (const [creditOrder, credit] of credits.entries()) {
    const artistId =
      creditOrder === 0 ? primaryArtistId : await ensureCreditArtist(db, credit.name);
    await db.insert(trackCredits).values({
      trackId: track.id,
      artistId,
      creditOrder,
      role: credit.role,
      creditedName: credit.name,
    });
  }
  canonicalTracks.push({
    id: track.id,
    title: candidate.title,
    normalizedTitle: normalizeText(candidate.title),
    credits: candidate.credits,
    ...(candidate.durationMs ? { durationMs: candidate.durationMs } : {}),
    ...(candidate.isrc ? { isrc: normalizeIdentifier(candidate.isrc) } : {}),
    ...(candidate.upc ? { upc: candidate.upc } : {}),
    ...(candidate.ean ? { ean: candidate.ean } : {}),
    ...(candidate.discNumber ? { discNumber: candidate.discNumber } : {}),
    ...(candidate.trackNumber ? { trackNumber: candidate.trackNumber } : {}),
    ...(candidate.version ? { version: candidate.version } : {}),
  });
  return track.id;
}

async function resolveCanonicalRelease(
  db: DatabaseExecutor,
  candidate: TrackCandidate,
): Promise<string> {
  const providerRelease = await db.query.releaseExternalIds.findFirst({
    where: and(
      eq(releaseExternalIds.provider, candidate.provider),
      eq(releaseExternalIds.externalId, candidate.externalReleaseId),
    ),
    columns: { releaseId: true },
  });
  if (providerRelease) return providerRelease.releaseId;

  const normalizedUpc = candidate.upc ? normalizeIdentifier(candidate.upc) : undefined;
  const normalizedEan = candidate.ean ? normalizeIdentifier(candidate.ean) : undefined;
  const barcodeRelease =
    !normalizedUpc && !normalizedEan
      ? undefined
      : await db.query.releases.findFirst({
          where: or(
            ...(normalizedUpc ? [eq(releases.upc, normalizedUpc)] : []),
            ...(normalizedEan ? [eq(releases.ean, normalizedEan)] : []),
          ),
          columns: { id: true },
        });
  if (barcodeRelease) return barcodeRelease.id;

  const exactRelease = await db.query.releases.findFirst({
    where: and(
      eq(releases.normalizedTitle, normalizeText(candidate.releaseTitle)),
      eq(releases.releaseDate, candidate.releaseDate),
      eq(releases.releaseType, candidate.releaseType),
    ),
    columns: { id: true },
  });
  if (exactRelease) return exactRelease.id;

  const [createdRelease] = await db
    .insert(releases)
    .values({
      title: candidate.releaseTitle,
      normalizedTitle: normalizeText(candidate.releaseTitle),
      releaseType: candidate.releaseType,
      releaseDate: candidate.releaseDate,
      releaseDatePrecision: candidate.releaseDatePrecision,
      ...(normalizedUpc ? { upc: normalizedUpc } : {}),
      ...(normalizedEan ? { ean: normalizedEan } : {}),
      ...(candidate.version ? { version: candidate.version } : {}),
    })
    .returning({ id: releases.id });
  if (!createdRelease) throw new Error("Failed to create release");
  return createdRelease.id;
}

async function upsertReleaseExternalId(
  db: DatabaseExecutor,
  candidate: TrackCandidate,
  releaseId: string,
): Promise<void> {
  const existing = await db.query.releaseExternalIds.findFirst({
    where: and(
      eq(releaseExternalIds.provider, candidate.provider),
      eq(releaseExternalIds.externalId, candidate.externalReleaseId),
    ),
    columns: { providerFields: true },
  });
  const artwork =
    candidate.provider === "spotify"
      ? parseSpotifyReleaseArtwork(candidate.spotifyRelease)
      : candidate.provider === "apple_music"
        ? parseAppleMusicReleaseArtwork(candidate.appleMusicRelease)
        : null;
  await db
    .insert(releaseExternalIds)
    .values({
      externalId: candidate.externalReleaseId,
      provider: candidate.provider,
      providerFields: releaseProviderFields(candidate, existing?.providerFields),
      providerUrl: artwork?.albumUrl ?? providerReleaseUrl(candidate),
      releaseId,
    })
    .onConflictDoUpdate({
      target: [releaseExternalIds.provider, releaseExternalIds.externalId],
      set: {
        providerFields: releaseProviderFields(candidate, existing?.providerFields),
        providerUrl: artwork?.albumUrl ?? providerReleaseUrl(candidate),
        releaseId,
        updatedAt: new Date(),
      },
    });
}

async function upsertReleaseAppearance(
  db: DatabaseExecutor,
  candidate: TrackCandidate,
  candidateId: string,
  releaseId: string,
  trackId: string,
): Promise<string> {
  const discNumber = candidate.discNumber ?? 1;
  const trackNumber = candidate.trackNumber ?? 1;
  const [appearance] = await db
    .insert(releaseTrackAppearances)
    .values({
      discNumber,
      firstObservedAt: new Date(candidate.firstSeenAt),
      lastObservedAt: new Date(candidate.firstSeenAt),
      presentationMetadata: {
        releaseTitle: candidate.releaseTitle,
        ...(candidate.version ? { version: candidate.version } : {}),
      },
      providerOrder: candidate.trackNumber,
      releaseId,
      trackId,
      trackNumber,
    })
    .onConflictDoUpdate({
      target: [
        releaseTrackAppearances.releaseId,
        releaseTrackAppearances.trackId,
        releaseTrackAppearances.discNumber,
        releaseTrackAppearances.trackNumber,
      ],
      set: {
        lastObservedAt: new Date(candidate.firstSeenAt),
        presentationMetadata: {
          releaseTitle: candidate.releaseTitle,
          ...(candidate.version ? { version: candidate.version } : {}),
        },
        providerOrder: candidate.trackNumber,
        updatedAt: new Date(),
      },
    })
    .returning({ id: releaseTrackAppearances.id });
  if (!appearance) throw new Error("Failed to create release track appearance");
  await db
    .insert(releaseTrackAppearanceSources)
    .values({
      appearanceId: appearance.id,
      candidateId,
      firstObservedAt: new Date(candidate.firstSeenAt),
      lastObservedAt: new Date(candidate.firstSeenAt),
      observedCredit: candidate.credits,
      provider: candidate.provider,
      providerReleaseId: candidate.externalReleaseId,
      providerTrackId: candidate.externalTrackId,
    })
    .onConflictDoUpdate({
      target: releaseTrackAppearanceSources.candidateId,
      set: {
        appearanceId: appearance.id,
        lastObservedAt: new Date(candidate.firstSeenAt),
        observedCredit: candidate.credits,
        updatedAt: new Date(),
      },
    });
  return appearance.id;
}

async function ensureCreditArtist(db: DatabaseExecutor, name: string): Promise<string> {
  const normalizedName = normalizeText(name);
  const existing = await db.query.artists.findFirst({
    where: eq(artists.normalizedName, normalizedName),
    columns: { id: true },
  });
  if (existing) return existing.id;
  const [artist] = await db
    .insert(artists)
    .values({ name, normalizedName })
    .returning({ id: artists.id });
  if (!artist) throw new Error("Failed to create credited artist");
  return artist.id;
}
