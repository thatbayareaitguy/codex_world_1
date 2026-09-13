import {
  acquireOperationLock,
  createDatabase,
  createOrResumeDiscoveryReconciliationCampaign,
  discoveryReconciliationCampaignReport,
  failDiscoveryReconciliationCampaign,
  finishDiscoveryReconciliationCampaign,
  discoveryReconciliationCampaigns,
  heartbeatOperationLock,
  loadCampaignIdentities,
  loadDiscoveryReconciliationCampaign,
  recordCampaignAppleBatch,
  recordCampaignPlaylistPreview,
  recordCampaignSpotifyBatch,
  reconcileCampaignProviderReleases,
  releaseOperationLock,
  releaseSelectedSpotifyCohort,
  selectNextSpotifyReconciliationCohort,
  appleMusicScanBatches,
  spotifyScanBatches,
  type OperationLockHandle,
  type RadarDatabase,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { desc, gte } from "drizzle-orm";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "./local-env";
import { runScan } from "./scan";
import { runSpotifyPlaylistExportPreview } from "./spotify-playlist-export-runtime";

loadLocalEnvironment();

interface AppleFirstSyncOptions {
  artistLimit?: number;
  campaignId?: string;
  confirmLiveProviders: boolean;
  maxCohorts?: number;
  mode: "run" | "status";
  spotifyCohortSize?: number;
  spotifyPageLimit?: number;
  spotifyRotationSize?: number;
}

const campaignLockTtlMs = 4 * 60 * 60_000;
const campaignHeartbeatIntervalMs = 30_000;

export function parseAppleFirstSyncOptions(args: string[]): AppleFirstSyncOptions {
  const values = args.filter((value) => value !== "--");
  const options: AppleFirstSyncOptions = { confirmLiveProviders: false, mode: "run" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "run" || value === "status") {
      options.mode = value;
      continue;
    }
    if (value === "--confirm-live-providers") {
      options.confirmLiveProviders = true;
      continue;
    }
    if (value === "--campaign") {
      options.campaignId = requiredValue(values[++index], "--campaign");
      continue;
    }
    if (value === "--artist-limit") {
      options.artistLimit = positiveInteger(values[++index], "--artist-limit");
      continue;
    }
    if (value === "--max-cohorts") {
      options.maxCohorts = positiveInteger(values[++index], "--max-cohorts");
      continue;
    }
    if (value === "--spotify-cohort-size") {
      options.spotifyCohortSize = positiveInteger(values[++index], "--spotify-cohort-size");
      continue;
    }
    if (value === "--spotify-page-limit") {
      options.spotifyPageLimit = boundedInteger(values[++index], "--spotify-page-limit", 1, 50);
      continue;
    }
    if (value === "--spotify-rotation-size") {
      options.spotifyRotationSize = boundedInteger(
        values[++index],
        "--spotify-rotation-size",
        0,
        10_000,
      );
      continue;
    }
    throw new Error(`Unknown Apple-first synchronization option: ${value}`);
  }
  return options;
}

export async function runAppleFirstSync(options: AppleFirstSyncOptions) {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  const connection = createDatabase(configuration.databaseUrl);
  try {
    if (options.mode === "status") {
      const campaignId =
        options.campaignId ??
        (
          await connection.db.query.discoveryReconciliationCampaigns.findFirst({
            orderBy: [desc(discoveryReconciliationCampaigns.createdAt)],
          })
        )?.id;
      if (!campaignId) return { status: "no_campaign" };
      return await discoveryReconciliationCampaignReport(connection.db, campaignId);
    }
    if (!options.confirmLiveProviders) {
      throw new Error(
        "Apple-first synchronization requires --confirm-live-providers. Playlist export remains dry-run only.",
      );
    }
    assertProviderConfiguration(configuration);
    const cohortSize = options.spotifyCohortSize ?? configuration.spotify.artistsPerBatch;
    const rotationSize = options.spotifyRotationSize ?? Math.min(3, cohortSize);
    const pageLimit = options.spotifyPageLimit ?? configuration.spotify.dailyMaxPagesPerArtist;
    const campaignResult = options.campaignId
      ? {
          campaignId: options.campaignId,
          created: false,
          identities: await loadCampaignIdentities(connection.db, options.campaignId),
        }
      : await createOrResumeDiscoveryReconciliationCampaign(
          connection.db,
          {
            spotifyCohortSize: cohortSize,
            spotifyPageLimit: pageLimit,
            spotifyRotationSize: rotationSize,
            windowDays: configuration.initialBackfillDays,
          },
          new Date(),
          options.artistLimit ? { artistLimit: options.artistLimit } : {},
        );
    const handle = await acquireOperationLock(connection.db, {
      lockKey: "apple-first-sync:global",
      metadata: { campaignId: campaignResult.campaignId },
      operationType: "apple_first_discovery_reconciliation",
      ttlMs: campaignLockTtlMs,
    });
    const heartbeat = startCampaignHeartbeat(connection.db, handle, campaignResult.campaignId);
    try {
      let campaign = await loadDiscoveryReconciliationCampaign(
        connection.db,
        campaignResult.campaignId,
      );
      if (campaign.stage === "completed") {
        await heartbeat.stop({ stage: "completed" });
        return {
          campaign: await discoveryReconciliationCampaignReport(connection.db, campaign.id),
          cohort: [],
          cohorts: [],
          playlistPreview: campaign.playlistPreview,
        };
      }
      if (campaign.stage === "apple_discovery") {
        await heartbeat.assert({ stage: "apple_discovery" });
        const startedAt = new Date();
        let appleError: unknown;
        try {
          await runScan({
            artistIds: campaignResult.identities.map((identity) => identity.artistId),
            dryRun: false,
            full: false,
            providerArtistIdentities: campaignResult.identities.map((identity) => ({
              artistId: identity.artistId,
              providerArtistId: identity.appleArtistId,
            })),
            provider: "apple_music",
          });
        } catch (error) {
          appleError = error;
        }
        const appleBatch = await connection.db.query.appleMusicScanBatches.findFirst({
          where: gte(appleMusicScanBatches.updatedAt, startedAt),
          orderBy: [desc(appleMusicScanBatches.updatedAt)],
        });
        if (!appleBatch) {
          throw asError(appleError, "Apple Music scan completed without a persisted batch.");
        }
        await recordCampaignAppleBatch(connection.db, campaign.id, appleBatch.id);
        campaign = await loadDiscoveryReconciliationCampaign(connection.db, campaign.id);
        await heartbeat.assert({ appleBatchId: appleBatch.id, stage: campaign.stage });
        if (appleError) throw asError(appleError, "Apple Music scan failed.");
        if (campaign.stage === "apple_discovery") {
          await heartbeat.stop({ stage: "apple_discovery_paused" });
          return {
            campaign: await discoveryReconciliationCampaignReport(connection.db, campaign.id),
            cohort: [],
            cohorts: [],
            playlistPreview: null,
          };
        }
      }

      const processedCohorts: Array<Array<{ artistId: string; name: string }>> = [];
      for (let cohortIndex = 0; cohortIndex < (options.maxCohorts ?? 1); cohortIndex += 1) {
        await heartbeat.assert({ cohortIndex, stage: "spotify_reconciliation" });
        const cohort = await selectNextSpotifyReconciliationCohort(connection.db, campaign.id);
        if (cohort.length === 0) break;
        processedCohorts.push(
          cohort.map((identity) => ({ artistId: identity.artistId, name: identity.name })),
        );
        const startedAt = new Date();
        try {
          await runScan({
            artistIds: cohort.map((identity) => identity.artistId),
            dryRun: false,
            full: false,
            providerArtistIdentities: cohort.map((identity) => ({
              artistId: identity.artistId,
              providerArtistId: identity.spotifyArtistId,
            })),
            provider: "spotify",
            spotifyMaxPages: campaign.spotifyPageLimit,
            spotifyMode: "daily",
            spotifyRequestCampaignId: campaign.id,
          });
        } catch (error) {
          const batch = await connection.db.query.spotifyScanBatches.findFirst({
            where: gte(spotifyScanBatches.updatedAt, startedAt),
            orderBy: [desc(spotifyScanBatches.updatedAt)],
          });
          if (batch) {
            const recorded = await recordCampaignSpotifyBatch(connection.db, campaign.id, batch.id);
            await reconcileCampaignProviderReleases(
              connection.db,
              campaign.id,
              recorded.reconciliableArtistIds,
            );
          } else {
            await releaseSelectedSpotifyCohort(
              connection.db,
              campaign.id,
              safeClassification(error),
            );
          }
          throw error;
        }
        const spotifyBatch = await connection.db.query.spotifyScanBatches.findFirst({
          where: gte(spotifyScanBatches.updatedAt, startedAt),
          orderBy: [desc(spotifyScanBatches.updatedAt)],
        });
        if (!spotifyBatch) throw new Error("Spotify scan completed without a persisted batch.");
        const recorded = await recordCampaignSpotifyBatch(
          connection.db,
          campaign.id,
          spotifyBatch.id,
        );
        await reconcileCampaignProviderReleases(
          connection.db,
          campaign.id,
          recorded.reconciliableArtistIds,
        );
        await heartbeat.assert({
          cohortIndex,
          spotifyBatchId: spotifyBatch.id,
          stage: "internal_reconciliation",
        });
      }

      await finishDiscoveryReconciliationCampaign(connection.db, campaign.id);
      campaign = await loadDiscoveryReconciliationCampaign(connection.db, campaign.id);
      if (campaign.stage !== "playlist_preview") {
        await heartbeat.stop({ stage: "spotify_reconciliation_paused" });
        return {
          campaign: await discoveryReconciliationCampaignReport(connection.db, campaign.id),
          cohort: processedCohorts[0] ?? [],
          cohorts: processedCohorts,
          playlistPreview: null,
        };
      }

      await heartbeat.assert({ stage: campaign.stage });
      const playlist = await runSpotifyPlaylistExportPreview(
        connection.db,
        configuration,
        campaign.id,
      );
      await recordCampaignPlaylistPreview(connection.db, campaign.id, playlist.sanitized);
      await heartbeat.stop({ stage: "finished" });
      return {
        campaign: await discoveryReconciliationCampaignReport(connection.db, campaign.id),
        cohort: processedCohorts[0] ?? [],
        cohorts: processedCohorts,
        playlistPreview: playlist.sanitized,
      };
    } catch (error) {
      await failDiscoveryReconciliationCampaign(
        connection.db,
        campaignResult.campaignId,
        safeClassification(error),
      );
      throw error;
    } finally {
      await heartbeat.stopQuietly();
      await releaseOperationLock(connection.db, handle);
    }
  } finally {
    await connection.client.end();
  }
}

interface CampaignHeartbeat {
  assert(metadata: Record<string, unknown>): Promise<void>;
  stop(metadata: Record<string, unknown>): Promise<void>;
  stopQuietly(): Promise<void>;
}

function startCampaignHeartbeat(
  db: RadarDatabase,
  handle: OperationLockHandle,
  campaignId: string,
): CampaignHeartbeat {
  let failure: Error | null = null;
  let stopped = false;
  let task = Promise.resolve();
  const enqueue = (metadata: Record<string, unknown>) => {
    task = task.then(async () => {
      if (failure || stopped) return;
      try {
        const active = await heartbeatOperationLock(
          db,
          handle,
          { campaignId, ...metadata },
          campaignLockTtlMs,
        );
        if (!active) failure = new Error("The Apple-first campaign operation lock was lost.");
      } catch (error) {
        failure = asError(error, "The Apple-first campaign heartbeat failed.");
      }
    });
    return task;
  };
  const timer = setInterval(() => {
    void enqueue({ stage: "running" });
  }, campaignHeartbeatIntervalMs);
  timer.unref();

  const assertHealthy = async (metadata: Record<string, unknown>) => {
    await enqueue(metadata);
    if (failure) throw failure;
  };
  return {
    assert: assertHealthy,
    stop: async (metadata) => {
      clearInterval(timer);
      await assertHealthy(metadata);
      stopped = true;
    },
    stopQuietly: async () => {
      clearInterval(timer);
      await task;
      stopped = true;
    },
  };
}

function assertProviderConfiguration(
  configuration: ReturnType<typeof loadProviderConfiguration>,
): void {
  if (!configuration.appleMusic.configured) {
    throw new Error("Apple Music must be enabled and configured for Apple-first synchronization.");
  }
  if (!configuration.spotify.configured) {
    throw new Error("Spotify must be enabled and configured for reconciliation.");
  }
  if (!configuration.spotify.allowedPlaylistId) {
    throw new Error("SPOTIFY_ALLOWED_PLAYLIST_ID is required for the dry-run export preview.");
  }
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function positiveInteger(value: string | undefined, option: string): number {
  return boundedInteger(value, option, 1, 10_000);
}

function boundedInteger(
  value: string | undefined,
  option: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${option} requires an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function safeClassification(error: unknown): string {
  return error instanceof Error
    ? error.name
        .replace(/[^a-z0-9_]+/gi, "_")
        .toLowerCase()
        .slice(0, 100)
    : "unknown_failure";
}

function asError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

async function main(): Promise<void> {
  const result = await runAppleFirstSync(parseAppleFirstSyncOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.env.VITEST !== "true" &&
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Apple-first sync failed."}\n`,
    );
    process.exitCode = 1;
  });
}
