import {
  acquireOperationLock,
  createDatabase,
  createSpotifyReleaseReconciliationRepository,
  createSpotifyRequestGate,
  ensureLocalOwner,
  getSpotifyOperationalStatus,
  heartbeatOperationLock,
  listOperationLocks,
  oauthAccounts,
  releaseOperationLock,
  SpotifyTokenManager,
} from "@radar/db";
import { loadProviderConfiguration, SpotifyClient, SpotifyOAuthClient } from "@radar/providers";
import { and, eq } from "drizzle-orm";
import { loadLocalEnvironment } from "./local-env";
import { budgetSpotifyRequestGate } from "./scan";
import {
  runSpotifyReleaseReconciliation,
  type SpotifyReleaseReconciliationOptions,
} from "./spotify-release-reconciliation";

loadLocalEnvironment();

export interface SpotifyReleaseReconciliationCliOptions extends SpotifyReleaseReconciliationOptions {
  confirmLive: boolean;
}

export function parseSpotifyReleaseReconciliationOptions(
  args: string[],
): SpotifyReleaseReconciliationCliOptions {
  const releaseIds: string[] = [];
  let pageSize = 50;
  let maxPagesPerRelease = 50;
  let confirmLive = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--confirm-live") confirmLive = true;
    else if (arg === "--release") {
      const value = args[index + 1];
      if (!value) throw new Error("--release requires a canonical release ID.");
      releaseIds.push(value);
      index += 1;
    } else if (arg === "--page-size") {
      const value = args[index + 1];
      if (!value) throw new Error("--page-size requires an integer value.");
      pageSize = Number(value);
      index += 1;
    } else if (arg === "--max-pages-per-release") {
      const value = args[index + 1];
      if (!value) throw new Error("--max-pages-per-release requires an integer value.");
      maxPagesPerRelease = Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown release reconciliation option: ${arg ?? ""}`);
    }
  }
  if (!confirmLive) {
    throw new Error("Live release reconciliation requires --confirm-live.");
  }
  return { confirmLive, maxPagesPerRelease, pageSize, releaseIds };
}

async function main(): Promise<void> {
  const options = parseSpotifyReleaseReconciliationOptions(process.argv.slice(2));
  const configuration = loadProviderConfiguration();
  if (
    !configuration.databaseUrl ||
    !configuration.spotify.configured ||
    !configuration.spotify.clientId ||
    !configuration.spotify.clientSecret ||
    !configuration.appEncryptionKey
  ) {
    throw new Error("Release reconciliation requires PostgreSQL and configured Spotify access.");
  }
  if (configuration.spotify.playlistWritesEnabled) {
    throw new Error("Disable Spotify playlist writes before release reconciliation.");
  }

  const connection = createDatabase(configuration.databaseUrl);
  try {
    const userId = await ensureLocalOwner(connection.db);
    const account = await connection.db.query.oauthAccounts.findFirst({
      where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "spotify")),
      columns: { disconnectedAt: true, id: true, reconnectRequired: true },
    });
    if (!account || account.disconnectedAt || account.reconnectRequired) {
      throw new Error("Spotify is not connected.");
    }
    const operational = await getSpotifyOperationalStatus(connection.db);
    if (operational.cooldownActive) {
      throw new Error(
        `Spotify cooldown is active until ${operational.cooldownUntil?.toISOString() ?? "cleared"}.`,
      );
    }
    const activeLocks = (await listOperationLocks(connection.db)).filter((lock) => !lock.stale);
    if (activeLocks.length > 0) {
      throw new Error(
        `Another operation is active: ${activeLocks.map((lock) => lock.lockKey).join(", ")}.`,
      );
    }

    const repository = createSpotifyReleaseReconciliationRepository(connection.db);
    const targets = await repository.listTargets(options.releaseIds);
    const selectedIds = new Set(targets.map((target) => target.releaseId));
    if (
      targets.length !== options.releaseIds.length ||
      options.releaseIds.some((releaseId) => !selectedIds.has(releaseId))
    ) {
      throw new Error("One or more selected releases lack an exact Spotify retrieval mapping.");
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          estimatedMaximumRequests: Math.min(
            configuration.spotify.maxRequestsPerRun,
            targets.reduce(
              (total, target) =>
                total +
                (target.status === "completed"
                  ? 0
                  : Math.min(
                      options.maxPagesPerRelease,
                      Math.max(1, Math.ceil(target.expectedTotalTracks / options.pageSize)),
                    )),
              0,
            ),
          ),
          pageSize: options.pageSize,
          selected: targets.map((target) => ({
            expectedTotalTracks: target.expectedTotalTracks,
            releaseId: target.releaseId,
            title: target.title,
          })),
        },
        null,
        2,
      )}\n`,
    );

    const lock = await acquireOperationLock(connection.db, {
      lockKey: "scan:global",
      metadata: {
        maxPagesPerRelease: options.maxPagesPerRelease,
        pageSize: options.pageSize,
        releaseCount: options.releaseIds.length,
      },
      operationType: "spotify_release_track_reconciliation",
    });
    try {
      const gate = budgetSpotifyRequestGate(
        createSpotifyRequestGate(connection.db, configuration.spotify.minRequestIntervalMs),
        configuration.spotify.maxRequestsPerRun,
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
      const summary = await runSpotifyReleaseReconciliation(options, {
        client,
        onProgress: async (progress) => {
          const active = await heartbeatOperationLock(connection.db, lock, {
            ...progress,
            requests: client.metrics.requests,
          });
          if (!active) throw new Error("Release reconciliation operation lock was lost.");
        },
        repository,
      });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } finally {
      await releaseOperationLock(connection.db, lock);
    }
  } finally {
    await connection.client.end();
  }
}

if (process.env.VITEST !== "true") {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Spotify release reconciliation failed."}\n`,
    );
    process.exitCode = 1;
  });
}
