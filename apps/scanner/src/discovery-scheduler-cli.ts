import {
  claimDiscoveryScheduleAppleJob,
  createDatabase,
  finishDiscoveryScheduleAppleJob,
  getRecurringDiscoveryScheduleStatus,
  getSpotifySchedulerStatus,
  ensureLocalOwner,
  markBroadDiscoveryPlaylistCheckpointPending,
  prepareBroadDiscoveryPlaylistCheckpoint,
  reconcileDiscoveryScheduleAfterCooldown,
  reconcileStaleSpotifyQueueDepth,
  surfaceUncertainSpotifyMatchesForReview,
  type DiscoveryAppleJobClaim,
  type SpotifySchedulerClaim,
  type SpotifySchedulerLimits,
  type SpotifySchedulerStatus,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { desc, gte } from "drizzle-orm";
import { appleMusicScanBatches } from "@radar/db";
import { loadLocalEnvironment } from "./local-env";
import {
  inspectAutomaticDiscoveryPlaylistCheckpoint,
  runAutomaticDiscoveryPlaylistExport,
} from "./spotify-playlist-export-runtime";
import { schedulerLimitsFromConfiguration } from "./spotify-scheduler-cli";
import type { SpotifySchedulerTickResult } from "./spotify-scheduler";

loadLocalEnvironment();

export function parseDiscoverySchedulerCommand(args: string[]): "status" | "tick" {
  const values = args.filter((value) => value !== "--");
  if (values.length !== 1 || !["status", "tick"].includes(values[0] ?? "")) {
    throw new Error("Usage: pnpm discovery:scheduler:status or pnpm discovery:scheduler:tick");
  }
  return values[0] as "status" | "tick";
}

export function discoverySchedulerRoute(input: {
  phase: string;
  playlistInboxStatus: string;
}): "playlist_export" | "spotify_priority" | "apple_or_spotify" {
  if (
    input.phase === "playlist_inbox" &&
    ["ready", "exporting", "partial", "failed"].includes(input.playlistInboxStatus)
  ) {
    return "playlist_export";
  }
  if (
    input.phase === "apple_priority" ||
    input.phase === "apple_catchup_priority" ||
    input.phase === "cooldown_wait"
  ) {
    return "spotify_priority";
  }
  return "apple_or_spotify";
}

type BroadPlaylistTickResult = {
  reason: "planned" | "completed" | "no_work" | "capability_disabled" | "cooldown" | "failed";
  requestsStarted: number;
  selected: Pick<SpotifySchedulerClaim, "source"> | null;
  status: Pick<
    SpotifySchedulerStatus,
    | "backlog"
    | "cooldownActive"
    | "dailyBudget"
    | "dueArtistCount"
    | "endpointBudget"
    | "requestCounts"
  >;
};

export function shouldFlushBroadPlaylistCheckpoint(
  result: BroadPlaylistTickResult,
  limits: SpotifySchedulerLimits,
): boolean {
  if (result.status.cooldownActive) return true;
  const status = result.status;
  const rollingBroadCeiling =
    limits.rolling24HourLimit - limits.priorityRequestReserve - limits.playlistRequestReserve;
  const budgetBoundary =
    status.requestCounts.last30Minutes >= limits.rolling30MinuteLimit ||
    status.requestCounts.last24Hours + limits.maxRequestsPerTick > rollingBroadCeiling ||
    status.dailyBudget.broadArtistsUsed >= status.dailyBudget.broadArtistsLimit ||
    status.dailyBudget.broadRequestsUsed + limits.maxRequestsPerTick >
      status.dailyBudget.broadRequestsLimit ||
    status.endpointBudget.artistAlbums.broadRemaining === 0;
  const queueDrained =
    result.reason === "no_work" &&
    status.dueArtistCount === 0 &&
    status.backlog.release_detail === 0 &&
    status.backlog.release_tracks === 0;
  return budgetBoundary || queueDrained;
}

export async function runBroadAutomaticPlaylistCheckpoint(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  result: BroadPlaylistTickResult,
  dependencies: {
    inspect?: (
      db: ReturnType<typeof createDatabase>["db"],
      configuration: ReturnType<typeof loadProviderConfiguration>,
    ) => Promise<{ reason: string; shouldRun: boolean }>;
    markPending?: typeof markBroadDiscoveryPlaylistCheckpointPending;
    prepare?: typeof prepareBroadDiscoveryPlaylistCheckpoint;
    runExport?: (
      db: ReturnType<typeof createDatabase>["db"],
      configuration: ReturnType<typeof loadProviderConfiguration>,
    ) => Promise<unknown>;
  } = {},
) {
  if (
    result.selected &&
    ["apple_priority", "apple_catchup", "validation"].includes(result.selected.source)
  ) {
    return null;
  }
  if (
    !shouldFlushBroadPlaylistCheckpoint(result, schedulerLimitsFromConfiguration(configuration))
  ) {
    return null;
  }
  const inspection = await (dependencies.inspect ?? inspectAutomaticDiscoveryPlaylistCheckpoint)(
    db,
    configuration,
  );
  if (!inspection.shouldRun) return { inspection, reason: "no_changes" as const };
  await (dependencies.markPending ?? markBroadDiscoveryPlaylistCheckpointPending)(db);
  const prepared = await (dependencies.prepare ?? prepareBroadDiscoveryPlaylistCheckpoint)(db);
  if (!prepared) return null;
  return (dependencies.runExport ?? runAutomaticDiscoveryPlaylistExport)(db, configuration);
}

export async function selectDiscoverySchedulerAction(
  db: ReturnType<typeof createDatabase>["db"],
  dependencies: {
    claimAppleJob?: (
      db: ReturnType<typeof createDatabase>["db"],
    ) => Promise<DiscoveryAppleJobClaim | null>;
    getStatus?: (
      db: ReturnType<typeof createDatabase>["db"],
    ) => Promise<{ phase: string; playlistInbox: { status: string } }>;
    reconcileCooldown?: (db: ReturnType<typeof createDatabase>["db"]) => Promise<boolean>;
  } = {},
): Promise<
  | { appleClaim: DiscoveryAppleJobClaim; route: "apple_scan" }
  | { route: "playlist_export" | "spotify_priority" | "apple_or_spotify" }
> {
  const appleClaim = await (dependencies.claimAppleJob ?? claimDiscoveryScheduleAppleJob)(db);
  if (appleClaim) return { appleClaim, route: "apple_scan" };

  await (dependencies.reconcileCooldown ?? reconcileDiscoveryScheduleAfterCooldown)(db);
  const status = await (dependencies.getStatus ?? getRecurringDiscoveryScheduleStatus)(db);
  return {
    route: discoverySchedulerRoute({
      phase: status.phase,
      playlistInboxStatus: status.playlistInbox.status,
    }),
  };
}

export async function runReadyAutomaticPlaylistExport(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  dependencies: {
    getStatus?: (
      db: ReturnType<typeof createDatabase>["db"],
    ) => Promise<{ phase: string; playlistInbox: { status: string } }>;
    runExport?: (
      db: ReturnType<typeof createDatabase>["db"],
      configuration: ReturnType<typeof loadProviderConfiguration>,
    ) => Promise<unknown>;
  } = {},
) {
  const status = await (dependencies.getStatus ?? getRecurringDiscoveryScheduleStatus)(db);
  if (
    discoverySchedulerRoute({
      phase: status.phase,
      playlistInboxStatus: status.playlistInbox.status,
    }) !== "playlist_export"
  ) {
    return null;
  }
  return (dependencies.runExport ?? runAutomaticDiscoveryPlaylistExport)(db, configuration);
}

type PriorityPhaseStatus = {
  phase: string;
  playlistInbox: { status: string };
};

export type DynamicPriorityRunResult = {
  completedItems: number;
  reason: "capacity_exhausted" | "cooldown" | "drained" | "failed" | "limit_reached" | "no_work";
  requestsStarted: number;
};

export async function runDynamicSpotifyPriorityPhase(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  dependencies: {
    getStatus?: (db: ReturnType<typeof createDatabase>["db"]) => Promise<PriorityPhaseStatus>;
    runExport?: (
      db: ReturnType<typeof createDatabase>["db"],
      configuration: ReturnType<typeof loadProviderConfiguration>,
    ) => Promise<unknown>;
    runTick?: (
      db: ReturnType<typeof createDatabase>["db"],
      configuration: ReturnType<typeof loadProviderConfiguration>,
    ) => Promise<SpotifySchedulerTickResult>;
  } = {},
): Promise<DynamicPriorityRunResult> {
  const getStatus = dependencies.getStatus ?? getRecurringDiscoveryScheduleStatus;
  const runExport = dependencies.runExport ?? runReadyAutomaticPlaylistExport;
  const runTick = dependencies.runTick ?? runSpotifyTick;
  const maximumItems = configuration.spotify.scheduler.priorityMaxItemsPerRun;
  let completedItems = 0;
  let requestsStarted = 0;

  while (completedItems < maximumItems) {
    const status = await getStatus(db);
    if (
      discoverySchedulerRoute({
        phase: status.phase,
        playlistInboxStatus: status.playlistInbox.status,
      }) !== "spotify_priority"
    ) {
      return { completedItems, reason: "drained", requestsStarted };
    }

    const result = await runTick(db, configuration);
    requestsStarted += result.requestsStarted;
    if (result.reason !== "completed") {
      if (result.reason === "cooldown" || result.status.cooldownActive) {
        return { completedItems, reason: "cooldown", requestsStarted };
      }
      if (
        result.reason === "no_work" &&
        result.status.endpointBudget.artistAlbums.priorityRemaining === 0
      ) {
        return { completedItems, reason: "capacity_exhausted", requestsStarted };
      }
      return {
        completedItems,
        reason: result.reason === "no_work" ? "no_work" : "failed",
        requestsStarted,
      };
    }
    if (!result.selected || !["apple_priority", "apple_catchup"].includes(result.selected.source)) {
      throw new Error("Dynamic priority execution selected non-priority Spotify work.");
    }

    completedItems += 1;
    await runExport(db, configuration);
    if (result.status.endpointBudget.artistAlbums.priorityRemaining === 0) {
      return { completedItems, reason: "capacity_exhausted", requestsStarted };
    }
  }

  return { completedItems, reason: "limit_reached", requestsStarted };
}

async function main(): Promise<void> {
  const command = parseDiscoverySchedulerCommand(process.argv.slice(2));
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  const connection = createDatabase(configuration.databaseUrl);
  try {
    if (command === "status") {
      const discovery = await getRecurringDiscoveryScheduleStatus(connection.db);
      const spotify = await getSpotifySchedulerStatus(connection.db);
      process.stdout.write(
        `${JSON.stringify(
          {
            discovery,
            spotify,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    if (!configuration.discoverySchedulerEnabled) {
      throw new Error(
        "Recurring discovery execution is disabled. Set DISCOVERY_SCHEDULER_ENABLED=true only after validation.",
      );
    }

    const userId = await ensureLocalOwner(connection.db);
    await surfaceUncertainSpotifyMatchesForReview(connection.db, userId);
    await reconcileStaleSpotifyQueueDepth(connection.db);

    const action = await selectDiscoverySchedulerAction(connection.db);
    const route = action.route;
    if (route === "apple_scan") {
      await runClaimedAppleJob(connection.db, configuration, action.appleClaim);
      return;
    }
    if (route === "playlist_export") {
      const playlist = await runAutomaticDiscoveryPlaylistExport(connection.db, configuration);
      process.stdout.write(`${JSON.stringify({ playlist }, null, 2)}\n`);
      return;
    }
    if (route === "spotify_priority") {
      const spotifyPriority = await runDynamicSpotifyPriorityPhase(connection.db, configuration);
      process.stdout.write(`${JSON.stringify({ spotifyPriority }, null, 2)}\n`);
      return;
    }

    const spotify = await runSpotifyTick(connection.db, configuration);
    const playlist = await runBroadAutomaticPlaylistCheckpoint(
      connection.db,
      configuration,
      spotify,
    );
    process.stdout.write(
      `${JSON.stringify({ spotify, ...(playlist ? { playlist } : {}) }, null, 2)}\n`,
    );
  } finally {
    await connection.client.end();
  }
}

async function runClaimedAppleJob(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  appleClaim: DiscoveryAppleJobClaim,
): Promise<void> {
  if (!configuration.appleMusic.configured) {
    await finishDiscoveryScheduleAppleJob(db, appleClaim, {
      errorClassification: "apple_music_not_configured",
      status: "failed",
    });
    throw new Error("Apple Music is not configured for the scheduled catalog scan.");
  }
  const startedAt = new Date();
  try {
    const { runScan } = await import("./scan");
    await runScan({ dryRun: false, full: false, provider: "apple_music" });
    const batch = await db.query.appleMusicScanBatches.findFirst({
      where: gte(appleMusicScanBatches.createdAt, startedAt),
      orderBy: [desc(appleMusicScanBatches.createdAt)],
    });
    if (!batch || batch.status !== "completed") {
      throw new Error("Scheduled Apple Music scan did not produce a completed batch.");
    }
    const finished = await finishDiscoveryScheduleAppleJob(db, appleClaim, {
      appleMusicBatchId: batch.id,
      scanRunId: batch.scanRunId,
      status: "completed",
    });
    if (!finished) throw new Error("The scheduled Apple Music job lease was lost.");
    const playlist = await runReadyAutomaticPlaylistExport(db, configuration);
    process.stdout.write(
      `${JSON.stringify({
        appleMusicBatchId: batch.id,
        completedArtists: batch.completedArtists,
        jobType: appleClaim.jobType,
        ...(playlist ? { playlist } : {}),
        status: "completed",
        totalArtists: batch.totalArtists,
      })}\n`,
    );
  } catch (error) {
    await finishDiscoveryScheduleAppleJob(db, appleClaim, {
      errorClassification: safeClassification(error),
      status: "failed",
    });
    throw error;
  }
}

async function runSpotifyTick(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
) {
  const [schedulerCli, schedulerRuntime] = await Promise.all([
    import("./spotify-scheduler-cli"),
    import("./spotify-scheduler"),
  ]);
  const executor = configuration.spotify.scheduler.enabled
    ? await schedulerCli.createProductionSchedulerExecutor(db, configuration)
    : undefined;
  return schedulerRuntime.runSpotifySchedulerTick(db, {
    capabilityEnabled: configuration.spotify.scheduler.enabled,
    ...(executor ? { executor } : {}),
    limits: schedulerCli.schedulerLimitsFromConfiguration(configuration),
    mode: "production",
  });
}

function safeClassification(error: unknown): string {
  if (!(error instanceof Error)) return "scheduled_apple_scan_failed";
  return error.message.toLowerCase().includes("cooldown")
    ? "apple_music_cooldown"
    : "scheduled_apple_scan_failed";
}

if (process.env.VITEST !== "true") {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Scheduler failed."}\n`);
      process.exit(1);
    },
  );
}
