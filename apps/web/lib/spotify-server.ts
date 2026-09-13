import {
  createDatabase,
  createSpotifyRequestGate,
  ensureLocalOwner,
  SpotifyTokenManager,
  type RadarDatabase,
} from "@radar/db";
import { loadProviderConfiguration, SpotifyClient, SpotifyOAuthClient } from "@radar/providers";

export interface SpotifyServerContext {
  client: SpotifyClient;
  close: () => Promise<void>;
  db: RadarDatabase;
  oauthClient: SpotifyOAuthClient;
  userId: string;
}

export async function createSpotifyServerContext(): Promise<SpotifyServerContext> {
  const config = loadProviderConfiguration();
  if (!config.spotify.enabled) throw new Error("Spotify is disabled");
  if (
    !config.spotify.configured ||
    !config.spotify.clientId ||
    !config.spotify.clientSecret ||
    !config.appEncryptionKey ||
    !config.databaseUrl
  ) {
    throw new Error("Spotify or database configuration is incomplete");
  }
  const connection = createDatabase(config.databaseUrl);
  const userId = await ensureLocalOwner(connection.db);
  const oauthClient = new SpotifyOAuthClient({
    clientId: config.spotify.clientId,
    clientSecret: config.spotify.clientSecret,
    playlistWritesEnabled:
      config.spotify.playlistWritesEnabled && Boolean(config.spotify.allowedPlaylistId),
    redirectUri: config.spotify.redirectUri,
    requestGate: createSpotifyRequestGate(connection.db, config.spotify.minRequestIntervalMs),
  });
  const tokens = new SpotifyTokenManager(
    connection.db,
    userId,
    config.appEncryptionKey,
    oauthClient,
  );
  const client = new SpotifyClient({
    accessToken: () => tokens.getAccessToken(),
    onUnauthorized: () => tokens.refresh().then(() => undefined),
    playlistWritePolicy: {
      ...(config.spotify.allowedPlaylistId
        ? { allowedPlaylistId: config.spotify.allowedPlaylistId }
        : {}),
      enabled: config.spotify.playlistWritesEnabled,
    },
    requestGate: createSpotifyRequestGate(connection.db, config.spotify.minRequestIntervalMs),
  });
  return {
    client,
    close: () => connection.client.end(),
    db: connection.db,
    oauthClient,
    userId,
  };
}
