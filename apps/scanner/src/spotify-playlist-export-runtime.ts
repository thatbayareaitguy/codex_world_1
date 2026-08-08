import {
  acquireOperationLock,
  claimAutomaticDiscoveryPlaylistInboxExport,
  createSpotifyRequestGate,
  ensureLocalOwner,
  executeSpotifyPlaylistExport,
  markDiscoveryPlaylistInboxStatus,
  previewSpotifyPlaylistExport,
  releaseOperationLock,
  SpotifyTokenManager,
  type RadarDatabase,
} from "@radar/db";
import { SpotifyClient, SpotifyOAuthClient, type ProviderConfiguration } from "@radar/providers";
import { sanitizedSpotifyPlaylistExportOutput } from "./spotify-playlist-export-cli";

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
  } = {},
) {
  if (
    !configuration.appEncryptionKey ||
    !configuration.spotify.enabled ||
    !configuration.spotify.configured ||
    !configuration.spotify.clientId ||
    !configuration.spotify.clientSecret ||
    !configuration.spotify.allowedPlaylistId ||
    !configuration.spotify.playlistWritesEnabled
  ) {
    throw new Error(
      "Automatic Spotify playlist export requires explicitly enabled writes, encryption, Spotify credentials, and SPOTIFY_ALLOWED_PLAYLIST_ID.",
    );
  }
  const lock = await acquireOperationLock(db, {
    lockKey: "spotify:playlist-export",
    metadata: { automatic: true, provider: "spotify" },
    operationType: "spotify_playlist_export",
  });
  try {
    const claimed = await claimAutomaticDiscoveryPlaylistInboxExport(db);
    if (!claimed) return { reason: "not_due" as const };
    const userId = await ensureLocalOwner(db);
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
        orderingPolicy: "discovery_inbox",
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
    await markDiscoveryPlaylistInboxStatus(db, { status: "failed" });
    throw error;
  } finally {
    await releaseOperationLock(db, lock);
  }
}
