import {
  claimDiscoveryScheduleAppleJob,
  createDatabase,
  finishDiscoveryScheduleAppleJob,
  getRecurringDiscoveryScheduleStatus,
  getSpotifySchedulerStatus,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { desc, gte } from "drizzle-orm";
import { appleMusicScanBatches } from "@radar/db";
import { loadLocalEnvironment } from "./local-env";
import { runAutomaticDiscoveryPlaylistExport } from "./spotify-playlist-export-runtime";

loadLocalEnvironment();

export function parseDiscoverySchedulerCommand(args: string[]): "status" | "tick" {
  const values = args.filter((value) => value !== "--");
  if (values.length !== 1 || !["status", "tick"].includes(values[0] ?? "")) {
    throw new Error("Usage: pnpm discovery:scheduler:status or pnpm discovery:scheduler:tick");
  }
  return values[0] as "status" | "tick";
}

async function main(): Promise<void> {
  const command = parseDiscoverySchedulerCommand(process.argv.slice(2));
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  const connection = createDatabase(configuration.databaseUrl);
  try {
    if (command === "status") {
      const discovery = await getRecurringDiscoveryScheduleStatus(connection.db);
      const spotify = await getSpotifySchedulerStatus(connection.db);
      process.stdout.write(
        `${JSON.stringify(
          {
            discovery,
            spotify,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    if (!configuration.discoverySchedulerEnabled) {
      throw new Error(
        "Recurring discovery execution is disabled. Set DISCOVERY_SCHEDULER_ENABLED=true only after validation.",
      );
    }

    const discoveryStatus = await getRecurringDiscoveryScheduleStatus(connection.db);
    if (
      discoveryStatus.phase === "playlist_inbox" &&
      ["ready", "partial", "failed"].includes(discoveryStatus.playlistInbox.status)
    ) {
      const playlist = await runAutomaticDiscoveryPlaylistExport(connection.db, configuration);
      process.stdout.write(`${JSON.stringify({ playlist }, null, 2)}\n`);
      return;
    }
    if (
      discoveryStatus.phase === "apple_priority" ||
      discoveryStatus.phase === "apple_catchup_priority" ||
      discoveryStatus.phase === "cooldown_wait"
    ) {
      const spotify = await runSpotifyTick(connection.db, configuration);
      process.stdout.write(`${JSON.stringify({ spotify }, null, 2)}\n`);
      return;
    }

    const appleClaim = await claimDiscoveryScheduleAppleJob(connection.db);
    if (appleClaim) {
      if (!configuration.appleMusic.configured) {
        await finishDiscoveryScheduleAppleJob(connection.db, appleClaim, {
          errorClassification: "apple_music_not_configured",
          status: "failed",
        });
        throw new Error("Apple Music is not configured for the scheduled catalog scan.");
      }
      const startedAt = new Date();
      try {
        const { runScan } = await import("./scan");
        await runScan({ dryRun: false, full: false, provider: "apple_music" });
        const batch = await connection.db.query.appleMusicScanBatches.findFirst({
          where: gte(appleMusicScanBatches.createdAt, startedAt),
          orderBy: [desc(appleMusicScanBatches.createdAt)],
        });
        if (!batch || batch.status !== "completed") {
          throw new Error("Scheduled Apple Music scan did not produce a completed batch.");
        }
        const finished = await finishDiscoveryScheduleAppleJob(connection.db, appleClaim, {
          appleMusicBatchId: batch.id,
          scanRunId: batch.scanRunId,
          status: "completed",
        });
        if (!finished) throw new Error("The scheduled Apple Music job lease was lost.");
        process.stdout.write(
          `${JSON.stringify({
            appleMusicBatchId: batch.id,
            completedArtists: batch.completedArtists,
            jobType: appleClaim.jobType,
            status: "completed",
            totalArtists: batch.totalArtists,
          })}\n`,
        );
        return;
      } catch (error) {
        await finishDiscoveryScheduleAppleJob(connection.db, appleClaim, {
          errorClassification: safeClassification(error),
          status: "failed",
        });
        throw error;
      }
    }

    const spotify = await runSpotifyTick(connection.db, configuration);
    process.stdout.write(`${JSON.stringify({ spotify }, null, 2)}\n`);
  } finally {
    await connection.client.end();
  }
}

async function runSpotifyTick(
  db: ReturnType<typeof createDatabase>["db"],
  configuration: ReturnType<typeof loadProviderConfiguration>,
) {
  const [schedulerCli, schedulerRuntime] = await Promise.all([
    import("./spotify-scheduler-cli"),
    import("./spotify-scheduler"),
  ]);
  const executor = configuration.spotify.scheduler.enabled
    ? await schedulerCli.createProductionSchedulerExecutor(db, configuration)
    : undefined;
  return schedulerRuntime.runSpotifySchedulerTick(db, {
    capabilityEnabled: configuration.spotify.scheduler.enabled,
    ...(executor ? { executor } : {}),
    limits: schedulerCli.schedulerLimitsFromConfiguration(configuration),
    mode: "production",
  });
}

function safeClassification(error: unknown): string {
  if (!(error instanceof Error)) return "scheduled_apple_scan_failed";
  return error.message.toLowerCase().includes("cooldown")
    ? "apple_music_cooldown"
    : "scheduled_apple_scan_failed";
}

if (process.env.VITEST !== "true") {
  main().then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Scheduler failed."}\n`);
      process.exit(1);
    },
  );
}
