import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  appleMusicRequestEvents,
  claimAppleMusicPilotLease,
  createAppleMusicComparisonRun,
  createAppleMusicRequestPersistence,
  createDatabase,
  finishAppleMusicComparisonRun,
  getAppleMusicOperationalStatus,
  releaseAppleMusicPilotLease,
  saveAppleMusicArtistMapping,
  saveAppleMusicCatalog,
  saveAppleMusicComparisons,
  type RadarDatabase,
} from "@radar/db";
import {
  AppleDeveloperTokenManager,
  AppleMusicClient,
  loadProviderConfiguration,
} from "@radar/providers";
import { asc, eq } from "drizzle-orm";
import { executeAppleMusicPilotCommand } from "./apple-music-pilot-command";
import {
  appleMusicPilotDefinition,
  createAppleMusicPilotPlan,
  formatAppleMusicPilotPlan,
} from "./apple-music-pilot-definition";
import {
  runBoundedAppleMusicPilot,
  type AppleMusicPilotLiveAuthorization,
  type AppleMusicPilotStore,
  type AppleMusicPilotStoredEvidence,
} from "./apple-music-pilot-runner";
import { importItunesSnapshot } from "./itunes-pilot-repository";
import { readItunesPilotSnapshot } from "./itunes-pilot-snapshot";
import { loadLocalEnvironment } from "./local-env";

async function main(): Promise<void> {
  const result = await executeAppleMusicPilotCommand(process.argv.slice(2), {
    createPlan: createAppleMusicPilotPlan,
    executeLive: executeLive,
    loadLiveSafety: loadLiveSafety,
  });
  if (result.mode === "plan") {
    process.stdout.write(`${formatAppleMusicPilotPlan(result.plan)}\n\n`);
    process.stdout.write(`Machine-readable plan:\n${JSON.stringify(result.plan, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
}

function loadLiveSafety(): Promise<{
  otherProvidersDisabled: boolean;
  persistentAppleMusicEnabled: string | undefined;
  storefront: string;
}> {
  const environment = loadLocalEnvironment(
    process.env,
    resolve(process.cwd(), ".app-runtime/apple-music.env"),
  );
  const configuration = loadProviderConfiguration(environment);
  return Promise.resolve({
    otherProvidersDisabled:
      !configuration.spotify.enabled &&
      !configuration.spotify.playlistWritesEnabled &&
      !configuration.itunes.enabled &&
      !configuration.musicbrainz.enabled &&
      !configuration.reddit.enabled &&
      !configuration.soundcloudManualLinksEnabled,
    persistentAppleMusicEnabled: environment.APPLE_MUSIC_ENABLED,
    storefront: configuration.appleMusic.storefront,
  });
}

async function executeLive(authorization: AppleMusicPilotLiveAuthorization, snapshotPath: string) {
  const snapshot = await readItunesPilotSnapshot(snapshotPath);
  const environment = loadLocalEnvironment(
    process.env,
    resolve(process.cwd(), ".app-runtime/apple-music.env"),
  );
  const configuration = loadProviderConfiguration(environment);
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  assertAppleDatabase(configuration.databaseUrl);
  assertAppleBranch();
  assertLiveCredentialShape(configuration.appleMusic);
  const connection = createDatabase(configuration.databaseUrl);
  let tokenManager: AppleDeveloperTokenManager | undefined;
  try {
    const store = createStore(connection.db);
    return await runBoundedAppleMusicPilot({
      authorization,
      createClient: (phase, runId, leaseToken) => {
        tokenManager ??= new AppleDeveloperTokenManager({
          keyId: configuration.appleMusic.keyId!,
          privateKeyPath: configuration.appleMusic.privateKeyPath!,
          teamId: configuration.appleMusic.teamId!,
          tokenLifetimeSeconds: configuration.appleMusic.tokenLifetimeSeconds,
        });
        return new AppleMusicClient({
          enabled: authorization.mode === "bounded_public_catalog_25",
          maxRequestsPerRun:
            phase === "canary"
              ? appleMusicPilotDefinition.limits.canaryRequestBudget
              : appleMusicPilotDefinition.limits.requestBudget,
          maxResponseBytes: configuration.appleMusic.maxResponseBytes,
          maximumRuntimeMs:
            phase === "canary"
              ? appleMusicPilotDefinition.limits.canaryRuntimeMs
              : appleMusicPilotDefinition.limits.runtimeMs,
          minRequestIntervalMs: appleMusicPilotDefinition.limits.minRequestIntervalMs,
          persistence: createAppleMusicRequestPersistence(connection.db, {
            runLeaseToken: leaseToken,
          }),
          requestTimeoutMs: configuration.appleMusic.requestTimeoutMs,
          runId,
          storefront: authorization.storefront,
          tokenProvider: tokenManager,
        });
      },
      implementationCommit: git(["rev-parse", "HEAD"]),
      snapshot,
      store,
    });
  } finally {
    await connection.client.end();
  }
}

function createStore(db: RadarDatabase): AppleMusicPilotStore {
  return {
    claimLease: (runId) => claimAppleMusicPilotLease(db, runId),
    createRun: (input) => createAppleMusicComparisonRun(db, input),
    finishRun: (runId, input) => finishAppleMusicComparisonRun(db, runId, input),
    importSnapshot: (snapshot) => importItunesSnapshot(db, snapshot),
    operationalStatus: () => getAppleMusicOperationalStatus(db),
    readEvidence: (runId) => readStoredEvidence(db, runId),
    releaseLease: (leaseToken) => releaseAppleMusicPilotLease(db, leaseToken),
    saveCatalog: (input) => saveAppleMusicCatalog(db, input),
    saveComparisons: (input) => saveAppleMusicComparisons(db, input),
    saveMapping: async (input) => {
      await saveAppleMusicArtistMapping(db, input);
    },
  };
}

async function readStoredEvidence(
  db: RadarDatabase,
  runId: string,
): Promise<AppleMusicPilotStoredEvidence> {
  const events = await db
    .select({
      cacheHit: appleMusicRequestEvents.cacheHit,
      endpointCategory: appleMusicRequestEvents.endpointCategory,
      requestIdentity: appleMusicRequestEvents.requestIdentity,
      startedAt: appleMusicRequestEvents.startedAt,
      status: appleMusicRequestEvents.status,
    })
    .from(appleMusicRequestEvents)
    .where(eq(appleMusicRequestEvents.runId, runId))
    .orderBy(asc(appleMusicRequestEvents.startedAt));
  const network = events.filter((event) => !event.cacheHit);
  const intervals = network
    .slice(1)
    .map((event, index) => event.startedAt.getTime() - network[index]!.startedAt.getTime());
  return {
    cacheHits: events.length - network.length,
    endpointRequestCounts: countBy(network.map((event) => event.endpointCategory)),
    httpStatusCounts: countBy(
      network.map((event) => (event.status === null ? "none" : String(event.status))),
    ),
    maximumConcurrency: network.length > 0 ? 1 : 0,
    ...(intervals.length > 0 ? { minimumRequestIntervalMs: Math.min(...intervals) } : {}),
    paginationRequests: network.filter((event) =>
      /[?&](?:offset|cursor)=/.test(event.requestIdentity),
    ).length,
    requestCount: network.length,
  };
}

function assertAppleDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (
    url.protocol !== "postgres:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55435" ||
    url.pathname !== "/radar_apple"
  ) {
    throw new Error("Refusing to use a database other than the isolated radar_apple database.");
  }
}

function assertAppleBranch(): void {
  if (git(["branch", "--show-current"]) !== "codex/apple-music-discovery") {
    throw new Error("Apple pilot live execution requires codex/apple-music-discovery.");
  }
  if (git(["status", "--porcelain"])) {
    throw new Error("Apple pilot live execution requires a clean implementation checkpoint.");
  }
}

function assertLiveCredentialShape(
  configuration: ReturnType<typeof loadProviderConfiguration>["appleMusic"],
): void {
  if (
    !configuration.teamId ||
    !configuration.keyId ||
    !configuration.mediaId ||
    !configuration.privateKeyPath
  ) {
    throw new Error("The isolated Apple catalog credentials are incomplete.");
  }
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function git(args: string[]): string {
  return execFileSync("git", ["-C", process.cwd(), ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Apple Music pilot failed."}\n`);
  process.exitCode = 1;
});
