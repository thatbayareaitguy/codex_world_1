import {
  acquireOperationLock,
  createDatabase,
  createSpotifyRequestGate,
  ensureLocalOwner,
  executeSpotifyPlaylistCustomOrder,
  hasVerifiedSpotifyPlaylistOrderCanary,
  previewSpotifyPlaylistCustomOrder,
  releaseOperationLock,
  SpotifyTokenManager,
} from "@radar/db";
import {
  loadProviderConfiguration,
  SpotifyClient,
  spotifyAuthorizedPlaylistId,
  SpotifyOAuthClient,
} from "@radar/providers";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "./local-env";

loadLocalEnvironment();

type OrderMode = "dry-run" | "canary" | "live";

export function parseSpotifyPlaylistOrderMode(args: string[]): OrderMode {
  const values = args.filter((value) => value !== "--");
  if (values.length !== 1) {
    throw new Error("Choose exactly one of --dry-run, --canary, or --live.");
  }
  if (values[0] === "--dry-run") return "dry-run";
  if (values[0] === "--canary") return "canary";
  if (values[0] === "--live") return "live";
  throw new Error("Choose exactly one of --dry-run, --canary, or --live.");
}

async function main(): Promise<void> {
  const mode = parseSpotifyPlaylistOrderMode(process.argv.slice(2));
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
      "Spotify playlist ordering requires database, encryption, Spotify credentials, and SPOTIFY_ALLOWED_PLAYLIST_ID.",
    );
  }
  if (configuration.spotify.allowedPlaylistId !== spotifyAuthorizedPlaylistId) {
    throw new Error(`Spotify playlist ordering is restricted to ${spotifyAuthorizedPlaylistId}.`);
  }
  if (mode !== "dry-run" && !configuration.spotify.playlistWritesEnabled) {
    throw new Error(
      "Live Spotify playlist ordering requires SPOTIFY_PLAYLIST_WRITES_ENABLED=true.",
    );
  }
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const lock = await acquireOperationLock(connection.db, {
      lockKey: "spotify:playlist-order",
      metadata: { mode, provider: "spotify" },
      operationType: "spotify_playlist_export",
    });
    try {
      const userId = await ensureLocalOwner(connection.db);
      const requestGate = createSpotifyRequestGate(
        connection.db,
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
        playlistWritesEnabled: mode !== "dry-run",
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
          enabled: mode !== "dry-run",
        },
        requestGate,
      });
      if (mode === "dry-run") {
        const preview = await previewSpotifyPlaylistCustomOrder(
          connection.db,
          userId,
          client,
          configuration.spotify.allowedPlaylistId,
          { forceRefresh: true },
        );
        process.stdout.write(`${JSON.stringify(sanitizePreview(preview), null, 2)}\n`);
        return;
      }
      if (
        mode === "live" &&
        !(await hasVerifiedSpotifyPlaylistOrderCanary(
          connection.db,
          userId,
          configuration.spotify.allowedPlaylistId,
        ))
      ) {
        throw new Error("Run and verify --canary before the full playlist reorder.");
      }
      const execution = await executeSpotifyPlaylistCustomOrder(connection.db, userId, client, {
        canary: mode === "canary",
        forceRefresh: mode === "canary",
        playlistId: configuration.spotify.allowedPlaylistId,
        policy: {
          allowedPlaylistId: configuration.spotify.allowedPlaylistId,
          enabled: true,
        },
      });
      process.stdout.write(
        `${JSON.stringify({ ...sanitizePreview(execution), result: execution.result }, null, 2)}\n`,
      );
    } finally {
      await releaseOperationLock(connection.db, lock);
    }
  } finally {
    await connection.client.end();
  }
}

function sanitizePreview(preview: Awaited<ReturnType<typeof previewSpotifyPlaylistCustomOrder>>) {
  return {
    cacheHit: preview.cacheHit,
    mode: "release_date_custom_order",
    target: { itemCount: preview.target.itemCount, name: preview.target.name },
    totals: {
      additions: 0,
      duplicatesCreated: 0,
      moves: preview.plan.moves.length,
      removals: 0,
      unknownDateItems: preview.plan.unknownDateItems,
    },
    moves: preview.plan.moves.map((move, ordinal) => ({
      insertBefore: move.insertBefore,
      ordinal,
      rangeLength: move.rangeLength,
      rangeStart: move.rangeStart,
    })),
  };
}

if (
  process.env.VITEST !== "true" &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Playlist ordering failed."}\n`,
    );
    process.exitCode = 1;
  });
}
