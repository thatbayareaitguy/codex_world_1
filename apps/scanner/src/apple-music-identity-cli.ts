import { join, resolve } from "node:path";
import {
  acquireOperationLock,
  appleMusicScanBatches,
  createAppleMusicRequestPersistence,
  createDatabase,
  createMusicBrainzRequestGate,
  getAppleMusicOperationalStatus,
  listAppleIdentityResolutionBatch,
  releaseOperationLock,
  scanRuns,
  verifyAppleIdentityResolutionState,
  type RadarDatabase,
} from "@radar/db";
import {
  AppleDeveloperTokenManager,
  AppleMusicClient,
  loadProviderConfiguration,
  MusicBrainzClient,
  type AppleMusicArtist,
  type ProviderConfiguration,
} from "@radar/providers";
import { eq } from "drizzle-orm";
import {
  applyAppleIdentityPreview,
  previewAppleIdentityCsv,
  readAppleIdentityCsv,
  writeAppleIdentityBatch,
  type AppleIdentityVerifier,
} from "./apple-music-identity-workflow";
import {
  inventoryBoundedMusicBrainzEvidence,
  runBoundedMusicBrainzAppleResolution,
} from "./apple-music-musicbrainz-resolution";
import { loadLocalEnvironment } from "./local-env";
import { exportDirectory } from "./paths";

type Command = "apply" | "export" | "musicbrainz-pass" | "preview" | "verify";

interface Options {
  command: Command;
  confirmLive: boolean;
  file?: string;
  limit: number;
  maxCandidates: number;
  output?: string;
}

loadLocalEnvironment();

try {
  const options = parseOptions(process.argv.slice(2));
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const lock = await acquireOperationLock(connection.db, {
      lockKey: "apple-music-identity-resolution",
      metadata: { command: options.command },
      operationType: "apple_music_identity_resolution",
    });
    try {
      const result = await execute(options, connection.db, configuration);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
      await releaseOperationLock(connection.db, lock);
    }
  } finally {
    await connection.client.end();
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Apple Music identity command failed."}\n`,
  );
  process.exitCode = 1;
}

async function execute(
  options: Options,
  db: RadarDatabase,
  configuration: ProviderConfiguration,
): Promise<unknown> {
  if (options.command === "export") {
    const rows = await listAppleIdentityResolutionBatch(db, options.limit);
    const path =
      options.output ??
      join(
        exportDirectory(),
        `apple-music-identities-${new Date().toISOString().slice(0, 10)}.csv`,
      );
    await writeAppleIdentityBatch(path, rows);
    return { batchSize: rows.length, path };
  }
  if (options.command === "verify") {
    return verifyAppleIdentityResolutionState(db);
  }
  if (!options.confirmLive) {
    throw new Error("Live Apple Music verification requires --confirm-live.");
  }
  const fileRows = options.file ? await readAppleIdentityCsv(options.file) : [];
  if (options.command === "preview" || options.command === "apply") {
    return withAppleClient(
      db,
      configuration,
      options.command === "preview" ? "apple_identity_csv_preview" : "apple_identity_csv_apply",
      fileRows.length,
      async (client) => {
        const verifier = createVerifier(client);
        const preview = await previewAppleIdentityCsv(db, fileRows, verifier);
        return options.command === "apply"
          ? {
              preview: summarizePreview(preview),
              result: await applyAppleIdentityPreview(db, preview),
            }
          : summarizePreview(preview);
      },
    );
  }
  if (!configuration.musicbrainz.configured || !configuration.musicbrainz.contactEmail) {
    throw new Error("MusicBrainz contact email is required for the bounded evidence pass.");
  }
  const rows = await listAppleIdentityResolutionBatch(db, 100);
  const musicBrainzClient = new MusicBrainzClient({
    contactEmail: configuration.musicbrainz.contactEmail,
    requestGate: createMusicBrainzRequestGate(db),
  });
  if (!hasAppleCredentials(configuration)) {
    return inventoryBoundedMusicBrainzEvidence({
      limit: options.limit,
      musicBrainzClient,
      rows,
    });
  }
  return withAppleClient(
    db,
    configuration,
    "apple_identity_musicbrainz_pass",
    options.limit,
    async (appleClient) => {
      return runBoundedMusicBrainzAppleResolution({
        appleClient,
        db,
        limit: options.limit,
        maxCandidates: options.maxCandidates,
        musicBrainzClient,
        rows,
      });
    },
  );
}

function hasAppleCredentials(configuration: ProviderConfiguration): boolean {
  return Boolean(
    configuration.appleMusic.teamId &&
    configuration.appleMusic.keyId &&
    configuration.appleMusic.privateKeyPath,
  );
}

async function withAppleClient<T>(
  db: RadarDatabase,
  configuration: ProviderConfiguration,
  triggerType: string,
  totalArtists: number,
  operation: (client: AppleMusicClient) => Promise<T>,
): Promise<T> {
  const apple = configuration.appleMusic;
  if (!apple.teamId || !apple.keyId || !apple.privateKeyPath) {
    throw new Error("Apple Music developer-token credentials are not configured.");
  }
  const operational = await getAppleMusicOperationalStatus(db);
  if (operational.cooldownActive) throw new Error("Apple Music cooldown is active.");
  if (operational.leaseActive) throw new Error("Apple Music request lease is active.");
  const now = new Date();
  const [run] = await db
    .insert(scanRuns)
    .values({
      detailedExpiresAt: new Date(
        now.getTime() + configuration.scanDetailRetentionDays * 86_400_000,
      ),
      metadata: {
        compliantEvidenceSources: ["musicbrainz", "user_supplied_apple_id"],
        maxRequestsPerRun: Math.min(apple.maxRequestsPerRun, 150),
        minRequestIntervalMs: apple.minRequestIntervalMs,
      },
      provider: "apple_music",
      providersRequested: ["apple_music"],
      startedAt: now,
      triggerType,
    })
    .returning({ id: scanRuns.id });
  if (!run) throw new Error("Apple Music identity scan run could not be created.");
  const [batch] = await db
    .insert(appleMusicScanBatches)
    .values({
      scanRunId: run.id,
      startedAt: now,
      status: "running",
      totalArtists,
      windowDays: 30,
    })
    .returning({ id: appleMusicScanBatches.id });
  if (!batch) throw new Error("Apple Music identity request batch could not be created.");
  const tokenManager = new AppleDeveloperTokenManager({
    keyId: apple.keyId,
    privateKeyPath: apple.privateKeyPath,
    teamId: apple.teamId,
    tokenLifetimeSeconds: apple.tokenLifetimeSeconds,
  });
  const client = new AppleMusicClient({
    enabled: true,
    maxRequestsPerRun: Math.min(apple.maxRequestsPerRun, 150),
    maximumRuntimeMs: apple.maxRuntimeMs,
    minRequestIntervalMs: apple.minRequestIntervalMs,
    persistence: createAppleMusicRequestPersistence(db, { batchId: batch.id, scanRunId: run.id }),
    requestTimeoutMs: apple.requestTimeoutMs,
    runId: run.id,
    storefront: apple.storefront,
    tokenProvider: tokenManager,
  });
  try {
    const result = await operation(client);
    const finishedAt = new Date();
    await db
      .update(appleMusicScanBatches)
      .set({
        completedArtists: totalArtists,
        finishedAt,
        status: "completed",
        updatedAt: finishedAt,
      })
      .where(eq(appleMusicScanBatches.id, batch.id));
    await db
      .update(scanRuns)
      .set({
        artistsProcessedCount: totalArtists,
        completedAt: finishedAt,
        providersCompleted: ["apple_music"],
        status: "completed",
      })
      .where(eq(scanRuns.id, run.id));
    return result;
  } catch (error) {
    const finishedAt = new Date();
    await db
      .update(appleMusicScanBatches)
      .set({ failedArtists: totalArtists, finishedAt, status: "failed", updatedAt: finishedAt })
      .where(eq(appleMusicScanBatches.id, batch.id));
    await db
      .update(scanRuns)
      .set({
        completedAt: finishedAt,
        errors: [{ message: safeError(error) }],
        providersFailed: ["apple_music"],
        status: "failed",
      })
      .where(eq(scanRuns.id, run.id));
    throw error;
  }
}

function createVerifier(client: AppleMusicClient): AppleIdentityVerifier {
  return {
    verify: async (ids) => {
      const artists: AppleMusicArtist[] = [];
      const missingIds: string[] = [];
      for (let offset = 0; offset < ids.length; offset += 25) {
        const result = await client.getArtists(ids.slice(offset, offset + 25));
        artists.push(...result.items);
        missingIds.push(...result.missingIds);
      }
      return { artists, missingIds };
    },
  };
}

function summarizePreview(preview: Awaited<ReturnType<typeof previewAppleIdentityCsv>>) {
  return {
    duplicateAssignments: preview.duplicateAssignments,
    existingConflicts: preview.existingConflicts,
    invalidInputs: preview.invalidInputs,
    nameDisagreements: preview.nameDisagreements,
    nonMappingOutcomes: preview.nonMappingOutcomes,
    unchanged: preview.unchanged,
    validMappings: preview.validMappings,
    verifiedMappings: preview.decisions
      .filter((decision) => decision.decision === "confirm")
      .map((decision) => ({
        appleArtist: decision.appleArtists[0],
        artistId: decision.artistId,
      })),
  };
}

function parseOptions(args: string[]): Options {
  const command = args[0] as Command | undefined;
  if (!command || !["apply", "export", "musicbrainz-pass", "preview", "verify"].includes(command)) {
    throw new Error(
      "Usage: apple-music:identities <export|preview|apply|verify|musicbrainz-pass> [options]",
    );
  }
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const limit = parseBoundedInteger(value("--limit") ?? "100", 1, 100, "limit");
  const maxCandidates = parseBoundedInteger(
    value("--max-candidates") ?? "3",
    1,
    5,
    "max candidates",
  );
  const file = value("--file");
  if ((command === "preview" || command === "apply") && !file) {
    throw new Error(`${command} requires --file <path>.`);
  }
  return {
    command,
    confirmLive: args.includes("--confirm-live"),
    ...(file ? { file: resolve(file) } : {}),
    limit,
    maxCandidates,
    ...(value("--output") ? { output: resolve(value("--output")!) } : {}),
  };
}

function parseBoundedInteger(
  value: string,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : "Unknown error";
}
