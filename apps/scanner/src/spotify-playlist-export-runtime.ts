import {
  createSpotifyRequestGate,
  ensureLocalOwner,
  previewSpotifyPlaylistExport,
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
