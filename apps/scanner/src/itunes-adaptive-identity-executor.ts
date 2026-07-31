import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createItunesRequestPersistence,
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
  type ItunesNormalizedResponse,
  type ProviderConfiguration,
} from "@radar/providers";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  evaluateArtist,
  experimentCanaryLimit,
  experimentNetworkBudget,
  experimentRunKind,
  hashCanonical,
  serializeHashedArtifact,
  validateExperimentExecutionGate,
  type ArtistExperimentDecision,
  type ExperimentControlArtifact,
  type ExperimentFrozenInputs,
} from "./itunes-adaptive-identity-experiment";
import type { AdaptiveRequest } from "./itunes-adaptive-identity-planner";

const legacyAnchorSnapshotHash = "48259f7e2016aa8bbbabf4baa7e3baf8d4f9e9b53b413dab56f9d4fc70e1278a";

export interface ExperimentRunMetrics {
  controlCanonicalContentSha256: string;
  controlPath: string;
  expectedCacheHits: 19;
  expectedNetworkRequests: 79;
  expectedOperations: 98;
  initialCacheRows: number;
  initialMusicBrainzRequestEvents: number;
  initialRequestEvents: number;
  initialSpotifyRequestEvents: number;
  manifestCanonicalContentSha256: string;
  manifestFileSha256: string;
  runKind: typeof experimentRunKind;
  sourceBranch: string;
  sourceCommit: string;
  [key: string]: boolean | number | string;
}

export interface ExperimentSegmentResult {
  cacheHits: number;
  completedOperations: number;
  networkRequests: number;
  runId: string;
  status: "completed" | "controlled_partial" | "failed";
  stopReason: string;
}

export interface ExperimentResultArtifact {
  artists: Array<
    ArtistExperimentDecision & {
      controlLabel: string;
      controlOutcome: "correct" | "incorrect" | "unlabeled" | "unresolved";
      candidateSetReduction: number;
      originalCandidateCount: number;
      outsideTop10CandidateIds: string[];
      outsideTop10Selected: boolean;
    }
  >;
  branch: string;
  canonicalContentSha256: string;
  completenessState: "complete" | "controlled_partial";
  controlsCanonicalContentSha256: string;
  executionCommit: string;
  finalTotals: {
    cacheRows: number;
    requestEvents: number;
  };
  frozenInputs: {
    censusFileSha256: string;
    censusPath: string;
    historicalFileSha256: string;
    historicalPath: string;
    manifestFileSha256: string;
    manifestPath: string;
  };
  kind: "itunes_adaptive_identity_experiment_result";
  operations: Array<{
    cacheHit: boolean;
    canonicalArtistId: string;
    completedAt: string;
    endpointCategory: string;
    errorClassification: string;
    requestIdentity: string;
    requestOrder: number;
    responseBytes: number;
    startedAt: string;
    status: number;
    strategy: string;
  }>;
  operational: {
    cacheHits: number;
    completedOperations: number;
    errors: number;
    http429s: number;
    minimumNetworkPacingMs: number;
    networkRequests: number;
    overlapCount: number;
    plannedOperations: 98;
    retries: number;
    runtimeMs: number;
    byEndpoint: Record<string, number>;
    byStrategy: Record<string, number>;
    errorClassifications: Record<string, number>;
  };
  runId: string;
  stopReason: string;
  terminalStatus: string;
  version: 1;
}

export async function executeExperimentSegment(input: {
  configuration: ProviderConfiguration;
  controlArtifactPath: string;
  db: RadarDatabase;
  expectedBranch: string;
  expectedCommit: string;
  explicitLive: boolean;
  frozen: ExperimentFrozenInputs;
  maximumNetworkRequests: number;
  mode: "canary" | "continue";
  runtimeMs: number;
}): Promise<ExperimentSegmentResult> {
  const source = gitState();
  const control = await readControlArtifact(input.controlArtifactPath);
  const allRuns = await input.db.select().from(itunesPilotRuns);
  const experimentRuns = allRuns.filter((run) => isExperimentMetrics(run.metrics));
  if (experimentRuns.length > 1) throw new Error("More than one adaptive experiment run exists.");
  const existing = experimentRuns[0];
  const providerState = await input.db.query.itunesPilotProviderState.findFirst({
    where: eq(itunesPilotProviderState.id, "global"),
  });
  validateExperimentExecutionGate({
    activeLease: Boolean(providerState?.leaseOwner || providerState?.leaseExpiresAt),
    activeRun: allRuns.some(
      (run) => run.id !== existing?.id && (run.status === "running" || run.status === "planned"),
    ),
    branch: source.branch,
    clean: source.clean,
    databaseUrl: input.configuration.databaseUrl,
    explicitLive: input.explicitLive,
    expectedBranch: input.expectedBranch,
    expectedCommit: input.expectedCommit,
    itunesEnabled: input.configuration.itunes.enabled,
    manifestValid: true,
    maximumNetworkRequests: input.maximumNetworkRequests,
    nonItunesDisabled: nonItunesDisabled(input.configuration),
    runtimeMs: input.runtimeMs,
    sourceCommit: source.commit,
  });
  assertFrozenRuntime(input.configuration);
  if (control.manifestCanonicalContentSha256 !== input.frozen.manifest.canonicalContentSha256) {
    throw new Error("Control labels do not reference the frozen experiment manifest.");
  }
  if (input.mode === "canary" && existing) {
    throw new Error("The canary can run only before an experiment run exists.");
  }
  if (input.mode === "continue" && existing?.status !== "controlled_partial") {
    throw new Error("Continuation requires the controlled-partial canary run.");
  }
  await assertManifestCacheState(input.db, input.frozen.manifest.requests, existing?.id);
  const baseline = await databaseBaseline(input.db);
  const run = existing
    ? await resumeRun(input.db, existing)
    : await createRun(input.db, {
        control,
        controlPath: resolve(input.controlArtifactPath),
        expectedCommit: input.expectedCommit,
        frozen: input.frozen,
        initial: baseline,
        runtimeMs: input.runtimeMs,
      });
  const existingEvents = await input.db
    .select()
    .from(itunesPilotRequestEvents)
    .where(eq(itunesPilotRequestEvents.runId, run.id));
  const completed = new Set(existingEvents.map((event) => event.requestIdentity));
  if (completed.size !== existingEvents.length) {
    throw new Error("Duplicate request identities already exist in the experiment run.");
  }
  const client = new ItunesClient({
    enabled: true,
    language: input.configuration.itunes.language,
    maxRequestsPerRun: experimentNetworkBudget,
    maxResponseBytes: input.configuration.itunes.maxResponseBytes,
    minRequestIntervalMs: input.configuration.itunes.minRequestIntervalMs,
    persistence: createItunesRequestPersistence(input.db),
    requestTimeoutMs: input.configuration.itunes.requestTimeoutMs,
    storefront: input.configuration.itunes.storefront,
  });
  let segmentNetworkStarts = 0;
  let status: ExperimentSegmentResult["status"] = "completed";
  let stopReason = "adaptive_experiment_completed";
  const startedAt = Date.now();
  try {
    for (const request of input.frozen.manifest.requests) {
      if (completed.has(request.cacheIdentity)) continue;
      if (input.mode === "canary" && segmentNetworkStarts >= experimentCanaryLimit) {
        status = "controlled_partial";
        stopReason = "adaptive_canary_pause";
        break;
      }
      if (Date.now() - startedAt >= input.runtimeMs) {
        status = "controlled_partial";
        stopReason = "adaptive_runtime_ceiling_reached";
        break;
      }
      const before = await runEventCount(input.db, run.id);
      if (request.operationType === "targeted_collection_search") {
        await client.searchCollectionsExact(run.id, {
          cacheIdentity: request.cacheIdentity,
          parameters: request.normalizedParameters,
        });
      } else {
        await client.lookupAlbums(run.id, [request.normalizedParameters.id!]);
      }
      const events = await input.db
        .select()
        .from(itunesPilotRequestEvents)
        .where(
          and(
            eq(itunesPilotRequestEvents.runId, run.id),
            eq(itunesPilotRequestEvents.requestIdentity, request.cacheIdentity),
          ),
        );
      if (
        events.length !== 1 ||
        events[0]!.status !== 200 ||
        events[0]!.errorClassification ||
        events[0]!.retryAfterSeconds
      ) {
        throw new Error("Unexpected retry or request anomaly.");
      }
      const after = await runEventCount(input.db, run.id);
      if (after !== before + 1) throw new Error("Operation attribution is not one-to-one.");
      if (!events[0]!.cacheHit) segmentNetworkStarts += 1;
      completed.add(request.cacheIdentity);
      await assertExecutionInputsUnchanged(input.frozen, input.expectedCommit);
    }
    if (status === "completed") {
      await persistFinalMappings(input.db, run.id, input.frozen);
    }
    const integrity = await verifyRunIntegrity(input.db, run.id, input.frozen.manifest.requests);
    if (!integrity.passed) throw new Error(integrity.reasons.join("; "));
    if (status === "completed" && integrity.completedOperations !== 98) {
      throw new Error("Completed experiment does not contain all 98 operations.");
    }
    if (input.mode === "canary" && status === "controlled_partial") {
      if (segmentNetworkStarts > experimentCanaryLimit || segmentNetworkStarts < 1) {
        throw new Error("Canary network segment was outside its 1 to 15 request bound.");
      }
    }
  } catch (error) {
    status = "failed";
    stopReason = safeFailure(error);
  }
  const integrity = await verifyRunIntegrity(input.db, run.id, input.frozen.manifest.requests);
  const completedAt = new Date();
  const metrics = {
    ...experimentMetrics(run.metrics),
    actualCacheHits: integrity.cacheHits,
    actualNetworkRequests: integrity.networkRequests,
    completedOperations: integrity.completedOperations,
    mappingCount: integrity.mappingCount,
    runtimeMs: completedAt.getTime() - startedAt,
  };
  await input.db
    .update(itunesPilotRuns)
    .set({
      completedAt,
      metrics,
      status,
      stopReason,
      updatedAt: completedAt,
    })
    .where(eq(itunesPilotRuns.id, run.id));
  return {
    cacheHits: integrity.cacheHits,
    completedOperations: integrity.completedOperations,
    networkRequests: integrity.networkRequests,
    runId: run.id,
    status,
    stopReason,
  };
}

export async function verifyExperiment(input: {
  db: RadarDatabase;
  frozen: ExperimentFrozenInputs;
  requireComplete: boolean;
}): Promise<Awaited<ReturnType<typeof verifyRunIntegrity>> & { runId: string; status: string }> {
  const run = (await input.db.select().from(itunesPilotRuns)).find((row) =>
    isExperimentMetrics(row.metrics),
  );
  if (!run) throw new Error("Adaptive experiment run does not exist.");
  const integrity = await verifyRunIntegrity(input.db, run.id, input.frozen.manifest.requests);
  return {
    ...integrity,
    passed:
      integrity.passed &&
      (!input.requireComplete ||
        (run.status === "completed" && integrity.completedOperations === 98)),
    runId: run.id,
    status: run.status,
  };
}

export async function generateExperimentArtifactTwice(input: {
  branch: string;
  controlArtifactPath: string;
  db: RadarDatabase;
  executionCommit: string;
  frozen: ExperimentFrozenInputs;
  outputPath: string;
}): Promise<{ artifact: ExperimentResultArtifact; fileByteSha256: string; outputPath: string }> {
  const first = await buildExperimentArtifact(input);
  const second = await buildExperimentArtifact(input);
  const firstText = serializeHashedArtifact(first);
  const secondText = serializeHashedArtifact(second);
  if (first.canonicalContentSha256 !== second.canonicalContentSha256 || firstText !== secondText) {
    throw new Error("Repeated experiment artifact generation was not deterministic.");
  }
  const outputPath = resolve(input.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, firstText, "utf8");
  return {
    artifact: first,
    fileByteSha256: createHash("sha256").update(firstText).digest("hex"),
    outputPath,
  };
}

export async function buildExperimentArtifact(input: {
  branch: string;
  controlArtifactPath: string;
  db: RadarDatabase;
  executionCommit: string;
  frozen: ExperimentFrozenInputs;
}): Promise<ExperimentResultArtifact> {
  const runs = (await input.db.select().from(itunesPilotRuns)).filter((run) =>
    isExperimentMetrics(run.metrics),
  );
  if (runs.length !== 1) throw new Error("Expected exactly one adaptive experiment run.");
  const run = runs[0]!;
  const [events, cacheRows, controls, baseline] = await Promise.all([
    input.db
      .select()
      .from(itunesPilotRequestEvents)
      .where(eq(itunesPilotRequestEvents.runId, run.id))
      .orderBy(asc(itunesPilotRequestEvents.startedAt)),
    input.db
      .select()
      .from(itunesPilotResponseCache)
      .where(
        inArray(
          itunesPilotResponseCache.requestIdentity,
          input.frozen.manifest.requests.map((request) => request.cacheIdentity),
        ),
      ),
    readControlArtifact(input.controlArtifactPath),
    databaseBaseline(input.db),
  ]);
  const eventByIdentity = new Map(events.map((event) => [event.requestIdentity, event]));
  const responseByIdentity = new Map(
    cacheRows.map((row) => [row.requestIdentity, asNormalizedResponse(row.response)]),
  );
  const historicalById = new Map(
    input.frozen.historical.artists.map((artist) => [artist.canonicalArtistId, artist]),
  );
  const controlById = new Map(
    controls.controls.map((control) => [control.canonicalArtistId, control]),
  );
  const artists = input.frozen.manifest.artists.map((manifestArtist) => {
    const historical = historicalById.get(manifestArtist.canonicalArtistId);
    if (!historical) throw new Error("Historical evidence is missing a manifest artist.");
    const operations = input.frozen.manifest.requests.filter(
      (request) => request.canonicalArtistId === manifestArtist.canonicalArtistId,
    );
    const completed = operations.filter(
      (request) =>
        eventByIdentity.has(request.cacheIdentity) && responseByIdentity.has(request.cacheIdentity),
    );
    const decision = evaluateArtist({
      albumResponses: completed
        .filter((request) => request.strategy === "album_first")
        .map((request) => ({ request, response: responseByIdentity.get(request.cacheIdentity)! })),
      artist: historical,
      stratum: manifestArtist.stratum,
      targetedResponses: completed
        .filter((request) => request.strategy === "targeted_search")
        .map((request) => ({ request, response: responseByIdentity.get(request.cacheIdentity)! })),
    });
    const control = controlById.get(manifestArtist.canonicalArtistId);
    const controlOutcome: "correct" | "incorrect" | "unlabeled" | "unresolved" = !control
      ? "unlabeled"
      : control.labelKind === "unresolved_control" || decision.hybrid.state !== "resolved"
        ? "unresolved"
        : decision.hybrid.selectedArtistId === control.previouslySelectedAppleArtistId
          ? "correct"
          : "incorrect";
    const originalCandidateIds = censusCandidateIds(
      input.frozen.census,
      manifestArtist.canonicalArtistId,
    );
    const finalCandidateCount =
      decision.hybrid.state === "resolved"
        ? 1
        : new Set([...decision.albumFirst.candidateIds, ...decision.targetedSearch.candidateIds])
            .size;
    const outsideTop10CandidateIds = decision.targetedSearch.candidateIds.filter(
      (id) => !originalCandidateIds.includes(id),
    );
    return {
      ...decision,
      candidateSetReduction: Math.max(0, originalCandidateIds.length - finalCandidateCount),
      controlLabel: control?.labelKind ?? "",
      controlOutcome,
      originalCandidateCount: originalCandidateIds.length,
      outsideTop10CandidateIds,
      outsideTop10Selected:
        decision.hybrid.state === "resolved" &&
        outsideTop10CandidateIds.includes(decision.hybrid.selectedArtistId),
    };
  });
  const starts = events
    .filter((event) => !event.cacheHit)
    .map((event) => event.startedAt.getTime());
  const spacings = starts.slice(1).map((start, index) => start - starts[index]!);
  const overlapCount = events.filter(
    (event, index) =>
      !event.cacheHit &&
      events
        .slice(0, index)
        .some(
          (prior) =>
            !prior.cacheHit &&
            prior.startedAt < event.startedAt &&
            (!prior.completedAt || prior.completedAt > event.startedAt),
        ),
  ).length;
  const operations = input.frozen.manifest.requests
    .filter((request) => eventByIdentity.has(request.cacheIdentity))
    .map((request) => {
      const event = eventByIdentity.get(request.cacheIdentity)!;
      return {
        cacheHit: event.cacheHit,
        canonicalArtistId: request.canonicalArtistId,
        completedAt: event.completedAt?.toISOString() ?? "",
        endpointCategory: event.endpointCategory,
        errorClassification: event.errorClassification ?? "",
        requestIdentity: request.cacheIdentity,
        requestOrder: request.requestOrder,
        responseBytes: event.responseBytes,
        startedAt: event.startedAt.toISOString(),
        status: event.status ?? 0,
        strategy: request.strategy,
      };
    });
  const content = {
    artists,
    branch: input.branch,
    completenessState:
      run.status === "completed" ? ("complete" as const) : ("controlled_partial" as const),
    controlsCanonicalContentSha256: controls.canonicalContentSha256,
    executionCommit: input.executionCommit,
    finalTotals: { cacheRows: baseline.cacheRows, requestEvents: baseline.requestEvents },
    frozenInputs: {
      censusFileSha256: input.frozen.censusFileSha256,
      censusPath: input.frozen.censusPath,
      historicalFileSha256: input.frozen.historicalFileSha256,
      historicalPath: input.frozen.historicalPath,
      manifestFileSha256: input.frozen.manifestFileSha256,
      manifestPath: input.frozen.manifestPath,
    },
    kind: "itunes_adaptive_identity_experiment_result" as const,
    operations,
    operational: {
      cacheHits: events.filter((event) => event.cacheHit).length,
      completedOperations: events.length,
      errors: events.filter(
        (event) => event.errorClassification || event.status !== 200 || event.retryAfterSeconds,
      ).length,
      http429s: events.filter((event) => event.status === 429).length,
      minimumNetworkPacingMs: spacings.length > 0 ? Math.min(...spacings) : 0,
      networkRequests: starts.length,
      overlapCount,
      plannedOperations: 98 as const,
      retries: events.length - new Set(events.map((event) => event.requestIdentity)).size,
      runtimeMs:
        events.length === 0
          ? 0
          : Math.max(
              ...events.map((event) => event.completedAt?.getTime() ?? event.startedAt.getTime()),
            ) - Math.min(...events.map((event) => event.startedAt.getTime())),
      byEndpoint: countValues(operations.map((operation) => operation.endpointCategory)),
      byStrategy: countValues(operations.map((operation) => operation.strategy)),
      errorClassifications: countValues(
        operations.map((operation) => operation.errorClassification).filter(Boolean),
      ),
    },
    runId: run.id,
    stopReason: run.stopReason ?? "",
    terminalStatus: run.status,
    version: 1 as const,
  };
  return { ...content, canonicalContentSha256: hashCanonical(content) };
}

async function verifyRunIntegrity(
  db: RadarDatabase,
  runId: string,
  manifest: AdaptiveRequest[],
): Promise<{
  cacheHits: number;
  completedOperations: number;
  mappingCount: number;
  minimumNetworkPacingMs: number;
  networkRequests: number;
  overlapCount: number;
  passed: boolean;
  reasons: string[];
}> {
  const events = await db
    .select()
    .from(itunesPilotRequestEvents)
    .where(eq(itunesPilotRequestEvents.runId, runId))
    .orderBy(asc(itunesPilotRequestEvents.startedAt));
  const [mappingRow] = await db
    .select({ value: count() })
    .from(itunesPilotArtistMappings)
    .where(eq(itunesPilotArtistMappings.runId, runId));
  const mappingCount = mappingRow?.value ?? 0;
  const allowed = new Map(manifest.map((request) => [request.cacheIdentity, request]));
  const reasons: string[] = [];
  if (new Set(events.map((event) => event.requestIdentity)).size !== events.length)
    reasons.push("duplicate request identity");
  if (events.some((event) => !allowed.has(event.requestIdentity)))
    reasons.push("request outside manifest");
  if (
    events.some((event) => {
      const request = allowed.get(event.requestIdentity);
      return (
        !request ||
        (request.operationType === "artist_album_lookup" &&
          event.endpointCategory !== "artist_albums") ||
        (request.operationType === "targeted_collection_search" &&
          event.endpointCategory !== "targeted_collection_search")
      );
    })
  )
    reasons.push("endpoint attribution mismatch");
  if (
    events.some(
      (event) =>
        event.status !== 200 ||
        event.errorClassification !== null ||
        event.retryAfterSeconds !== null,
    )
  )
    reasons.push("request error");
  const network = events.filter((event) => !event.cacheHit);
  const spacings = network
    .slice(1)
    .map((event, index) => event.startedAt.getTime() - network[index]!.startedAt.getTime());
  if (spacings.some((spacing) => spacing < 3200)) reasons.push("pacing below 3200 ms");
  const overlapCount = network.filter((event, index) =>
    network
      .slice(0, index)
      .some(
        (prior) =>
          prior.startedAt < event.startedAt &&
          (!prior.completedAt || prior.completedAt > event.startedAt),
      ),
  ).length;
  if (overlapCount > 0) reasons.push("request overlap");
  if (network.length > 79) reasons.push("network request budget exceeded");
  if (events.length === 98 && mappingCount !== 50) reasons.push("terminal artist mapping count");
  return {
    cacheHits: events.filter((event) => event.cacheHit).length,
    completedOperations: events.length,
    mappingCount,
    minimumNetworkPacingMs: spacings.length ? Math.min(...spacings) : 0,
    networkRequests: network.length,
    overlapCount,
    passed: reasons.length === 0,
    reasons,
  };
}

async function assertManifestCacheState(
  db: RadarDatabase,
  manifest: AdaptiveRequest[],
  currentRunId?: string,
): Promise<void> {
  const rows = await db
    .select({ identity: itunesPilotResponseCache.requestIdentity })
    .from(itunesPilotResponseCache)
    .where(
      inArray(
        itunesPilotResponseCache.requestIdentity,
        manifest.map((row) => row.cacheIdentity),
      ),
    );
  const cached = new Set(rows.map((row) => row.identity));
  const completed = new Set<string>();
  if (currentRunId) {
    const events = await db
      .select()
      .from(itunesPilotRequestEvents)
      .where(eq(itunesPilotRequestEvents.runId, currentRunId));
    for (const event of events) {
      if (event.status === 200 && !event.errorClassification) completed.add(event.requestIdentity);
    }
  }
  for (const request of manifest) {
    if (
      cached.has(request.cacheIdentity) !==
      (request.cacheHit || completed.has(request.cacheIdentity))
    ) {
      throw new Error(`Frozen cache state changed for ${request.canonicalArtistId}.`);
    }
  }
}

async function createRun(
  db: RadarDatabase,
  input: {
    control: ExperimentControlArtifact;
    controlPath: string;
    expectedCommit: string;
    frozen: ExperimentFrozenInputs;
    initial: Awaited<ReturnType<typeof databaseBaseline>>;
    runtimeMs: number;
  },
) {
  const anchor = await db.query.itunesPilotSnapshots.findFirst({
    where: eq(itunesPilotSnapshots.snapshotHash, legacyAnchorSnapshotHash),
  });
  if (!anchor) throw new Error("Legacy pilot snapshot anchor is missing.");
  const now = new Date();
  const metrics: ExperimentRunMetrics = {
    controlCanonicalContentSha256: input.control.canonicalContentSha256,
    controlPath: input.controlPath,
    expectedCacheHits: 19,
    expectedNetworkRequests: 79,
    expectedOperations: 98,
    initialCacheRows: input.initial.cacheRows,
    initialMusicBrainzRequestEvents: input.initial.musicbrainzRequestEvents,
    initialRequestEvents: input.initial.requestEvents,
    initialSpotifyRequestEvents: input.initial.spotifyRequestEvents,
    manifestCanonicalContentSha256: input.frozen.manifest.canonicalContentSha256,
    manifestFileSha256: input.frozen.manifestFileSha256,
    runKind: experimentRunKind,
    sourceBranch: gitState().branch,
    sourceCommit: input.expectedCommit,
  };
  const [run] = await db
    .insert(itunesPilotRuns)
    .values({
      deadlineAt: new Date(now.getTime() + input.runtimeMs),
      implementationCommit: input.expectedCommit,
      maximumRuntimeMs: input.runtimeMs,
      metrics,
      minRequestIntervalMs: 3200,
      requestBudget: 79,
      snapshotId: anchor.id,
      startedAt: now,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("Adaptive experiment run could not be created.");
  return run;
}

async function resumeRun(db: RadarDatabase, run: typeof itunesPilotRuns.$inferSelect) {
  const now = new Date();
  const [resumed] = await db
    .update(itunesPilotRuns)
    .set({
      completedAt: null,
      deadlineAt: run.deadlineAt,
      status: "running",
      stopReason: null,
      updatedAt: now,
    })
    .where(and(eq(itunesPilotRuns.id, run.id), eq(itunesPilotRuns.status, "controlled_partial")))
    .returning();
  if (!resumed) throw new Error("Adaptive experiment run could not be resumed.");
  return resumed;
}

async function readControlArtifact(path: string): Promise<ExperimentControlArtifact> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as ExperimentControlArtifact;
  const { canonicalContentSha256, ...content } = parsed;
  if (
    parsed.kind !== "itunes_adaptive_identity_control_labels" ||
    hashCanonical(content) !== canonicalContentSha256
  ) {
    throw new Error("Control-label artifact is invalid.");
  }
  return parsed;
}

async function assertExecutionInputsUnchanged(
  frozen: ExperimentFrozenInputs,
  expectedCommit: string,
): Promise<void> {
  const source = gitState();
  if (
    !source.clean ||
    source.commit !== expectedCommit ||
    source.branch !== "codex/itunes-discovery"
  ) {
    throw new Error("Source branch, commit, or clean state changed during live execution.");
  }
  const [census, historical, manifest] = await Promise.all([
    readFile(frozen.censusPath),
    readFile(frozen.historicalPath),
    readFile(frozen.manifestPath),
  ]);
  if (
    fileHash(census) !== frozen.censusFileSha256 ||
    fileHash(historical) !== frozen.historicalFileSha256 ||
    fileHash(manifest) !== frozen.manifestFileSha256
  ) {
    throw new Error("A frozen experiment input changed during live execution.");
  }
}

async function databaseBaseline(db: RadarDatabase) {
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

async function persistFinalMappings(
  db: RadarDatabase,
  runId: string,
  frozen: ExperimentFrozenInputs,
): Promise<void> {
  const cacheRows = await db
    .select()
    .from(itunesPilotResponseCache)
    .where(
      inArray(
        itunesPilotResponseCache.requestIdentity,
        frozen.manifest.requests.map((request) => request.cacheIdentity),
      ),
    );
  const responses = new Map(
    cacheRows.map((row) => [row.requestIdentity, asNormalizedResponse(row.response)]),
  );
  const history = new Map(
    frozen.historical.artists.map((artist) => [artist.canonicalArtistId, artist]),
  );
  for (const manifestArtist of frozen.manifest.artists) {
    const artist = history.get(manifestArtist.canonicalArtistId);
    if (!artist) throw new Error("Historical evidence is missing a manifest artist.");
    const operations = frozen.manifest.requests.filter(
      (request) => request.canonicalArtistId === manifestArtist.canonicalArtistId,
    );
    if (operations.some((request) => !responses.has(request.cacheIdentity))) {
      throw new Error("A completed artist is missing a normalized cached response.");
    }
    const decision = evaluateArtist({
      albumResponses: operations
        .filter((request) => request.strategy === "album_first")
        .map((request) => ({ request, response: responses.get(request.cacheIdentity)! })),
      artist,
      stratum: manifestArtist.stratum,
      targetedResponses: operations
        .filter((request) => request.strategy === "targeted_search")
        .map((request) => ({ request, response: responses.get(request.cacheIdentity)! })),
    });
    await db
      .insert(itunesPilotArtistMappings)
      .values({
        ambiguityReason:
          decision.hybrid.state === "resolved"
            ? null
            : "Adaptive methods did not yield one non-conflicting deterministic identity.",
        candidates: {
          albumFirst: decision.albumFirst.candidateIds,
          targetedSearch: decision.targetedSearch.candidateIds,
        },
        canonicalArtistId: manifestArtist.canonicalArtistId,
        confidence: decision.hybrid.state === "resolved" ? "0.900" : "0.000",
        decisionReason:
          decision.hybrid.state === "resolved"
            ? "Frozen adaptive evidence produced one non-conflicting Apple artist ID."
            : "Insufficient or conflicting frozen adaptive evidence preserved ambiguity.",
        evidence: decision,
        runId,
        selectedArtistId:
          decision.hybrid.state === "resolved" ? decision.hybrid.selectedArtistId : null,
        selectedArtistName:
          decision.hybrid.state === "resolved" ? manifestArtist.canonicalArtist : null,
        status:
          decision.hybrid.state === "resolved"
            ? "evidence_confirmed"
            : decision.hybrid.state === "no_useful_evidence"
              ? "no_match"
              : "ambiguous",
      })
      .onConflictDoUpdate({
        target: [itunesPilotArtistMappings.runId, itunesPilotArtistMappings.canonicalArtistId],
        set: {
          ambiguityReason:
            decision.hybrid.state === "resolved"
              ? null
              : "Adaptive methods did not yield one non-conflicting deterministic identity.",
          candidates: {
            albumFirst: decision.albumFirst.candidateIds,
            targetedSearch: decision.targetedSearch.candidateIds,
          },
          confidence: decision.hybrid.state === "resolved" ? "0.900" : "0.000",
          decisionReason:
            decision.hybrid.state === "resolved"
              ? "Frozen adaptive evidence produced one non-conflicting Apple artist ID."
              : "Insufficient or conflicting frozen adaptive evidence preserved ambiguity.",
          evidence: decision,
          selectedArtistId:
            decision.hybrid.state === "resolved" ? decision.hybrid.selectedArtistId : null,
          selectedArtistName:
            decision.hybrid.state === "resolved" ? manifestArtist.canonicalArtist : null,
          status:
            decision.hybrid.state === "resolved"
              ? "evidence_confirmed"
              : decision.hybrid.state === "no_useful_evidence"
                ? "no_match"
                : "ambiguous",
          updatedAt: new Date(),
        },
      });
  }
}

function asNormalizedResponse(value: unknown): ItunesNormalizedResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cached normalized response is invalid.");
  }
  const response = value as Partial<ItunesNormalizedResponse>;
  if (
    !Array.isArray(response.artists) ||
    !Array.isArray(response.collections) ||
    !Array.isArray(response.tracks) ||
    !Number.isInteger(response.declaredResultCount) ||
    !Number.isInteger(response.unknownResultCount)
  ) {
    throw new Error("Cached normalized response shape is invalid.");
  }
  const serialized = JSON.stringify(value);
  if (/artwork|previewUrl|previewUrl|rawPayload/i.test(serialized)) {
    throw new Error("Cached response contains a prohibited raw, artwork, or preview field.");
  }
  return response as ItunesNormalizedResponse;
}

function censusCandidateIds(census: object, canonicalArtistId: string): string[] {
  const artists = (
    census as { artists?: Array<{ canonicalArtistId: string; plausibleCandidateIds?: string[] }> }
  ).artists;
  return (
    artists?.find((artist) => artist.canonicalArtistId === canonicalArtistId)
      ?.plausibleCandidateIds ?? []
  );
}

function nonItunesDisabled(configuration: ProviderConfiguration): boolean {
  return !(
    configuration.spotify.enabled ||
    configuration.spotify.configured ||
    configuration.spotify.playlistWritesEnabled ||
    configuration.musicbrainz.enabled ||
    configuration.reddit.enabled ||
    configuration.reddit.configured ||
    configuration.soundcloudManualLinksEnabled
  );
}

function assertFrozenRuntime(configuration: ProviderConfiguration): void {
  if (
    configuration.itunes.storefront !== "US" ||
    configuration.itunes.language !== "en_us" ||
    configuration.itunes.concurrency !== 1 ||
    configuration.itunes.minRequestIntervalMs !== 3200 ||
    configuration.itunes.maxRequestsPerRun !== 79
  ) {
    throw new Error("The isolated iTunes runtime differs from the frozen experiment settings.");
  }
}

function experimentMetrics(value: unknown): ExperimentRunMetrics {
  if (!isExperimentMetrics(value)) throw new Error("Run does not contain experiment metrics.");
  return value;
}

function isExperimentMetrics(value: unknown): value is ExperimentRunMetrics {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { runKind?: unknown }).runKind === experimentRunKind
  );
}

async function runEventCount(db: RadarDatabase, runId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(itunesPilotRequestEvents)
    .where(eq(itunesPilotRequestEvents.runId, runId));
  return row?.value ?? 0;
}

function gitState(): { branch: string; clean: boolean; commit: string } {
  return {
    branch: git(["branch", "--show-current"]),
    clean: git(["status", "--porcelain"]) === "",
    commit: git(["rev-parse", "HEAD"]),
  };
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function safeFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return `adaptive_experiment_failed:${text.replace(/[^A-Za-z0-9_ .:-]/g, "").slice(0, 350)}`;
}

function countValues(values: string[]): Record<string, number> {
  return Object.fromEntries(
    [...new Set(values)]
      .sort()
      .map((value) => [value, values.filter((candidate) => candidate === value).length]),
  );
}

function fileHash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
