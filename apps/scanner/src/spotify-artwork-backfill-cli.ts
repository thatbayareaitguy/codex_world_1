import {
  acquireOperationLock,
  createDatabase,
  createSpotifyArtworkBackfillRepository,
  createSpotifyRequestGate,
  ensureLocalOwner,
  releaseOperationLock,
  SpotifyTokenManager,
} from "@radar/db";
import { loadProviderConfiguration, SpotifyClient, SpotifyOAuthClient } from "@radar/providers";
import { loadLocalEnvironment } from "./local-env";
import {
  parseSpotifyArtworkBackfillOptions,
  runSpotifyArtworkBackfill,
} from "./spotify-artwork-backfill";

loadLocalEnvironment();

try {
  const options = parseSpotifyArtworkBackfillOptions(process.argv.slice(2));
  const configuration = loadProviderConfiguration();
  if (
    !configuration.databaseUrl ||
    !configuration.spotify.configured ||
    !configuration.spotify.clientId ||
    !configuration.spotify.clientSecret ||
    !configuration.appEncryptionKey
  ) {
    throw new Error("Artwork backfill requires PostgreSQL and a connected Spotify account.");
  }
  if (configuration.spotify.playlistWritesEnabled) {
    throw new Error("Disable Spotify playlist writes before running artwork backfill.");
  }

  const connection = createDatabase(configuration.databaseUrl);
  try {
    const lock = await acquireOperationLock(connection.db, {
      lockKey: "spotify-artwork-backfill",
      metadata: { apply: options.apply, limit: options.limit },
      operationType: "spotify_artwork_backfill",
    });
    try {
      const userId = await ensureLocalOwner(connection.db);
      const gate = createSpotifyRequestGate(
        connection.db,
        configuration.spotify.minRequestIntervalMs,
      );
      const oauth = new SpotifyOAuthClient({
        clientId: configuration.spotify.clientId,
        clientSecret: configuration.spotify.clientSecret,
        redirectUri: configuration.spotify.redirectUri,
        requestGate: gate,
      });
      const tokens = new SpotifyTokenManager(
        connection.db,
        userId,
        configuration.appEncryptionKey,
        oauth,
      );
      const client = new SpotifyClient({
        accessToken: () => tokens.getAccessToken(),
        onUnauthorized: () => tokens.refresh().then(() => undefined),
        requestGate: gate,
      });
      const summary = await runSpotifyArtworkBackfill(options, {
        client,
        repository: createSpotifyArtworkBackfillRepository(connection.db),
      });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      if (summary.stoppedReason !== "completed") process.exitCode = 1;
    } finally {
      await releaseOperationLock(connection.db, lock);
    }
  } finally {
    await connection.client.end();
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Spotify artwork backfill failed."}\n`,
  );
  process.exitCode = 1;
}
