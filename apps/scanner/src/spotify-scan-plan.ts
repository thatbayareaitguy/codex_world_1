import {
  createSpotifyScanBatch,
  loadSpotifyCatalogSummaries,
  loadSpotifyReleaseTrackResume,
  latestSpotifyBatch,
  prepareSpotifyCoverage,
  recoverSpotifyBatch,
  reconcileSpotifyBatchMappings,
  releaseCandidates,
  releaseExternalIds,
  resumeSpotifyBatch,
  spotifyArtistScans,
  spotifyCoverageByArtist,
  type RadarDatabase,
  type SpotifyScanMode,
  type SpotifyReleaseTrackResume,
} from "@radar/db";
import type { ProviderConfiguration, SpotifyArtistMapping } from "@radar/providers";
import { desc, eq, inArray } from "drizzle-orm";
import type { ScannerOptions } from "./args";
import { providerIdentityOverrides } from "./provider-identity-overrides";

export interface PreparedSpotifyWork {
  batchId: string;
  deferredArtistCount: number;
  knownReleaseIds: ReadonlySet<string>;
  mappings: SpotifyArtistMapping[];
  maxPagesPerArtist: number;
  maxRequestsPerRun: number;
  mode: SpotifyScanMode;
  paused: boolean;
  reconciliationCycleIds: ReadonlyMap<string, string | null>;
  startOffsets: ReadonlyMap<string, number>;
  knownReleaseSummaries: ReadonlyMap<string, string>;
  incompleteReleaseIds: ReadonlySet<string>;
  releaseTrackResume: ReadonlyMap<string, SpotifyReleaseTrackResume>;
}

interface ReconciliationCoverage {
  artistId: string;
  lastFullReconciliationAt: Date | null;
  partial: boolean;
  status: string;
}

export async function prepareSpotifyWork(
  db: RadarDatabase,
  mappings: SpotifyArtistMapping[],
  configuration: ProviderConfiguration,
  options: ScannerOptions,
): Promise<PreparedSpotifyWork> {
  const knownReleaseIds = await loadKnownSpotifyReleaseIds(db);
  const releaseTrackResume = await loadSpotifyReleaseTrackResume(db);
  const incompleteReleaseIds = new Set(releaseTrackResume.keys());
  const requestedArtistIds = options.artistId ? [options.artistId] : (options.artistIds ?? []);
  if (options.artistId && options.artistIds?.length) {
    throw new Error("Choose either one Spotify artist or an internal artist cohort, not both.");
  }
  if (requestedArtistIds.length) {
    const identityOverrides = providerIdentityOverrides(options, requestedArtistIds);
    const requestedMappings = requestedArtistIds
      .map((artistId) => {
        const mapping = mappings.find((entry) => entry.artistId === artistId);
        return mapping && identityOverrides.has(artistId)
          ? { ...mapping, spotifyArtistId: identityOverrides.get(artistId)! }
          : mapping;
      })
      .filter((mapping): mapping is SpotifyArtistMapping => Boolean(mapping));
    if (requestedMappings.length !== new Set(requestedArtistIds).size) {
      throw new Error("A requested artist has no confirmed Spotify mapping.");
    }
    const mode = options.spotifyMode ?? "daily";
    const maxPagesPerArtist = pageLimit(configuration, mode, options.spotifyMaxPages);
    const batchId = await createSpotifyScanBatch(db, {
      artists: requestedMappings.map((mapping) => ({
        artistId: mapping.artistId,
        spotifyArtistId: mapping.spotifyArtistId,
      })),
      confirmationRequired: false,
      estimatedRequests: estimateRequests(requestedMappings.length, maxPagesPerArtist),
      mode,
      pageLimit: maxPagesPerArtist,
    });
    const coverage = await prepareSpotifyCoverage(db, {
      artistIds: requestedMappings.map((mapping) => mapping.artistId),
      cycleDays: configuration.spotify.reconciliationCycleDays,
      mode,
      newCycle: options.spotifyNewReconciliationCycle ?? false,
    });
    return {
      batchId,
      deferredArtistCount: 0,
      knownReleaseIds,
      knownReleaseSummaries: await loadSpotifyCatalogSummaries(db),
      incompleteReleaseIds,
      mappings: requestedMappings,
      maxPagesPerArtist,
      maxRequestsPerRun: configuration.spotify.maxRequestsPerRun,
      mode,
      paused: false,
      releaseTrackResume,
      reconciliationCycleIds: new Map(
        coverage.map((entry) => [entry.artistId, entry.cycleId] as const),
      ),
      startOffsets: new Map(coverage.map((entry) => [entry.artistId, entry.startOffset] as const)),
    };
  }

  let latest = options.spotifyBatchId
    ? await loadBatch(db, options.spotifyBatchId)
    : await latestSpotifyBatch(db);
  if (
    latest &&
    ["pending", "running", "paused", "rate_limited", "blocked_mapping"].includes(latest.status)
  ) {
    await recoverSpotifyBatch(db, latest.id);
    await reconcileSpotifyBatchMappings(db, latest.id, mappings);
    latest = await loadBatch(db, latest.id);
    if (options.spotifyConfirmBatch) await resumeSpotifyBatch(db, latest.id);
    const resumable = latest.artistScans
      .filter((progress) =>
        ["pending", "running", "paused", "rate_limited"].includes(progress.status),
      )
      .map((progress) => mappings.find((mapping) => mapping.artistId === progress.artistId))
      .filter((mapping): mapping is SpotifyArtistMapping => Boolean(mapping));
    const selection = selectSpotifyBatchMappings(resumable, configuration.spotify.artistsPerBatch);
    const selected = selection.mappings;
    const mode = latest.mode as SpotifyScanMode;
    const coverage = await prepareSpotifyCoverage(db, {
      artistIds: selected.map((mapping) => mapping.artistId),
      cycleDays: configuration.spotify.reconciliationCycleDays,
      mode,
      newCycle: false,
    });
    return {
      batchId: latest.id,
      deferredArtistCount: selection.deferredArtistCount,
      knownReleaseIds,
      knownReleaseSummaries: await loadSpotifyCatalogSummaries(db),
      incompleteReleaseIds,
      mappings: selected,
      maxPagesPerArtist: latest.pageLimit,
      maxRequestsPerRun: configuration.spotify.maxRequestsPerRun,
      mode,
      paused: latest.status === "paused" && !options.spotifyConfirmBatch,
      releaseTrackResume,
      reconciliationCycleIds: new Map(
        coverage.map((entry) => [entry.artistId, entry.cycleId] as const),
      ),
      startOffsets: new Map(coverage.map((entry) => [entry.artistId, entry.startOffset] as const)),
    };
  }

  const history = await db
    .select()
    .from(spotifyArtistScans)
    .where(inArray(spotifyArtistScans.status, ["completed", "partial"]))
    .orderBy(desc(spotifyArtistScans.finishedAt));
  const lastByArtist = new Map<string, (typeof history)[number]>();
  for (const row of history)
    if (!lastByArtist.has(row.artistId)) lastByArtist.set(row.artistId, row);
  const recentSpotifyCandidates = await db
    .select({
      artistExternalId: releaseCandidates.artistExternalId,
      releaseDate: releaseCandidates.releaseDate,
    })
    .from(releaseCandidates)
    .where(eq(releaseCandidates.provider, "spotify"));
  const recentCutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const recentlyActiveSpotifyIds = new Set(
    recentSpotifyCandidates
      .filter((candidate) => candidate.releaseDate >= recentCutoff)
      .map((candidate) => candidate.artistExternalId),
  );
  const ordered = [...mappings].sort((left, right) => {
    const leftHistory = lastByArtist.get(left.artistId);
    const rightHistory = lastByArtist.get(right.artistId);
    const rank = (
      historyEntry: (typeof history)[number] | undefined,
      mapping: SpotifyArtistMapping,
    ) =>
      !historyEntry
        ? 0
        : recentlyActiveSpotifyIds.has(mapping.spotifyArtistId)
          ? 1
          : historyEntry.status === "partial"
            ? 2
            : 3;
    const leftRank = rank(leftHistory, left);
    const rightRank = rank(rightHistory, right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (leftHistory?.finishedAt?.getTime() ?? 0) - (rightHistory?.finishedAt?.getTime() ?? 0);
  });
  const requestedMode = options.spotifyMode ?? "daily";
  const batchSize =
    requestedMode === "reconciliation"
      ? configuration.spotify.reconciliationArtistsPerBatch
      : configuration.spotify.artistsPerBatch;
  const eligibleMappings =
    requestedMode === "reconciliation"
      ? selectSpotifyReconciliationMappings(
          ordered,
          await spotifyCoverageByArtist(
            db,
            ordered.map((mapping) => mapping.artistId),
          ),
          configuration.spotify.reconciliationCycleDays,
        )
      : ordered;
  const selected = eligibleMappings.slice(0, batchSize);
  if (selected.length === 0) throw new Error("No active Spotify artist mappings are available.");
  const firstStagedBatch = history.length === 0;
  const mode = firstStagedBatch ? "initial" : (options.spotifyMode ?? "daily");
  const maxPagesPerArtist = pageLimit(configuration, mode, options.spotifyMaxPages);
  const batchId = await createSpotifyScanBatch(db, {
    artists: selected,
    confirmationRequired: firstStagedBatch,
    estimatedRequests: estimateRequests(selected.length, maxPagesPerArtist),
    mode,
    pageLimit: maxPagesPerArtist,
  });
  const coverage = await prepareSpotifyCoverage(db, {
    artistIds: selected.map((mapping) => mapping.artistId),
    cycleDays: configuration.spotify.reconciliationCycleDays,
    mode,
    newCycle: options.spotifyNewReconciliationCycle ?? false,
  });
  return {
    batchId,
    deferredArtistCount: 0,
    knownReleaseIds,
    knownReleaseSummaries: await loadSpotifyCatalogSummaries(db),
    incompleteReleaseIds,
    mappings: selected,
    maxPagesPerArtist,
    maxRequestsPerRun: configuration.spotify.maxRequestsPerRun,
    mode,
    paused: firstStagedBatch,
    releaseTrackResume,
    reconciliationCycleIds: new Map(
      coverage.map((entry) => [entry.artistId, entry.cycleId] as const),
    ),
    startOffsets: new Map(coverage.map((entry) => [entry.artistId, entry.startOffset] as const)),
  };
}

export function selectSpotifyBatchMappings(
  mappings: SpotifyArtistMapping[],
  maximumArtists: number,
): { deferredArtistCount: number; mappings: SpotifyArtistMapping[] } {
  if (!Number.isInteger(maximumArtists) || maximumArtists < 1) {
    throw new Error("Spotify resumed-batch artist limit must be a positive integer.");
  }
  return {
    deferredArtistCount: Math.max(0, mappings.length - maximumArtists),
    mappings: mappings.slice(0, maximumArtists),
  };
}

export function selectSpotifyReconciliationMappings(
  mappings: SpotifyArtistMapping[],
  coverage: ReconciliationCoverage[],
  cycleDays: number,
  now = new Date(),
): SpotifyArtistMapping[] {
  const byArtist = new Map(coverage.map((row) => [row.artistId, row] as const));
  const cycleCutoff = now.getTime() - cycleDays * 86_400_000;
  return mappings.filter((mapping) => {
    const row = byArtist.get(mapping.artistId);
    if (!row || row.partial || row.status !== "fully_reconciled") return true;
    return (
      row.lastFullReconciliationAt === null || row.lastFullReconciliationAt.getTime() <= cycleCutoff
    );
  });
}

export function spotifyScheduleEstimate(
  artistCount: number,
  configuration: ProviderConfiguration,
): {
  artistsPerHour: number;
  estimatedMaximumRequests: number;
  estimatedMinimumHours: number;
  estimatedMaximumHours: number;
} {
  const artistsPerHour = artistCount / configuration.spotify.scanDistributionHours;
  const estimatedMaximumRequests = estimateRequests(
    artistCount,
    configuration.spotify.dailyMaxPagesPerArtist,
  );
  const requestHours =
    (estimatedMaximumRequests * configuration.spotify.minRequestIntervalMs) / 3_600_000;
  return {
    artistsPerHour,
    estimatedMaximumHours: Math.max(
      configuration.spotify.scanDistributionHours,
      requestHours * 1.5,
    ),
    estimatedMaximumRequests,
    estimatedMinimumHours: Math.max(configuration.spotify.scanDistributionHours, requestHours),
  };
}

function pageLimit(
  configuration: ProviderConfiguration,
  mode: SpotifyScanMode,
  override?: number,
): number {
  if (override) return override;
  if (mode === "initial") return configuration.spotify.initialMaxPagesPerArtist;
  if (mode === "reconciliation") return configuration.spotify.reconciliationMaxPagesPerRun;
  return configuration.spotify.dailyMaxPagesPerArtist;
}

function estimateRequests(artists: number, pagesPerArtist: number): number {
  return artists * (pagesPerArtist + pagesPerArtist * 10);
}

async function loadKnownSpotifyReleaseIds(db: RadarDatabase): Promise<ReadonlySet<string>> {
  const [external, candidates] = await Promise.all([
    db
      .select({ id: releaseExternalIds.externalId })
      .from(releaseExternalIds)
      .where(eq(releaseExternalIds.provider, "spotify")),
    db
      .select({ id: releaseCandidates.providerReleaseId })
      .from(releaseCandidates)
      .where(eq(releaseCandidates.provider, "spotify")),
  ]);
  return new Set([...external, ...candidates].map((row) => row.id));
}

async function loadBatch(db: RadarDatabase, batchId: string) {
  const batch = await db.query.spotifyScanBatches.findFirst({
    where: (table, { eq }) => eq(table.id, batchId),
  });
  if (!batch) throw new Error("Spotify scan batch was not found.");
  const artistScans = await db.query.spotifyArtistScans.findMany({
    where: eq(spotifyArtistScans.batchId, batch.id),
    orderBy: (table, { asc }) => [asc(table.position)],
  });
  return { ...batch, artistScans };
}
