import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeArtistIdentity } from "@radar/core";
import {
  itunesPilotArtistMappings,
  itunesPilotProviderState,
  itunesPilotRequestEvents,
  itunesPilotResponseCache,
  itunesPilotRuns,
  itunesPilotSnapshots,
  musicbrainzRequestEvents,
  spotifyRequestEvents,
  type RadarDatabase,
} from "@radar/db";
import {
  ItunesClient,
  type ItunesArtist,
  type ItunesNormalizedResponse,
  type ProviderConfiguration,
} from "@radar/providers";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { createItunesRequestPersistence } from "@radar/db";
import {
  readFullWatchlistIdentitySnapshot,
  type FullWatchlistIdentityArtist,
  type FullWatchlistIdentitySnapshot,
} from "./itunes-full-watchlist-identity-snapshot";
import {
  artistSearchRequestIdentity,
  type SearchCensusManifest,
  type SearchCensusManifestItem,
  validateSearchCensusManifest,
} from "./itunes-search-census-planner";

export const censusRunKind = "full_watchlist_artist_search_census";
export const censusExpectedBranch = "codex/itunes-discovery";
export const legacyAnchorSnapshotHash =
  "48259f7e2016aa8bbbabf4baa7e3baf8d4f9e9b53b413dab56f9d4fc70e1278a";

export type SearchStageMappingState =
  | "unique_exact_canonical"
  | "unique_alias_supported"
  | "competing_exact_or_alias"
  | "no_exact_or_alias_candidate"
  | "invalid_input"
  | "rejected_unsafe_result";

export interface CensusFrozenInputs {
  manifest: SearchCensusManifest;
  manifestFileByteSha256: string;
  manifestPath: string;
  snapshot: FullWatchlistIdentitySnapshot;
  snapshotFileByteSha256: string;
  snapshotPath: string;
}

export interface CensusRunMetrics {
  behaviorFingerprint: string;
  expectedArtistCount: number;
  expectedCacheHitCount: number;
  expectedNetworkSearchCount: number;
  initialCacheRowCount: number;
  initialMusicBrainzRequestEventCount: number;
  initialRequestEventCount: number;
  initialSpotifyRequestEventCount: number;
  manifestFileByteSha256: string;
  manifestPath: string;
  runKind: typeof censusRunKind;
  shardNumber: number;
  snapshotCanonicalContentSha256: string;
  snapshotFileByteSha256: string;
  snapshotPath: string;
  sourceBranch: string;
  sourceCommit: string;
  [key: string]: boolean | number | string;
}

export interface CensusArtistEvidence {
  cacheProvenance: "original_cache" | "network";
  candidateCount: number;
  declaredResultCount: number;
  exactAliasCandidateCount: number;
  exactCanonicalCandidateCount: number;
  mappingReason: string;
  plausibleCandidateIds: string[];
  requestIdentity: string;
  runId: string;
  searchStageMappingState: SearchStageMappingState;
  searchTerm: string;
  shardNumber: number;
  storefront: string;
  terminalProcessingState: "completed";
  unknownResultCount: number;
  version: 1;
}

export interface CensusExecutionGateInput {
  activeLease: boolean;
  activeRun: boolean;
  branch: string;
  completedShard: boolean;
  configuration: ProviderConfiguration;
  explicitLive: boolean;
  expectedBranch: string;
  expectedCommit: string;
  manifestHashMatches: boolean;
  networkBudget: number;
  plannedNetworkSearches: number;
  requestedShardExists: boolean;
  runtimeMs: number;
  snapshotHashesMatch: boolean;
  sourceCommit: string;
  worktreeClean: boolean;
}

interface ArtistSearchOnlyClient {
  searchArtists(runId: string, term: string): Promise<ItunesNormalizedResponse>;
}

export interface CensusShardExecutionResult {
  artistCount: number;
  cacheHitCount: number;
  completedAt: string;
  networkSearchCount: number;
  runId: string;
  runtimeMs: number;
  shardNumber: number;
  status: "completed" | "controlled_partial" | "failed";
  stopReason: string;
}

export async function readCensusFrozenInputs(input: {
  expectedManifestFileByteSha256: string;
  expectedSnapshotCanonicalContentSha256: string;
  expectedSnapshotFileByteSha256: string;
  manifestPath: string;
  snapshotPath: string;
}): Promise<CensusFrozenInputs> {
  const snapshotPath = resolve(input.snapshotPath);
  const manifestPath = resolve(input.manifestPath);
  const snapshotBytes = await readFile(snapshotPath, "utf8");
  const manifestBytes = await readFile(manifestPath, "utf8");
  const snapshotFileByteSha256 = sha256(snapshotBytes);
  const manifestFileByteSha256 = sha256(manifestBytes);
  if (snapshotFileByteSha256 !== input.expectedSnapshotFileByteSha256) {
    throw new Error("Identity snapshot file-byte SHA-256 mismatch.");
  }
  if (manifestFileByteSha256 !== input.expectedManifestFileByteSha256) {
    throw new Error("Search census manifest SHA-256 mismatch.");
  }
  const snapshot = await readFullWatchlistIdentitySnapshot(snapshotPath);
  if (snapshot.canonicalContentSha256 !== input.expectedSnapshotCanonicalContentSha256) {
    throw new Error("Identity snapshot canonical-content SHA-256 mismatch.");
  }
  const parsed: unknown = JSON.parse(manifestBytes);
  if (!parsed || typeof parsed !== "object") throw new Error("Census manifest must be an object.");
  const manifest = parsed as SearchCensusManifest;
  validateSearchCensusManifest(manifest);
  if (
    manifest.snapshot.id !== snapshot.snapshotId ||
    manifest.snapshot.path !== snapshotPath ||
    manifest.snapshot.fileByteSha256 !== snapshotFileByteSha256 ||
    manifest.snapshot.canonicalContentSha256 !== snapshot.canonicalContentSha256
  ) {
    throw new Error("Census manifest does not reference the frozen identity snapshot exactly.");
  }
  validateCompleteManifest(snapshot, manifest);
  return {
    manifest,
    manifestFileByteSha256,
    manifestPath,
    snapshot,
    snapshotFileByteSha256,
    snapshotPath,
  };
}

export function validateCensusExecutionGate(input: CensusExecutionGateInput): void {
  const database = input.configuration.databaseUrl
    ? new URL(input.configuration.databaseUrl)
    : null;
  if (
    !database ||
    database.hostname !== "127.0.0.1" ||
    database.port !== "55433" ||
    database.pathname !== "/radar_itunes"
  ) {
    throw new Error("Census execution requires the isolated radar_itunes database.");
  }
  if (!input.explicitLive || !input.configuration.itunes.enabled) {
    throw new Error("Census execution requires explicit live mode and iTunes enablement.");
  }
  if (
    input.configuration.spotify.enabled ||
    input.configuration.spotify.configured ||
    input.configuration.spotify.playlistWritesEnabled ||
    input.configuration.musicbrainz.enabled ||
    input.configuration.reddit.enabled ||
    input.configuration.reddit.configured ||
    input.configuration.soundcloudManualLinksEnabled
  ) {
    throw new Error("Every non-iTunes provider must be disabled and unusable.");
  }
  if (
    input.configuration.itunes.storefront !== "US" ||
    input.configuration.itunes.language !== "en_us" ||
    input.configuration.itunes.concurrency !== 1 ||
    input.configuration.itunes.minRequestIntervalMs !== 3200
  ) {
    throw new Error("The frozen iTunes search configuration changed.");
  }
  if (!input.snapshotHashesMatch || !input.manifestHashMatches) {
    throw new Error("Frozen census input verification failed.");
  }
  if (!input.requestedShardExists) throw new Error("The requested census shard does not exist.");
  if (input.completedShard) throw new Error("The requested census shard is already complete.");
  if (input.activeRun || input.activeLease) {
    throw new Error("Census execution requires no active pilot run or request lease.");
  }
  if (
    !Number.isInteger(input.networkBudget) ||
    input.networkBudget < 1 ||
    input.networkBudget > 150 ||
    input.networkBudget !== input.plannedNetworkSearches
  ) {
    throw new Error("The supplied network budget must exactly match the shard plan and be <= 150.");
  }
  if (!Number.isInteger(input.runtimeMs) || input.runtimeMs < 1 || input.runtimeMs > 15 * 60_000) {
    throw new Error("The census runtime ceiling must be between 1 ms and 15 minutes.");
  }
  if (
    input.branch !== input.expectedBranch ||
    input.branch !== censusExpectedBranch ||
    input.sourceCommit !== input.expectedCommit ||
    !input.worktreeClean
  ) {
    throw new Error("Census execution requires the expected clean branch and execution commit.");
  }
}

export async function executeCensusShard(input: {
  configuration: ProviderConfiguration;
  db: RadarDatabase;
  expectedBranch: string;
  expectedCommit: string;
  explicitLive: boolean;
  frozen: CensusFrozenInputs;
  networkBudget: number;
  runtimeMs: number;
  shardNumber: number;
}): Promise<CensusShardExecutionResult> {
  const source = currentGitState();
  const shardItems = input.frozen.manifest.items.filter(
    (item) => item.assignedShard === input.shardNumber,
  );
  const plannedNetworkSearches = shardItems.filter(
    (item) => item.projectedNetworkRequestRequired,
  ).length;
  const currentRuns = await input.db.select().from(itunesPilotRuns);
  const censusRuns = currentRuns.filter((run) => isCensusMetrics(run.metrics));
  const existingShardRun = censusRuns.find(
    (run) => censusMetrics(run.metrics).shardNumber === input.shardNumber,
  );
  const providerState = await input.db.query.itunesPilotProviderState.findFirst({
    where: eq(itunesPilotProviderState.id, "global"),
  });
  validateCensusExecutionGate({
    activeLease: Boolean(providerState?.leaseOwner || providerState?.leaseExpiresAt),
    activeRun: currentRuns.some((run) => run.status === "running" || run.status === "planned"),
    branch: source.branch,
    completedShard: existingShardRun?.status === "completed",
    configuration: input.configuration,
    explicitLive: input.explicitLive,
    expectedBranch: input.expectedBranch,
    expectedCommit: input.expectedCommit,
    manifestHashMatches: true,
    networkBudget: input.networkBudget,
    plannedNetworkSearches,
    requestedShardExists: shardItems.length > 0,
    runtimeMs: input.runtimeMs,
    snapshotHashesMatch: true,
    sourceCommit: source.commit,
    worktreeClean: source.clean,
  });
  validateShardItems(shardItems, input.shardNumber);
  await assertShardCacheState(input.db, shardItems, existingShardRun?.id);
  await assertNoCrossShardArtistProcessing(input.db, censusRuns, shardItems, existingShardRun?.id);
  const behavior = buildSearchBehaviorFingerprint(input.expectedCommit);
  const baseline = await censusDatabaseBaseline(input.db);
  const originalSource = originalGitState();
  const anchor = await input.db.query.itunesPilotSnapshots.findFirst({
    where: eq(itunesPilotSnapshots.snapshotHash, legacyAnchorSnapshotHash),
  });
  if (!anchor || anchor.artistCount !== 50 || anchor.releaseCount !== 106) {
    throw new Error("The unchanged legacy pilot snapshot anchor is missing.");
  }
  const newMetrics: CensusRunMetrics = {
    behaviorFingerprint: behavior.fingerprint,
    expectedArtistCount: shardItems.length,
    expectedCacheHitCount: shardItems.filter((item) => item.cacheStatus === "valid_cache_hit")
      .length,
    expectedNetworkSearchCount: plannedNetworkSearches,
    initialCacheRowCount: baseline.cacheRows,
    initialMusicBrainzRequestEventCount: baseline.musicbrainzRequestEvents,
    initialRequestEventCount: baseline.requestEvents,
    initialSpotifyRequestEventCount: baseline.spotifyRequestEvents,
    manifestFileByteSha256: input.frozen.manifestFileByteSha256,
    manifestPath: input.frozen.manifestPath,
    originalWorktreeBranch: originalSource.branch,
    originalWorktreeCommit: originalSource.commit,
    originalWorktreeStatus: originalSource.status,
    runKind: censusRunKind,
    shardNumber: input.shardNumber,
    snapshotCanonicalContentSha256: input.frozen.snapshot.canonicalContentSha256,
    snapshotFileByteSha256: input.frozen.snapshotFileByteSha256,
    snapshotPath: input.frozen.snapshotPath,
    sourceBranch: source.branch,
    sourceCommit: source.commit,
  };
  const metrics = existingShardRun ? censusMetrics(existingShardRun.metrics) : newMetrics;
  if (
    metrics.behaviorFingerprint !== behavior.fingerprint ||
    metrics.manifestFileByteSha256 !== input.frozen.manifestFileByteSha256 ||
    metrics.snapshotFileByteSha256 !== input.frozen.snapshotFileByteSha256 ||
    metrics.snapshotCanonicalContentSha256 !== input.frozen.snapshot.canonicalContentSha256 ||
    metrics.sourceBranch !== source.branch ||
    metrics.sourceCommit !== source.commit
  ) {
    throw new Error("Controlled-partial run inputs or search behavior changed.");
  }
  const run = existingShardRun
    ? await resumeControlledPartialRun(input.db, existingShardRun, input.runtimeMs)
    : await createAndStartCensusRun(input.db, {
        anchorSnapshotId: anchor.id,
        metrics,
        networkBudget: input.networkBudget,
        runtimeMs: input.runtimeMs,
        sourceCommit: source.commit,
      });
  const existingMappings = await input.db
    .select()
    .from(itunesPilotArtistMappings)
    .where(eq(itunesPilotArtistMappings.runId, run.id));
  const completedArtists = new Set(existingMappings.map((mapping) => mapping.canonicalArtistId));
  const snapshotArtists = new Map(
    input.frozen.snapshot.artists.map((artist) => [artist.canonicalArtistId, artist]),
  );
  const client: ArtistSearchOnlyClient = new ItunesClient({
    enabled: input.configuration.itunes.enabled,
    language: input.configuration.itunes.language,
    maxRequestsPerRun: input.networkBudget,
    maxResponseBytes: input.configuration.itunes.maxResponseBytes,
    minRequestIntervalMs: input.configuration.itunes.minRequestIntervalMs,
    persistence: createItunesRequestPersistence(input.db),
    requestTimeoutMs: input.configuration.itunes.requestTimeoutMs,
    storefront: input.configuration.itunes.storefront,
  });
  const executionStartedAt = Date.now();
  let status: CensusShardExecutionResult["status"] = "completed";
  let stopReason = "census_shard_completed";
  try {
    for (const item of shardItems) {
      if (completedArtists.has(item.canonicalArtistId)) continue;
      if (Date.now() - executionStartedAt >= input.runtimeMs) {
        status = "controlled_partial";
        stopReason = "census_runtime_ceiling_reached";
        break;
      }
      const artist = snapshotArtists.get(item.canonicalArtistId);
      if (!artist)
        throw new Error(`Manifest artist is absent from snapshot: ${item.canonicalArtistId}`);
      const response = await client.searchArtists(run.id, item.normalizedSearchTerm);
      const eventRows = await input.db
        .select()
        .from(itunesPilotRequestEvents)
        .where(
          and(
            eq(itunesPilotRequestEvents.runId, run.id),
            eq(itunesPilotRequestEvents.requestIdentity, item.cacheKeyIdentity),
          ),
        );
      if (
        eventRows.length !== 1 ||
        eventRows[0]!.status !== 200 ||
        eventRows[0]!.errorClassification ||
        eventRows[0]!.retryAfterSeconds
      ) {
        throw new Error(`Unexpected retry or request anomaly for ${item.canonicalArtistId}.`);
      }
      const expectedCacheHit = item.cacheStatus === "valid_cache_hit";
      if (eventRows[0]!.cacheHit !== expectedCacheHit) {
        throw new Error(`Cache provenance changed for ${item.canonicalArtistId}.`);
      }
      const classified = classifySearchStage(artist, response);
      await persistCensusArtistResult(input.db, {
        artist,
        candidates: response.artists,
        classified,
        item,
        runId: run.id,
        shardNumber: input.shardNumber,
        storefront: input.configuration.itunes.storefront,
        declaredResultCount: response.declaredResultCount,
        unknownResultCount: response.unknownResultCount,
      });
      if (classified.state === "rejected_unsafe_result") {
        throw new Error(`Unsafe search response shape for ${item.canonicalArtistId}.`);
      }
    }
    const integrity = await censusShardIntegrity(input.db, run.id);
    const expectedCompleted =
      status === "completed" &&
      integrity.mappingCount === shardItems.length &&
      integrity.eventCount === shardItems.length &&
      integrity.cacheHitCount === metrics.expectedCacheHitCount &&
      integrity.networkEventCount === metrics.expectedNetworkSearchCount &&
      integrity.errorCount === 0;
    if (status === "completed" && !expectedCompleted) {
      throw new Error("Completed census shard did not match its frozen integrity totals.");
    }
  } catch (error) {
    status = "failed";
    stopReason = safeErrorClassification(error);
  }
  const completedAt = new Date();
  const finalIntegrity = await censusShardIntegrity(input.db, run.id);
  const finalMetrics = {
    ...metrics,
    actualCacheHitCount: finalIntegrity.cacheHitCount,
    actualErrorCount: finalIntegrity.errorCount,
    actualEventCount: finalIntegrity.eventCount,
    actualMappingCount: finalIntegrity.mappingCount,
    actualNetworkSearchCount: finalIntegrity.networkEventCount,
    completedAt: completedAt.toISOString(),
    runtimeMs: completedAt.getTime() - executionStartedAt,
  };
  await input.db
    .update(itunesPilotRuns)
    .set({
      completedAt,
      metrics: finalMetrics,
      status,
      stopReason,
      updatedAt: completedAt,
    })
    .where(eq(itunesPilotRuns.id, run.id));
  return {
    artistCount: finalIntegrity.mappingCount,
    cacheHitCount: finalIntegrity.cacheHitCount,
    completedAt: completedAt.toISOString(),
    networkSearchCount: finalIntegrity.networkEventCount,
    runId: run.id,
    runtimeMs: completedAt.getTime() - executionStartedAt,
    shardNumber: input.shardNumber,
    status,
    stopReason,
  };
}

export function classifySearchStage(
  artist: FullWatchlistIdentityArtist,
  response: ItunesNormalizedResponse,
): {
  exactAliasCandidateCount: number;
  exactCanonicalCandidateCount: number;
  plausibleCandidateIds: string[];
  reason: string;
  selected?: ItunesArtist;
  state: SearchStageMappingState;
} {
  if (!artist.displayName.trim()) {
    return {
      exactAliasCandidateCount: 0,
      exactCanonicalCandidateCount: 0,
      plausibleCandidateIds: [],
      reason: "Canonical artist search input is empty.",
      state: "invalid_input",
    };
  }
  if (response.collections.length > 0 || response.tracks.length > 0) {
    return {
      exactAliasCandidateCount: 0,
      exactCanonicalCandidateCount: 0,
      plausibleCandidateIds: [],
      reason: "Artist-search response contained a non-artist normalized result.",
      state: "rejected_unsafe_result",
    };
  }
  const canonical = normalizeArtistIdentity(artist.displayName);
  const aliasNames = new Set(artist.aliases.map(normalizeArtistIdentity).filter(Boolean));
  const exactCanonical = response.artists.filter(
    (candidate) => normalizeArtistIdentity(candidate.artistName) === canonical,
  );
  const exactAliases = response.artists.filter(
    (candidate) =>
      normalizeArtistIdentity(candidate.artistName) !== canonical &&
      aliasNames.has(normalizeArtistIdentity(candidate.artistName)),
  );
  const plausible = [...exactCanonical, ...exactAliases];
  const plausibleCandidateIds = [...new Set(plausible.map((candidate) => candidate.artistId))].sort(
    compareText,
  );
  if (exactCanonical.length === 1) {
    return {
      exactAliasCandidateCount: exactAliases.length,
      exactCanonicalCandidateCount: 1,
      plausibleCandidateIds,
      reason: "One candidate exactly matches the normalized canonical name.",
      selected: exactCanonical[0]!,
      state: "unique_exact_canonical",
    };
  }
  if (exactCanonical.length > 1) {
    return {
      exactAliasCandidateCount: exactAliases.length,
      exactCanonicalCandidateCount: exactCanonical.length,
      plausibleCandidateIds,
      reason: "Multiple candidates exactly match the normalized canonical name.",
      state: "competing_exact_or_alias",
    };
  }
  if (exactAliases.length === 1) {
    return {
      exactAliasCandidateCount: 1,
      exactCanonicalCandidateCount: 0,
      plausibleCandidateIds,
      reason: "One candidate exactly matches a stored normalized alias.",
      selected: exactAliases[0]!,
      state: "unique_alias_supported",
    };
  }
  if (exactAliases.length > 1) {
    return {
      exactAliasCandidateCount: exactAliases.length,
      exactCanonicalCandidateCount: 0,
      plausibleCandidateIds,
      reason: "Multiple candidates exactly match stored normalized aliases.",
      state: "competing_exact_or_alias",
    };
  }
  return {
    exactAliasCandidateCount: 0,
    exactCanonicalCandidateCount: 0,
    plausibleCandidateIds: [],
    reason:
      response.artists.length === 0
        ? "Artist search returned no normalized artist candidates."
        : "No candidate exactly matches the normalized canonical name or stored aliases.",
    state: "no_exact_or_alias_candidate",
  };
}

export function buildSearchBehaviorFingerprint(commit: string): {
  components: Record<string, string>;
  fingerprint: string;
} {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Execution commit must be a full Git SHA.");
  const files = [
    "packages/providers/src/itunes.ts",
    "packages/providers/src/config.ts",
    "packages/db/src/itunes-pilot.ts",
    "apps/scanner/src/itunes-search-census-executor.ts",
  ];
  const components: Record<string, string> = {
    entity: "musicArtist",
    explicit: "Yes",
    host: "itunes.apple.com",
    language: "en_us",
    limit: "10",
    media: "music",
    path: "/search",
    storefront: "US",
    termBehavior: "trim-only-over-nfc-snapshot-v1",
  };
  for (const file of files) components[`gitBlob:${file}`] = git(["rev-parse", `${commit}:${file}`]);
  return { components, fingerprint: sha256(stableStringify(components)) };
}

export async function censusDatabaseBaseline(db: RadarDatabase): Promise<{
  cacheRows: number;
  musicbrainzRequestEvents: number;
  requestEvents: number;
  spotifyRequestEvents: number;
}> {
  const [[requestEvents], [cacheRows], [spotifyRows], [musicbrainzRows]] = await Promise.all([
    db.select({ value: count() }).from(itunesPilotRequestEvents),
    db.select({ value: count() }).from(itunesPilotResponseCache),
    db.select({ value: count() }).from(spotifyRequestEvents),
    db.select({ value: count() }).from(musicbrainzRequestEvents),
  ]);
  return {
    cacheRows: cacheRows?.value ?? 0,
    musicbrainzRequestEvents: musicbrainzRows?.value ?? 0,
    requestEvents: requestEvents?.value ?? 0,
    spotifyRequestEvents: spotifyRows?.value ?? 0,
  };
}

export function censusMetrics(value: unknown): CensusRunMetrics {
  if (!isCensusMetrics(value)) throw new Error("Run does not contain census metrics.");
  return value;
}

export function isCensusMetrics(value: unknown): value is CensusRunMetrics {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { runKind?: unknown }).runKind === censusRunKind &&
    Number.isInteger((value as { shardNumber?: unknown }).shardNumber)
  );
}

function validateCompleteManifest(
  snapshot: FullWatchlistIdentitySnapshot,
  manifest: SearchCensusManifest,
): void {
  if (
    snapshot.artists.length !== 593 ||
    manifest.items.length !== 593 ||
    manifest.shards.length !== 4 ||
    new Set(manifest.items.map((item) => item.canonicalArtistId)).size !== 593
  ) {
    throw new Error("Frozen census population or shard count changed.");
  }
  const expected = [
    { artists: 150, cacheHits: 25, network: 125, shard: 1 },
    { artists: 150, cacheHits: 5, network: 145, shard: 2 },
    { artists: 150, cacheHits: 11, network: 139, shard: 3 },
    { artists: 143, cacheHits: 9, network: 134, shard: 4 },
  ];
  for (const item of manifest.items) {
    if (
      item.requestKind !== "artist_search" ||
      item.cacheKeyIdentity !== artistSearchRequestIdentity(item.normalizedSearchTerm) ||
      /\/lookup|entity=(?:album|song)|batch|collection/i.test(item.cacheKeyIdentity)
    ) {
      throw new Error("Manifest contains a non-search or changed request identity.");
    }
  }
  for (const expectedShard of expected) {
    const members = manifest.items.filter((item) => item.assignedShard === expectedShard.shard);
    const cacheHits = members.filter((item) => item.cacheStatus === "valid_cache_hit").length;
    const network = members.filter((item) => item.projectedNetworkRequestRequired).length;
    if (
      members.length !== expectedShard.artists ||
      cacheHits !== expectedShard.cacheHits ||
      network !== expectedShard.network
    ) {
      throw new Error(`Frozen census shard ${expectedShard.shard} changed.`);
    }
  }
}

function validateShardItems(items: SearchCensusManifestItem[], shardNumber: number): void {
  if (
    items.length === 0 ||
    items.length > 150 ||
    new Set(items.map((item) => item.canonicalArtistId)).size !== items.length ||
    new Set(items.map((item) => item.cacheKeyIdentity)).size !== items.length ||
    items.some(
      (item) =>
        item.assignedShard !== shardNumber ||
        item.requestKind !== "artist_search" ||
        !item.cacheKeyIdentity.startsWith("/search?"),
    )
  ) {
    throw new Error("Census shard membership or operation type is invalid.");
  }
}

async function assertShardCacheState(
  db: RadarDatabase,
  items: SearchCensusManifestItem[],
  currentRunId?: string,
): Promise<void> {
  const identities = items.map((item) => item.cacheKeyIdentity);
  const cacheRows = await db
    .select({ identity: itunesPilotResponseCache.requestIdentity })
    .from(itunesPilotResponseCache)
    .where(inArray(itunesPilotResponseCache.requestIdentity, identities));
  const cached = new Set(cacheRows.map((row) => row.identity));
  const resumedNetworkIdentities = new Set<string>();
  const resumedArtistIds = new Set<string>();
  if (currentRunId) {
    const [events, mappings] = await Promise.all([
      db
        .select({
          cacheHit: itunesPilotRequestEvents.cacheHit,
          identity: itunesPilotRequestEvents.requestIdentity,
          status: itunesPilotRequestEvents.status,
        })
        .from(itunesPilotRequestEvents)
        .where(eq(itunesPilotRequestEvents.runId, currentRunId)),
      db
        .select({ artistId: itunesPilotArtistMappings.canonicalArtistId })
        .from(itunesPilotArtistMappings)
        .where(eq(itunesPilotArtistMappings.runId, currentRunId)),
    ]);
    for (const event of events) {
      if (!event.cacheHit && event.status === 200) {
        resumedNetworkIdentities.add(event.identity);
      }
    }
    for (const mapping of mappings) resumedArtistIds.add(mapping.artistId);
  }
  for (const item of items) {
    const expected = item.cacheStatus === "valid_cache_hit";
    const completedNetworkSearch =
      !expected &&
      resumedNetworkIdentities.has(item.cacheKeyIdentity) &&
      resumedArtistIds.has(item.canonicalArtistId);
    if (cached.has(item.cacheKeyIdentity) !== (expected || completedNetworkSearch)) {
      throw new Error(`Frozen cache state changed for ${item.canonicalArtistId}.`);
    }
  }
}

async function assertNoCrossShardArtistProcessing(
  db: RadarDatabase,
  censusRuns: Array<typeof itunesPilotRuns.$inferSelect>,
  items: SearchCensusManifestItem[],
  currentRunId?: string,
): Promise<void> {
  const otherRunIds = censusRuns.filter((run) => run.id !== currentRunId).map((run) => run.id);
  if (otherRunIds.length === 0) return;
  const rows = await db
    .select({ artistId: itunesPilotArtistMappings.canonicalArtistId })
    .from(itunesPilotArtistMappings)
    .where(inArray(itunesPilotArtistMappings.runId, otherRunIds));
  const processed = new Set(rows.map((row) => row.artistId));
  const duplicate = items.find((item) => processed.has(item.canonicalArtistId));
  if (duplicate)
    throw new Error(
      `Artist was already processed in another shard: ${duplicate.canonicalArtistId}`,
    );
}

async function createAndStartCensusRun(
  db: RadarDatabase,
  input: {
    anchorSnapshotId: string;
    metrics: CensusRunMetrics;
    networkBudget: number;
    runtimeMs: number;
    sourceCommit: string;
  },
) {
  const now = new Date();
  const [run] = await db
    .insert(itunesPilotRuns)
    .values({
      completedAt: null,
      deadlineAt: new Date(now.getTime() + input.runtimeMs),
      implementationCommit: input.sourceCommit,
      maximumRuntimeMs: input.runtimeMs,
      metrics: input.metrics,
      minRequestIntervalMs: 3200,
      requestBudget: input.networkBudget,
      snapshotId: input.anchorSnapshotId,
      startedAt: now,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("Census run could not be created.");
  return run;
}

async function resumeControlledPartialRun(
  db: RadarDatabase,
  run: typeof itunesPilotRuns.$inferSelect,
  runtimeMs: number,
) {
  if (run.status !== "controlled_partial") {
    throw new Error("Only a controlled-partial census run can be resumed.");
  }
  const now = new Date();
  const [resumed] = await db
    .update(itunesPilotRuns)
    .set({
      completedAt: null,
      deadlineAt: new Date(now.getTime() + runtimeMs),
      status: "running",
      stopReason: null,
      updatedAt: now,
    })
    .where(and(eq(itunesPilotRuns.id, run.id), eq(itunesPilotRuns.status, "controlled_partial")))
    .returning();
  if (!resumed) throw new Error("Controlled-partial census run could not be resumed.");
  return resumed;
}

async function persistCensusArtistResult(
  db: RadarDatabase,
  input: {
    artist: FullWatchlistIdentityArtist;
    candidates: ItunesArtist[];
    classified: ReturnType<typeof classifySearchStage>;
    declaredResultCount: number;
    item: SearchCensusManifestItem;
    runId: string;
    shardNumber: number;
    storefront: string;
    unknownResultCount: number;
  },
): Promise<void> {
  const evidence: CensusArtistEvidence = {
    cacheProvenance: input.item.cacheStatus === "valid_cache_hit" ? "original_cache" : "network",
    candidateCount: input.candidates.length,
    declaredResultCount: input.declaredResultCount,
    exactAliasCandidateCount: input.classified.exactAliasCandidateCount,
    exactCanonicalCandidateCount: input.classified.exactCanonicalCandidateCount,
    mappingReason: input.classified.reason,
    plausibleCandidateIds: input.classified.plausibleCandidateIds,
    requestIdentity: input.item.cacheKeyIdentity,
    runId: input.runId,
    searchStageMappingState: input.classified.state,
    searchTerm: input.item.normalizedSearchTerm,
    shardNumber: input.shardNumber,
    storefront: input.storefront,
    terminalProcessingState: "completed",
    unknownResultCount: input.unknownResultCount,
    version: 1,
  };
  const status = legacyMappingStatus(input.classified.state);
  const confidence =
    input.classified.state === "unique_exact_canonical"
      ? "1.000"
      : input.classified.state === "unique_alias_supported"
        ? "0.950"
        : "0.000";
  const sanitizedCandidates = input.candidates.map((candidate) => ({
    artistId: candidate.artistId,
    artistName: candidate.artistName,
    wrapperType: "artist" as const,
  }));
  await db
    .insert(itunesPilotArtistMappings)
    .values({
      ambiguityReason:
        input.classified.state === "competing_exact_or_alias" ? input.classified.reason : undefined,
      candidates: sanitizedCandidates,
      canonicalArtistId: input.artist.canonicalArtistId,
      confidence,
      decisionReason: input.classified.reason,
      evidence,
      runId: input.runId,
      selectedArtistId: input.classified.selected?.artistId,
      selectedArtistName: input.classified.selected?.artistName,
      status,
    })
    .onConflictDoNothing({
      target: [itunesPilotArtistMappings.runId, itunesPilotArtistMappings.canonicalArtistId],
    });
}

function legacyMappingStatus(state: SearchStageMappingState) {
  if (state === "unique_exact_canonical") return "exact_confirmed" as const;
  if (state === "unique_alias_supported") return "evidence_confirmed" as const;
  if (state === "competing_exact_or_alias") return "ambiguous" as const;
  if (state === "no_exact_or_alias_candidate") return "no_match" as const;
  return "rejected" as const;
}

async function censusShardIntegrity(db: RadarDatabase, runId: string) {
  const events = await db
    .select()
    .from(itunesPilotRequestEvents)
    .where(eq(itunesPilotRequestEvents.runId, runId))
    .orderBy(asc(itunesPilotRequestEvents.startedAt));
  const [mappingCount] = await db
    .select({ value: count() })
    .from(itunesPilotArtistMappings)
    .where(eq(itunesPilotArtistMappings.runId, runId));
  return {
    cacheHitCount: events.filter((event) => event.cacheHit).length,
    errorCount: events.filter(
      (event) =>
        event.errorClassification !== null ||
        event.retryAfterSeconds !== null ||
        event.status !== 200,
    ).length,
    eventCount: events.length,
    mappingCount: mappingCount?.value ?? 0,
    networkEventCount: events.filter((event) => !event.cacheHit).length,
  };
}

function currentGitState(): { branch: string; clean: boolean; commit: string } {
  return {
    branch: git(["branch", "--show-current"]),
    clean: git(["status", "--porcelain"]) === "",
    commit: git(["rev-parse", "HEAD"]),
  };
}

function originalGitState(): { branch: string; commit: string; status: string } {
  const path = "C:\\Users\\taysh\\Documents\\Codex\\codex_world_1";
  return {
    branch: git(["-C", path, "branch", "--show-current"]),
    commit: git(["-C", path, "rev-parse", "HEAD"]),
    status: git(["-C", path, "status", "--porcelain"]),
  };
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function safeErrorClassification(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return `census_failed:${value.replace(/[^A-Za-z0-9_ .:-]/g, "").slice(0, 400)}`;
}

function stableStringify(value: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right))),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
