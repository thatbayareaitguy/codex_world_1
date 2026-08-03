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
  getConfirmedAppleMusicArtistMapping,
  getLastSuccessfulAppleMusicRecentScan,
  releaseAppleMusicPilotLease,
  saveAppleMusicArtistMapping,
  saveAppleMusicCatalog,
  saveAppleMusicRecentCandidates,
  type RadarDatabase,
} from "@radar/db";
import {
  AppleDeveloperTokenManager,
  AppleMusicClient,
  loadProviderConfiguration,
} from "@radar/providers";
import { asc, eq } from "drizzle-orm";
import {
  createAppleMusicRecentMappingBootstrapPlan,
  createAppleMusicRecentPlan,
  parseAppleMusicRecentCommand,
} from "./apple-music-recent-command";
import {
  authorizeAppleMusicIdentityBootstrap,
  runAppleMusicIdentityBootstrap,
} from "./apple-music-identity-bootstrap-runner";
import {
  readAppleMusicIdentityBootstrapArtifact,
  validateAppleMusicIdentityBootstrapArtifact,
  validateAppleMusicIdentityBootstrapSources,
} from "./apple-music-identity-bootstrap";
import {
  authorizeAppleMusicRecent,
  runAppleMusicRecent,
  runAppleMusicRecentOptimization,
  runAppleMusicRecentSeedDiscovery,
  runAppleMusicRecentValidation,
  type AppleMusicRecentStore,
} from "./apple-music-recent-runner";
import { readAppleMusicRecentValidationManifest } from "./apple-music-recent-validation";
import { readAppleMusicRecentSeedDiscoveryManifest } from "./apple-music-recent-seed-discovery";
import type { AppleMusicPilotStoredEvidence } from "./apple-music-pilot-runner";
import { importItunesSnapshot } from "./itunes-pilot-repository";
import { readItunesPilotSnapshot } from "./itunes-pilot-snapshot";
import { loadLocalEnvironment } from "./local-env";

async function main(): Promise<void> {
  const command = parseAppleMusicRecentCommand(process.argv.slice(2));
  if (command.mode === "mapping_bootstrap_plan") {
    process.stdout.write(
      `${JSON.stringify(
        await createAppleMusicRecentMappingBootstrapPlan(
          command.snapshotPath,
          command.identitySeedsPath,
        ),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command.mode === "plan") {
    process.stdout.write(
      `${JSON.stringify(
        await createAppleMusicRecentPlan(
          command.snapshotPath,
          command.profile,
          readItunesPilotSnapshot,
          undefined,
          command.cohortManifestPath,
          command.seedDiscoveryManifestPath,
        ),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command.mode === "mapping_bootstrap_live") {
    const snapshot = await readItunesPilotSnapshot(command.snapshotPath);
    const artifact = validateAppleMusicIdentityBootstrapArtifact(
      await readAppleMusicIdentityBootstrapArtifact(command.identitySeedsPath),
      snapshot,
    );
    await validateAppleMusicIdentityBootstrapSources(artifact);
    const environment = loadLocalEnvironment(
      process.env,
      resolve(process.cwd(), ".app-runtime/apple-music.env"),
    );
    const configuration = loadProviderConfiguration(environment);
    const authorization = authorizeAppleMusicIdentityBootstrap({
      confirmation: command.confirmation,
      evidenceSourcesValidated: true,
      executeLive: true,
      otherProvidersDisabled: otherProvidersDisabled(configuration),
      persistentAppleMusicEnabled: environment.APPLE_MUSIC_ENABLED,
      storefront: configuration.appleMusic.storefront,
    });
    if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
    assertAppleDatabase(configuration.databaseUrl);
    assertAppleBranch();
    assertLiveCredentialShape(configuration.appleMusic);
    const connection = createDatabase(configuration.databaseUrl);
    let tokenManager: AppleDeveloperTokenManager | undefined;
    try {
      const summary = await runAppleMusicIdentityBootstrap({
        artifact,
        authorization,
        createClient: (runId, leaseToken) => {
          tokenManager ??= new AppleDeveloperTokenManager({
            keyId: configuration.appleMusic.keyId!,
            privateKeyPath: configuration.appleMusic.privateKeyPath!,
            teamId: configuration.appleMusic.teamId!,
            tokenLifetimeSeconds: configuration.appleMusic.tokenLifetimeSeconds,
          });
          return new AppleMusicClient({
            enabled: true,
            maxRequestsPerRun: 25,
            maxResponseBytes: configuration.appleMusic.maxResponseBytes,
            maximumRuntimeMs: 60_000,
            maxRetries: 0,
            minRequestIntervalMs: 1_100,
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
        store: createStore(connection.db),
      });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } finally {
      await connection.client.end();
    }
    return;
  }
  const environment = loadLocalEnvironment(
    process.env,
    resolve(process.cwd(), ".app-runtime/apple-music.env"),
  );
  const configuration = loadProviderConfiguration(environment);
  const authorization = authorizeAppleMusicRecent({
    confirmation: command.confirmation,
    evaluationAsOf: command.evaluationAsOf,
    executeLive: true,
    otherProvidersDisabled: otherProvidersDisabled(configuration),
    persistentAppleMusicEnabled: environment.APPLE_MUSIC_ENABLED,
    storefront: configuration.appleMusic.storefront,
    scope: command.scope,
  });
  if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
  assertAppleDatabase(configuration.databaseUrl);
  assertAppleBranch();
  assertLiveCredentialShape(configuration.appleMusic);
  const snapshot = await readItunesPilotSnapshot(command.snapshotPath);
  const connection = createDatabase(configuration.databaseUrl);
  let tokenManager: AppleDeveloperTokenManager | undefined;
  try {
    const validation = command.scope === "validation_25";
    const seedDiscovery = command.scope === "seed_discovery_5";
    const requestBudget = validation ? 175 : command.profile === "optimized_four_source" ? 25 : 100;
    const maximumRuntimeMs = validation
      ? 1_200_000
      : command.profile === "optimized_four_source"
        ? 300_000
        : 900_000;
    const common = {
      authorization,
      createClient: (runId: string, leaseToken: string) => {
        tokenManager ??= new AppleDeveloperTokenManager({
          keyId: configuration.appleMusic.keyId!,
          privateKeyPath: configuration.appleMusic.privateKeyPath!,
          teamId: configuration.appleMusic.teamId!,
          tokenLifetimeSeconds: configuration.appleMusic.tokenLifetimeSeconds,
        });
        return new AppleMusicClient({
          enabled: true,
          maxRequestsPerRun: requestBudget,
          maxResponseBytes: configuration.appleMusic.maxResponseBytes,
          maximumRuntimeMs,
          maxRetries: validation || seedDiscovery ? 1 : 2,
          minRequestIntervalMs: 1_100,
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
      store: createStore(connection.db),
    };
    const summary = validation
      ? await runAppleMusicRecentValidation({
          ...common,
          manifest: await readAppleMusicRecentValidationManifest(command.cohortManifestPath!),
        })
      : seedDiscovery
        ? await runAppleMusicRecentSeedDiscovery({
            ...common,
            manifest: await readAppleMusicRecentSeedDiscoveryManifest(
              command.seedDiscoveryManifestPath!,
            ),
          })
        : command.profile === "optimized_four_source"
          ? await runAppleMusicRecentOptimization(common)
          : await runAppleMusicRecent(common);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await connection.client.end();
  }
}

function otherProvidersDisabled(
  configuration: ReturnType<typeof loadProviderConfiguration>,
): boolean {
  return (
    !configuration.spotify.enabled &&
    !configuration.spotify.playlistWritesEnabled &&
    !configuration.itunes.enabled &&
    !configuration.musicbrainz.enabled &&
    !configuration.reddit.enabled &&
    !configuration.soundcloudManualLinksEnabled
  );
}

function createStore(db: RadarDatabase): AppleMusicRecentStore {
  return {
    claimLease: (runId) => claimAppleMusicPilotLease(db, runId),
    createRun: (input) => createAppleMusicComparisonRun(db, input),
    findConfirmedMapping: (input) => getConfirmedAppleMusicArtistMapping(db, input),
    finishRun: (runId, input) => finishAppleMusicComparisonRun(db, runId, input),
    importSnapshot: (snapshot) => importItunesSnapshot(db, snapshot),
    lastSuccessfulCompletedAt: () => getLastSuccessfulAppleMusicRecentScan(db),
    operationalStatus: () => getAppleMusicOperationalStatus(db),
    readEvidence: (runId) => readStoredEvidence(db, runId),
    releaseLease: (leaseToken) => releaseAppleMusicPilotLease(db, leaseToken),
    saveCandidates: (input) => saveAppleMusicRecentCandidates(db, input),
    saveCatalog: (input) => saveAppleMusicCatalog(db, input),
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
    authenticationAttempts: 0,
    cacheHits: events.length - network.length,
    endpointRequestCounts: countBy(network.map((event) => event.endpointCategory)),
    httpStatusCounts: countBy(
      network.map((event) => (event.status === null ? "none" : String(event.status))),
    ),
    maximumConcurrency: network.length > 0 ? 1 : 0,
    ...(intervals.length > 0 ? { minimumRequestIntervalMs: Math.min(...intervals) } : {}),
    paginationRequests: network.filter((event) => event.requestIdentity.includes(":pagination:"))
      .length,
    requestCount: network.length,
    retryCount: Math.max(
      0,
      network.length - new Set(network.map((event) => event.requestIdentity)).size,
    ),
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
    throw new Error("Apple recent live execution requires codex/apple-music-discovery.");
  }
  if (git(["status", "--porcelain"])) {
    throw new Error("Apple recent live execution requires a clean implementation checkpoint.");
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
  process.stderr.write(`${error instanceof Error ? error.message : "Apple recent MVP failed."}\n`);
  process.exitCode = 1;
});
