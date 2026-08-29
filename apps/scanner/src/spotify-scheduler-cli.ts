import {
  createDatabase,
  createSpotifyReleaseReconciliationRepository,
  createSpotifyRequestGate,
  defaultSchedulerLimits,
  ensureLocalOwner,
  artistExternalIds,
  artists,
  loadSpotifyReleaseTrackResume,
  markSpotifyReleaseDetailsFetched,
  markSpotifyReleaseTrackInterrupted,
  oauthAccounts,
  reconcileCampaignProviderReleases,
  recordSpotifyReleaseTrackPage,
  recordSpotifyCatalogReleaseSummaries,
  recordCampaignSpotifyBatch,
  spotifyCatalogReleases,
  spotifyArtistScans,
  spotifyReleaseTrackRetrievals,
  spotifyScanBatches,
  startSpotifyReleaseTrackRetrieval,
  SpotifyTokenManager,
  queueSpotifyCampaignReleaseTrackWork,
  queueSpotifyResolutionReleaseDetailWork,
  queueSpotifyReleaseTrackWork,
  queueSpotifyTrackResolutionWork,
  releases,
  trackExternalIds,
  tracks,
  type SpotifySchedulerClaim,
  type SpotifySchedulerLimits,
} from "@radar/db";
import {
  loadProviderConfiguration,
  SpotifyClient,
  SpotifyOAuthClient,
  SpotifyProvider,
  spotifyCandidateFromTrack,
  type ProviderReleaseTrackPage,
  type ProviderConfiguration,
  type SpotifyArtistMapping,
} from "@radar/providers";
import { and, desc, eq, gte } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadLocalEnvironment } from "./local-env";
import { persistCandidates, runScanUnlocked } from "./scan";
import {
  runSpotifyReleaseReconciliation,
  type SpotifyReleaseReconciliationRepository,
} from "./spotify-release-reconciliation";
import {
  runSpotifySchedulerTick,
  type SpotifySchedulerExecutionContext,
  type SpotifySchedulerExecutor,
} from "./spotify-scheduler";

class SpotifyResolutionMismatchError extends Error {
  readonly code = "spotify_resolution_mismatch";

  constructor() {
    super("The Spotify track does not match the target ISRC and artist.");
    this.name = "SpotifyResolutionMismatchError";
  }
}

loadLocalEnvironment();

export function parseSpotifySchedulerCommand(args: string[]): "plan" | "tick" {
  const values = args.filter((value) => value !== "--");
  if (values.length !== 1 || !["plan", "tick"].includes(values[0] ?? "")) {
    throw new Error("Usage: pnpm spotify:scheduler:plan or pnpm spotify:scheduler:tick");
  }
  return values[0] as "plan" | "tick";
}

export function schedulerLimitsFromConfiguration(
  configuration: ProviderConfiguration,
): SpotifySchedulerLimits {
  const defaults = defaultSchedulerLimits();
  return {
    ...defaults,
    artistAlbums24HourLimit: configuration.spotify.artistAlbums24HourLimit,
    artistAlbumsPriorityReserve: configuration.spotify.artistAlbumsPriorityReserve,
    artistAlbumsReserveReleaseAfterHours:
      configuration.spotify.artistAlbumsReserveReleaseAfterHours,
    maxRequestsPerTick: configuration.spotify.scheduler.maxRequestsPerTick,
    maxRuntimeMs: configuration.spotify.scheduler.maxRuntimeMs,
    minRequestIntervalMs: configuration.spotify.minRequestIntervalMs,
    rolling24HourLimit: configuration.spotify.scheduler.rolling24HourLimit,
    rolling30MinuteLimit: configuration.spotify.scheduler.rolling30MinuteLimit,
  };
}

export function sanitizedSchedulerOutput(
  result: Awaited<ReturnType<typeof runSpotifySchedulerTick>>,
) {
  return {
    mode: result.mode,
    reason: result.reason,
    requestsStarted: result.requestsStarted,
    selected: result.selected
      ? {
          source: result.selected.source,
          workId: abbreviate(result.selected.id),
          workType: result.selected.workType,
        }
      : null,
    status: {
      backlog: result.status.backlog,
      blockedCount: result.status.blockedCount,
      blockedReasons: result.status.blockedReasons,
      cooldownActive: result.status.cooldownActive,
      dueArtistCount: result.status.dueArtistCount,
      eligibleArtistCount: result.status.eligibleArtistCount,
      estimatedCompletion: result.status.estimatedCompletion,
      mode: result.status.mode,
      nextBaseSlotAt: result.status.nextBaseSlotAt,
      overdueArtistCount: result.status.overdueArtistCount,
      requestCounts: result.status.requestCounts,
      recentWork: result.status.recentWork
        ? {
            completedAt: result.status.recentWork.completedAt,
            workId: abbreviate(result.status.recentWork.workId),
            workType: result.status.recentWork.workType,
          }
        : null,
    },
  };
}

export function spotifyArtistWorkScanOptions(
  work: Pick<SpotifySchedulerClaim, "source" | "workType">,
) {
  const refreshNewestCatalogPage = ["apple_priority", "apple_catchup"].includes(work.source);
  return {
    full: work.workType === "artist_reconciliation" && !refreshNewestCatalogPage,
    spotifyMode:
      work.workType === "artist_reconciliation" && !refreshNewestCatalogPage
        ? ("reconciliation" as const)
        : ("daily" as const),
  };
}

async function main(): Promise<void> {
  const command = parseSpotifySchedulerCommand(process.argv.slice(2));
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const mode = command === "plan" ? "plan" : "production";
    const executor =
      command === "tick" && configuration.spotify.scheduler.enabled
        ? await createProductionSchedulerExecutor(connection.db, configuration)
        : undefined;
    const result = await runSpotifySchedulerTick(connection.db, {
      capabilityEnabled: configuration.spotify.scheduler.enabled,
      ...(executor ? { executor } : {}),
      limits: schedulerLimitsFromConfiguration(configuration),
      mode,
    });
    process.stdout.write(`${JSON.stringify(sanitizedSchedulerOutput(result), null, 2)}\n`);
  } finally {
    await connection.client.end();
  }
}

export async function createProductionSchedulerExecutor(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ProviderConfiguration,
): Promise<SpotifySchedulerExecutor> {
  if (
    !configuration.spotify.configured ||
    !configuration.spotify.clientId ||
    !configuration.spotify.clientSecret ||
    !configuration.appEncryptionKey
  ) {
    throw new Error("Spotify scheduler production execution is not configured.");
  }
  const userId = await ensureLocalOwner(db);
  const account = await db.query.oauthAccounts.findFirst({
    where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "spotify")),
    columns: { disconnectedAt: true, reconnectRequired: true },
  });
  if (!account || account.disconnectedAt || account.reconnectRequired) {
    throw new Error("Spotify scheduler production execution requires a connected account.");
  }
  return {
    execute: (work, context) => executeProductionWork(db, configuration, work, context),
  };
}

async function executeProductionWork(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ProviderConfiguration,
  work: SpotifySchedulerClaim,
  context: SpotifySchedulerExecutionContext,
): Promise<void> {
  if (work.workType === "release_tracks") {
    await executeReleaseTrackWork(db, configuration, work, context);
    return;
  }
  if (work.workType === "release_detail") {
    await executeReleaseDetailWork(db, configuration, work, context);
    return;
  }
  if (work.workType === "track_resolution") {
    await executeTrackResolutionWork(db, configuration, work, context);
    return;
  }
  if (!work.artistId) throw new Error("Scheduler artist work is missing its canonical artist ID.");
  const adjustedConfiguration: ProviderConfiguration = {
    ...configuration,
    spotify: {
      ...configuration.spotify,
      artistsPerBatch: 1,
      dailyMaxPagesPerArtist: 1,
      maxRequestsPerRun: configuration.spotify.scheduler.maxRequestsPerTick,
      minRequestIntervalMs: Math.max(10_000, configuration.spotify.minRequestIntervalMs),
      reconciliationArtistsPerBatch: 1,
      reconciliationMaxPagesPerRun: 1,
    },
  };
  const startedAt = new Date();
  const scanOptions = spotifyArtistWorkScanOptions(work);
  try {
    await runScanUnlocked(
      {
        artistId: work.artistId,
        dryRun: false,
        full: scanOptions.full,
        provider: "spotify",
        source: "spotify_scheduler",
        spotifyConfirmBatch: false,
        spotifyMaxPages: 1,
        spotifyMode: scanOptions.spotifyMode,
        spotifyNewReconciliationCycle: false,
      },
      adjustedConfiguration,
      {
        deadlineAt: context.deadlineAt,
        deferSpotifyReleaseDetails: true,
        reportProgress: () => Promise.resolve(),
        requestGateWrapper: context.wrapRequestGate,
        schedulerContext: {
          ...(campaignContext(work) ?? {}),
          ...(work.discoveryReconciliationCampaignId
            ? {
                discoveryReconciliationCampaignId: work.discoveryReconciliationCampaignId,
              }
            : {}),
          source: work.source,
          workId: work.id,
          workType: work.workType,
        },
        signal: context.signal,
      },
    );
  } catch (error) {
    await recordDiscoveryCampaignScan(db, work, startedAt, false);
    throw error;
  }
  await recordDiscoveryCampaignScan(db, work, startedAt, true);
}

async function executeTrackResolutionWork(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ProviderConfiguration,
  work: SpotifySchedulerClaim,
  context: SpotifySchedulerExecutionContext,
): Promise<void> {
  if (
    !work.artistId ||
    !work.expectedSpotifyArtistId ||
    !work.targetTrackId ||
    !work.targetIsrc ||
    !work.trackResolutionMode
  ) {
    throw new Error("Track-resolution work is missing its target context.");
  }
  const expectedSpotifyArtistId = work.expectedSpotifyArtistId;
  const existing = await db.query.trackExternalIds.findFirst({
    where: and(
      eq(trackExternalIds.trackId, work.targetTrackId),
      eq(trackExternalIds.provider, "spotify"),
    ),
    columns: { id: true },
  });
  if (existing) return;

  const [target] = await db
    .select({
      artistName: artists.name,
      durationMs: tracks.durationMs,
      releaseDate: releases.releaseDate,
      title: tracks.title,
    })
    .from(tracks)
    .leftJoin(releases, eq(releases.id, tracks.releaseId))
    .innerJoin(artists, eq(artists.id, work.artistId))
    .where(eq(tracks.id, work.targetTrackId))
    .limit(1);
  if (!target) throw new Error("Track-resolution target no longer exists.");

  const client = await createSchedulerSpotifyClient(db, configuration, work, context);
  const mapping: SpotifyArtistMapping = {
    artistId: work.artistId,
    name: target.artistName,
    spotifyArtistId: work.expectedSpotifyArtistId,
  };
  if (work.trackResolutionMode === "manual") {
    if (!work.targetSpotifyTrackId) throw new Error("Manual track resolution has no Spotify ID.");
    const track = await client.getTrack(work.targetSpotifyTrackId, context.signal);
    assertSpotifyResolutionTrack(work, track);
    await persistCandidates(
      db,
      [spotifyCandidateFromTrack(mapping, track, new Date(), "US")],
      trackResolutionScanOptions(work.artistId),
    );
    return;
  }
  if (work.trackResolutionMode === "isrc") {
    const matches = (await client.searchTracksByIsrc(work.targetIsrc, context.signal))
      .filter((track) => spotifyResolutionTrackMatches(work, track))
      .sort((left, right) =>
        compareResolutionTracks(left, right, target.releaseDate, expectedSpotifyArtistId),
      );
    const match = matches[0];
    if (match) {
      await persistCandidates(
        db,
        [spotifyCandidateFromTrack(mapping, match, new Date(), "US")],
        trackResolutionScanOptions(work.artistId),
      );
      return;
    }
    await queueSpotifyTrackResolutionWork(db, {
      artistId: work.artistId,
      expectedSpotifyArtistId: work.expectedSpotifyArtistId,
      mode: "single",
      requeueCompleted: false,
      source: work.source,
      targetIsrc: work.targetIsrc,
      targetTrackId: work.targetTrackId,
    });
    return;
  }

  const group = work.trackResolutionMode;
  const page = await client.getArtistAlbumsPage(work.expectedSpotifyArtistId, 0, context.signal, [
    group,
  ]);
  const observedAt = new Date();
  await recordSpotifyCatalogReleaseSummaries(db, {
    artistId: work.artistId,
    observedAt,
    releases: page.items.map((album) => ({
      externalReleaseId: album.id,
      releaseDate: normalizeSpotifyReleaseDate(album.release_date),
      releaseDatePrecision: album.release_date_precision,
      releaseType: album.album_type,
      title: album.name,
      totalTracks: album.total_tracks,
    })),
  });
  for (const album of page.items.filter((item) =>
    isResolutionReleaseDate(item.release_date, target.releaseDate),
  )) {
    await queueSpotifyResolutionReleaseDetailWork(db, {
      artistId: work.artistId,
      dueAt: observedAt,
      source: work.source,
      spotifyAlbumId: album.id,
      targetTrackId: work.targetTrackId,
    });
  }
  if (group === "single") {
    await queueSpotifyTrackResolutionWork(db, {
      artistId: work.artistId,
      expectedSpotifyArtistId: work.expectedSpotifyArtistId,
      mode: "album",
      requeueCompleted: false,
      source: work.source,
      targetIsrc: work.targetIsrc,
      targetTrackId: work.targetTrackId,
    });
  }
}

function spotifyResolutionTrackMatches(
  work: Pick<SpotifySchedulerClaim, "expectedSpotifyArtistId" | "targetIsrc">,
  track: Awaited<ReturnType<SpotifyClient["getTrack"]>>,
): boolean {
  const targetIsrc = work.targetIsrc?.replaceAll(/[^A-Za-z0-9]/g, "").toUpperCase();
  const trackIsrc = track.external_ids?.isrc?.replaceAll(/[^A-Za-z0-9]/g, "").toUpperCase();
  return Boolean(
    targetIsrc &&
    targetIsrc === trackIsrc &&
    track.artists.some((artist) => artist.id === work.expectedSpotifyArtistId),
  );
}

function assertSpotifyResolutionTrack(
  work: Pick<SpotifySchedulerClaim, "expectedSpotifyArtistId" | "targetIsrc">,
  track: Awaited<ReturnType<SpotifyClient["getTrack"]>>,
): void {
  if (!spotifyResolutionTrackMatches(work, track)) {
    throw new SpotifyResolutionMismatchError();
  }
}

function compareResolutionTracks(
  left: Awaited<ReturnType<SpotifyClient["getTrack"]>>,
  right: Awaited<ReturnType<SpotifyClient["getTrack"]>>,
  targetReleaseDate: string | null,
  expectedSpotifyArtistId: string,
): number {
  const leftDate = normalizeSpotifyReleaseDate(left.album.release_date);
  const rightDate = normalizeSpotifyReleaseDate(right.album.release_date);
  const leftExact = targetReleaseDate === leftDate ? 1 : 0;
  const rightExact = targetReleaseDate === rightDate ? 1 : 0;
  if (leftExact !== rightExact) return rightExact - leftExact;
  const leftPrimary = left.artists[0]?.id === expectedSpotifyArtistId ? 1 : 0;
  const rightPrimary = right.artists[0]?.id === expectedSpotifyArtistId ? 1 : 0;
  if (leftPrimary !== rightPrimary) return rightPrimary - leftPrimary;
  return left.id.localeCompare(right.id);
}

function isResolutionReleaseDate(releaseDate: string, targetReleaseDate: string | null): boolean {
  if (!targetReleaseDate) return true;
  const observed = Date.parse(`${normalizeSpotifyReleaseDate(releaseDate)}T00:00:00Z`);
  const target = Date.parse(`${targetReleaseDate}T00:00:00Z`);
  return Number.isFinite(observed) && Math.abs(observed - target) <= 45 * 86_400_000;
}

function normalizeSpotifyReleaseDate(value: string): string {
  if (/^\d{4}$/.test(value)) return `${value}-01-01`;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  return value;
}

function trackResolutionScanOptions(artistId: string) {
  return {
    artistId,
    dryRun: false,
    full: false,
    provider: "spotify" as const,
    source: "spotify_track_resolution",
  };
}

async function executeReleaseDetailWork(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ProviderConfiguration,
  work: SpotifySchedulerClaim,
  context: SpotifySchedulerExecutionContext,
): Promise<void> {
  if (!work.artistId || !work.spotifyAlbumId) {
    throw new Error("Release-detail work is missing its artist or Spotify album ID.");
  }
  const [catalog, mappingRow] = await Promise.all([
    db.query.spotifyCatalogReleases.findFirst({
      where: and(
        eq(spotifyCatalogReleases.artistId, work.artistId),
        eq(spotifyCatalogReleases.externalReleaseId, work.spotifyAlbumId),
      ),
    }),
    db
      .select({
        artistId: artists.id,
        name: artists.name,
        spotifyArtistId: artistExternalIds.externalId,
      })
      .from(artists)
      .innerJoin(
        artistExternalIds,
        and(
          eq(artistExternalIds.artistId, artists.id),
          eq(artistExternalIds.provider, "spotify"),
          eq(artistExternalIds.confirmed, true),
        ),
      )
      .where(eq(artists.id, work.artistId))
      .limit(1),
  ]);
  const mapping: SpotifyArtistMapping | undefined = mappingRow[0];
  if (!catalog || !mapping) throw new Error("Release-detail scheduler context is unavailable.");
  const client = await createSchedulerSpotifyClient(db, configuration, work, context);
  const provider = new SpotifyProvider({
    client,
    mappings: [],
    releaseTrackResume: await loadSpotifyReleaseTrackResume(db),
  });
  try {
    await provider.scanReleaseDetails(
      mapping,
      { id: work.spotifyAlbumId, total_tracks: catalog.totalTracks },
      {
        filter: { artistId: work.artistId, provider: "spotify" },
        onReleaseTrackError: (error) =>
          markSpotifyReleaseTrackInterrupted(db, {
            errorClassification: error.classification,
            spotifyAlbumId: error.externalReleaseId,
            status: error.status,
          }),
        onReleaseTrackPage: async (page: ProviderReleaseTrackPage) => {
          await persistCandidates(db, page.candidates, {
            artistId: work.artistId!,
            dryRun: false,
            full: false,
            provider: "spotify",
            source: "spotify_scheduler_detail",
          });
          await recordSpotifyReleaseTrackPage(db, {
            ...(page.errorClassification ? { errorClassification: page.errorClassification } : {}),
            expectedTotalTracks: page.expectedTotalTracks,
            finishedAt: page.finishedAt,
            items: page.items,
            nextOffset: page.nextOffset,
            offset: page.offset,
            spotifyAlbumId: page.externalReleaseId,
            startedAt: page.startedAt,
            terminal: page.terminal,
          });
        },
        onReleaseTrackStart: (release) =>
          startSpotifyReleaseTrackRetrieval(db, {
            expectedTotalTracks: release.expectedTotalTracks,
            spotifyAlbumId: release.externalReleaseId,
          }),
        signal: context.signal,
      },
    );
    await markSpotifyReleaseDetailsFetched(db, {
      artistId: work.artistId,
      spotifyAlbumId: work.spotifyAlbumId,
    });
  } finally {
    const campaign = campaignContext(work);
    const retrieval = await db.query.spotifyReleaseTrackRetrievals.findFirst({
      where: eq(spotifyReleaseTrackRetrievals.spotifyAlbumId, work.spotifyAlbumId),
    });
    if (retrieval && retrieval.status !== "completed") {
      if (campaign) {
        await queueSpotifyCampaignReleaseTrackWork(db, {
          campaignId: campaign.campaignId,
          campaignMemberId: campaign.campaignMemberId,
          releaseTrackRetrievalId: retrieval.id,
          ...(work.source === "apple_priority" ? { source: "apple_priority" as const } : {}),
          spotifyAlbumId: work.spotifyAlbumId,
        });
      } else if (work.discoveryReconciliationCampaignId) {
        await queueSpotifyReleaseTrackWork(db, {
          discoveryReconciliationCampaignId: work.discoveryReconciliationCampaignId,
          releaseTrackRetrievalId: retrieval.id,
          source: work.source,
          spotifyAlbumId: work.spotifyAlbumId,
        });
      }
    }
  }
}

async function createSchedulerSpotifyClient(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ProviderConfiguration,
  work: SpotifySchedulerClaim,
  context: SpotifySchedulerExecutionContext,
): Promise<SpotifyClient> {
  const userId = await ensureLocalOwner(db);
  const gate = context.wrapRequestGate(
    createSpotifyRequestGate(
      db,
      configuration.spotify.minRequestIntervalMs,
      {
        source: work.source,
        workId: work.id,
        workType: work.workType,
      },
      work.discoveryReconciliationCampaignId ?? undefined,
      {
        artistAlbumsBudget: {
          limit: configuration.spotify.artistAlbums24HourLimit,
          priorityReserve: configuration.spotify.artistAlbumsPriorityReserve,
          reserveReleaseAfterHours: configuration.spotify.artistAlbumsReserveReleaseAfterHours,
        },
      },
    ),
  );
  const oauth = new SpotifyOAuthClient({
    clientId: configuration.spotify.clientId!,
    clientSecret: configuration.spotify.clientSecret!,
    redirectUri: configuration.spotify.redirectUri,
    requestGate: gate,
  });
  const tokens = new SpotifyTokenManager(db, userId, configuration.appEncryptionKey!, oauth);
  return new SpotifyClient({
    accessToken: () => tokens.getAccessToken(),
    onUnauthorized: () => tokens.refresh().then(() => undefined),
    requestGate: gate,
  });
}

async function recordDiscoveryCampaignScan(
  db: ReturnType<typeof createDatabase>["db"],
  work: SpotifySchedulerClaim,
  startedAt: Date,
  required: boolean,
): Promise<void> {
  if (!work.discoveryReconciliationCampaignId || !work.artistId) return;
  const [batch] = await db
    .select({ id: spotifyScanBatches.id })
    .from(spotifyArtistScans)
    .innerJoin(spotifyScanBatches, eq(spotifyArtistScans.batchId, spotifyScanBatches.id))
    .where(
      and(
        eq(spotifyArtistScans.artistId, work.artistId),
        gte(spotifyScanBatches.updatedAt, startedAt),
      ),
    )
    .orderBy(desc(spotifyScanBatches.updatedAt))
    .limit(1);
  if (!batch) {
    if (required) throw new Error("Spotify priority work completed without a persisted batch.");
    return;
  }
  const recorded = await recordCampaignSpotifyBatch(
    db,
    work.discoveryReconciliationCampaignId,
    batch.id,
  );
  if (recorded.reconciliableArtistIds.includes(work.artistId)) {
    await reconcileCampaignProviderReleases(db, work.discoveryReconciliationCampaignId, [
      work.artistId,
    ]);
  }
}

async function executeReleaseTrackWork(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ProviderConfiguration,
  work: SpotifySchedulerClaim,
  context: SpotifySchedulerExecutionContext,
): Promise<void> {
  if (!work.releaseTrackRetrievalId) throw new Error("Release-track work has no retrieval ID.");
  const retrieval = await db.query.spotifyReleaseTrackRetrievals.findFirst({
    where: eq(spotifyReleaseTrackRetrievals.id, work.releaseTrackRetrievalId),
  });
  if (!retrieval?.releaseId)
    throw new Error("Release-track work has no canonical release mapping.");
  if (retrieval.status === "completed") return;
  const client = await createSchedulerSpotifyClient(db, configuration, work, context);
  const repository: SpotifyReleaseReconciliationRepository =
    createSpotifyReleaseReconciliationRepository(db);
  await runSpotifyReleaseReconciliation(
    {
      maxPagesPerRelease: configuration.spotify.scheduler.maxRequestsPerTick,
      pageSize: 50,
      releaseIds: [retrieval.releaseId],
    },
    { client, repository },
  );
}

function abbreviate(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function campaignContext(work: SpotifySchedulerClaim): {
  campaignId: string;
  campaignMemberId: string | null;
} | null {
  if (typeof work.campaignId !== "string") return null;
  return {
    campaignId: work.campaignId,
    campaignMemberId: work.campaignMemberId,
  };
}

if (
  process.env.VITEST !== "true" &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Scheduler failed."}\n`);
    process.exitCode = 1;
  });
}
