import { log, type TrackCandidate } from "@radar/core";
import {
  artistExternalIds,
  artistFollows,
  artists,
  attachAppleMusicBatchScanRun,
  bootstrapAppleMusicIdentity,
  countAppleMusicRequests,
  createAppleMusicBatch,
  createAppleMusicRequestPersistence,
  finishAppleMusicArtist,
  finishAppleMusicBatch,
  getAppleMusicOperationalStatus,
  loadAppleMusicBatchItems,
  scanRuns,
  startAppleMusicArtist,
  type AppleMusicSeedEntry,
  type RadarDatabase,
} from "@radar/db";
import {
  AppleDeveloperTokenManager,
  AppleMusicClient,
  AppleMusicClientError,
  AppleMusicProvider,
  type ProviderConfiguration,
} from "@radar/providers";
import { and, asc, eq } from "drizzle-orm";
import seedArtifact from "./apple-music-full-watchlist-identity-seeds-v1.json";
import type { ScannerOptions } from "./args";
import { providerIdentityOverrides } from "./provider-identity-overrides";

export interface AppleMusicScanSummary {
  discovered: number;
  dryRun: boolean;
  inserted: number;
  needsReview: number;
  providerResults: Record<string, { discovered: number; error?: string; inserted: number }>;
  skipped: number;
}

export interface AppleMusicScanRuntime {
  reportProgress?: (metadata: Record<string, unknown>, force?: boolean) => Promise<void>;
  signal?: AbortSignal;
}

export interface AppleMusicPersistContext {
  artistsProcessedCount: number;
  cumulativeBase: Omit<AppleMusicScanSummary, "providerResults">;
  id: string;
  status: "running" | "completed" | "partial" | "paused" | "cancelled" | "rate_limited";
}

export type AppleMusicCandidatePersister = (
  candidates: TrackCandidate[],
  context: AppleMusicPersistContext,
) => Promise<Omit<AppleMusicScanSummary, "providerResults">>;

export async function runAppleMusicScan(
  db: RadarDatabase,
  configuration: ProviderConfiguration,
  options: ScannerOptions,
  persist: AppleMusicCandidatePersister,
  runtime: AppleMusicScanRuntime = {},
): Promise<AppleMusicScanSummary> {
  if (options.dryRun) {
    throw new Error("Apple Music dry-run scanning is not implemented. Use a bounded live canary.");
  }
  const seeds = validateSeedArtifact(seedArtifact);
  const bootstrap = await bootstrapAppleMusicIdentity(db, seeds);
  if (
    !configuration.appleMusic.configured ||
    !configuration.appleMusic.teamId ||
    !configuration.appleMusic.keyId ||
    !configuration.appleMusic.privateKeyPath
  ) {
    throw new Error("Apple Music catalog access is not configured.");
  }
  const operational = await getAppleMusicOperationalStatus(db);
  if (operational.cooldownActive) {
    throw new Error("Apple Music requests are blocked by a persisted cooldown.");
  }
  if (operational.leaseActive) {
    throw new Error("An Apple Music request lease is already active.");
  }

  const availableMappings = await loadAppleMusicMappings(db);
  const requestedArtistIds = scannerArtistIds(options);
  const requestedArtistIdSet = new Set(requestedArtistIds);
  const identityOverrides = providerIdentityOverrides(options, requestedArtistIds);
  const mappings = requestedArtistIds.length
    ? requestedArtistIds
        .map((artistId) => {
          const mapping = availableMappings.find(
            (candidate) => candidate.canonicalArtistId === artistId,
          );
          return mapping && identityOverrides.has(artistId)
            ? { ...mapping, appleArtistId: identityOverrides.get(artistId)! }
            : mapping;
        })
        .filter((mapping): mapping is (typeof availableMappings)[number] => Boolean(mapping))
    : availableMappings;
  if (requestedArtistIds.length && mappings.length !== requestedArtistIdSet.size) {
    throw new Error("The selected artist does not have a confirmed Apple Music mapping.");
  }
  if (mappings.length === 0) {
    return emptySummary();
  }

  const batchId = await createAppleMusicBatch(
    db,
    mappings.map((mapping) => ({
      appleArtistId: mapping.appleArtistId,
      artistId: mapping.canonicalArtistId,
    })),
  );
  const [run] = await db
    .insert(scanRuns)
    .values({
      artistFilter:
        options.artistId ??
        (options.artistIds?.length ? `cohort:${options.artistIds.length}` : null),
      detailedExpiresAt: new Date(Date.now() + configuration.scanDetailRetentionDays * 86_400_000),
      dryRun: false,
      metadata: {
        appleMusicBatchId: batchId,
        identityBootstrap: bootstrap,
        effectiveAppleMusicConfiguration: {
          maxRequestsPerRun: configuration.appleMusic.maxRequestsPerRun,
          maxRuntimeMs: configuration.appleMusic.maxRuntimeMs,
          minRequestIntervalMs: configuration.appleMusic.minRequestIntervalMs,
          storefront: configuration.appleMusic.storefront,
          windowDays: 30,
        },
      },
      provider: "apple_music",
      providersRequested: ["apple_music"],
      triggerType: options.artistId
        ? "provider_single_artist"
        : options.artistIds?.length
          ? "provider_cohort"
          : "provider_manual",
    })
    .returning({ id: scanRuns.id });
  if (!run) throw new Error("Apple Music scan run creation failed.");
  await attachAppleMusicBatchScanRun(db, batchId, run.id);

  const tokenManager = new AppleDeveloperTokenManager({
    keyId: configuration.appleMusic.keyId,
    privateKeyPath: configuration.appleMusic.privateKeyPath,
    teamId: configuration.appleMusic.teamId,
    tokenLifetimeSeconds: configuration.appleMusic.tokenLifetimeSeconds,
  });
  const client = new AppleMusicClient({
    enabled: true,
    maxRequestsPerRun: configuration.appleMusic.maxRequestsPerRun,
    maximumRuntimeMs: configuration.appleMusic.maxRuntimeMs,
    minRequestIntervalMs: configuration.appleMusic.minRequestIntervalMs,
    persistence: createAppleMusicRequestPersistence(db, { batchId, scanRunId: run.id }),
    requestTimeoutMs: configuration.appleMusic.requestTimeoutMs,
    runId: run.id,
    storefront: configuration.appleMusic.storefront,
    tokenProvider: tokenManager,
  });
  const mappingByArtist = new Map(mappings.map((mapping) => [mapping.canonicalArtistId, mapping]));
  const items = await loadAppleMusicBatchItems(db, batchId);
  let cumulative = emptyIncrementalSummary();
  let artistsProcessed = 0;
  let terminalFailures = 0;
  let finalStatus: AppleMusicPersistContext["status"] = "completed";
  let fatalError: unknown;

  await runtime.reportProgress?.(
    {
      appleMusicBatchId: batchId,
      completedUnits: 0,
      currentProvider: "apple_music",
      phase: "provider_start",
      totalUnits: items.length,
    },
    true,
  );

  for (const [position, item] of items.entries()) {
    if (runtime.signal?.aborted) {
      finalStatus = "cancelled";
      fatalError = runtime.signal.reason ?? new Error("Apple Music scan cancelled.");
      break;
    }
    const mapping = mappingByArtist.get(item.artistId);
    if (!mapping) {
      await finishAppleMusicArtist(db, {
        candidateCount: 0,
        errorClassification: "mapping_removed",
        id: item.id,
        releaseCount: 0,
        requestCount: 0,
        status: "terminal",
      });
      terminalFailures += 1;
      continue;
    }
    if (!(await startAppleMusicArtist(db, item.id))) continue;
    const requestBase = await countAppleMusicRequests(db, batchId);
    let releaseCount = 0;
    let candidates: TrackCandidate[] = [];
    try {
      await runtime.reportProgress?.(
        {
          completedUnits: position,
          currentUnit: mapping.canonicalName,
          currentUnitId: mapping.canonicalArtistId,
          phase: "scanning",
          totalUnits: items.length,
        },
        true,
      );
      const provider = new AppleMusicProvider(
        client,
        [mapping],
        () => new Date(),
        `batch:${batchId}:artist-scan:${item.id}`,
      );
      await provider.scan({
        filter: {
          artistId: mapping.canonicalArtistId,
          provider: "apple_music",
          since: item.windowStart,
        },
        onBatch: async (batch) => {
          candidates = batch.candidates;
          releaseCount = batch.releases?.length ?? 0;
          if (candidates.length > 0) {
            const result = await persist(candidates, {
              artistsProcessedCount: artistsProcessed + 1,
              cumulativeBase: cumulative,
              id: run.id,
              status: "running",
            });
            cumulative = addSummaries(cumulative, result);
          }
        },
        ...(runtime.signal ? { signal: runtime.signal } : {}),
      });
      const requestCount = (await countAppleMusicRequests(db, batchId)) - requestBase;
      await finishAppleMusicArtist(db, {
        candidateCount: candidates.length,
        id: item.id,
        releaseCount,
        requestCount,
        status: "completed",
      });
      artistsProcessed += 1;
    } catch (error) {
      const requestCount = Math.max(0, (await countAppleMusicRequests(db, batchId)) - requestBase);
      const outcome = classifyAppleMusicFailure(error, runtime.signal);
      await finishAppleMusicArtist(db, {
        candidateCount: candidates.length,
        errorClassification: outcome.classification,
        id: item.id,
        releaseCount,
        requestCount,
        ...(outcome.retryEligibleAt ? { retryEligibleAt: outcome.retryEligibleAt } : {}),
        status: outcome.artistStatus,
      });
      if (outcome.continue) {
        terminalFailures += 1;
        log("warn", "apple_music.artist_failed", {
          classification: outcome.classification,
          position,
        });
        continue;
      }
      finalStatus = outcome.runStatus;
      fatalError = error;
      break;
    }
  }

  if (fatalError) {
    await finishAppleMusicBatch(
      db,
      batchId,
      finalStatus === "rate_limited" ? "rate_limited" : "paused",
    );
    await finalizeScanRun(db, run.id, cumulative, artistsProcessed, finalStatus, fatalError);
    throw fatalError instanceof Error ? fatalError : new Error("Apple Music scan stopped.");
  }

  const remaining = await loadAppleMusicBatchItems(db, batchId);
  finalStatus = remaining.length > 0 ? "partial" : terminalFailures > 0 ? "partial" : "completed";
  await finishAppleMusicBatch(db, batchId, finalStatus);
  await finalizeScanRun(db, run.id, cumulative, artistsProcessed, finalStatus);
  await runtime.reportProgress?.(
    {
      completedUnits: artistsProcessed,
      currentProvider: null,
      phase: finalStatus === "completed" ? "provider_completed" : finalStatus,
      totalUnits: items.length,
    },
    true,
  );
  return {
    ...cumulative,
    providerResults: {
      apple_music: { discovered: cumulative.discovered, inserted: cumulative.inserted },
    },
  };
}

function scannerArtistIds(options: ScannerOptions): readonly string[] {
  if (options.artistId && options.artistIds?.length) {
    throw new Error("Choose either one artist or an internal artist cohort, not both.");
  }
  return options.artistId ? [options.artistId] : (options.artistIds ?? []);
}

async function loadAppleMusicMappings(db: RadarDatabase) {
  return db
    .select({
      appleArtistId: artistExternalIds.externalId,
      canonicalArtistId: artistExternalIds.artistId,
      canonicalName: artists.name,
    })
    .from(artistExternalIds)
    .innerJoin(artists, eq(artists.id, artistExternalIds.artistId))
    .innerJoin(artistFollows, eq(artistFollows.artistId, artists.id))
    .where(
      and(
        eq(artistExternalIds.provider, "apple_music"),
        eq(artistExternalIds.confirmed, true),
        eq(artistFollows.active, true),
      ),
    )
    .orderBy(asc(artists.normalizedName), asc(artists.id));
}

async function finalizeScanRun(
  db: RadarDatabase,
  runId: string,
  summary: Omit<AppleMusicScanSummary, "providerResults">,
  artistsProcessed: number,
  status: AppleMusicPersistContext["status"],
  error?: unknown,
): Promise<void> {
  await db
    .update(scanRuns)
    .set({
      artistsProcessedCount: artistsProcessed,
      completedAt: status === "running" ? null : new Date(),
      discoveredCount: summary.discovered,
      duplicatesIgnoredCount: summary.skipped,
      ...(error ? { errors: [{ classification: safeClassification(error) }] } : {}),
      insertedCount: summary.inserted,
      providersCompleted: status === "completed" ? ["apple_music"] : [],
      providersFailed: status === "partial" || status === "completed" ? [] : ["apple_music"],
      providerResults: {
        apple_music: {
          discovered: summary.discovered,
          inserted: summary.inserted,
          skipped: summary.skipped,
          status,
        },
      },
      reviewCount: summary.needsReview,
      skippedCount: summary.skipped,
      status,
    })
    .where(eq(scanRuns.id, runId));
}

export function classifyAppleMusicFailure(
  error: unknown,
  signal?: AbortSignal,
): {
  artistStatus: "retryable" | "terminal";
  classification: string;
  continue: boolean;
  retryEligibleAt?: Date;
  runStatus: "paused" | "cancelled" | "rate_limited";
} {
  if (signal?.aborted) {
    return {
      artistStatus: "retryable",
      classification: "cancelled",
      continue: false,
      runStatus: "cancelled",
    };
  }
  const classification =
    error instanceof AppleMusicClientError ? error.classification : "persistence_failure";
  if (
    error instanceof AppleMusicClientError &&
    (error.status === 400 || error.status === 404 || classification === "invalid_payload")
  ) {
    return { artistStatus: "terminal", classification, continue: true, runStatus: "paused" };
  }
  if (error instanceof AppleMusicClientError && error.status === 429) {
    return {
      artistStatus: "retryable",
      classification: "rate_limited",
      continue: false,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryEligibleAt: new Date(Date.now() + error.retryAfterSeconds * 1_000) }),
      runStatus: "rate_limited",
    };
  }
  if (
    classification === "request_budget_exhausted" ||
    classification === "runtime_budget_exhausted"
  ) {
    return { artistStatus: "retryable", classification, continue: false, runStatus: "paused" };
  }
  if (
    error instanceof AppleMusicClientError &&
    (error.status === 401 || error.status === 403 || classification === "provider_disabled")
  ) {
    return { artistStatus: "terminal", classification, continue: false, runStatus: "paused" };
  }
  return {
    artistStatus: "retryable",
    classification,
    continue:
      classification === "temporary_server_error" ||
      classification === "timeout" ||
      classification === "transport_error",
    retryEligibleAt: new Date(Date.now() + 5 * 60_000),
    runStatus: "paused",
  };
}

function validateSeedArtifact(value: unknown): AppleMusicSeedEntry[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Apple Music identity artifact is malformed.");
  }
  return value.entries.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.canonicalArtistName !== "string" ||
      typeof entry.classification !== "string" ||
      ![
        "ambiguous_seed",
        "evidence_supported_seed",
        "high_confidence_seed",
        "manual_review_required",
      ].includes(entry.classification) ||
      !Array.isArray(entry.evidenceSources) ||
      !entry.evidenceSources.every((source) => typeof source === "string") ||
      !Array.isArray(entry.alternateCandidateIds) ||
      !entry.alternateCandidateIds.every((id) => typeof id === "string") ||
      typeof entry.watchedArtistId !== "string"
    ) {
      throw new Error("Apple Music identity artifact contains an invalid entry.");
    }
    return {
      ...(typeof entry.candidateArtistId === "string"
        ? { candidateArtistId: entry.candidateArtistId }
        : {}),
      alternateCandidateIds: entry.alternateCandidateIds,
      canonicalArtistName: entry.canonicalArtistName,
      classification: entry.classification as AppleMusicSeedEntry["classification"],
      evidenceSources: entry.evidenceSources,
      ...(typeof entry.manualReviewReason === "string"
        ? { manualReviewReason: entry.manualReviewReason }
        : {}),
      watchedArtistId: entry.watchedArtistId,
    };
  });
}

function emptySummary(): AppleMusicScanSummary {
  return { ...emptyIncrementalSummary(), providerResults: {} };
}

function emptyIncrementalSummary(): Omit<AppleMusicScanSummary, "providerResults"> {
  return { discovered: 0, dryRun: false, inserted: 0, needsReview: 0, skipped: 0 };
}

function addSummaries(
  left: Omit<AppleMusicScanSummary, "providerResults">,
  right: Omit<AppleMusicScanSummary, "providerResults">,
): Omit<AppleMusicScanSummary, "providerResults"> {
  return {
    discovered: left.discovered + right.discovered,
    dryRun: false,
    inserted: left.inserted + right.inserted,
    needsReview: left.needsReview + right.needsReview,
    skipped: left.skipped + right.skipped,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeClassification(error: unknown): string {
  return error instanceof AppleMusicClientError ? error.classification : "scanner_failure";
}
