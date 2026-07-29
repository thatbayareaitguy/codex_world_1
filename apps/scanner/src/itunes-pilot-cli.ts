import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDatabase, itunesPilotRequestEvents } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { count, eq } from "drizzle-orm";
import { loadLocalEnvironment } from "./local-env";
import {
  createItunesPilotPlan,
  importItunesSnapshot,
  latestItunesRun,
  latestItunesSnapshot,
  pilotArtists,
  pilotEvaluationRows,
} from "./itunes-pilot-repository";
import { buildItunesEvaluationMarkdown, runLiveItunesPilot } from "./itunes-pilot-runner";
import { exportItunesPilotSnapshot, readItunesPilotSnapshot } from "./itunes-pilot-snapshot";

type Command = "export-snapshot" | "import-snapshot" | "plan" | "live" | "evaluate" | "status";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const command = args[0] as Command | undefined;
  if (
    !command ||
    !["export-snapshot", "import-snapshot", "plan", "live", "evaluate", "status"].includes(command)
  ) {
    throw new Error(usage());
  }
  if (command === "export-snapshot") {
    const sourceEnvironmentPath = requiredOption(args, "--source-env");
    const outputPath = requiredOption(args, "--output");
    const mainRepository = requiredOption(args, "--main-repository");
    const mainRepositoryCommit = git(mainRepository, ["rev-parse", "HEAD"]);
    const snapshot = await exportItunesPilotSnapshot({
      mainRepositoryCommit,
      outputPath,
      sourceEnvironmentPath,
    });
    output({
      artistCount: snapshot.artists.length,
      cohort: {
        identityStress: snapshot.artists.filter(
          (artist) => artist.cohortReason === "identity_stress",
        ).length,
        negative: snapshot.artists.filter((artist) => artist.cohortReason === "negative").length,
        positive: snapshot.artists.filter((artist) => artist.cohortReason === "positive").length,
      },
      groundTruthReleaseCount: snapshot.groundTruthReleases.length,
      outputPath: resolve(outputPath),
      snapshotHash: snapshot.snapshotHash,
      snapshotTimestamp: snapshot.snapshotTimestamp,
      windowEnd: snapshot.windowEnd,
      windowStart: snapshot.windowStart,
    });
    return;
  }

  loadLocalEnvironment();
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  assertPilotDatabase(configuration.databaseUrl);
  const connection = createDatabase(configuration.databaseUrl);
  try {
    if (command === "import-snapshot") {
      const snapshot = await readItunesPilotSnapshot(requiredOption(args, "--path"));
      const snapshotId = await importItunesSnapshot(connection.db, snapshot);
      output({ snapshotId, snapshotHash: snapshot.snapshotHash });
      return;
    }
    if (command === "plan") {
      assertNonItunesProvidersDisabled(configuration);
      if (configuration.itunes.enabled) {
        throw new Error("Plan mode requires ITUNES_DISCOVERY_ENABLED=false.");
      }
      const snapshot = await latestItunesSnapshot(connection.db);
      if (!snapshot) throw new Error("Import the sanitized snapshot before planning.");
      const artists = await pilotArtists(connection.db, snapshot.id);
      if (artists.length !== 50) throw new Error("Plan mode requires exactly 50 artists.");
      const [{ value: requestEvents = 0 } = {}] = await connection.db
        .select({ value: count() })
        .from(itunesPilotRequestEvents);
      if (requestEvents !== 0) {
        throw new Error("Plan mode requires zero existing iTunes request events.");
      }
      const currentCommit = git(process.cwd(), ["rev-parse", "HEAD"]);
      const status = git(process.cwd(), ["status", "--porcelain"]);
      if (status) throw new Error("Plan mode requires a clean implementation checkpoint.");
      const existing = await latestItunesRun(connection.db);
      if (existing) throw new Error("A pilot run already exists.");
      const run = await createItunesPilotPlan(connection.db, {
        implementationCommit: currentCommit,
        maximumRuntimeMs: 30 * 60_000,
        minRequestIntervalMs: configuration.itunes.minRequestIntervalMs,
        requestBudget: configuration.itunes.maxRequestsPerRun,
        snapshotId: snapshot.id,
      });
      output({
        artistCount: artists.length,
        groundTruthWindow: [snapshot.windowStart, snapshot.windowEnd],
        implementationCommit: currentCommit,
        mainDatabaseConnection: false,
        requestBudget: run.requestBudget,
        requestCount: run.requestCount,
        runId: run.id,
        snapshotHash: snapshot.snapshotHash,
        status: run.status,
      });
      return;
    }
    if (command === "live") {
      const run = await latestItunesRun(connection.db);
      if (!run || run.status !== "planned") throw new Error("A planned pilot run is required.");
      const result = await runLiveItunesPilot({
        configuration,
        db: connection.db,
        runId: run.id,
      });
      output({ runId: run.id, ...result });
      return;
    }
    if (command === "evaluate") {
      const run = await latestItunesRun(connection.db);
      if (!run || !["completed", "controlled_partial"].includes(run.status)) {
        throw new Error("A completed or controlled-partial pilot run is required.");
      }
      const rows = await pilotEvaluationRows(connection.db, run.id);
      const destination = resolve(
        optionalOption(args, "--output") ?? "docs/itunes-pilot-evaluation.md",
      );
      await writeFile(destination, buildItunesEvaluationMarkdown(rows), "utf8");
      output({ evaluationPath: destination, runId: run.id, status: run.status });
      return;
    }
    const run = await latestItunesRun(connection.db);
    const snapshot = await latestItunesSnapshot(connection.db);
    const requestSummary = run
      ? await connection.db
          .select({
            cacheHits: count(itunesPilotRequestEvents.id),
          })
          .from(itunesPilotRequestEvents)
          .where(eq(itunesPilotRequestEvents.runId, run.id))
      : [];
    output({
      run,
      snapshot,
      telemetryRows: requestSummary[0]?.cacheHits ?? 0,
    });
  } finally {
    await connection.client.end();
  }
}

function assertPilotDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (
    url.protocol !== "postgres:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55433" ||
    url.pathname !== "/radar_itunes"
  ) {
    throw new Error("Refusing to use a database other than the isolated radar_itunes database.");
  }
}

function assertNonItunesProvidersDisabled(
  configuration: ReturnType<typeof loadProviderConfiguration>,
): void {
  if (
    configuration.spotify.enabled ||
    configuration.spotify.playlistWritesEnabled ||
    configuration.musicbrainz.enabled ||
    configuration.reddit.enabled ||
    configuration.soundcloudManualLinksEnabled
  ) {
    throw new Error("Every non-iTunes provider must be disabled in pilot mode.");
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function requiredOption(args: string[], name: string): string {
  const value = optionalOption(args, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return "Usage: itunes:pilot <export-snapshot|import-snapshot|plan|live|evaluate|status>";
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "iTunes pilot failed."}\n`);
  process.exitCode = 1;
});
