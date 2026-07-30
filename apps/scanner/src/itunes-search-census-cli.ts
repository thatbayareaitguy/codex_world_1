import { createDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import {
  buildCensusResultArtifact,
  generateCensusResultArtifactTwice,
  verifyCensusShard,
} from "./itunes-search-census-artifact";
import { executeCensusShard, readCensusFrozenInputs } from "./itunes-search-census-executor";
import { loadLocalEnvironment } from "./local-env";

type Command = "artifact" | "execute" | "verify";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const command = args[0] as Command | undefined;
  if (!command || !["artifact", "execute", "verify"].includes(command)) {
    throw new Error(usage());
  }

  loadLocalEnvironment();
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  assertIsolatedDatabase(configuration.databaseUrl);

  const frozen = await readCensusFrozenInputs({
    expectedManifestFileByteSha256: requiredOption(args, "--expected-manifest-sha256"),
    expectedSnapshotCanonicalContentSha256: requiredOption(
      args,
      "--expected-snapshot-canonical-sha256",
    ),
    expectedSnapshotFileByteSha256: requiredOption(args, "--expected-snapshot-file-sha256"),
    manifestPath: requiredOption(args, "--manifest"),
    snapshotPath: requiredOption(args, "--snapshot"),
  });
  const expectedBranch = requiredOption(args, "--expected-branch");
  const expectedCommit = requiredFullCommit(args, "--execution-commit");
  const connection = createDatabase(configuration.databaseUrl);
  try {
    if (command === "execute") {
      const result = await executeCensusShard({
        configuration,
        db: connection.db,
        expectedBranch,
        expectedCommit,
        explicitLive: args.includes("--live"),
        frozen,
        networkBudget: requiredInteger(args, "--network-budget"),
        runtimeMs: requiredInteger(args, "--runtime-ms"),
        shardNumber: requiredShard(args),
      });
      output(result);
      if (result.status !== "completed") process.exitCode = 1;
      return;
    }

    if (command === "verify") {
      const result = await verifyCensusShard({
        db: connection.db,
        expectedBranch,
        expectedCommit,
        frozen,
        shardNumber: requiredShard(args),
      });
      output(result);
      if (!result.passed) process.exitCode = 1;
      return;
    }

    const outputPath = requiredOption(args, "--output");
    if (args.includes("--dry-run")) {
      const artifact = await buildCensusResultArtifact({
        branch: expectedBranch,
        db: connection.db,
        executionCommit: expectedCommit,
        frozen,
      });
      output(artifact);
      return;
    }
    output(
      await generateCensusResultArtifactTwice({
        branch: expectedBranch,
        db: connection.db,
        executionCommit: expectedCommit,
        frozen,
        outputPath,
      }),
    );
  } finally {
    await connection.client.end();
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

function requiredFullCommit(args: string[], name: string): string {
  const value = requiredOption(args, name);
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${name} must be a full Git SHA.`);
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

function requiredShard(args: string[]): number {
  const shard = requiredInteger(args, "--shard");
  if (shard < 1 || shard > 4) throw new Error("--shard must be between 1 and 4.");
  return shard;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return [
    "Usage: itunes:shadow:search-census <execute|verify|artifact>",
    "  --snapshot <path> --manifest <path>",
    "  --expected-snapshot-file-sha256 <hash>",
    "  --expected-snapshot-canonical-sha256 <hash>",
    "  --expected-manifest-sha256 <hash>",
    "  --expected-branch <branch> --execution-commit <full-sha>",
    "Execute: --shard <1..4> --live --network-budget <count> --runtime-ms <ms>",
    "Verify: --shard <1..4>",
    "Artifact: --output <path> [--dry-run]",
  ].join("\n");
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "iTunes search census command failed."}\n`,
  );
  process.exitCode = 1;
});
