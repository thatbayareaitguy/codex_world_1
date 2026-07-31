import { createDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import {
  generateControlArtifactTwice,
  readExperimentFrozenInputs,
} from "./itunes-adaptive-identity-experiment";
import {
  executeExperimentSegment,
  generateExperimentArtifactTwice,
  verifyExperiment,
} from "./itunes-adaptive-identity-executor";
import { loadLocalEnvironment } from "./local-env";

type Command = "artifact" | "canary" | "continue" | "controls" | "verify";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const command = args[0] as Command | undefined;
  if (!command || !["artifact", "canary", "continue", "controls", "verify"].includes(command)) {
    throw new Error(usage());
  }
  loadLocalEnvironment();
  const configuration = loadProviderConfiguration();
  const frozen = await readExperimentFrozenInputs({
    censusPath: requiredOption(args, "--census"),
    expectedCensusCanonicalSha256: requiredHash(args, "--expected-census-canonical-sha256"),
    expectedCensusFileSha256: requiredHash(args, "--expected-census-file-sha256"),
    expectedHistoricalCanonicalSha256: requiredHash(args, "--expected-historical-canonical-sha256"),
    expectedHistoricalFileSha256: requiredHash(args, "--expected-historical-file-sha256"),
    expectedManifestCanonicalSha256: requiredHash(args, "--expected-manifest-canonical-sha256"),
    expectedManifestFileSha256: requiredHash(args, "--expected-manifest-file-sha256"),
    historicalPath: requiredOption(args, "--historical-evidence"),
    manifestPath: requiredOption(args, "--manifest"),
  });
  if (command === "controls") {
    assertEveryProviderDisabled(configuration);
    output(
      await generateControlArtifactTwice({
        evaluationPath: requiredOption(args, "--pilot-evaluation"),
        manifest: frozen.manifest,
        outputPath: requiredOption(args, "--output"),
      }),
    );
    return;
  }
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  assertIsolatedDatabase(configuration.databaseUrl);
  const connection = createDatabase(configuration.databaseUrl);
  try {
    if (command === "canary" || command === "continue") {
      const result = await executeExperimentSegment({
        configuration,
        controlArtifactPath: requiredOption(args, "--controls"),
        db: connection.db,
        expectedBranch: requiredOption(args, "--expected-branch"),
        expectedCommit: requiredCommit(args, "--execution-commit"),
        explicitLive: args.includes("--live"),
        frozen,
        maximumNetworkRequests: requiredInteger(args, "--max-new-network-requests"),
        mode: command,
        runtimeMs: requiredInteger(args, "--runtime-ms"),
      });
      output(result);
      if (
        (command === "canary" && result.status !== "controlled_partial") ||
        (command === "continue" && result.status !== "completed")
      ) {
        process.exitCode = 1;
      }
      return;
    }
    assertEveryProviderDisabled(configuration);
    if (command === "verify") {
      const result = await verifyExperiment({
        db: connection.db,
        frozen,
        requireComplete: args.includes("--require-complete"),
      });
      output(result);
      if (!result.passed) process.exitCode = 1;
      return;
    }
    output(
      await generateExperimentArtifactTwice({
        branch: requiredOption(args, "--expected-branch"),
        controlArtifactPath: requiredOption(args, "--controls"),
        db: connection.db,
        executionCommit: requiredCommit(args, "--execution-commit"),
        frozen,
        outputPath: requiredOption(args, "--output"),
      }),
    );
  } finally {
    await connection.client.end();
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
    throw new Error("Offline experiment commands require every provider to be disabled.");
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

function requiredCommit(args: string[], name: string): string {
  const value = requiredOption(args, name);
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be a full Git SHA.`);
  return value;
}

function requiredHash(args: string[], name: string): string {
  const value = requiredOption(args, name);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a SHA-256.`);
  return value;
}

function requiredInteger(args: string[], name: string): number {
  const value = Number(requiredOption(args, name));
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer.`);
  return value;
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
    "Usage: itunes:adaptive-identity:run <controls|canary|continue|verify|artifact>",
    "All commands require:",
    "  --census <path> --historical-evidence <path> --manifest <path>",
    "  --expected-census-file-sha256 <hash>",
    "  --expected-census-canonical-sha256 <hash>",
    "  --expected-historical-file-sha256 <hash>",
    "  --expected-historical-canonical-sha256 <hash>",
    "  --expected-manifest-file-sha256 <hash>",
    "  --expected-manifest-canonical-sha256 <hash>",
    "Controls: --pilot-evaluation <path> --output <path>",
    "Canary/continue: --controls <path> --expected-branch <branch>",
    "  --execution-commit <sha> --live --max-new-network-requests 79 --runtime-ms <ms>",
    "Verify: [--require-complete]",
    "Artifact: --controls <path> --expected-branch <branch>",
    "  --execution-commit <sha> --output <path>",
  ].join("\n");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Adaptive iTunes experiment command failed."}\n`,
  );
  process.exitCode = 1;
});
