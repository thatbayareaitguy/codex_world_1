import {
  acquireOperationLock,
  createDatabase,
  createSpotifyRequestGate,
  ensureLocalOwner,
  executeSpotifyPlaylistVisibility,
  previewSpotifyPlaylistVisibility,
  releaseOperationLock,
  SpotifyTokenManager,
} from "@radar/db";
import {
  abbreviateSpotifyPlaylistId,
  loadProviderConfiguration,
  SpotifyClient,
  spotifyAuthorizedPlaylistId,
  SpotifyOAuthClient,
} from "@radar/providers";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "./local-env";

loadLocalEnvironment();

export type SpotifyPlaylistVisibilityMode = "dry-run" | "live";

export function parseSpotifyPlaylistVisibilityMode(
  args: readonly string[],
): SpotifyPlaylistVisibilityMode {
  const values = args.filter((value) => value !== "--");
  if (values.length !== 1) throw new Error("Choose exactly one of --dry-run or --live.");
  if (values[0] === "--dry-run") return "dry-run";
  if (values[0] === "--live") return "live";
  throw new Error("Choose exactly one of --dry-run or --live.");
}

async function main(): Promise<void> {
  const mode = parseSpotifyPlaylistVisibilityMode(process.argv.slice(2));
  const configuration = loadProviderConfiguration();
  if (
    !configuration.databaseUrl ||
    !configuration.appEncryptionKey ||
    !configuration.spotify.enabled ||
    !configuration.spotify.configured ||
    !configuration.spotify.clientId ||
    !configuration.spotify.clientSecret ||
    !configuration.spotify.allowedPlaylistId
  ) {
    throw new Error(
      "Spotify playlist visibility requires database, encryption, Spotify credentials, and SPOTIFY_ALLOWED_PLAYLIST_ID.",
    );
  }
  if (configuration.spotify.allowedPlaylistId !== spotifyAuthorizedPlaylistId) {
    throw new Error(`Spotify playlist visibility is restricted to ${spotifyAuthorizedPlaylistId}.`);
  }
  if (mode === "live" && !configuration.spotify.playlistWritesEnabled) {
    throw new Error(
      "Live Spotify playlist visibility requires SPOTIFY_PLAYLIST_WRITES_ENABLED=true.",
    );
  }

  const connection = createDatabase(configuration.databaseUrl);
  try {
    const lock = await acquireOperationLock(connection.db, {
      lockKey: "spotify:playlist-export",
      metadata: { mode, provider: "spotify", purpose: "authorized_playlist_visibility" },
      operationType: "spotify_playlist_export",
    });
    try {
      const userId = await ensureLocalOwner(connection.db);
      const requestGate = createSpotifyRequestGate(
        connection.db,
        configuration.spotify.minRequestIntervalMs,
        undefined,
        undefined,
        { quotaLane: "playlist" },
      );
      const oauth = new SpotifyOAuthClient({
        clientId: configuration.spotify.clientId,
        clientSecret: configuration.spotify.clientSecret,
        playlistWritesEnabled: mode === "live",
        redirectUri: configuration.spotify.redirectUri,
        requestGate,
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
        playlistWritePolicy: {
          allowedPlaylistId: configuration.spotify.allowedPlaylistId,
          enabled: mode === "live",
        },
        requestGate,
      });

      const result =
        mode === "live"
          ? await executeSpotifyPlaylistVisibility(connection.db, userId, client, {
              playlistId: configuration.spotify.allowedPlaylistId,
              policy: {
                allowedPlaylistId: configuration.spotify.allowedPlaylistId,
                enabled: true,
              },
            })
          : await previewSpotifyPlaylistVisibility(
              connection.db,
              userId,
              client,
              configuration.spotify.allowedPlaylistId,
            );
      process.stdout.write(`${JSON.stringify(sanitizeResult(mode, result), null, 2)}\n`);
    } finally {
      await releaseOperationLock(connection.db, lock);
    }
  } finally {
    await connection.client.end();
  }
}

function sanitizeResult(
  mode: SpotifyPlaylistVisibilityMode,
  result:
    | Awaited<ReturnType<typeof executeSpotifyPlaylistVisibility>>
    | Awaited<ReturnType<typeof previewSpotifyPlaylistVisibility>>,
) {
  return {
    cacheHit: result.cacheHit,
    mode,
    target: {
      collaborative: result.target.collaborative,
      currentPublic: result.target.currentPublic,
      expectedPublic: result.target.expectedPublic,
      id: abbreviateSpotifyPlaylistId(result.target.id),
      itemCount: result.target.itemCount,
      name: result.target.name,
      ownerVerified: result.target.ownerVerified,
      snapshotIdPresent: result.target.snapshotId.length > 0,
    },
    verification: result.verification,
    ...(mode === "live" && "result" in result ? { result: result.result } : {}),
  };
}

if (
  process.env.VITEST !== "true" &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Playlist visibility operation failed."}\n`,
    );
    process.exitCode = 1;
  });
}
