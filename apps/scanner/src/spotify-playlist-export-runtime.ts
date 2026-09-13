import {
  acquireOperationLock,
  claimAutomaticDiscoveryPlaylistInboxExport,
  createSpotifyRequestGate,
  ensureLocalOwner,
  executeSpotifyPlaylistExport,
  inspectSpotifyPlaylistCheckpoint,
  loadOperationLock,
  markDiscoveryPlaylistInboxStatus,
  previewSpotifyPlaylistExport,
  releaseOperationLock,
  renewOperationLock,
  SpotifyTokenManager,
  SpotifyCooldownError,
  SpotifyPlaylistSnapshotYieldError,
  type RadarDatabase,
} from "@radar/db";
import {
  SpotifyClient,
  spotifyAuthorizedPlaylistId,
  SpotifyHttpError,
  SpotifyOAuthClient,
  type ProviderConfiguration,
} from "@radar/providers";
import { hostname } from "node:os";
import { sanitizedSpotifyPlaylistExportOutput } from "./spotify-playlist-export-cli";

const automaticPlaylistExportLockKey = "spotify:playlist-export";
export const automaticPlaylistExportMaxAdditions = 3;
export const automaticPlaylistExportMaxMutations = 3;
export const automaticPlaylistExportMaxReadPages = 6;
export const automaticPlaylistExportFallbackTtlMs = 5 * 60_000;
export const automaticPlaylistExportOwnerLeaseMs = 2 * 60 * 60_000;

type ProcessLiveness = "alive" | "dead" | "unknown";

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
  const requestGate = createSpotifyRequestGate(
    db,
    configuration.spotify.minRequestIntervalMs,
    undefined,
    discoveryReconciliationCampaignId,
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
    executeExport?: typeof executeSpotifyPlaylistExport;
    inspectProcess?: (pid: number) => ProcessLiveness;
    now?: () => Date;
    ownerHost?: string;
    ownerPid?: number;
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
  const ownerHost = dependencies.ownerHost ?? hostname();
  const ownerPid = dependencies.ownerPid ?? process.pid;
  await recoverAbandonedAutomaticPlaylistExportLock(db, {
    inspectProcess: dependencies.inspectProcess ?? inspectLocalProcess,
    now,
    ownerHost,
  });
  const lock = await acquireOperationLock(db, {
    lockKey: automaticPlaylistExportLockKey,
    metadata: {
      automatic: true,
      heartbeatAt: now.toISOString(),
      maxAdditions: automaticPlaylistExportMaxAdditions,
      maxMutations: automaticPlaylistExportMaxMutations,
      maxPlaylistReadPages: automaticPlaylistExportMaxReadPages,
      ownerHost,
      ownerPid,
      provider: "spotify",
    },
    operationType: "spotify_playlist_export",
    ttlMs: automaticPlaylistExportOwnerLeaseMs,
  });
  try {
    const claimed = await claimAutomaticDiscoveryPlaylistInboxExport(db);
    if (!claimed) return { reason: "not_due" as const };
    const userId = await ensureLocalOwner(db);
    const inspection = await inspectSpotifyPlaylistCheckpoint(
      db,
      userId,
      configuration.spotify.allowedPlaylistId,
    );
    if (!inspection.shouldRun) {
      await markDiscoveryPlaylistInboxStatus(db, { status: "completed" });
      return { inspection, reason: "no_changes" as const };
    }
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
    const execution = await (dependencies.executeExport ?? executeSpotifyPlaylistExport)(
      db,
      userId,
      client,
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
      },
    );
    await markDiscoveryPlaylistInboxStatus(db, {
      exportRunId: execution.run.id,
      status: execution.run.status === "completed" ? "completed" : "partial",
    });
    return {
      reason: execution.run.status === "completed" ? ("completed" as const) : ("partial" as const),
      runId: execution.run.id,
      sanitized: sanitizedSpotifyPlaylistExportOutput(execution),
    };
  } catch (error) {
    if (error instanceof SpotifyPlaylistSnapshotYieldError) {
      await markDiscoveryPlaylistInboxStatus(db, { status: "partial" });
      return {
        nextOffset: error.nextOffset,
        reason: "snapshot_yield" as const,
      };
    }
    await markDiscoveryPlaylistInboxStatus(db, {
      pauseForCooldown: isSpotifyCooldown(error),
      status: isSpotifyCooldown(error) ? "partial" : "failed",
    });
    throw error;
  } finally {
    await releaseOperationLock(db, lock);
  }
}

async function recoverAbandonedAutomaticPlaylistExportLock(
  db: RadarDatabase,
  input: {
    inspectProcess: (pid: number) => ProcessLiveness;
    now: Date;
    ownerHost: string;
  },
): Promise<void> {
  const existing = await loadOperationLock(db, automaticPlaylistExportLockKey);
  if (!existing) return;

  const metadata = isRecord(existing.metadata) ? existing.metadata : {};
  const recordedHost = typeof metadata.ownerHost === "string" ? metadata.ownerHost : null;
  const recordedPid =
    typeof metadata.ownerPid === "number" && Number.isInteger(metadata.ownerPid)
      ? metadata.ownerPid
      : null;
  const liveness =
    recordedHost === input.ownerHost && recordedPid !== null
      ? input.inspectProcess(recordedPid)
      : "unknown";
  const heartbeatAt = parseTimestamp(metadata.heartbeatAt) ?? existing.acquiredAt;
  const fallbackExpired =
    input.now.getTime() - heartbeatAt.getTime() >= automaticPlaylistExportFallbackTtlMs;

  if (liveness === "alive" || (liveness === "unknown" && !fallbackExpired)) {
    await renewOperationLock(db, {
      lockKey: existing.lockKey,
      ownerToken: existing.ownerToken,
      ttlMs: automaticPlaylistExportOwnerLeaseMs,
    });
    return;
  }
  await releaseOperationLock(db, {
    lockKey: existing.lockKey,
    ownerToken: existing.ownerToken,
  });
}

function inspectLocalProcess(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  return inspectSpotifyPlaylistCheckpoint(db, userId, configuration.spotify.allowedPlaylistId);
}

function isSpotifyCooldown(error: unknown): boolean {
  return (
    error instanceof SpotifyCooldownError ||
    (error instanceof SpotifyHttpError && error.status === 429)
  );
}
