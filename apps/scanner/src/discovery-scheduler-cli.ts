import {
  appleMusicScanBatches,
  attachDiscoveryScheduleAppleJobBatch,
  claimDiscoveryScheduleAppleJob,
  createDatabase,
  finishDiscoveryScheduleAppleJob,
  getAppleMusicOperationalStatus,
  getRecurringDiscoveryScheduleStatus,
  getSpotifySchedulerStatus,
  ensureLocalOwner,
  markBroadDiscoveryPlaylistCheckpointPending,
  matureReleasedFeedItems,
  prepareBroadDiscoveryPlaylistCheckpoint,
  preparePriorityDiscoveryPlaylistCheckpoint,
  reconcileDiscoveryScheduleAfterCooldown,
  reconcileDiscoverySchedulePriorityPhase,
  reconcileDeferredPriorityTrackResolutionWork,
  reconcileStaleSpotifyQueueDepth,
  surfaceUncertainSpotifyMatchesForReview,
  yieldDiscoveryScheduleAppleJob,
  type DiscoveryAppleJobClaim,
  type SpotifySchedulerClaim,
  type SpotifySchedulerLimits,
  type SpotifySchedulerStatus,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { eq } from "drizzle-orm";
import { loadLocalEnvironment } from "./local-env";
import { createRecurringSchedulerDiagnostics } from "./recurring-scheduler-diagnostics";
import type { runScan } from "./scan";
import {
  inspectAutomaticDiscoveryPlaylistCheckpoint,
  runAutomaticDiscoveryPlaylistExport,
} from "./spotify-playlist-export-runtime";
import { schedulerLimitsFromConfiguration } from "./spotify-scheduler-cli";
import type { SpotifySchedulerTickResult } from "./spotify-scheduler";
import {
  decideDiscoveryMaintenance,
  type DiscoveryMaintenanceDecision,
} from "./discovery-maintenance";
import { ensureWindowsMaintenanceWake, updateWindowsMaintenanceWake } from "./windows-maintenance";

loadLocalEnvironment();

export const scheduledAppleMaximumRuntimeMs = 3.5 * 60 * 60_000;
export const recurringMaintenanceDispatchDelayMs = 15_000;

type AutomaticPlaylistExportRunner = (
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  dependencies?: { deadlineAt?: Date },
) => Promise<unknown>;

type PriorityPlaylistCheckpointRunner = (
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  dependencies?: { deadlineAt?: Date },
) => Promise<unknown>;

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
    deadlineAt?: Date;
    inspect?: (
      db: ReturnType<typeof createDatabase>["db"],
      configuration: ReturnType<typeof loadProviderConfiguration>,
    ) => Promise<{ reason: string; shouldRun: boolean }>;
    markPending?: typeof markBroadDiscoveryPlaylistCheckpointPending;
    prepare?: typeof prepareBroadDiscoveryPlaylistCheckpoint;
    runExport?: AutomaticPlaylistExportRunner;
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
  return (dependencies.runExport ?? runAutomaticDiscoveryPlaylistExport)(db, configuration, {
    ...(dependencies.deadlineAt ? { deadlineAt: dependencies.deadlineAt } : {}),
  });
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
  await (dependencies.reconcileCooldown ?? reconcileDiscoveryScheduleAfterCooldown)(db);
  const status = await (dependencies.getStatus ?? getRecurringDiscoveryScheduleStatus)(db);
  const route = discoverySchedulerRoute({
    phase: status.phase,
    playlistInboxStatus: status.playlistInbox.status,
  });
  if (route === "playlist_export") return { route };
  const appleClaim = await (dependencies.claimAppleJob ?? claimDiscoveryScheduleAppleJob)(db);
  if (appleClaim) return { appleClaim, route: "apple_scan" };
  return { route };
}

export async function runReadyAutomaticPlaylistExport(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  dependencies: {
    deadlineAt?: Date;
    getStatus?: (
      db: ReturnType<typeof createDatabase>["db"],
    ) => Promise<{ phase: string; playlistInbox: { status: string } }>;
    runExport?: AutomaticPlaylistExportRunner;
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
  return (dependencies.runExport ?? runAutomaticDiscoveryPlaylistExport)(db, configuration, {
    ...(dependencies.deadlineAt ? { deadlineAt: dependencies.deadlineAt } : {}),
  });
}

export async function runPriorityAutomaticPlaylistCheckpoint(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  dependencies: {
    deadlineAt?: Date;
    inspect?: (
      db: ReturnType<typeof createDatabase>["db"],
      configuration: ReturnType<typeof loadProviderConfiguration>,
    ) => Promise<{ reason: string; shouldRun: boolean }>;
    prepare?: typeof preparePriorityDiscoveryPlaylistCheckpoint;
    runExport?: AutomaticPlaylistExportRunner;
  } = {},
) {
  const inspection = await (dependencies.inspect ?? inspectAutomaticDiscoveryPlaylistCheckpoint)(
    db,
    configuration,
  );
  if (!inspection.shouldRun) return { inspection, reason: "no_changes" as const };
  const prepared = await (dependencies.prepare ?? preparePriorityDiscoveryPlaylistCheckpoint)(db);
  if (!prepared) return null;
  return (dependencies.runExport ?? runAutomaticDiscoveryPlaylistExport)(db, configuration, {
    ...(dependencies.deadlineAt ? { deadlineAt: dependencies.deadlineAt } : {}),
  });
}

export async function runPendingPriorityPlaylistCheckpoint(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  dependencies: {
    deadlineAt?: Date;
    getStatus?: (
      db: ReturnType<typeof createDatabase>["db"],
    ) => Promise<{ phase: string; playlistInbox: { status: string } }>;
    runCheckpoint?: PriorityPlaylistCheckpointRunner;
  } = {},
): Promise<unknown> {
  const status = await (dependencies.getStatus ?? getRecurringDiscoveryScheduleStatus)(db);
  if (
    !["apple_priority", "apple_catchup_priority"].includes(status.phase) ||
    !["pending", "completed"].includes(status.playlistInbox.status)
  ) {
    return null;
  }

  const result = await (dependencies.runCheckpoint ?? runPriorityAutomaticPlaylistCheckpoint)(
    db,
    configuration,
    { ...(dependencies.deadlineAt ? { deadlineAt: dependencies.deadlineAt } : {}) },
  );
  if (result === null) return { reason: "checkpoint_state_changed" as const };
  return isNoChangePlaylistCheckpoint(result) ? null : result;
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
    deadlineAt?: Date;
    getStatus?: (db: ReturnType<typeof createDatabase>["db"]) => Promise<PriorityPhaseStatus>;
    maximumItems?: number;
    runCheckpoint?: PriorityPlaylistCheckpointRunner;
    runTick?: (
      db: ReturnType<typeof createDatabase>["db"],
      configuration: ReturnType<typeof loadProviderConfiguration>,
    ) => Promise<SpotifySchedulerTickResult>;
  } = {},
): Promise<DynamicPriorityRunResult> {
  const getStatus = dependencies.getStatus ?? getRecurringDiscoveryScheduleStatus;
  const runCheckpoint = dependencies.runCheckpoint ?? runPriorityAutomaticPlaylistCheckpoint;
  const runTick = dependencies.runTick ?? runSpotifyTick;
  const maximumItems = Math.min(
    configuration.spotify.scheduler.priorityMaxItemsPerRun,
    dependencies.maximumItems ?? Number.POSITIVE_INFINITY,
  );
  let completedItems = 0;
  let requestsStarted = 0;

  await runCheckpoint(db, configuration, {
    ...(dependencies.deadlineAt ? { deadlineAt: dependencies.deadlineAt } : {}),
  });

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
    if (result.status.endpointBudget.artistAlbums.priorityRemaining === 0) {
      return { completedItems, reason: "capacity_exhausted", requestsStarted };
    }
  }

  return { completedItems, reason: "limit_reached", requestsStarted };
}

export async function runDiscoverySchedulerCommand(
  command: "status" | "tick",
  configuration = loadProviderConfiguration(),
): Promise<unknown> {
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  const connection = createDatabase(configuration.databaseUrl);
  try {
    if (command === "status") {
      const discovery = await getRecurringDiscoveryScheduleStatus(connection.db);
      const spotify = await getSpotifySchedulerStatus(connection.db);
      return { discovery, spotify };
    }
    if (!configuration.discoverySchedulerEnabled) {
      throw new Error(
        "Recurring discovery execution is disabled. Set DISCOVERY_SCHEDULER_ENABLED=true only after validation.",
      );
    }

    return await runRecurringDiscoverySchedulerTick(connection.db);
  } finally {
    await connection.client.end();
  }
}

export async function runRecurringDiscoverySchedulerTick(
  db: ReturnType<typeof createDatabase>["db"],
  now = new Date(),
  dependencies: {
    applyWake?: (decision: DiscoveryMaintenanceDecision) => Promise<void>;
    decide?: typeof decideDiscoveryMaintenance;
    ensureOwner?: typeof ensureLocalOwner;
    getAppleStatus?: typeof getAppleMusicOperationalStatus;
    getDiscoveryStatus?: typeof getRecurringDiscoveryScheduleStatus;
    getSpotifyStatus?: typeof getSpotifySchedulerStatus;
    matureFeed?: typeof matureReleasedFeedItems;
    reconcileCooldown?: typeof reconcileDiscoveryScheduleAfterCooldown;
    reconcileDeferredPriority?: typeof reconcileDeferredPriorityTrackResolutionWork;
    reconcilePriorityPhase?: typeof reconcileDiscoverySchedulePriorityPhase;
    reconcileQueueDepth?: typeof reconcileStaleSpotifyQueueDepth;
    surfaceReviews?: typeof surfaceUncertainSpotifyMatchesForReview;
  } = {},
): Promise<{ decision: DiscoveryMaintenanceDecision; dispatchedToMaintenance: boolean }> {
  const userId = await (dependencies.ensureOwner ?? ensureLocalOwner)(db);
  await (dependencies.matureFeed ?? matureReleasedFeedItems)(db);
  await (dependencies.surfaceReviews ?? surfaceUncertainSpotifyMatchesForReview)(db, userId);
  await (dependencies.reconcileQueueDepth ?? reconcileStaleSpotifyQueueDepth)(db);
  await (dependencies.reconcileDeferredPriority ?? reconcileDeferredPriorityTrackResolutionWork)(
    db,
  );
  await (dependencies.reconcileCooldown ?? reconcileDiscoveryScheduleAfterCooldown)(db);
  await (dependencies.reconcilePriorityPhase ?? reconcileDiscoverySchedulePriorityPhase)(db, now);

  const [apple, discovery, spotify] = await Promise.all([
    (dependencies.getAppleStatus ?? getAppleMusicOperationalStatus)(db, now),
    (dependencies.getDiscoveryStatus ?? getRecurringDiscoveryScheduleStatus)(db, now),
    (dependencies.getSpotifyStatus ?? getSpotifySchedulerStatus)(db, now),
  ]);
  const decision = (dependencies.decide ?? decideDiscoveryMaintenance)(
    { apple, discovery, spotify },
    now,
  );
  await (dependencies.applyWake ?? applyRecurringDynamicMaintenanceWake)(decision);
  return {
    decision,
    dispatchedToMaintenance:
      decision.runNow || decision.holdPower || decision.dynamicWakeAt !== null,
  };
}

export async function runDiscoverySchedulerTick(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  options: {
    appleMusicMaximumRuntimeMs?: number;
    playlistDeadlineAt?: Date;
    priorityMaximumItems?: number;
  } = {},
): Promise<unknown> {
  const userId = await ensureLocalOwner(db);
  await matureReleasedFeedItems(db);
  await surfaceUncertainSpotifyMatchesForReview(db, userId);
  await reconcileStaleSpotifyQueueDepth(db);
  await reconcileDeferredPriorityTrackResolutionWork(db);

  // A completed Apple workflow deliberately leaves a pending priority checkpoint while
  // reconciliation is active. Flush any already-eligible tracks before claiming another Apple
  // job. A local no-change inspection falls through to the normal Apple/priority selection.
  const pendingPriorityPlaylist = await runPendingPriorityPlaylistCheckpoint(db, configuration, {
    ...(options.playlistDeadlineAt ? { deadlineAt: options.playlistDeadlineAt } : {}),
  });
  if (pendingPriorityPlaylist) return { playlist: pendingPriorityPlaylist };

  const action = await selectDiscoverySchedulerAction(db);
  const route = action.route;
  if (route === "apple_scan") {
    return runClaimedAppleJob(db, configuration, action.appleClaim, {
      ...(options.appleMusicMaximumRuntimeMs === undefined
        ? {}
        : { maximumRuntimeMs: options.appleMusicMaximumRuntimeMs }),
      ...(options.playlistDeadlineAt === undefined
        ? {}
        : { playlistDeadlineAt: options.playlistDeadlineAt }),
    });
  }
  if (route === "playlist_export") {
    return {
      playlist: await runAutomaticDiscoveryPlaylistExport(db, configuration, {
        ...(options.playlistDeadlineAt ? { deadlineAt: options.playlistDeadlineAt } : {}),
      }),
    };
  }
  if (route === "spotify_priority") {
    return {
      spotifyPriority: await runDynamicSpotifyPriorityPhase(db, configuration, {
        ...(options.playlistDeadlineAt ? { deadlineAt: options.playlistDeadlineAt } : {}),
        ...(options.priorityMaximumItems === undefined
          ? {}
          : { maximumItems: options.priorityMaximumItems }),
      }),
    };
  }
  const spotify = await runSpotifyTick(db, configuration);
  const playlist = await runBroadAutomaticPlaylistCheckpoint(db, configuration, spotify, {
    ...(options.playlistDeadlineAt ? { deadlineAt: options.playlistDeadlineAt } : {}),
  });
  return { spotify, ...(playlist ? { playlist } : {}) };
}

export async function refreshDynamicMaintenanceWake(
  db: ReturnType<typeof createDatabase>["db"],
  now = new Date(),
): Promise<Date | null> {
  await reconcileDiscoveryScheduleAfterCooldown(db, now);
  await reconcileDiscoverySchedulePriorityPhase(db, now);
  const [apple, discovery, spotify] = await Promise.all([
    getAppleMusicOperationalStatus(db, now),
    getRecurringDiscoveryScheduleStatus(db, now),
    getSpotifySchedulerStatus(db, now),
  ]);
  const decision = decideDiscoveryMaintenance({ apple, discovery, spotify }, now);
  await applyRecurringDynamicMaintenanceWake(decision);
  return decision.dynamicWakeAt;
}

export async function applyRecurringDynamicMaintenanceWake(
  decision: DiscoveryMaintenanceDecision,
  dependencies: {
    ensureWake?: (wakeAt: Date) => Promise<void>;
    now?: () => Date;
    updateWake?: (wakeAt: Date | null) => Promise<void>;
  } = {},
): Promise<void> {
  if (decision.holdPower || decision.runNow) {
    const dispatchAt = new Date(
      (dependencies.now?.() ?? new Date()).getTime() + recurringMaintenanceDispatchDelayMs,
    );
    await (dependencies.ensureWake ?? ensureWindowsMaintenanceWake)(dispatchAt);
    return;
  }
  await (dependencies.updateWake ?? updateWindowsMaintenanceWake)(decision.dynamicWakeAt);
}

type RunScan = typeof runScan;

export async function runClaimedAppleJob(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
  appleClaim: DiscoveryAppleJobClaim,
  options: { maximumRuntimeMs?: number; playlistDeadlineAt?: Date } = {},
  dependencies: {
    attachJob?: typeof attachDiscoveryScheduleAppleJobBatch;
    finishJob?: typeof finishDiscoveryScheduleAppleJob;
    getBatch?: (
      db: ReturnType<typeof createDatabase>["db"],
      batchId: string,
    ) => Promise<{
      completedArtists: number;
      failedArtists: number;
      finishedAt: Date | null;
      id: string;
      scanRunId: string | null;
      status: string;
      totalArtists: number;
    } | null>;
    runReadyPlaylist?: typeof runReadyAutomaticPlaylistExport;
    runScan?: RunScan;
    yieldJob?: typeof yieldDiscoveryScheduleAppleJob;
  } = {},
): Promise<unknown> {
  let batchId = appleClaim.appleMusicBatchId;
  let scanRunId = appleClaim.scanRunId;
  const getBatch =
    dependencies.getBatch ??
    ((candidateDb, candidateBatchId) =>
      candidateDb.query.appleMusicScanBatches.findFirst({
        where: eq(appleMusicScanBatches.id, candidateBatchId),
      }));
  const attachedBatch = batchId ? await getBatch(db, batchId) : null;
  if (!isCompletedAppleWorkflowBatch(attachedBatch) && !configuration.appleMusic.configured) {
    await (dependencies.finishJob ?? finishDiscoveryScheduleAppleJob)(db, appleClaim, {
      errorClassification: "apple_music_not_configured",
      status: "failed",
    });
    throw new Error("Apple Music is not configured for the scheduled catalog scan.");
  }
  try {
    let batch = attachedBatch;
    if (!isCompletedAppleWorkflowBatch(batch)) {
      const runScan = dependencies.runScan ?? (await import("./scan")).runScan;
      await runScan(
        {
          dryRun: false,
          full: false,
          provider: "apple_music",
          source:
            appleClaim.jobType === "apple_full"
              ? "apple_full_scheduler"
              : "apple_catchup_scheduler",
        },
        {
          ...(batchId ? { appleMusicBatchId: batchId } : {}),
          appleMusicMaximumRuntimeMs: Math.min(
            scheduledAppleMaximumRuntimeMs,
            options.maximumRuntimeMs ?? scheduledAppleMaximumRuntimeMs,
          ),
          scanTriggerType:
            appleClaim.jobType === "apple_full"
              ? "apple_full_scheduled"
              : "apple_catchup_scheduled",
          appleMusicBatchReady: async (input) => {
            batchId = input.batchId;
            scanRunId = input.scanRunId;
            const attached = await (dependencies.attachJob ?? attachDiscoveryScheduleAppleJobBatch)(
              db,
              appleClaim,
              {
                appleMusicBatchId: input.batchId,
                scanRunId: input.scanRunId,
              },
            );
            if (!attached) throw new Error("The scheduled Apple Music job lease was lost.");
          },
        },
      );
      batch = batchId ? await getBatch(db, batchId) : null;
    }
    if (!batchId) throw new Error("Scheduled Apple Music scan did not attach a durable batch.");
    if (batch?.status === "partial" && batch.finishedAt === null) {
      throw Object.assign(
        new Error("Scheduled Apple Music batch has deferred retryable artists."),
        {
          classification: "apple_items_deferred",
        },
      );
    }
    if (!isCompletedAppleWorkflowBatch(batch)) {
      throw new Error("Scheduled Apple Music scan did not produce a completed batch.");
    }
    const finished = await (dependencies.finishJob ?? finishDiscoveryScheduleAppleJob)(
      db,
      appleClaim,
      {
        appleMusicBatchId: batch.id,
        ...(batch.status === "partial"
          ? { errorClassification: "apple_terminal_artist_failures" }
          : {}),
        scanRunId: batch.scanRunId,
        status: "completed",
      },
    );
    if (!finished) throw new Error("The scheduled Apple Music job lease was lost.");
    const playlist = await (dependencies.runReadyPlaylist ?? runReadyAutomaticPlaylistExport)(
      db,
      configuration,
      { ...(options.playlistDeadlineAt ? { deadlineAt: options.playlistDeadlineAt } : {}) },
    );
    return {
      appleMusicBatchId: batch.id,
      completedArtists: batch.completedArtists,
      failedArtists: batch.failedArtists,
      jobType: appleClaim.jobType,
      ...(playlist ? { playlist } : {}),
      status: batch.status === "partial" ? "completed_with_failures" : "completed",
      totalArtists: batch.totalArtists,
    };
  } catch (error) {
    const classification = appleScanClassification(error);
    const scanLockContended = isAppleScanLockContention(error);
    const resumableBeforeBatch = ["apple_music_cooldown", "apple_request_lease_active"].includes(
      classification,
    );
    if (
      scanLockContended ||
      resumableBeforeBatch ||
      (batchId && isRetryableAppleYield(classification))
    ) {
      const yielded = await (dependencies.yieldJob ?? yieldDiscoveryScheduleAppleJob)(
        db,
        appleClaim,
        {
          appleMusicBatchId: batchId,
          errorClassification: scanLockContended ? "apple_scan_lock_contended" : classification,
          scanRunId,
        },
      );
      if (!yielded) throw new Error("The scheduled Apple Music job lease was lost while yielding.");
      if (scanLockContended) throw error;
      return {
        appleMusicBatchId: batchId,
        errorClassification: classification,
        jobType: appleClaim.jobType,
        status: "yielded",
      };
    }
    await (dependencies.finishJob ?? finishDiscoveryScheduleAppleJob)(db, appleClaim, {
      errorClassification: safeClassification(error),
      status: "failed",
    });
    throw error;
  }
}

function isCompletedAppleWorkflowBatch(
  batch:
    | {
        finishedAt: Date | null;
        status: string;
      }
    | null
    | undefined,
): batch is { finishedAt: Date | null; status: "completed" | "partial" } {
  return (
    batch?.status === "completed" || (batch?.status === "partial" && batch.finishedAt !== null)
  );
}

function isAppleScanLockContention(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "Operation scan:global is already running." ||
    /^A apple_music scan is already running\.?$/.test(error.message)
  );
}

function appleScanClassification(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "classification" in error &&
    typeof error.classification === "string"
  ) {
    return error.classification === "provider_cooldown"
      ? "apple_music_cooldown"
      : error.classification;
  }
  if (
    error instanceof Error &&
    error.message === "An Apple Music request lease is already active."
  ) {
    return "apple_request_lease_active";
  }
  return safeClassification(error);
}

function isRetryableAppleYield(classification: string): boolean {
  return [
    "apple_items_deferred",
    "cancelled",
    "rate_limited",
    "request_budget_exhausted",
    "runtime_budget_exhausted",
    "temporary_server_error",
    "timeout",
    "transport_error",
  ].includes(classification);
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

function isNoChangePlaylistCheckpoint(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "reason" in value &&
    value.reason === "no_changes"
  );
}

if (process.env.VITEST !== "true" && process.argv[1]?.endsWith("discovery-scheduler-cli.ts")) {
  const command = parseDiscoverySchedulerCommand(process.argv.slice(2));
  let diagnostics: ReturnType<typeof createRecurringSchedulerDiagnostics> | null = null;
  if (command === "tick") {
    try {
      diagnostics = createRecurringSchedulerDiagnostics();
    } catch {
      // A diagnostic filesystem problem must never block the production coordinator.
    }
  }
  runDiscoverySchedulerCommand(command).then(
    (result) => {
      try {
        if (isRecurringSchedulerResult(result)) diagnostics?.complete(result);
      } catch {
        // Dispatch already succeeded; diagnostics are deliberately fail-open.
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(0);
    },
    (error) => {
      try {
        diagnostics?.fail(error);
      } catch {
        // Preserve the scheduler error even if its diagnostic file cannot be updated.
      }
      process.stderr.write(`${error instanceof Error ? error.message : "Scheduler failed."}\n`);
      process.exit(1);
    },
  );
}

function isRecurringSchedulerResult(value: unknown): value is {
  decision: DiscoveryMaintenanceDecision;
  dispatchedToMaintenance: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "decision" in value &&
    "dispatchedToMaintenance" in value &&
    typeof value.dispatchedToMaintenance === "boolean"
  );
}
