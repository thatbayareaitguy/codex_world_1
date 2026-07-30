import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  itunesPilotArtistMappings,
  itunesPilotProviderState,
  itunesPilotRequestEvents,
  itunesPilotResponseCache,
  itunesPilotRuns,
  itunesPilotSnapshotArtists,
  musicbrainzRequestEvents,
  spotifyRequestEvents,
  type RadarDatabase,
} from "@radar/db";
import { asc, count, eq, inArray } from "drizzle-orm";
import {
  censusMetrics,
  isCensusMetrics,
  readCensusFrozenInputs,
  type CensusArtistEvidence,
  type CensusFrozenInputs,
  type SearchStageMappingState,
} from "./itunes-search-census-executor";

export interface CanaryCondition {
  detail: string;
  name: string;
  passed: boolean;
}

export interface CensusCanaryResult {
  conditions: CanaryCondition[];
  passed: boolean;
  runId: string;
  shardNumber: number;
}

export const censusCanaryConditionNames = [
  "terminal_artist_count",
  "expected_cache_hits",
  "expected_network_searches",
  "shard_membership",
  "duplicate_artists",
  "duplicate_search_identities",
  "unexpected_retries",
  "http_errors",
  "http_429",
  "retry_after",
  "parsing_errors",
  "response_bound_errors",
  "redirect_errors",
  "minimum_pacing",
  "overlap_count",
  "search_only_path",
  "no_lookup",
  "no_batch",
  "no_other_provider",
  "run_terminal",
  "no_active_run",
  "no_active_lease",
  "snapshot_hash",
  "manifest_hash",
  "source_unchanged",
  "original_worktree_unchanged",
  "safe_persisted_shape",
] as const;

export interface CensusResultArtifact {
  analysis: CensusAnalysis;
  branch: string;
  canonicalContentSha256: string;
  completenessState: "complete" | "controlled_partial" | "failed";
  executionCommit: string;
  fileByteSha256: string;
  finalCacheRowCount: number;
  finalRequestEventCount: number;
  kind: "itunes_full_watchlist_search_census";
  manifest: {
    fileByteSha256: string;
    path: string;
  };
  requestConfiguration: {
    concurrency: 1;
    entity: "musicArtist";
    language: "en_us";
    limit: 10;
    media: "music";
    minimumRequestStartIntervalMs: 3200;
    path: "/search";
    storefront: "US";
  };
  searchBehaviorFingerprint: string;
  shards: CensusArtifactShard[];
  snapshot: {
    canonicalContentSha256: string;
    fileByteSha256: string;
    id: string;
    path: string;
  };
  stopReason: string;
  version: 1;
  artists: CensusArtifactArtist[];
}

export interface CensusArtifactArtist {
  aliases: string[];
  cacheProvenance: "original_cache" | "network" | "not_processed";
  candidateCount: number;
  declaredResultCount: number;
  candidates: Array<{ artistId: string; artistName: string }>;
  canonicalArtistId: string;
  displayName: string;
  exactAliasCandidateCount: number;
  exactCanonicalCandidateCount: number;
  normalizedName: string;
  plausibleCandidateIds: string[];
  requestIdentity: string;
  runId?: string;
  searchStageMappingState?: SearchStageMappingState;
  searchTerm: string;
  shardNumber: number;
  spotifyArtistId: string;
  terminalProcessingState: "completed" | "not_processed";
  unknownResultCount: number;
}

export interface CensusArtifactShard {
  artistCount: number;
  cacheHitCount: number;
  errorCount: number;
  http429Count: number;
  minimumNetworkStartIntervalMs?: number;
  networkRequestCount: number;
  overlapCount: number;
  parseOrResponseBoundErrorCount: number;
  retryCount: number;
  runId: string;
  runtimeMs: number;
  shardNumber: number;
  status: string;
  stopReason: string;
}

export interface CensusAnalysis {
  ambiguousArtistCount: number;
  candidateCountBands: {
    maximumResultCount: number;
    one: number;
    sixToNine: number;
    threeToFive: number;
    two: number;
    zero: number;
  };
  candidateCountDistribution: Record<string, number>;
  exactNameCandidateIdCount: number;
  exactNameCompetitorDistribution: Record<string, number>;
  futureCatalogEvidence: {
    albumCacheCandidateIds: number;
    newAlbumRequests: number;
    newSongRequests: number;
    newTotalRequests: number;
    projectedRuntimeMs: number;
    requestCountsByShard: number[];
    shardCount: number;
    songCacheCandidateIds: number;
  };
  mappingCounts: Record<SearchStageMappingState, number>;
  maximumCandidateCount: number;
  originalCohort: {
    artistsFound: number;
    cacheRowsReused: number;
    discrepancies: string[];
    mappingCounts: Partial<Record<SearchStageMappingState, number>>;
  };
  plausibleCandidateIdCount: number;
  searchStageMappingCoverage: number;
  totalNormalizedAppleCandidates: number;
  unresolvedIdentityRate: number;
  artistsAtResultLimit: string[];
}

export async function verifyCensusShard(input: {
  db: RadarDatabase;
  expectedBranch: string;
  expectedCommit: string;
  frozen: CensusFrozenInputs;
  shardNumber: number;
}): Promise<CensusCanaryResult> {
  const runs = (await input.db.select().from(itunesPilotRuns)).filter((run) =>
    isCensusMetrics(run.metrics),
  );
  const run = runs.find(
    (candidate) => censusMetrics(candidate.metrics).shardNumber === input.shardNumber,
  );
  if (!run) throw new Error(`Census shard ${input.shardNumber} has no persisted run.`);
  const metrics = censusMetrics(run.metrics);
  const expectedItems = input.frozen.manifest.items.filter(
    (item) => item.assignedShard === input.shardNumber,
  );
  const expectedIds = new Set(expectedItems.map((item) => item.canonicalArtistId));
  const expectedIdentities = new Set(expectedItems.map((item) => item.cacheKeyIdentity));
  const events = await input.db
    .select()
    .from(itunesPilotRequestEvents)
    .where(eq(itunesPilotRequestEvents.runId, run.id))
    .orderBy(asc(itunesPilotRequestEvents.startedAt));
  const allNetworkEvents = (
    await input.db
      .select()
      .from(itunesPilotRequestEvents)
      .orderBy(asc(itunesPilotRequestEvents.startedAt))
  ).filter((event) => !event.cacheHit);
  const mappings = await input.db
    .select()
    .from(itunesPilotArtistMappings)
    .where(eq(itunesPilotArtistMappings.runId, run.id));
  const providerState = await input.db.query.itunesPilotProviderState.findFirst({
    where: eq(itunesPilotProviderState.id, "global"),
  });
  const [spotifyCount] = await input.db.select({ value: count() }).from(spotifyRequestEvents);
  const [musicbrainzCount] = await input.db
    .select({ value: count() })
    .from(musicbrainzRequestEvents);
  const networkEvents = events.filter((event) => !event.cacheHit);
  const cacheEvents = events.filter((event) => event.cacheHit);
  const intervals = allNetworkEvents.flatMap((event, index) => {
    const prior = allNetworkEvents[index - 1];
    return event.runId === run.id && prior
      ? [event.startedAt.getTime() - prior.startedAt.getTime()]
      : [];
  });
  const minimumInterval = intervals.length > 0 ? Math.min(...intervals) : Number.POSITIVE_INFINITY;
  const overlapCount = networkEvents.slice(1).filter((event, index) => {
    const prior = networkEvents[index]!;
    return prior.completedAt !== null && event.startedAt < prior.completedAt;
  }).length;
  const source = currentGitState();
  const original = originalGitState();
  const mappingIds = mappings.map((mapping) => mapping.canonicalArtistId);
  const eventIdentities = events.map((event) => event.requestIdentity);
  const duplicateEventIdentityCount = duplicateCount(eventIdentities);
  const forbiddenPersistedKey = findForbiddenPersistedKey(
    mappings.flatMap((mapping) => [mapping.candidates, mapping.evidence]),
  );
  const conditions: CanaryCondition[] = [
    condition(
      "terminal_artist_count",
      mappings.length === expectedItems.length,
      `${mappings.length}/${expectedItems.length}`,
    ),
    condition(
      "expected_cache_hits",
      cacheEvents.length === metrics.expectedCacheHitCount,
      `${cacheEvents.length}/${metrics.expectedCacheHitCount}`,
    ),
    condition(
      "expected_network_searches",
      networkEvents.length === metrics.expectedNetworkSearchCount,
      `${networkEvents.length}/${metrics.expectedNetworkSearchCount}`,
    ),
    condition(
      "shard_membership",
      mappingIds.every((id) => expectedIds.has(id)),
      `${mappingIds.length} persisted artists`,
    ),
    condition(
      "duplicate_artists",
      new Set(mappingIds).size === mappingIds.length,
      `${mappingIds.length - new Set(mappingIds).size} duplicates`,
    ),
    condition(
      "duplicate_search_identities",
      duplicateEventIdentityCount === 0,
      `${duplicateEventIdentityCount} duplicates`,
    ),
    condition(
      "unexpected_retries",
      networkEvents.length === new Set(networkEvents.map((event) => event.requestIdentity)).size,
      "network events equal unique identities",
    ),
    condition(
      "http_errors",
      events.every((event) => event.status === 200),
      `${events.filter((event) => event.status !== 200).length} errors`,
    ),
    condition(
      "http_429",
      events.every((event) => event.status !== 429),
      `${events.filter((event) => event.status === 429).length} responses`,
    ),
    condition(
      "retry_after",
      events.every((event) => event.retryAfterSeconds === null),
      `${events.filter((event) => event.retryAfterSeconds !== null).length} rows`,
    ),
    condition(
      "parsing_errors",
      events.every(
        (event) =>
          !["malformed_json", "invalid_response"].includes(event.errorClassification ?? ""),
      ),
      "no parse classifications",
    ),
    condition(
      "response_bound_errors",
      events.every((event) => event.errorClassification !== "response_too_large"),
      "no response bound classifications",
    ),
    condition(
      "redirect_errors",
      events.every((event) => event.errorClassification !== "network_error"),
      "no redirect/network classification",
    ),
    condition(
      "minimum_pacing",
      minimumInterval >= 3200,
      Number.isFinite(minimumInterval)
        ? `${minimumInterval} ms`
        : "single or zero network requests",
    ),
    condition("overlap_count", overlapCount === 0, `${overlapCount} overlaps`),
    condition(
      "search_only_path",
      events.every(
        (event) =>
          event.requestIdentity.startsWith("/search?") &&
          expectedIdentities.has(event.requestIdentity),
      ),
      "all identities are frozen /search entries",
    ),
    condition(
      "no_lookup",
      events.every((event) => !event.requestIdentity.includes("/lookup")),
      "no /lookup identity",
    ),
    condition(
      "no_batch",
      events.every((event) => !event.endpointCategory.startsWith("batch_")),
      "no batch category",
    ),
    condition(
      "no_other_provider",
      (spotifyCount?.value ?? 0) === metrics.initialSpotifyRequestEventCount &&
        (musicbrainzCount?.value ?? 0) === metrics.initialMusicBrainzRequestEventCount,
      "non-iTunes event counts unchanged",
    ),
    condition("run_terminal", run.status === "completed", run.status),
    condition(
      "no_active_run",
      runs.every((candidate) => !["planned", "running"].includes(candidate.status)),
      "no census run is planned or running",
    ),
    condition(
      "no_active_lease",
      !providerState?.leaseOwner && !providerState?.leaseExpiresAt,
      "global lease is empty",
    ),
    condition(
      "snapshot_hash",
      metrics.snapshotFileByteSha256 === input.frozen.snapshotFileByteSha256 &&
        metrics.snapshotCanonicalContentSha256 === input.frozen.snapshot.canonicalContentSha256,
      "snapshot hashes match",
    ),
    condition(
      "manifest_hash",
      metrics.manifestFileByteSha256 === input.frozen.manifestFileByteSha256,
      "manifest hash matches",
    ),
    condition(
      "source_unchanged",
      source.branch === input.expectedBranch &&
        source.commit === input.expectedCommit &&
        source.clean,
      `${source.branch}@${source.commit}, clean=${source.clean}`,
    ),
    condition(
      "original_worktree_unchanged",
      original.branch === metrics.originalWorktreeBranch &&
        original.commit === metrics.originalWorktreeCommit &&
        original.status === metrics.originalWorktreeStatus,
      `${original.branch}@${original.commit}`,
    ),
    condition(
      "safe_persisted_shape",
      forbiddenPersistedKey === undefined,
      forbiddenPersistedKey ?? "no raw, artwork, preview, release, or track keys",
    ),
  ];
  assertCanaryConditionCoverage(conditions);
  return {
    conditions,
    passed: conditions.every((item) => item.passed),
    runId: run.id,
    shardNumber: input.shardNumber,
  };
}

export async function buildCensusResultArtifact(input: {
  branch: string;
  db: RadarDatabase;
  executionCommit: string;
  frozen: CensusFrozenInputs;
}): Promise<CensusResultArtifact> {
  const runs = (await input.db.select().from(itunesPilotRuns))
    .filter((run) => isCensusMetrics(run.metrics))
    .sort(
      (left, right) =>
        censusMetrics(left.metrics).shardNumber - censusMetrics(right.metrics).shardNumber,
    );
  if (runs.length === 0) throw new Error("No census runs exist.");
  const runIds = runs.map((run) => run.id);
  const mappings = await input.db
    .select()
    .from(itunesPilotArtistMappings)
    .where(inArray(itunesPilotArtistMappings.runId, runIds));
  const events = await input.db
    .select()
    .from(itunesPilotRequestEvents)
    .where(inArray(itunesPilotRequestEvents.runId, runIds))
    .orderBy(asc(itunesPilotRequestEvents.startedAt));
  const cacheRows = await input.db.select().from(itunesPilotResponseCache);
  const [requestCount] = await input.db.select({ value: count() }).from(itunesPilotRequestEvents);
  const mappingByRunArtist = new Map(
    mappings.map((mapping) => [`${mapping.runId}:${mapping.canonicalArtistId}`, mapping]),
  );
  const runByShard = new Map(runs.map((run) => [censusMetrics(run.metrics).shardNumber, run]));
  const manifestByArtist = new Map(
    input.frozen.manifest.items.map((item) => [item.canonicalArtistId, item]),
  );
  const artists: CensusArtifactArtist[] = input.frozen.snapshot.artists
    .map((artist) => {
      const manifestItem = manifestByArtist.get(artist.canonicalArtistId)!;
      const run = runByShard.get(manifestItem.assignedShard);
      const mapping = run
        ? mappingByRunArtist.get(`${run.id}:${artist.canonicalArtistId}`)
        : undefined;
      const evidence = mapping ? parsedEvidence(mapping.evidence) : undefined;
      const result: CensusArtifactArtist = {
        aliases: artist.aliases,
        cacheProvenance: evidence?.cacheProvenance ?? "not_processed",
        candidateCount: evidence?.candidateCount ?? 0,
        candidates: mapping ? sanitizedCandidates(mapping.candidates) : [],
        canonicalArtistId: artist.canonicalArtistId,
        declaredResultCount: evidence?.declaredResultCount ?? 0,
        displayName: artist.displayName,
        exactAliasCandidateCount: evidence?.exactAliasCandidateCount ?? 0,
        exactCanonicalCandidateCount: evidence?.exactCanonicalCandidateCount ?? 0,
        normalizedName: artist.normalizedName,
        plausibleCandidateIds: evidence?.plausibleCandidateIds ?? [],
        requestIdentity: manifestItem.cacheKeyIdentity,
        ...(run ? { runId: run.id } : {}),
        ...(evidence ? { searchStageMappingState: evidence.searchStageMappingState } : {}),
        searchTerm: manifestItem.normalizedSearchTerm,
        shardNumber: manifestItem.assignedShard,
        spotifyArtistId: artist.spotifyArtistId,
        terminalProcessingState: evidence ? "completed" : "not_processed",
        unknownResultCount: evidence?.unknownResultCount ?? 0,
      };
      return result;
    })
    .sort(
      (left, right) =>
        compareText(left.normalizedName, right.normalizedName) ||
        compareText(left.canonicalArtistId, right.canonicalArtistId),
    );
  const shards = runs.map((run) =>
    buildShardSummary(
      run,
      events.filter((event) => event.runId === run.id),
    ),
  );
  const completenessState = determineCensusCompleteness(
    runs.map((run) => run.status),
    artists.filter((artist) => artist.terminalProcessingState === "completed").length,
    artists.length,
  );
  const analysis = await analyzeCensus({
    artists,
    cacheRows,
    db: input.db,
    frozen: input.frozen,
    runs,
  });
  const content = {
    analysis,
    artists,
    branch: input.branch,
    completenessState,
    executionCommit: input.executionCommit,
    finalCacheRowCount: cacheRows.length,
    finalRequestEventCount: requestCount?.value ?? 0,
    kind: "itunes_full_watchlist_search_census" as const,
    manifest: {
      fileByteSha256: input.frozen.manifestFileByteSha256,
      path: input.frozen.manifestPath,
    },
    requestConfiguration: {
      concurrency: 1 as const,
      entity: "musicArtist" as const,
      language: "en_us" as const,
      limit: 10 as const,
      media: "music" as const,
      minimumRequestStartIntervalMs: 3200 as const,
      path: "/search" as const,
      storefront: "US" as const,
    },
    searchBehaviorFingerprint: censusMetrics(runs[0]!.metrics).behaviorFingerprint,
    shards,
    snapshot: {
      canonicalContentSha256: input.frozen.snapshot.canonicalContentSha256,
      fileByteSha256: input.frozen.snapshotFileByteSha256,
      id: input.frozen.snapshot.snapshotId,
      path: input.frozen.snapshotPath,
    },
    stopReason:
      completenessState === "complete"
        ? "all_census_shards_completed"
        : (runs.at(-1)?.stopReason ?? "census_incomplete"),
    version: 1 as const,
  };
  const { canonicalContentSha256, fileByteSha256 } = censusArtifactContentHashes(content);
  return { ...content, canonicalContentSha256, fileByteSha256 };
}

export function determineCensusCompleteness(
  runStatuses: string[],
  completedArtistCount: number,
  expectedArtistCount: number,
): CensusResultArtifact["completenessState"] {
  if (runStatuses.includes("failed")) return "failed";
  if (
    runStatuses.length === 4 &&
    runStatuses.every((status) => status === "completed") &&
    completedArtistCount === expectedArtistCount
  ) {
    return "complete";
  }
  return "controlled_partial";
}

export function censusArtifactContentHashes(content: unknown): {
  canonicalContentSha256: string;
  fileByteSha256: string;
} {
  return {
    canonicalContentSha256: sha256(JSON.stringify(content)),
    fileByteSha256: sha256(`${JSON.stringify(content, null, 2)}\n`),
  };
}

export async function generateCensusResultArtifactTwice(input: {
  branch: string;
  db: RadarDatabase;
  executionCommit: string;
  frozen: CensusFrozenInputs;
  outputPath: string;
}): Promise<{
  actualFileByteSha256: string;
  artifact: CensusResultArtifact;
  generationPasses: 2;
  outputPath: string;
}> {
  const first = await buildCensusResultArtifact(input);
  const second = await buildCensusResultArtifact(input);
  const firstBytes = `${JSON.stringify(first, null, 2)}\n`;
  const secondBytes = `${JSON.stringify(second, null, 2)}\n`;
  if (
    first.canonicalContentSha256 !== second.canonicalContentSha256 ||
    first.fileByteSha256 !== second.fileByteSha256 ||
    firstBytes !== secondBytes
  ) {
    throw new Error("Repeated census artifact generation was not deterministic.");
  }
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, firstBytes, { encoding: "utf8", flag: "wx" });
  return {
    actualFileByteSha256: sha256(firstBytes),
    artifact: first,
    generationPasses: 2,
    outputPath,
  };
}

export async function loadAndVerifyFrozenForArtifact(input: {
  expectedManifestFileByteSha256: string;
  expectedSnapshotCanonicalContentSha256: string;
  expectedSnapshotFileByteSha256: string;
  manifestPath: string;
  snapshotPath: string;
}) {
  return readCensusFrozenInputs(input);
}

function buildShardSummary(
  run: typeof itunesPilotRuns.$inferSelect,
  events: Array<typeof itunesPilotRequestEvents.$inferSelect>,
): CensusArtifactShard {
  const network = events.filter((event) => !event.cacheHit);
  const intervals = network
    .slice(1)
    .map((event, index) => event.startedAt.getTime() - network[index]!.startedAt.getTime());
  const overlapCount = network.slice(1).filter((event, index) => {
    const prior = network[index]!;
    return prior.completedAt !== null && event.startedAt < prior.completedAt;
  }).length;
  const uniqueNetworkIdentities = new Set(network.map((event) => event.requestIdentity)).size;
  const metrics = censusMetrics(run.metrics);
  return {
    artistCount: Number(metrics.actualMappingCount ?? 0),
    cacheHitCount: events.filter((event) => event.cacheHit).length,
    errorCount: events.filter((event) => event.errorClassification || event.status !== 200).length,
    http429Count: events.filter((event) => event.status === 429).length,
    ...(intervals.length > 0 ? { minimumNetworkStartIntervalMs: Math.min(...intervals) } : {}),
    networkRequestCount: network.length,
    overlapCount,
    parseOrResponseBoundErrorCount: events.filter((event) =>
      ["malformed_json", "invalid_response", "response_too_large"].includes(
        event.errorClassification ?? "",
      ),
    ).length,
    retryCount: Math.max(0, network.length - uniqueNetworkIdentities),
    runId: run.id,
    runtimeMs:
      run.startedAt && run.completedAt ? run.completedAt.getTime() - run.startedAt.getTime() : 0,
    shardNumber: metrics.shardNumber,
    status: run.status,
    stopReason: run.stopReason ?? "",
  };
}

async function analyzeCensus(input: {
  artists: CensusArtifactArtist[];
  cacheRows: Array<typeof itunesPilotResponseCache.$inferSelect>;
  db: RadarDatabase;
  frozen: CensusFrozenInputs;
  runs: Array<typeof itunesPilotRuns.$inferSelect>;
}): Promise<CensusAnalysis> {
  const states: SearchStageMappingState[] = [
    "unique_exact_canonical",
    "unique_alias_supported",
    "competing_exact_or_alias",
    "no_exact_or_alias_candidate",
    "invalid_input",
    "rejected_unsafe_result",
  ];
  const mappingCounts = Object.fromEntries(
    states.map((state) => [
      state,
      input.artists.filter((artist) => artist.searchStageMappingState === state).length,
    ]),
  ) as Record<SearchStageMappingState, number>;
  const completed = input.artists.filter(
    (artist) => artist.terminalProcessingState === "completed",
  );
  const mapped = mappingCounts.unique_exact_canonical + mappingCounts.unique_alias_supported;
  const plausibleIds = [
    ...new Set(input.artists.flatMap((artist) => artist.plausibleCandidateIds)),
  ].sort(compareText);
  const albumCache = cachedLookupIds(input.cacheRows, "album");
  const songCache = cachedLookupIds(input.cacheRows, "song");
  const newRequests = plausibleIds.flatMap((id) => [
    ...(albumCache.has(id) ? [] : [`album:${id}`]),
    ...(songCache.has(id) ? [] : [`song:${id}`]),
  ]);
  const requestCountsByShard = chunk(newRequests, 150).map((members) => members.length);
  const legacyArtists = await input.db
    .select()
    .from(itunesPilotSnapshotArtists)
    .where(eq(itunesPilotSnapshotArtists.snapshotId, "5c7c27ec-9432-4457-8787-aa3bba582eea"));
  const originalIds = new Set(legacyArtists.map((artist) => artist.canonicalArtistId));
  const original = input.artists.filter((artist) => originalIds.has(artist.canonicalArtistId));
  const originalCounts: Partial<Record<SearchStageMappingState, number>> = {};
  for (const state of states) {
    const value = original.filter((artist) => artist.searchStageMappingState === state).length;
    if (value > 0) originalCounts[state] = value;
  }
  const priorMappings = await input.db
    .select()
    .from(itunesPilotArtistMappings)
    .where(eq(itunesPilotArtistMappings.runId, "e51a57f6-2f95-4e6d-868b-f30ed43f90fd"));
  const priorByArtist = new Map(
    priorMappings.map((mapping) => [mapping.canonicalArtistId, mapping]),
  );
  const discrepancies = original
    .filter((artist) => {
      const prior = priorByArtist.get(artist.canonicalArtistId);
      if (!prior) return true;
      if (prior.status === "exact_confirmed") {
        return artist.searchStageMappingState !== "unique_exact_canonical";
      }
      if (prior.status === "ambiguous") {
        return !["competing_exact_or_alias", "no_exact_or_alias_candidate"].includes(
          artist.searchStageMappingState ?? "",
        );
      }
      return false;
    })
    .map((artist) => artist.displayName);
  return {
    ambiguousArtistCount: mappingCounts.competing_exact_or_alias,
    artistsAtResultLimit: completed
      .filter((artist) => artist.declaredResultCount >= 10)
      .map((artist) => artist.displayName),
    candidateCountBands: {
      maximumResultCount: completed.filter((artist) => artist.declaredResultCount >= 10).length,
      one: completed.filter((artist) => artist.candidateCount === 1).length,
      sixToNine: completed.filter(
        (artist) => artist.candidateCount >= 6 && artist.candidateCount <= 9,
      ).length,
      threeToFive: completed.filter(
        (artist) => artist.candidateCount >= 3 && artist.candidateCount <= 5,
      ).length,
      two: completed.filter((artist) => artist.candidateCount === 2).length,
      zero: completed.filter((artist) => artist.candidateCount === 0).length,
    },
    candidateCountDistribution: distribution(completed.map((artist) => artist.candidateCount)),
    exactNameCandidateIdCount: completed.reduce(
      (total, artist) => total + artist.exactCanonicalCandidateCount,
      0,
    ),
    exactNameCompetitorDistribution: distribution(
      completed.map((artist) => artist.exactCanonicalCandidateCount),
    ),
    futureCatalogEvidence: {
      albumCacheCandidateIds: plausibleIds.filter((id) => albumCache.has(id)).length,
      newAlbumRequests: plausibleIds.filter((id) => !albumCache.has(id)).length,
      newSongRequests: plausibleIds.filter((id) => !songCache.has(id)).length,
      newTotalRequests: newRequests.length,
      projectedRuntimeMs: newRequests.length * 3200,
      requestCountsByShard,
      shardCount: requestCountsByShard.length,
      songCacheCandidateIds: plausibleIds.filter((id) => songCache.has(id)).length,
    },
    mappingCounts,
    maximumCandidateCount: Math.max(0, ...completed.map((artist) => artist.candidateCount)),
    originalCohort: {
      artistsFound: original.length,
      cacheRowsReused: original.filter((artist) => artist.cacheProvenance === "original_cache")
        .length,
      discrepancies,
      mappingCounts: originalCounts,
    },
    plausibleCandidateIdCount: plausibleIds.length,
    searchStageMappingCoverage: completed.length === 0 ? 0 : mapped / completed.length,
    totalNormalizedAppleCandidates: completed.reduce(
      (total, artist) => total + artist.candidateCount,
      0,
    ),
    unresolvedIdentityRate:
      completed.length === 0 ? 0 : (completed.length - mapped) / completed.length,
  };
}

function cachedLookupIds(
  rows: Array<typeof itunesPilotResponseCache.$inferSelect>,
  entity: "album" | "song",
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    try {
      const url = new URL(row.requestIdentity, "https://itunes.apple.com");
      const id = url.searchParams.get("id");
      if (
        url.pathname === "/lookup" &&
        url.searchParams.get("entity") === entity &&
        id &&
        !id.includes(",") &&
        usableNormalizedResponse(row.response)
      ) {
        ids.add(id);
      }
    } catch {
      continue;
    }
  }
  return ids;
}

function usableNormalizedResponse(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return (
    Array.isArray(response.artists) &&
    Array.isArray(response.collections) &&
    Array.isArray(response.tracks) &&
    typeof response.declaredResultCount === "number" &&
    typeof response.unknownResultCount === "number"
  );
}

function parsedEvidence(value: unknown): CensusArtistEvidence {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1
  ) {
    throw new Error("Census mapping evidence is missing or invalid.");
  }
  return value as CensusArtistEvidence;
}

function sanitizedCandidates(value: unknown): Array<{ artistId: string; artistName: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (candidate): candidate is { artistId: string; artistName: string } =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        typeof (candidate as { artistId?: unknown }).artistId === "string" &&
        typeof (candidate as { artistName?: unknown }).artistName === "string",
    )
    .map((candidate) => ({
      artistId: candidate.artistId,
      artistName: candidate.artistName,
    }));
}

function condition(name: string, passed: boolean, detail: string): CanaryCondition {
  return { detail, name, passed };
}

function assertCanaryConditionCoverage(conditions: CanaryCondition[]): void {
  const actual = conditions.map((item) => item.name);
  if (
    actual.length !== censusCanaryConditionNames.length ||
    actual.some((name, index) => name !== censusCanaryConditionNames[index])
  ) {
    throw new Error("Census canary condition coverage changed.");
  }
}

function duplicateCount(values: string[]): number {
  return values.length - new Set(values).size;
}

function findForbiddenPersistedKey(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = findForbiddenPersistedKey(value[index], `${path}[${index}]`);
      if (result) return result;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (
      /(^|_)(raw|payload|artwork|preview|release|track|credential|token|authorization)(_|$)/.test(
        normalized,
      )
    ) {
      return path ? `${path}.${key}` : key;
    }
    const result = findForbiddenPersistedKey(child, path ? `${path}.${key}` : key);
    if (result) return result;
  }
  return undefined;
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

function distribution(values: number[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[String(value)] = (result[String(value)] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => Number(left) - Number(right)),
  );
}

function chunk<T>(values: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
