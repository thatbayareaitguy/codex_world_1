import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import postgres from "postgres";
import {
  exportFullWatchlistIdentitySnapshot,
  readFullWatchlistIdentitySnapshot,
} from "./itunes-full-watchlist-identity-snapshot";
import {
  createSearchCensusManifest,
  serializeSearchCensusManifest,
  type SearchCacheRow,
} from "./itunes-search-census-planner";
import { loadLocalEnvironment } from "./local-env";

type Command = "export-identity" | "plan-search";

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((value) => value !== "--");
  const command = args[0] as Command | undefined;
  if (!command || !["export-identity", "plan-search"].includes(command)) {
    throw new Error(usage());
  }
  if (command === "export-identity") {
    const result = await exportFullWatchlistIdentitySnapshot({
      outputDirectory: requiredOption(args, "--output-directory"),
      sourceEnvironmentPath: requiredOption(args, "--source-env"),
    });
    output({
      artistCount: result.snapshot.artists.length,
      canonicalContentSha256: result.canonicalContentSha256,
      fileByteSha256: result.fileByteSha256,
      mainDatabaseTransaction: "REPEATABLE READ, READ ONLY",
      networkClientsInitialized: 0,
      outputPath: result.outputPath,
      snapshotId: result.snapshot.snapshotId,
      snapshotTimestamp: result.snapshot.snapshotTimestamp,
      sourceSchemaVersion: result.snapshot.sourceSchemaVersion,
    });
    return;
  }

  const snapshotPath = resolve(requiredOption(args, "--snapshot"));
  const outputPath = resolve(requiredOption(args, "--output"));
  const cacheEnvironment = loadLocalEnvironment({}, requiredOption(args, "--cache-env"));
  const databaseUrl = cacheEnvironment.DATABASE_URL;
  if (!databaseUrl) throw new Error("The cache environment has no DATABASE_URL.");
  assertIsolatedPilotDatabase(databaseUrl);
  const snapshotBytes = await readFile(snapshotPath, "utf8");
  const snapshot = await readFullWatchlistIdentitySnapshot(snapshotPath);
  const sql = postgres(databaseUrl, {
    connection: { application_name: "itunes-search-census-offline-planner" },
    max: 1,
  });
  try {
    const rows = await sql<
      Array<{
        request_identity: string;
        response: unknown;
        response_hash: string;
      }>
    >`
      select request_identity, response, response_hash
      from itunes_pilot_response_cache
      order by request_identity
    `;
    const cacheRows: SearchCacheRow[] = rows.map((row) => ({
      requestIdentity: row.request_identity,
      response: row.response,
      responseHash: row.response_hash,
    }));
    const manifest = createSearchCensusManifest({
      cacheRows,
      snapshot,
      snapshotFileByteSha256: sha256(snapshotBytes),
      snapshotPath,
    });
    const serialized = serializeSearchCensusManifest(manifest);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
    output({
      manifestFileByteSha256: sha256(serialized),
      networkClientsInitialized: 0,
      outputPath,
      shards: manifest.shards,
      summary: manifest.summary,
    });
  } finally {
    await sql.end();
  }
}

function assertIsolatedPilotDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || url.port !== "55433" || url.pathname !== "/radar_itunes") {
    throw new Error("Search census planning requires the isolated radar_itunes database.");
  }
}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Missing required option ${name}.\n${usage()}`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function output(value: object): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): string {
  return [
    "Usage:",
    "  pnpm itunes:shadow:plan export-identity --source-env <path> --output-directory <path>",
    "  pnpm itunes:shadow:plan plan-search --snapshot <path> --cache-env <path> --output <path>",
  ].join("\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
