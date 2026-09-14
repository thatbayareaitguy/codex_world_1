import {
  acquireSpotifyPlaylistWriterLock,
  claimAutomaticDiscoveryPlaylistInboxExport,
  createSpotifyRequestGate,
  defaultSchedulerLimits,
  ensureLocalOwner,
  executeSpotifyPlaylistExport,
  guardSpotifyPlaylistWriterClient,
  inspectSpotifyPlaylistCheckpoint,
  verifySpotifyPlaylistCheckpoint,
  deferSpotifyPlaylistCheckpoint,
  loadResumableSpotifyPlaylistExportRunId,
  maximumSpotifyPlaylistCapacityWaitMs,
  markDiscoveryPlaylistInboxStatus,
  previewSpotifyPlaylistExport,
  releaseSpotifyPlaylistWriterLock,
  spotifyPlaylistWriterFallbackTtlMs,
  spotifyPlaylistWriterLeaseMs,
  SpotifyTokenManager,
  SpotifyCooldownError,
  SpotifyEndpointBudgetError,
  SpotifyRequestDeadlineError,
  SpotifyPlaylistSnapshotYieldError,
  SpotifyPlaylistMetadataLagError,
  type RadarDatabase,
  type SpotifyPlaylistWriterProcessLiveness,
} from "@radar/db";
import {
  SpotifyClient,
  spotifyAuthorizedPlaylistId,
  SpotifyHttpError,
  SpotifyOAuthClient,
  type ProviderConfiguration,
} from "@radar/providers";
import { sanitizedSpotifyPlaylistExportOutput } from "./spotify-playlist-export-cli";

export const automaticPlaylistExportMaxAdditions = 3;
export const automaticPlaylistExportMaxMutations = 3;
export const automaticPlaylistExportMaxReadPages = 6;
export const automaticPlaylistExportFallbackTtlMs = spotifyPlaylistWriterFallbackTtlMs;
export const automaticPlaylistExportOwnerLeaseMs = spotifyPlaylistWriterLeaseMs;

export async function runSpotifyPlaylistExportPreview(
  db: RadarDatabase,
  configuration: ProviderConfiguration,
  discoveryReconciliationCampaignId?: string,
) {
  if (
    !configuration.appEncryptionKey ||
    !configuration.spotify.enabled ||
    !configuration.spotify.configured ||
    !configuration.spotify.clientId ||
    !configuration.spotify.clientSecret ||
    !configuration.spotify.allowedPlaylistId
  ) {
    throw new Error(
      "Spotify playlist preview requires encryption, Spotify credentials, and SPOTIFY_ALLOWED_PLAYLIST_ID.",
    );
  }
  const userId = await ensureLocalOwner(db);
  const schedulerLimits = defaultSchedulerLimits();
  const requestGate = createSpotifyRequestGate(
    db,
    configuration.spotify.minRequestIntervalMs,
    undefined,
    discoveryReconciliationCampaignId,
    {
      quotaLane: "playlist",
      rollingRequestBudget: {
        playlistRequestReserve: schedulerLimits.playlistRequestReserve,
        priorityRequestReserve: schedulerLimits.priorityRequestReserve,
        rolling24HourLimit: configuration.spotify.scheduler.rolling24HourLimit,
        rolling30MinuteLimit: configuration.spotify.scheduler.rolling30MinuteLimit,
      },
    },
  );
  const oauth = new SpotifyOAuthClient({
    clientId: configuration.spotify.clientId,
    clientSecret: configuration.spotify.clientSecret,
    playlistWritesEnabled: false,
    redirectUri: configuration.spotify.redirectUri,
    requestGate,
  });
  const tokens = new SpotifyTokenManager(db, userId, configuration.appEncryptionKey, oauth);
  const client = new SpotifyClient({
    accessToken: () => tokens.getAccessToken(),
    onUnauthorized: () => tokens.refresh().then(() => undefined),
    playlistWritePolicy: {
      allowedPlaylistId: configuration.spotify.allowedPlaylistId,
      enabled: false,
    },
    requestGate,
  });
  const preview = await previewSpotifyPlaylistExport(
    db,
    userId,
    client,
    configuration.spotify.allowedPlaylistId,
  );
  return {
    preview,
    sanitized: sanitizedSpotifyPlaylistExportOutput(preview),
  };
}

export async function runAutomaticDiscoveryPlaylistExport(
  db: RadarDatabase,
  configuration: ProviderConfiguration,
  dependencies: {
    verificationOnly?: boolean;
    deliveryOnly?: boolean;
    inspectCheckpoint?: typeof inspectSpotifyPlaylistCheckpoint;
    executeExport?: typeof executeSpotifyPlaylistExport;
    deadlineAt?: Date;
    inspectProcess?: (pid: number) => SpotifyPlaylistWriterProcessLiveness;
    loadResumableRunId?: typeof loadResumableSpotifyPlaylistExportRunId;
    now?: () => Date;
    ownerHost?: string;
    ownerPid?: number;
    waitForHeartbeatObservation?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  if (
    !configuration.discoverySchedulerEnabled ||
    !configuration.spotify.scheduler.enabled ||
    !configuration.spotify.playlistWritesEnabled
  ) {
    return { reason: "capability_disabled" as const };
  }
  if (
    !configuration.appEncryptionKey ||
    !configuration.spotify.enabled ||
    !configuration.spotify.configured ||
    !configuration.spotify.clientId ||
    !configuration.spotify.clientSecret ||
    !configuration.spotify.allowedPlaylistId
  ) {
    throw new Error(
      "Automatic Spotify playlist export requires explicitly enabled writes, encryption, Spotify credentials, and SPOTIFY_ALLOWED_PLAYLIST_ID.",
    );
  }
  if (configuration.spotify.allowedPlaylistId !== spotifyAuthorizedPlaylistId) {
    throw new Error(
      `Automatic Spotify playlist export is restricted to ${spotifyAuthorizedPlaylistId}.`,
    );
  }
  const now = dependencies.now?.() ?? new Date();
  if (dependencies.deadlineAt && !Number.isFinite(dependencies.deadlineAt.getTime())) {
    throw new Error("Automatic playlist export deadline must be a valid date.");
  }
  if (dependencies.deadlineAt && now >= dependencies.deadlineAt) {
    return {
      deadlineAt: dependencies.deadlineAt,
      reason: "runtime_yield" as const,
    };
  }
  const schedulerLimits = defaultSchedulerLimits();
  const lock = await acquireSpotifyPlaylistWriterLock(db, {
    ...(dependencies.inspectProcess ? { inspectProcess: dependencies.inspectProcess } : {}),
    metadata: {
      automatic: true,
      maxAdditions: automaticPlaylistExportMaxAdditions,
      maxMutations: automaticPlaylistExportMaxMutations,
      maxPlaylistReadPages: automaticPlaylistExportMaxReadPages,
    },
    now,
    ...(dependencies.ownerHost ? { ownerHost: dependencies.ownerHost } : {}),
    ...(dependencies.ownerPid ? { ownerPid: dependencies.ownerPid } : {}),
    ...(dependencies.waitForHeartbeatObservation
      ? { waitForHeartbeatObservation: dependencies.waitForHeartbeatObservation }
      : {}),
  });
  let currentExportRunId: string | null = null;
  let userId: string | null = null;
  try {
    const claimed =
      dependencies.verificationOnly ||
      dependencies.deliveryOnly ||
      (await claimAutomaticDiscoveryPlaylistInboxExport(db));
    if (!claimed) return { reason: "not_due" as const };
    userId = await ensureLocalOwner(db);
    const inspection = await (dependencies.inspectCheckpoint ?? inspectSpotifyPlaylistCheckpoint)(
      db,
      userId,
      configuration.spotify.allowedPlaylistId,
    );
    if (!inspection.shouldRun) {
      await markDiscoveryPlaylistInboxStatus(db, { status: "completed" });
      return { inspection, reason: "no_changes" as const };
    }
    if (
      (!dependencies.verificationOnly && !inspection.shouldDeliver) ||
      (inspection.checkNotBefore && new Date(inspection.checkNotBefore) > now)
    ) {
      await markDiscoveryPlaylistInboxStatus(db, { status: "partial", yieldToMatching: true });
      return { reason: "not_due" as const, inspection };
    }
    currentExportRunId = await (
      dependencies.loadResumableRunId ?? loadResumableSpotifyPlaylistExportRunId
    )(db, userId, configuration.spotify.allowedPlaylistId, "release_date_custom_order");
    const requestGate = createSpotifyRequestGate(
      db,
      configuration.spotify.minRequestIntervalMs,
      undefined,
      undefined,
      {
        artistAlbumsBudget: {
          limit: configuration.spotify.artistAlbums24HourLimit,
          priorityReserve: configuration.spotify.artistAlbumsPriorityReserve,
          reserveReleaseAfterHours: configuration.spotify.artistAlbumsReserveReleaseAfterHours,
        },
        quotaLane: "playlist",
        rollingCapacityWait: {
          ...(dependencies.deadlineAt ? { deadlineAt: dependencies.deadlineAt } : {}),
          maximumWaitMs: maximumSpotifyPlaylistCapacityWaitMs,
        },
        rollingRequestBudget: {
          playlistRequestReserve: schedulerLimits.playlistRequestReserve,
          priorityRequestReserve: schedulerLimits.priorityRequestReserve,
          rolling24HourLimit: configuration.spotify.scheduler.rolling24HourLimit,
          rolling30MinuteLimit: configuration.spotify.scheduler.rolling30MinuteLimit,
        },
      },
    );
    const oauth = new SpotifyOAuthClient({
      clientId: configuration.spotify.clientId,
      clientSecret: configuration.spotify.clientSecret,
      playlistWritesEnabled: true,
      redirectUri: configuration.spotify.redirectUri,
      requestGate,
    });
    const tokens = new SpotifyTokenManager(db, userId, configuration.appEncryptionKey, oauth);
    const client = new SpotifyClient({
      accessToken: () => tokens.getAccessToken(),
      onUnauthorized: () => tokens.refresh().then(() => undefined),
      playlistWritePolicy: {
        allowedPlaylistId: configuration.spotify.allowedPlaylistId,
        enabled: true,
      },
      requestGate,
    });
    if (dependencies.verificationOnly) {
      return await verifySpotifyPlaylistCheckpoint(
        db,
        userId,
        client,
        configuration.spotify.allowedPlaylistId,
        automaticPlaylistExportMaxReadPages,
      );
    }
    const execution = await (dependencies.executeExport ?? executeSpotifyPlaylistExport)(
      db,
      userId,
      guardSpotifyPlaylistWriterClient(db, lock, client),
      {
        maxAdditions: automaticPlaylistExportMaxAdditions,
        maxMutations: automaticPlaylistExportMaxMutations,
        maxPlaylistReadPages: automaticPlaylistExportMaxReadPages,
        orderingPolicy: "release_date_custom_order",
        playlistId: configuration.spotify.allowedPlaylistId,
        policy: {
          allowedPlaylistId: configuration.spotify.allowedPlaylistId,
          enabled: true,
        },
        retryFailedExports: false,
      },
    );
    await markDiscoveryPlaylistInboxStatus(db, {
      exportRunId: execution.run.id,
      status: execution.run.status,
      yieldToMatching: true,
    });
    return {
      reason:
        execution.run.status === "completed"
          ? ("completed" as const)
          : execution.run.status === "failed"
            ? ("terminal_failure" as const)
            : ("partial" as const),
      runId: execution.run.id,
      sanitized: sanitizedSpotifyPlaylistExportOutput(execution),
    };
  } catch (error) {
    if (
      userId &&
      !(error instanceof SpotifyPlaylistSnapshotYieldError) &&
      !(error instanceof SpotifyPlaylistMetadataLagError)
    ) {
      await deferSpotifyPlaylistCheckpoint(
        db,
        userId,
        configuration.spotify.allowedPlaylistId,
        new Date((dependencies.now?.() ?? new Date()).getTime() + 5 * 60_000),
      );
    }
    if (userId) {
      try {
        currentExportRunId = await (
          dependencies.loadResumableRunId ?? loadResumableSpotifyPlaylistExportRunId
        )(db, userId, configuration.spotify.allowedPlaylistId, "release_date_custom_order");
      } catch {
        // Preserve the original export failure if diagnostic recovery also fails.
      }
    }
    if (error instanceof SpotifyPlaylistMetadataLagError) {
      await markDiscoveryPlaylistInboxStatus(db, {
        exportRunId: currentExportRunId,
        status: "partial",
        yieldToMatching: true,
      });
      return { reason: "metadata_lag" as const, checkNotBefore: error.checkNotBefore };
    }
    if (error instanceof SpotifyPlaylistSnapshotYieldError) {
      await markDiscoveryPlaylistInboxStatus(db, {
        exportRunId: currentExportRunId,
        status: "partial",
        yieldToMatching: true,
      });
      return {
        nextOffset: error.nextOffset,
        reason: "snapshot_yield" as const,
      };
    }
    if (error instanceof SpotifyEndpointBudgetError) {
      await markDiscoveryPlaylistInboxStatus(db, {
        exportRunId: currentExportRunId,
        status: "partial",
        yieldToMatching: true,
      });
      return {
        nextCapacityAt: error.nextCapacityAt,
        reason: "capacity_exhausted" as const,
      };
    }
    if (error instanceof SpotifyRequestDeadlineError) {
      await markDiscoveryPlaylistInboxStatus(db, {
        exportRunId: currentExportRunId,
        status: "partial",
        yieldToMatching: true,
      });
      return {
        deadlineAt: error.deadlineAt,
        nextCapacityAt: error.nextCapacityAt,
        reason: "runtime_yield" as const,
      };
    }
    await markDiscoveryPlaylistInboxStatus(db, {
      exportRunId: currentExportRunId,
      pauseForCooldown: isSpotifyCooldown(error),
      status: "partial",
      yieldToMatching: true,
    });
    throw error;
  } finally {
    await releaseSpotifyPlaylistWriterLock(db, lock);
  }
}

export async function inspectAutomaticDiscoveryPlaylistCheckpoint(
  db: RadarDatabase,
  configuration: ProviderConfiguration,
) {
  if (
    !configuration.discoverySchedulerEnabled ||
    !configuration.spotify.scheduler.enabled ||
    !configuration.spotify.playlistWritesEnabled ||
    !configuration.spotify.allowedPlaylistId
  ) {
    return { reason: "capability_disabled" as const, shouldRun: false };
  }
  const userId = await ensureLocalOwner(db);
  const inspection = await inspectSpotifyPlaylistCheckpoint(
    db,
    userId,
    configuration.spotify.allowedPlaylistId,
    { recordReady: true },
  );
  return { ...inspection, shouldRun: inspection.shouldDeliver };
}

function isSpotifyCooldown(error: unknown): boolean {
  return (
    error instanceof SpotifyCooldownError ||
    (error instanceof SpotifyHttpError && error.status === 429)
  );
}
