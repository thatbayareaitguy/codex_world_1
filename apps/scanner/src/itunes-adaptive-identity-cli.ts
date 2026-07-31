import { createDatabase, itunesPilotResponseCache } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import {
  buildAdaptivePlan,
  readAdaptivePlanningInputs,
  writeAdaptiveArtifacts,
} from "./itunes-adaptive-identity-planner";
import { exportHistoricalIdentityEvidence } from "./itunes-historical-identity-evidence";
import { loadLocalEnvironment } from "./local-env";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const command = args[0];
  if (!["export-history", "plan"].includes(command ?? "")) throw new Error(usage());
  loadLocalEnvironment();
  const configuration = loadProviderConfiguration();
  assertOfflineRuntime(configuration);
  if (command === "plan") {
    if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
    assertIsolatedDatabase(configuration.databaseUrl);
    const connection = createDatabase(configuration.databaseUrl);
    try {
      const inputs = await readAdaptivePlanningInputs({
        censusPath: requiredOption(args, "--census"),
        historicalEvidencePath: requiredOption(args, "--historical-evidence"),
        pilotEvaluationPath: requiredOption(args, "--pilot-evaluation"),
        pilotSnapshotPath: requiredOption(args, "--pilot-snapshot"),
      });
      const cache = await connection.db
        .select({ requestIdentity: itunesPilotResponseCache.requestIdentity })
        .from(itunesPilotResponseCache);
      const plan = buildAdaptivePlan({
        ...inputs,
        legacyCacheIdentities: cache.map((row) => row.requestIdentity),
      });
      const artifacts = await writeAdaptiveArtifacts({
        inventoryPath: requiredOption(args, "--inventory-output"),
        manifestPath: requiredOption(args, "--manifest-output"),
        plan,
      });
      output({
        albumFirst: plan.albumFirst,
        ambiguousEvidence: plan.ambiguousEvidence,
        artifacts,
        baseline: plan.baseline,
        cohort: plan.cohort,
        evidence: plan.evidence,
        hybrid: plan.hybrid,
        recommendation: plan.recommendation,
      });
    } finally {
      await connection.client.end();
    }
    return;
  }
  const result = await exportHistoricalIdentityEvidence({
    identitySnapshotPath: requiredOption(args, "--identity-snapshot"),
    outputPath: requiredOption(args, "--output"),
    sourceEnvironmentPath: requiredOption(args, "--source-env"),
    sourceRepositoryPath: requiredOption(args, "--source-repository"),
  });
  output({
    artistCount: result.snapshot.summary.artistCount,
    artistsWithUsableHistoricalEvidence:
      result.snapshot.summary.artistsWithUsableHistoricalEvidence,
    artistsWithoutUsableHistoricalEvidence:
      result.snapshot.summary.artistsWithoutUsableHistoricalEvidence,
    canonicalContentSha256: result.snapshot.canonicalContentSha256,
    evidenceCutoff: result.snapshot.evidenceCutoff,
    fileByteSha256: result.fileByteSha256,
    generationPasses: result.generationPasses,
    outputPath: result.outputPath,
    releaseCount: result.snapshot.summary.releaseCount,
    snapshotId: result.snapshot.snapshotId,
    snapshotTimestamp: result.snapshot.snapshotTimestamp,
    source: result.snapshot.source,
    trackCount: result.snapshot.summary.trackCount,
    usableReleaseCount: result.snapshot.summary.usableReleaseCount,
    usableTrackCount: result.snapshot.summary.usableTrackCount,
  });
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

function assertOfflineRuntime(configuration: ReturnType<typeof loadProviderConfiguration>): void {
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
    throw new Error("Adaptive identity planning requires every provider to be disabled.");
  }
}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return [
    "Usage: itunes:shadow:adaptive <export-history|plan>",
    "Export history:",
    "  --identity-snapshot <path>",
    "  --source-env <path>",
    "  --source-repository <path>",
    "  --output <path>",
    "Plan:",
    "  --census <path> --historical-evidence <path>",
    "  --pilot-snapshot <path> --pilot-evaluation <path>",
    "  --inventory-output <path> --manifest-output <path>",
  ].join("\n");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Adaptive iTunes identity planning failed."}\n`,
  );
  process.exitCode = 1;
});
