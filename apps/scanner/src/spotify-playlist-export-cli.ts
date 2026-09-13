import {
  createDatabase,
  createSpotifyRequestGate,
  ensureLocalOwner,
  executeSpotifyPlaylistExport,
  markDiscoveryPlaylistInboxStatus,
  prepareDiscoveryPlaylistInboxExport,
  previewSpotifyPlaylistExport,
  SpotifyTokenManager,
} from "@radar/db";
import {
  loadProviderConfiguration,
  SpotifyClient,
  SpotifyOAuthClient,
  type SpotifyPlaylistExportPlan,
} from "@radar/providers";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "./local-env";

loadLocalEnvironment();

export interface SpotifyPlaylistExportCliOptions {
  campaignId?: string;
  discoveryInbox: boolean;
  live: boolean;
  maxAdditions?: number;
}

export function parseSpotifyPlaylistExportOptions(args: string[]): SpotifyPlaylistExportCliOptions {
  const values = args.filter((value) => value !== "--");
  let live: boolean | undefined;
  let maxAdditions: number | undefined;
  let campaignId: string | undefined;
  let discoveryInbox = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--dry-run") {
      if (live !== undefined) throw new Error("Choose exactly one of --dry-run or --live.");
      live = false;
      continue;
    }
    if (value === "--live") {
      if (live !== undefined) throw new Error("Choose exactly one of --dry-run or --live.");
      live = true;
      continue;
    }
    if (value === "--campaign") {
      campaignId = requiredValue(values[index + 1], "--campaign");
      index += 1;
      continue;
    }
    if (value === "--discovery-inbox") {
      discoveryInbox = true;
      continue;
    }
    if (value === "--max-additions") {
      maxAdditions = parsePositiveInteger(values[index + 1]);
      index += 1;
      continue;
    }
    if (value.startsWith("--max-additions=")) {
      maxAdditions = parsePositiveInteger(value.slice("--max-additions=".length));
      continue;
    }
    throw new Error(`Unknown Spotify playlist export option: ${value}`);
  }
  if (live === undefined) throw new Error("Choose exactly one of --dry-run or --live.");
  if (!live && maxAdditions !== undefined) {
    throw new Error("--max-additions is available only with --live.");
  }
  if (discoveryInbox && !campaignId) {
    throw new Error("--discovery-inbox requires --campaign <campaign-id>.");
  }
  return {
    discoveryInbox,
    live,
    ...(campaignId ? { campaignId } : {}),
    ...(maxAdditions === undefined ? {} : { maxAdditions }),
  };
}

export function sanitizedSpotifyPlaylistExportOutput(input: {
  cacheHit?: boolean;
  plan: SpotifyPlaylistExportPlan;
  run?: {
    additionsAttempted: number;
    exported: number;
    failed: number;
    id: string;
    pending: number;
    resumed: boolean;
    skipped: number;
    status: string;
  };
  target: {
    collaborative?: boolean;
    id: string;
    name: string;
    public?: boolean | null;
    snapshotId: string;
  };
}) {
  const skipCounts = Object.fromEntries(
    [...new Set(input.plan.skips.map((item) => item.reason))]
      .sort()
      .map((reason) => [reason, input.plan.skips.filter((item) => item.reason === reason).length]),
  );
  return {
    cacheHit: input.cacheHit ?? false,
    mode: input.run ? "live" : "dry-run",
    target: {
      ...(input.target.collaborative === undefined
        ? {}
        : { collaborative: input.target.collaborative }),
      id: input.target.id,
      name: input.target.name,
      ...(input.target.public === undefined ? {} : { public: input.target.public }),
    },
    totals: {
      additions: input.plan.additions.length,
      alreadyPresent: input.plan.alreadyPresent.length,
      eligible: input.plan.desired.length,
      existingDuplicateTracks: input.plan.existingDuplicateTrackIds.length,
      finalPlaylistItems: input.plan.finalTrackIds.length,
      orderingConflicts: input.plan.reorderMoves.length,
      reorderMoves: input.plan.reorderMoves.length,
      releaseGroupingConflicts: input.plan.releaseGroupingConflicts.length,
      skipped: input.plan.skips.length,
      managedPlaylistItems: input.plan.managedPlaylistItemCount,
      managedOutsideCurrentEligibility: input.plan.outsideCurrentExportSetItems.filter(
        (item) => item.appManaged,
      ).length,
      outsideCurrentEligibility: input.plan.outsideCurrentExportSetItems.length,
      unmanagedPlaylistItems: input.plan.unmanagedItems.length,
    },
    skipCounts,
    additions: input.plan.additions.map((item) => ({
      position: item.position,
      providerTrackId: item.providerTrackId,
      reason: item.reason,
      releaseDate: item.releaseDate,
      releaseTitle: item.releaseTitle,
      title: item.title,
    })),
    skips: input.plan.skips.map((item) => ({
      ...(item.providerTrackId ? { providerTrackId: item.providerTrackId } : {}),
      reason: item.reason,
      title: item.title,
    })),
    orderingConflicts: input.plan.reorderMoves,
    releaseGroupingConflicts: input.plan.releaseGroupingConflicts,
    outsideCurrentExportSetItems: input.plan.outsideCurrentExportSetItems.map((item) => ({
      appManaged: item.appManaged,
      ...(item.addedAt ? { addedAt: item.addedAt } : {}),
      ...(item.albumId ? { albumId: item.albumId } : {}),
      ...(item.albumTitle ? { albumTitle: item.albumTitle } : {}),
      ...(item.artistNames ? { artistNames: item.artistNames } : {}),
      position: item.position,
      ...(item.releaseDate ? { releaseDate: item.releaseDate } : {}),
      trackId: item.trackId,
      ...(item.title ? { title: item.title } : {}),
    })),
    unmanagedItems: input.plan.unmanagedItems.map((item) => ({
      ...(item.addedAt ? { addedAt: item.addedAt } : {}),
      ...(item.albumTitle ? { albumTitle: item.albumTitle } : {}),
      ...(item.artistNames ? { artistNames: item.artistNames } : {}),
      position: item.position,
      ...(item.releaseDate ? { releaseDate: item.releaseDate } : {}),
      trackId: item.trackId,
      ...(item.title ? { title: item.title } : {}),
    })),
    ...(input.run ? { run: input.run } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseSpotifyPlaylistExportOptions(process.argv.slice(2));
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
      "Spotify playlist export requires database, encryption, Spotify credentials, and SPOTIFY_ALLOWED_PLAYLIST_ID.",
    );
  }
  if (options.live && !configuration.spotify.playlistWritesEnabled) {
    throw new Error("Live Spotify playlist export requires SPOTIFY_PLAYLIST_WRITES_ENABLED=true.");
  }
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const userId = await ensureLocalOwner(connection.db);
    const oauth = new SpotifyOAuthClient({
      clientId: configuration.spotify.clientId,
      clientSecret: configuration.spotify.clientSecret,
      playlistWritesEnabled:
        configuration.spotify.playlistWritesEnabled &&
        Boolean(configuration.spotify.allowedPlaylistId),
      redirectUri: configuration.spotify.redirectUri,
      requestGate: createSpotifyRequestGate(
        connection.db,
        configuration.spotify.minRequestIntervalMs,
      ),
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
        enabled: configuration.spotify.playlistWritesEnabled,
      },
      requestGate: createSpotifyRequestGate(
        connection.db,
        configuration.spotify.minRequestIntervalMs,
      ),
    });
    if (options.live && options.discoveryInbox) {
      await prepareDiscoveryPlaylistInboxExport(connection.db, options.campaignId!);
    }
    let result:
      | Awaited<ReturnType<typeof executeSpotifyPlaylistExport>>
      | Awaited<ReturnType<typeof previewSpotifyPlaylistExport>>;
    try {
      if (options.live) {
        const execution = await executeSpotifyPlaylistExport(connection.db, userId, client, {
          ...(options.campaignId ? { discoveryReconciliationCampaignId: options.campaignId } : {}),
          ...(options.maxAdditions === undefined ? {} : { maxAdditions: options.maxAdditions }),
          orderingPolicy: "release_date_custom_order",
          playlistId: configuration.spotify.allowedPlaylistId,
          policy: {
            allowedPlaylistId: configuration.spotify.allowedPlaylistId,
            enabled: configuration.spotify.playlistWritesEnabled,
          },
        });
        result = execution;
        if (options.discoveryInbox) {
          await markDiscoveryPlaylistInboxStatus(connection.db, {
            exportRunId: execution.run.id,
            status: execution.run.status === "completed" ? "completed" : "partial",
          });
        }
      } else {
        result = await previewSpotifyPlaylistExport(
          connection.db,
          userId,
          client,
          configuration.spotify.allowedPlaylistId,
          {
            ...(options.campaignId
              ? { discoveryReconciliationCampaignId: options.campaignId }
              : {}),
            orderingPolicy: "release_date_custom_order",
          },
        );
      }
    } catch (error) {
      if (options.live && options.discoveryInbox) {
        await markDiscoveryPlaylistInboxStatus(connection.db, { status: "failed" });
      }
      throw error;
    }
    process.stdout.write(
      `${JSON.stringify(sanitizedSpotifyPlaylistExportOutput(result), null, 2)}\n`,
    );
  } finally {
    await connection.client.end();
  }
}

function parsePositiveInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--max-additions must be a positive integer.");
  }
  return parsed;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

if (
  process.env.VITEST !== "true" &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Playlist export failed."}\n`);
    process.exitCode = 1;
  });
}
