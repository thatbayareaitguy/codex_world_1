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
  recordSpotifyReleaseTrackPage,
  spotifyCatalogReleases,
  spotifyReleaseTrackRetrievals,
  startSpotifyReleaseTrackRetrieval,
  SpotifyTokenManager,
  type SpotifySchedulerClaim,
  type SpotifySchedulerLimits,
} from "@radar/db";
import {
  loadProviderConfiguration,
  SpotifyClient,
  SpotifyOAuthClient,
  SpotifyProvider,
  type ProviderReleaseTrackPage,
  type ProviderConfiguration,
  type SpotifyArtistMapping,
} from "@radar/providers";
import { and, eq } from "drizzle-orm";
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

async function main(): Promise<void> {
  const command = parseSpotifySchedulerCommand(process.argv.slice(2));
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  if (configuration.spotify.playlistWritesEnabled) {
    throw new Error("Spotify playlist writes must remain disabled for scheduler execution.");
  }
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

async function createProductionSchedulerExecutor(
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
  await runScanUnlocked(
    {
      artistId: work.artistId,
      dryRun: false,
      full: work.workType === "artist_reconciliation",
      provider: "spotify",
      source: "spotify_scheduler",
      spotifyConfirmBatch: false,
      spotifyMaxPages: 1,
      spotifyMode: work.workType === "artist_reconciliation" ? "reconciliation" : "daily",
      spotifyNewReconciliationCycle: false,
    },
    adjustedConfiguration,
    {
      deadlineAt: context.deadlineAt,
      deferSpotifyReleaseDetails: true,
      reportProgress: () => Promise.resolve(),
      requestGateWrapper: context.wrapRequestGate,
      schedulerContext: { workId: work.id, workType: work.workType },
      signal: context.signal,
    },
  );
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
}

async function createSchedulerSpotifyClient(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ProviderConfiguration,
  work: SpotifySchedulerClaim,
  context: SpotifySchedulerExecutionContext,
): Promise<SpotifyClient> {
  const userId = await ensureLocalOwner(db);
  const gate = context.wrapRequestGate(
    createSpotifyRequestGate(db, configuration.spotify.minRequestIntervalMs, {
      workId: work.id,
      workType: work.workType,
    }),
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

if (process.env.VITEST !== "true") {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Scheduler failed."}\n`);
    process.exitCode = 1;
  });
}
