import { execFileSync } from "node:child_process";
import { createDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import {
  buildIdentitySeedArtifact,
  createIdentityExportPlan,
  assertIdentityExportCanExecute,
  identityExportExpectedBranch,
  loadIdentityExportDatabaseEvidence,
  readIdentityExportInputs,
  writeIdentitySeedExport,
} from "./itunes-identity-export";
import { loadLocalEnvironment } from "./local-env";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const planMode = args.includes("--plan");
  const executeMode = args.includes("--execute");
  if (planMode === executeMode) throw new Error(usage());

  loadLocalEnvironment();
  const configuration = loadProviderConfiguration();
  assertEveryProviderDisabled(configuration);
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  assertIsolatedDatabase(configuration.databaseUrl);
  if (configuration.itunes.minRequestIntervalMs < 3_200) {
    throw new Error("The iTunes request-start interval must remain at least 3,200 ms.");
  }

  const branch = git("branch", "--show-current");
  const sourceCommit = requiredOption(args, "--source-commit");
  if (branch !== identityExportExpectedBranch || git("rev-parse", "HEAD") !== sourceCommit) {
    throw new Error(
      "The identity export branch or source commit differs from the current checkout.",
    );
  }
  if (executeMode) assertCleanSynchronizedSource();

  const frozen = await readIdentityExportInputs({
    censusPath: requiredOption(args, "--census"),
    inventoryPath: requiredOption(args, "--inventory"),
  });
  const artifactPath = requiredOption(args, "--artifact");
  const reportPath = requiredOption(args, "--report");
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const before = await loadIdentityExportDatabaseEvidence(connection.db);
    const plan = createIdentityExportPlan({
      artifactPath,
      branch,
      census: frozen.census,
      databaseEvidence: before,
      inventory: frozen.inventory,
      reportPath,
      sourceCommit,
    });
    if (planMode) {
      output(plan);
      return;
    }
    assertIdentityExportCanExecute(plan);
    const artifact = buildIdentitySeedArtifact({
      branch,
      census: frozen.census,
      createdAt: requiredOption(args, "--created-at"),
      databaseEvidence: before,
      inventory: frozen.inventory,
      sourceCommit,
    });
    const written = await writeIdentitySeedExport({ artifact, artifactPath, reportPath });
    const after = await loadIdentityExportDatabaseEvidence(connection.db);
    if (
      after.historicalNetworkRequestCount !== before.historicalNetworkRequestCount ||
      after.activeRun !== before.activeRun ||
      after.activeLease !== before.activeLease ||
      after.providerCooldownActive !== before.providerCooldownActive
    ) {
      throw new Error("The isolated iTunes runtime state changed during the zero-network export.");
    }
    output({
      ...written,
      classificationCounts: artifact.classificationCounts,
      itunesNetworkRequests: 0,
      manualReviewCount:
        artifact.classificationCounts.ambiguous_seed +
        artifact.classificationCounts.manual_review_required,
      runtimeStateUnchanged: true,
      watchlistCount: artifact.canonicalWatchlistCount,
      watchlistHash: artifact.inputWatchlistHash,
    });
  } finally {
    await connection.client.end();
  }
}

function assertCleanSynchronizedSource(): void {
  if (git("status", "--porcelain=v1")) {
    throw new Error("Live export requires a clean source worktree.");
  }
  const [ahead, behind] = git("rev-list", "--left-right", "--count", "HEAD...@{upstream}")
    .split(/\s+/)
    .map(Number);
  if (ahead !== 0 || behind !== 0) {
    throw new Error("Live export requires the source commit to be synchronized with its upstream.");
  }
}

function assertEveryProviderDisabled(
  configuration: ReturnType<typeof loadProviderConfiguration>,
): void {
  if (
    configuration.itunes.enabled ||
    configuration.spotify.enabled ||
    configuration.spotify.configured ||
    configuration.spotify.playlistWritesEnabled ||
    configuration.musicbrainz.enabled ||
    configuration.reddit.enabled ||
    configuration.reddit.configured ||
    configuration.soundcloudManualLinksEnabled
  ) {
    throw new Error("Identity export requires every provider to be disabled.");
  }
}

function assertIsolatedDatabase(databaseUrl: string): void {
  const database = new URL(databaseUrl);
  if (
    database.protocol !== "postgres:" ||
    database.hostname !== "127.0.0.1" ||
    database.port !== "55433" ||
    database.pathname !== "/radar_itunes"
  ) {
    throw new Error("Refusing to use a database other than isolated radar_itunes.");
  }
}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return [
    "Usage: itunes:identity-export <--plan|--execute>",
    "  --census <frozen-census.json> --inventory <identity-evidence.csv>",
    "  --artifact <output.json> --report <output.md>",
    "  --source-commit <full-sha>",
    "Execute only: --created-at <canonical-ISO-timestamp>",
  ].join("\n");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "iTunes identity export failed."}\n`,
  );
  process.exitCode = 1;
});
