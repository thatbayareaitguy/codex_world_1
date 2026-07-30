import {
  compareAppleMusicToGroundTruth,
  decideAppleMusicArtistMapping,
  normalizeText,
  type AppleMusicMappingDecision,
  type SpotifyGroundTruthRelease,
} from "@radar/core";
import {
  AppleMusicClientError,
  appleMusicArtistViews,
  type AppleMusicAlbum,
  type AppleMusicArtist,
  type AppleMusicArtistView,
  type AppleMusicBatchResult,
  type AppleMusicSong,
} from "@radar/providers";
import { AppleMusicGateError } from "@radar/db";
import {
  appleMusicLiveConfirmation,
  appleMusicPilotDefinition,
  assertSanitizedAppleMusicPilotEvidence,
  forecastAppleMusicPilotRequests,
  validateAppleMusicPilotSnapshot,
  type AppleMusicPilotPlanArtist,
} from "./apple-music-pilot-definition";
import type { ItunesPilotSnapshot } from "./itunes-pilot-snapshot";

const authorizationMarker = Symbol("apple-music-pilot-live-authorization");

export interface AppleMusicPilotLiveAuthorization {
  readonly [authorizationMarker]: true;
  readonly confirmation: typeof appleMusicLiveConfirmation;
  readonly mode: "bounded_public_catalog_25";
  readonly persistentProviderEnabled: false;
  readonly scope: "canary_only" | "full_25";
  readonly stopAfterCanary: boolean;
  readonly storefront: "us";
}

export interface AppleMusicPilotClient {
  getAllArtistViews?(artistId: string): Promise<Record<string, AppleMusicAlbum[]>>;
  getAlbum?(albumId: string): Promise<AppleMusicAlbum | undefined>;
  getAlbumTracks?(albumId: string): Promise<AppleMusicSong[]>;
  getArtist(artistId: string): Promise<AppleMusicArtist | undefined>;
  getArtistView?(artistId: string, view: AppleMusicArtistView): Promise<AppleMusicAlbum[]>;
  getArtists(artistIds: string[]): Promise<AppleMusicBatchResult<AppleMusicArtist>>;
  searchArtists(term: string): Promise<AppleMusicArtist[]>;
}

export type AppleMusicPilotViewStatus =
  "available_with_results" | "available_empty" | "unavailable_404" | "failed" | "not_attempted";

export interface AppleMusicPilotViewResult {
  artist: string;
  paginationRequests: number;
  requestCount: number;
  resourceCount: number;
  status: AppleMusicPilotViewStatus;
  terminalPagination: boolean;
  view: AppleMusicArtistView;
}

export interface AppleMusicPilotStoredEvidence {
  authenticationAttempts: number;
  authenticationHttpStatus?: number;
  cacheHits: number;
  endpointRequestCounts: Record<string, number>;
  httpStatusCounts: Record<string, number>;
  maximumConcurrency: number;
  minimumRequestIntervalMs?: number;
  paginationRequests: number;
  requestCount: number;
  retryCount: number;
}

export interface AppleMusicPilotStore {
  claimLease(runId: string): Promise<string>;
  createRun(input: {
    implementationCommit: string;
    maximumRuntimeMs: number;
    minRequestIntervalMs: number;
    requestBudget: number;
    snapshotId: string;
  }): Promise<{ id: string }>;
  finishRun(
    runId: string,
    input: {
      metrics: Record<string, unknown>;
      status: "canary_completed" | "completed" | "controlled_partial" | "failed";
      stopReason: string;
    },
  ): Promise<void>;
  importSnapshot(snapshot: ItunesPilotSnapshot): Promise<string>;
  operationalStatus(): Promise<{ cooldownActive: boolean; leaseActive: boolean }>;
  readEvidence(runId: string): Promise<AppleMusicPilotStoredEvidence>;
  releaseLease(leaseToken: string): Promise<void>;
  saveCatalog(input: {
    albums: AppleMusicAlbum[];
    canonicalArtistId: string;
    runId: string;
    songs: AppleMusicSong[];
  }): Promise<void>;
  saveComparisons(input: {
    canonicalArtistId: string;
    comparisons: ReturnType<typeof compareAppleMusicToGroundTruth>;
    runId: string;
  }): Promise<void>;
  saveMapping(input: {
    canonicalArtistId: string;
    decision: AppleMusicMappingDecision;
    inheritedItunesArtistId?: string;
    runId: string;
  }): Promise<void>;
}

export interface AppleMusicPilotRunSummary {
  authentication: {
    accepted: boolean;
    attempts: number;
    httpStatus?: number;
    identityMatched: boolean;
  };
  batch: {
    confirmedIdsRequested: number;
    missingIds: string[];
    returnedIds: number;
  };
  cohortCount: 25;
  contactedArtists: string[];
  evidence: AppleMusicPilotStoredEvidence;
  executionScope: "canary_only" | "full_25";
  forecast: ReturnType<typeof forecastAppleMusicPilotRequests>;
  mappings: Record<string, number>;
  mappingResults: Array<{
    artist: string;
    status: AppleMusicMappingDecision["status"];
  }>;
  incompleteViewArtists: string[];
  omittedArtists: string[];
  phases: {
    authentication: "completed" | "not_started" | "stopped";
    canary: "completed" | "not_started" | "stopped";
    full: "completed" | "not_started" | "stopped";
  };
  runId: string;
  snapshotHash: string;
  status: "canary_completed" | "completed" | "controlled_partial" | "failed";
  stopReason: string;
  viewResults: AppleMusicPilotViewResult[];
}

export function authorizeAppleMusicPilotLive(input: {
  confirmation?: string;
  executeLive: boolean;
  otherProvidersDisabled: boolean;
  persistentAppleMusicEnabled: string | undefined;
  stopAfterCanary?: boolean;
  storefront: string;
}): AppleMusicPilotLiveAuthorization {
  if (!input.executeLive) {
    throw new Error("Live Apple execution requires --execute-live.");
  }
  if (input.confirmation !== appleMusicLiveConfirmation) {
    throw new Error(`Live Apple execution requires --confirm-live ${appleMusicLiveConfirmation}.`);
  }
  if (input.persistentAppleMusicEnabled !== "false") {
    throw new Error("Persistent APPLE_MUSIC_ENABLED must remain exactly false.");
  }
  if (!input.otherProvidersDisabled) {
    throw new Error("Every non-Apple provider must be disabled for the Apple pilot.");
  }
  if (input.storefront !== appleMusicPilotDefinition.storefront) {
    throw new Error("The Apple pilot requires the US storefront.");
  }
  return Object.freeze({
    [authorizationMarker]: true as const,
    confirmation: appleMusicLiveConfirmation,
    mode: "bounded_public_catalog_25" as const,
    persistentProviderEnabled: false as const,
    scope: input.stopAfterCanary ? ("canary_only" as const) : ("full_25" as const),
    stopAfterCanary: input.stopAfterCanary ?? false,
    storefront: "us" as const,
  });
}

export async function runBoundedAppleMusicPilot(input: {
  authorization: AppleMusicPilotLiveAuthorization;
  createClient: (
    phase: "canary" | "full",
    runId: string,
    leaseToken: string,
  ) => AppleMusicPilotClient;
  implementationCommit: string;
  now?: () => Date;
  snapshot: ItunesPilotSnapshot;
  store: AppleMusicPilotStore;
}): Promise<AppleMusicPilotRunSummary> {
  assertAuthorization(input.authorization);
  const cohort = validateAppleMusicPilotSnapshot(input.snapshot);
  const forecast = forecastAppleMusicPilotRequests(
    input.authorization.stopAfterCanary ? "canary" : "full",
  );
  if (!forecast.fitsBudget) {
    throw new Error("The conservative Apple pilot forecast exceeds the full-run budget.");
  }
  return runAppleMusicPilotAfterForecastGate(input, cohort);
}

/**
 * Executes the injected runner after its caller has satisfied the conservative
 * forecast gate. Production callers must use runBoundedAppleMusicPilot.
 * Credential-free tests use this boundary with fake clients and stores.
 */
export async function runAppleMusicPilotAfterForecastGate(
  input: {
    authorization: AppleMusicPilotLiveAuthorization;
    createClient: (
      phase: "canary" | "full",
      runId: string,
      leaseToken: string,
    ) => AppleMusicPilotClient;
    implementationCommit: string;
    now?: () => Date;
    snapshot: ItunesPilotSnapshot;
    store: AppleMusicPilotStore;
  },
  cohort: AppleMusicPilotPlanArtist[] = validateAppleMusicPilotSnapshot(input.snapshot),
): Promise<AppleMusicPilotRunSummary> {
  assertAuthorization(input.authorization);
  const status = await input.store.operationalStatus();
  if (status.cooldownActive) throw new Error("Apple Music has an active persisted cooldown.");
  if (status.leaseActive) throw new Error("Apple Music has an active request lease.");
  const snapshotId = await input.store.importSnapshot(input.snapshot);
  const run = await input.store.createRun({
    implementationCommit: input.implementationCommit,
    maximumRuntimeMs: input.authorization.stopAfterCanary
      ? appleMusicPilotDefinition.limits.canaryRuntimeMs
      : appleMusicPilotDefinition.limits.runtimeMs,
    minRequestIntervalMs: appleMusicPilotDefinition.limits.minRequestIntervalMs,
    requestBudget: input.authorization.stopAfterCanary
      ? appleMusicPilotDefinition.limits.canaryRequestBudget
      : appleMusicPilotDefinition.limits.requestBudget,
    snapshotId,
  });
  const startedAt = (input.now ?? (() => new Date()))().getTime();
  let leaseToken: string | undefined;
  const phases: AppleMusicPilotRunSummary["phases"] = {
    authentication: "not_started",
    canary: "not_started",
    full: "not_started",
  };
  const mappings = new Map<string, MappingState>();
  let batchMissingIds: string[] = [];
  let batchReturnedIds = 0;
  let batchRequestedIds = 0;
  let terminalStatus: AppleMusicPilotRunSummary["status"] = "failed";
  let stopReason = "unexpected_failure";
  let summary: AppleMusicPilotRunSummary | undefined;
  try {
    leaseToken = await input.store.claimLease(run.id);
    const canaryClient = input.createClient("canary", run.id, leaseToken);
    const authenticationEntry = cohortEntry(cohort, appleMusicPilotDefinition.authenticationArtist);
    const authenticationId = requiredKnownId(authenticationEntry);
    phases.authentication = "stopped";
    const authenticationArtist = await canaryClient.getArtist(authenticationId);
    if (!authenticationArtist) {
      throw new AppleMusicPilotControlledStop("authentication_artist_missing");
    }
    const authenticationDecision = decideAppleMusicArtistMapping({
      aliases: snapshotArtist(input.snapshot, authenticationEntry).aliases,
      canonicalName: authenticationEntry.name,
      existingArtist: authenticationArtist,
      existingArtistId: authenticationId,
      searchCandidates: [],
    });
    if (!authenticationDecision.selected) {
      throw new AppleMusicPilotControlledStop("authentication_artist_identity_rejected");
    }
    phases.authentication = "completed";
    mappings.set(authenticationEntry.canonicalArtistId, {
      decision: authenticationDecision,
      entry: authenticationEntry,
    });

    phases.canary = "stopped";
    for (const name of appleMusicPilotDefinition.canaryArtists) {
      const entry = cohortEntry(cohort, name);
      const state =
        mappings.get(entry.canonicalArtistId) ??
        (await resolveArtist(canaryClient, input.snapshot, entry));
      mappings.set(entry.canonicalArtistId, state);
      await persistMapping(input.store, run.id, state);
      if (state.decision.selected) {
        await fetchAndPersistCatalog(canaryClient, input, run.id, state);
      }
      await assertCanaryLimits(input.store, run.id, startedAt, input.now);
    }
    phases.canary = "completed";

    const canaryConfirmed = [...mappings.values()].filter((state) => state.decision.selected);
    await inspectRequiredTrackEvidence(canaryClient, input, run.id, canaryConfirmed);
    await assertCanaryLimits(input.store, run.id, startedAt, input.now);

    if (input.authorization.stopAfterCanary) {
      terminalStatus = "canary_completed";
      stopReason = "canary_workflow_completed";
    } else {
      phases.full = "stopped";
      const fullClient = input.createClient("full", run.id, leaseToken);
      for (const entry of cohort) {
        const state =
          mappings.get(entry.canonicalArtistId) ??
          (await resolveArtist(fullClient, input.snapshot, entry));
        mappings.set(entry.canonicalArtistId, state);
        await persistMapping(input.store, run.id, state);
      }
      const confirmed = [...mappings.values()].filter((state) => state.decision.selected);
      const confirmedIds = confirmed.map((state) => state.decision.selected!.artistId);
      batchRequestedIds = confirmedIds.length;
      if (confirmedIds.length > 0) {
        const batch = await fullClient.getArtists(confirmedIds);
        batchMissingIds = [...batch.missingIds].sort();
        batchReturnedIds = batch.items.length;
      }
      for (const state of confirmed) {
        if (!state.albums) {
          await fetchAndPersistCatalog(fullClient, input, run.id, state);
        }
      }
      await inspectRequiredTrackEvidence(fullClient, input, run.id, confirmed);
      phases.full = "completed";
      terminalStatus = "completed";
      stopReason = "pilot_workflow_completed";
    }
  } catch (error) {
    const classified = classifyStop(error);
    terminalStatus = classified.status;
    stopReason = classified.reason;
  } finally {
    try {
      let evidence: AppleMusicPilotStoredEvidence;
      try {
        evidence = await input.store.readEvidence(run.id);
      } catch {
        terminalStatus = "failed";
        stopReason = "evidence_read_failed";
        evidence = emptyStoredEvidence();
      }
      summary = createSummary({
        batchMissingIds,
        batchRequestedIds,
        batchReturnedIds,
        cohort,
        evidence,
        executionScope: input.authorization.scope,
        mappings,
        phases,
        runId: run.id,
        snapshotHash: input.snapshot.snapshotHash,
        status: terminalStatus,
        stopReason,
      });
      await input.store.finishRun(run.id, {
        metrics: summary as unknown as Record<string, unknown>,
        status: terminalStatus,
        stopReason,
      });
    } finally {
      if (leaseToken) await input.store.releaseLease(leaseToken);
    }
  }
  if (!summary) throw new Error("The Apple Music pilot summary was not created.");
  return summary;
}

class AppleMusicPilotControlledStop extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AppleMusicPilotControlledStop";
  }
}

interface MappingState {
  albums?: AppleMusicAlbum[];
  decision: AppleMusicMappingDecision;
  entry: AppleMusicPilotPlanArtist;
  songs?: AppleMusicSong[];
  viewResults?: Partial<Record<AppleMusicArtistView, Omit<AppleMusicPilotViewResult, "artist">>>;
}

async function resolveArtist(
  client: AppleMusicPilotClient,
  snapshot: ItunesPilotSnapshot,
  entry: AppleMusicPilotPlanArtist,
): Promise<MappingState> {
  const source = snapshotArtist(snapshot, entry);
  if (entry.knownAppleArtistId) {
    const existing = await client.getArtist(entry.knownAppleArtistId);
    if (existing) {
      const decision = decideAppleMusicArtistMapping({
        aliases: source.aliases,
        canonicalName: source.canonicalName,
        existingArtist: existing,
        existingArtistId: entry.knownAppleArtistId,
        searchCandidates: [],
      });
      if (decision.selected) return { decision, entry };
    }
  }
  const candidates = await client.searchArtists(source.canonicalName);
  return {
    decision: decideAppleMusicArtistMapping({
      aliases: source.aliases,
      canonicalName: source.canonicalName,
      searchCandidates: candidates,
    }),
    entry,
  };
}

async function fetchAndPersistCatalog(
  client: AppleMusicPilotClient,
  input: {
    snapshot: ItunesPilotSnapshot;
    store: AppleMusicPilotStore;
  },
  runId: string,
  state: MappingState,
): Promise<void> {
  const selected = state.decision.selected;
  if (!selected) return;
  const views = await fetchConfirmedArtistViews(client, selected.artistId, state);
  const albums = deduplicateAlbums(
    appleMusicArtistViews.flatMap((view) => views[view]?.items ?? []),
  );
  const allComparisons = compareAppleMusicToGroundTruth(
    groundTruth(input.snapshot, state.entry.canonicalArtistId),
    albums,
  );
  const incomplete = appleMusicArtistViews.some(
    (view) => views[view]?.status === "unavailable_404",
  );
  const comparisons = incomplete
    ? allComparisons.filter(
        (comparison) => comparison.classification !== "spotify_ground_truth_missed_by_apple_music",
      )
    : allComparisons;
  state.albums = albums;
  state.songs = [];
  await input.store.saveCatalog({
    albums,
    canonicalArtistId: state.entry.canonicalArtistId,
    runId,
    songs: [],
  });
  await input.store.saveComparisons({
    canonicalArtistId: state.entry.canonicalArtistId,
    comparisons,
    runId,
  });
}

async function fetchConfirmedArtistViews(
  client: AppleMusicPilotClient,
  artistId: string,
  state: MappingState,
): Promise<
  Record<
    AppleMusicArtistView,
    Omit<AppleMusicPilotViewResult, "artist"> & { items: AppleMusicAlbum[] }
  >
> {
  if (!client.getArtistView) {
    if (!client.getAllArtistViews) {
      throw new Error("Apple Music pilot client has no artist-view operation.");
    }
    const legacy = await client.getAllArtistViews(artistId);
    return Object.fromEntries(
      appleMusicArtistViews.map((view) => {
        const items = legacy[view] ?? [];
        const pageCount = pageCountFor(items);
        const evidence = {
          paginationRequests: pageCount - 1,
          requestCount: pageCount,
          resourceCount: items.length,
          status:
            items.length > 0 ? ("available_with_results" as const) : ("available_empty" as const),
          terminalPagination: true,
          view,
        };
        const result = { items, ...evidence };
        state.viewResults = { ...state.viewResults, [view]: evidence };
        return [view, result] as const;
      }),
    ) as Record<
      AppleMusicArtistView,
      Omit<AppleMusicPilotViewResult, "artist"> & { items: AppleMusicAlbum[] }
    >;
  }

  const results = {} as Record<
    AppleMusicArtistView,
    Omit<AppleMusicPilotViewResult, "artist"> & { items: AppleMusicAlbum[] }
  >;
  for (const view of appleMusicArtistViews) {
    try {
      const items = await client.getArtistView(artistId, view);
      const pageCount = pageCountFor(items);
      const evidence = {
        paginationRequests: pageCount - 1,
        requestCount: pageCount,
        resourceCount: items.length,
        status:
          items.length > 0 ? ("available_with_results" as const) : ("available_empty" as const),
        terminalPagination: true,
        view,
      };
      const result = { items, ...evidence };
      results[view] = result;
      state.viewResults = { ...state.viewResults, [view]: evidence };
    } catch (error) {
      if (isUnavailableConfirmedArtistView(error, view)) {
        const evidence = {
          paginationRequests: 0,
          requestCount: 1,
          resourceCount: 0,
          status: "unavailable_404" as const,
          terminalPagination: false,
          view,
        };
        const result = { items: [], ...evidence };
        results[view] = result;
        state.viewResults = { ...state.viewResults, [view]: evidence };
        continue;
      }
      state.viewResults = {
        ...state.viewResults,
        [view]: {
          paginationRequests: 0,
          requestCount: error instanceof AppleMusicClientError && error.status ? 1 : 0,
          resourceCount: 0,
          status: "failed",
          terminalPagination: false,
          view,
        },
      };
      throw error;
    }
  }
  return results;
}

function isUnavailableConfirmedArtistView(error: unknown, view: AppleMusicArtistView): boolean {
  return (
    error instanceof AppleMusicClientError &&
    error.status === 404 &&
    error.classification === "not_found" &&
    error.appleError?.endpointCategory === "artist_view" &&
    error.appleError.view === view
  );
}

function pageCountFor(items: AppleMusicAlbum[]): number {
  return Math.max(1, ...items.map((item) => item.pageNumber));
}

async function inspectRequiredTrackEvidence(
  client: AppleMusicPilotClient,
  input: {
    snapshot: ItunesPilotSnapshot;
    store: AppleMusicPilotStore;
  },
  runId: string,
  states: MappingState[],
): Promise<void> {
  if (!client.getAlbum || !client.getAlbumTracks) return;
  const candidates = states
    .flatMap((state) =>
      (state.albums ?? [])
        .filter(
          (album) =>
            album.sourceView === "appears-on-albums" &&
            groundTruth(input.snapshot, state.entry.canonicalArtistId).some(
              (release) => normalizeText(release.title) === normalizeText(album.title),
            ),
        )
        .map((album) => ({ album, state })),
    )
    .sort(
      (left, right) =>
        left.state.entry.name.localeCompare(right.state.entry.name) ||
        left.album.albumId.localeCompare(right.album.albumId),
    )
    .slice(0, 4);
  for (const { album, state } of candidates) {
    const detail = await client.getAlbum(album.albumId);
    const songs = await client.getAlbumTracks(album.albumId);
    state.songs = [...(state.songs ?? []), ...songs];
    await input.store.saveCatalog({
      albums: detail ? [detail] : [],
      canonicalArtistId: state.entry.canonicalArtistId,
      runId,
      songs,
    });
  }
}

async function persistMapping(
  store: AppleMusicPilotStore,
  runId: string,
  state: MappingState,
): Promise<void> {
  await store.saveMapping({
    canonicalArtistId: state.entry.canonicalArtistId,
    decision: state.decision,
    ...(state.entry.knownAppleArtistId
      ? { inheritedItunesArtistId: state.entry.knownAppleArtistId }
      : {}),
    runId,
  });
}

async function assertCanaryLimits(
  store: AppleMusicPilotStore,
  runId: string,
  startedAt: number,
  now: (() => Date) | undefined,
): Promise<void> {
  const evidence = await store.readEvidence(runId);
  if (evidence.requestCount > appleMusicPilotDefinition.limits.canaryRequestBudget) {
    throw new AppleMusicPilotControlledStop("canary_request_budget_exhausted");
  }
  if (
    (now ?? (() => new Date()))().getTime() - startedAt >
    appleMusicPilotDefinition.limits.canaryRuntimeMs
  ) {
    throw new AppleMusicPilotControlledStop("canary_runtime_budget_exhausted");
  }
}

function createSummary(input: {
  batchMissingIds: string[];
  batchRequestedIds: number;
  batchReturnedIds: number;
  cohort: AppleMusicPilotPlanArtist[];
  evidence: AppleMusicPilotStoredEvidence;
  executionScope: AppleMusicPilotRunSummary["executionScope"];
  mappings: Map<string, MappingState>;
  phases: AppleMusicPilotRunSummary["phases"];
  runId: string;
  snapshotHash: string;
  status: AppleMusicPilotRunSummary["status"];
  stopReason: string;
}): AppleMusicPilotRunSummary {
  const mappingCounts: Record<string, number> = {};
  for (const state of input.mappings.values()) {
    mappingCounts[state.decision.status] = (mappingCounts[state.decision.status] ?? 0) + 1;
  }
  const viewResults = [...input.mappings.values()].flatMap((state) =>
    appleMusicArtistViews.map((view): AppleMusicPilotViewResult => {
      const result = state.viewResults?.[view];
      return result
        ? { artist: state.entry.name, ...result }
        : {
            artist: state.entry.name,
            paginationRequests: 0,
            requestCount: 0,
            resourceCount: 0,
            status: "not_attempted",
            terminalPagination: false,
            view,
          };
    }),
  );
  const incompleteViewArtists = [
    ...new Set(
      viewResults
        .filter(
          (result) =>
            result.status === "unavailable_404" ||
            result.status === "failed" ||
            result.status === "not_attempted",
        )
        .map((result) => result.artist),
    ),
  ].sort();
  const mappedNames = new Set(
    [...input.mappings.values()]
      .filter((state) => state.decision.selected)
      .map((state) => state.entry.name),
  );
  const summary: AppleMusicPilotRunSummary = {
    authentication: {
      accepted: input.phases.authentication === "completed",
      attempts: input.evidence.authenticationAttempts,
      identityMatched: input.phases.authentication === "completed",
      ...(input.evidence.authenticationHttpStatus === undefined
        ? {}
        : { httpStatus: input.evidence.authenticationHttpStatus }),
    },
    batch: {
      confirmedIdsRequested: input.batchRequestedIds,
      missingIds: [...input.batchMissingIds],
      returnedIds: input.batchReturnedIds,
    },
    cohortCount: 25,
    contactedArtists: [...input.mappings.values()].map((state) => state.entry.name),
    evidence: input.evidence,
    executionScope: input.executionScope,
    forecast: forecastAppleMusicPilotRequests(
      input.executionScope === "canary_only" ? "canary" : "full",
    ),
    mappings: mappingCounts,
    mappingResults: [...input.mappings.values()]
      .map((state) => ({ artist: state.entry.name, status: state.decision.status }))
      .sort((left, right) => left.artist.localeCompare(right.artist)),
    incompleteViewArtists,
    omittedArtists: input.cohort
      .filter((entry) => !mappedNames.has(entry.name))
      .map((entry) => entry.name),
    phases: { ...input.phases },
    runId: input.runId,
    snapshotHash: input.snapshotHash,
    status: input.status,
    stopReason: input.stopReason,
    viewResults,
  };
  assertSanitizedAppleMusicPilotEvidence(summary);
  return summary;
}

function classifyStop(error: unknown): {
  reason: string;
  status: "controlled_partial" | "failed";
} {
  if (error instanceof AppleMusicPilotControlledStop) {
    return { reason: error.reason, status: "controlled_partial" };
  }
  if (error instanceof AppleMusicClientError) {
    return {
      reason:
        error.status === 401
          ? "authentication_http_401"
          : error.status === 403
            ? "authentication_http_403"
            : error.status === 429
              ? "provider_http_429"
              : error.classification.slice(0, 100),
      status:
        error.status === 401 ||
        error.status === 403 ||
        error.status === 429 ||
        error.classification.includes("budget")
          ? "controlled_partial"
          : "failed",
    };
  }
  if (error instanceof AppleMusicGateError) {
    return { reason: error.classification, status: "controlled_partial" };
  }
  return { reason: "unexpected_failure", status: "failed" };
}

function assertAuthorization(authorization: AppleMusicPilotLiveAuthorization): void {
  if (
    authorization[authorizationMarker] !== true ||
    authorization.confirmation !== appleMusicLiveConfirmation ||
    authorization.mode !== "bounded_public_catalog_25" ||
    authorization.persistentProviderEnabled !== false ||
    authorization.scope !== (authorization.stopAfterCanary ? "canary_only" : "full_25") ||
    authorization.storefront !== "us"
  ) {
    throw new Error("A valid command-scoped Apple pilot authorization is required.");
  }
}

function cohortEntry(cohort: AppleMusicPilotPlanArtist[], name: string): AppleMusicPilotPlanArtist {
  const entry = cohort.find((artist) => artist.name === name);
  if (!entry) throw new Error(`Pinned Apple pilot artist ${name} is missing.`);
  return entry;
}

function snapshotArtist(snapshot: ItunesPilotSnapshot, entry: AppleMusicPilotPlanArtist) {
  const artist = snapshot.artists.find(
    (candidate) => candidate.canonicalArtistId === entry.canonicalArtistId,
  );
  if (!artist) throw new Error(`Snapshot artist ${entry.name} is missing.`);
  return artist;
}

function requiredKnownId(entry: AppleMusicPilotPlanArtist): string {
  if (!entry.knownAppleArtistId) {
    throw new Error(`Authentication artist ${entry.name} has no pinned public artist ID.`);
  }
  return entry.knownAppleArtistId;
}

function groundTruth(
  snapshot: ItunesPilotSnapshot,
  canonicalArtistId: string,
): SpotifyGroundTruthRelease[] {
  return snapshot.groundTruthReleases
    .filter((release) => release.canonicalArtistId === canonicalArtistId)
    .map((release) => ({
      canonicalReleaseId: release.canonicalReleaseId,
      normalizedTitle: release.normalizedTitle,
      releaseDate: release.releaseDate,
      releaseType: release.releaseType,
      spotifyReleaseId: release.spotifyReleaseId,
      title: release.title,
      ...(release.trackCount === undefined ? {} : { trackCount: release.trackCount }),
      tracks: release.tracks.map((track) => ({
        ...(track.durationMs === undefined ? {} : { durationMs: track.durationMs }),
        normalizedTitle: track.normalizedTitle,
        title: track.title,
      })),
      ...(release.version === undefined ? {} : { version: release.version }),
    }));
}

function deduplicateAlbums(albums: AppleMusicAlbum[]): AppleMusicAlbum[] {
  return [
    ...new Map(
      albums.map((album) => [`${album.albumId}:${album.sourceView}`, album] as const),
    ).values(),
  ];
}

function emptyStoredEvidence(): AppleMusicPilotStoredEvidence {
  return {
    authenticationAttempts: 0,
    cacheHits: 0,
    endpointRequestCounts: {},
    httpStatusCounts: {},
    maximumConcurrency: 0,
    paginationRequests: 0,
    requestCount: 0,
    retryCount: 0,
  };
}
