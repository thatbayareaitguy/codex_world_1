import {
  resolveAppleMusicArtistFromCatalogEvidence,
  selectAppleMusicCatalogEvidenceCandidates,
  type AppleMusicAlbumCandidate,
  type AppleMusicMappingDecision,
  type AppleMusicMappingEvidence,
  type AppleMusicSongCandidate,
} from "@radar/core";
import {
  AppleMusicClientError,
  type AppleMusicAlbum,
  type AppleMusicArtist,
  type AppleMusicArtistSongViewPage,
  type AppleMusicArtistViewPage,
  type AppleMusicBatchResult,
  type AppleMusicSong,
} from "@radar/providers";
import type { AppleMusicDurableArtistMapping } from "@radar/db";
import type { AppleMusicIdentitySeedArtifact } from "./apple-music-identity-seed-artifact";
import type { AppleMusicPilotStoredEvidence } from "./apple-music-pilot-runner";
import {
  type AppleMusicStageBGroundTruth,
  type AppleMusicStageBReplaySummary,
} from "./apple-music-stage-b";

export const appleMusicStageBLiveConfirmation = "APPLE_IDENTITY_STAGE_B_EVIDENCE_6";
export const appleMusicStageBLiveRequestBudget = 88 as const;
export const appleMusicStageBLiveMaximumRuntimeMs = 180_000 as const;
export const appleMusicStageBLiveMinimumRequestIntervalMs = 1_100 as const;

const authorizationMarker = Symbol("apple-music-stage-b-live-authorization");

export interface AppleMusicStageBLiveAuthorization {
  readonly [authorizationMarker]: true;
  readonly confirmation: typeof appleMusicStageBLiveConfirmation;
  readonly persistentProviderEnabled: false;
  readonly storefront: "us";
}

export interface AppleMusicStageBLiveScopeArtist {
  aliases: string[];
  candidateArtistIds: string[];
  canonicalName: string;
  groundTruth: AppleMusicStageBGroundTruth;
  watchedArtistId: string;
}

export interface AppleMusicStageBLiveScope {
  artifactHash: string;
  artists: AppleMusicStageBLiveScopeArtist[];
  candidateCount: 39;
  reviewArtifactHash: string;
  sourceWatchlistHash: string;
}

export interface AppleMusicStageBLivePlan {
  artists: Array<{
    candidateCount: number;
    canonicalName: string;
    releaseTitleCount: number;
    trackTitleCount: number;
  }>;
  candidateBatchLookupRequests: 2;
  candidateCount: 39;
  confirmation: typeof appleMusicStageBLiveConfirmation;
  executionAuthorized: false;
  maximumRuntimeMs: 180_000;
  maximumSinglesFallbackRequests: 39;
  maximumTopSongsRequests: 39;
  minimumRequestIntervalMs: 1_100;
  networkRequestsStarted: 0;
  requestBudget: 88;
  retryAndSafetyHeadroom: 8;
  safety: {
    credentialsAccessed: false;
    databaseWrites: 0;
    developerTokenGenerated: false;
    httpClientInitialized: false;
    privateKeyAccessed: false;
  };
  watchedArtistCount: 6;
}

export interface AppleMusicStageBLiveClient {
  getArtists(ids: string[]): Promise<AppleMusicBatchResult<AppleMusicArtist>>;
  getArtistTopSongsFirstPage(
    artistId: string,
    identityScope: string,
  ): Promise<AppleMusicArtistSongViewPage>;
  getArtistViewFirstPage(
    artistId: string,
    view: "singles",
    signal?: AbortSignal,
    identityScope?: string,
  ): Promise<AppleMusicArtistViewPage>;
}

export interface AppleMusicStageBLiveStore {
  claimLease(runId: string): Promise<string>;
  createRun(input: {
    implementationCommit: string;
    maximumRuntimeMs: 180_000;
    minRequestIntervalMs: 1_100;
    requestBudget: 88;
    snapshotId: string;
  }): Promise<{ id: string }>;
  finishRun(
    runId: string,
    input: {
      metrics: Record<string, unknown>;
      status: "completed" | "controlled_partial" | "failed";
      stopReason: string;
    },
  ): Promise<void>;
  listDurableMappings(canonicalArtistIds: string[]): Promise<AppleMusicDurableArtistMapping[]>;
  operationalStatus(): Promise<{
    cooldownActive: boolean;
    leaseActive: boolean;
    queueDepth: number;
  }>;
  readEvidence(runId: string): Promise<AppleMusicPilotStoredEvidence>;
  releaseLease(leaseToken: string): Promise<void>;
  saveDurableMapping(input: {
    appleArtistId: string;
    artifactHash: string;
    artistName: string;
    canonicalArtistId: string;
    confirmationMethod: "catalog_evidence";
    confirmedRunId: string;
    sourceClassification: "ambiguous_seed";
  }): Promise<AppleMusicDurableArtistMapping>;
  saveMapping(input: {
    canonicalArtistId: string;
    decision: AppleMusicMappingDecision;
    runId: string;
  }): Promise<void>;
}

export interface AppleMusicStageBLiveArtistResult {
  artist: string;
  candidateCountSubmitted: number;
  candidateIdsReturnedCount: number;
  candidates: Array<{
    candidate: string;
    conflictCount: number;
    dateConflictCount: number;
    isrcMatches: number;
    releaseTitleOverlapCount: number;
    score: number;
    trackTitleOverlapCount: number;
    upcMatches: number;
  }>;
  compatibleCandidateCount: number;
  durableMappingWritten: boolean;
  finalClassification: AppleMusicMappingDecision["status"];
  manualReviewRequired: boolean;
  singlesFallbackRequests: number;
  topSongsRequests: number;
  unavailableCandidateEvidence: number;
  winningMargin?: number;
}

export interface AppleMusicStageBLiveSummary {
  artists: AppleMusicStageBLiveArtistResult[];
  batchValidation: {
    incompatibleCandidates: number;
    missingCandidates: number;
    requests: number;
    returnedCandidates: number;
    submittedCandidates: 39;
  };
  evidence: AppleMusicPilotStoredEvidence;
  mode: "stage_b_candidate_evidence_6";
  newDurableMappings: number;
  requestBudget: 88;
  runId: string;
  status: "completed" | "controlled_partial" | "failed";
  stopReason: string;
}

interface CandidateState {
  artist?: AppleMusicArtist;
  compatible: boolean;
  lookup: "incompatible" | "missing" | "returned";
  singles: AppleMusicAlbum[];
  singlesAvailable: boolean;
  topSongs: AppleMusicSong[];
  topSongsAvailable: boolean;
}

class AppleMusicStageBResponseError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AppleMusicStageBResponseError";
  }
}

export function createAppleMusicStageBLiveScope(input: {
  artifact: AppleMusicIdentitySeedArtifact;
  durableMappings: AppleMusicDurableArtistMapping[];
  groundTruth: Map<string, AppleMusicStageBGroundTruth>;
  replay: AppleMusicStageBReplaySummary;
  reviewArtifactHash: string;
}): AppleMusicStageBLiveScope {
  const eligible = input.replay.artists.filter(
    (artist) => artist.classification === "requires_live_candidate_evidence",
  );
  if (eligible.length !== 6) {
    throw new Error("Apple Stage B live scope requires exactly six replay-eligible artists.");
  }
  const artifactById = new Map(
    input.artifact.entries.map((entry) => [entry.watchedArtistId, entry]),
  );
  const durableIds = new Set(input.durableMappings.map((mapping) => mapping.canonicalArtistId));
  const artists = eligible
    .map((replayArtist) => {
      const entry = artifactById.get(replayArtist.watchedArtistId);
      if (!entry || entry.classification !== "ambiguous_seed") {
        throw new Error("Apple Stage B live scope contains an ineligible artifact entry.");
      }
      if (durableIds.has(entry.watchedArtistId)) {
        throw new Error("Apple Stage B live scope cannot include a durable confirmed artist.");
      }
      const candidateArtistIds = candidateIdsForEntry(entry);
      if (candidateArtistIds.length < 2) {
        throw new Error("Apple Stage B live artists require bounded alternate candidates.");
      }
      const groundTruth = input.groundTruth.get(entry.watchedArtistId);
      if (!groundTruth || groundTruth.releases.length === 0) {
        throw new Error("Apple Stage B live artists require approved watched-artist ground truth.");
      }
      if (
        replayArtist.groundTruth.releaseTitleCount === 0 &&
        replayArtist.groundTruth.trackTitleCount === 0
      ) {
        throw new Error(
          "Apple Stage B live artists require release-title or track-title evidence.",
        );
      }
      return {
        aliases: [...entry.aliases],
        candidateArtistIds,
        canonicalName: entry.canonicalArtistName,
        groundTruth,
        watchedArtistId: entry.watchedArtistId,
      } satisfies AppleMusicStageBLiveScopeArtist;
    })
    .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName));
  const allCandidateIds = artists.flatMap((artist) => artist.candidateArtistIds);
  if (allCandidateIds.length !== 39 || new Set(allCandidateIds).size !== 39) {
    throw new Error("Apple Stage B live scope requires exactly 39 unique candidate IDs.");
  }
  const artifactCandidates = new Set(
    input.artifact.entries.flatMap((entry) => candidateIdsForEntry(entry)),
  );
  if (allCandidateIds.some((candidateId) => !artifactCandidates.has(candidateId))) {
    throw new Error("Apple Stage B live scope contains a candidate outside the artifact.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.reviewArtifactHash)) {
    throw new Error("Apple Stage B live scope requires a validated review artifact hash.");
  }
  return {
    artifactHash: input.artifact.artifactSelfHash,
    artists,
    candidateCount: 39,
    reviewArtifactHash: input.reviewArtifactHash,
    sourceWatchlistHash: input.artifact.inputWatchlistHash,
  };
}

export function createAppleMusicStageBLivePlan(
  scope: AppleMusicStageBLiveScope,
): AppleMusicStageBLivePlan {
  assertExactScope(scope);
  return {
    artists: scope.artists.map((artist) => ({
      candidateCount: artist.candidateArtistIds.length,
      canonicalName: artist.canonicalName,
      releaseTitleCount: new Set(
        artist.groundTruth.releases.map((release) => release.normalizedTitle),
      ).size,
      trackTitleCount: new Set(
        artist.groundTruth.releases.flatMap((release) =>
          (release.tracks ?? []).map((track) => track.normalizedTitle),
        ),
      ).size,
    })),
    candidateBatchLookupRequests: 2,
    candidateCount: 39,
    confirmation: appleMusicStageBLiveConfirmation,
    executionAuthorized: false,
    maximumRuntimeMs: appleMusicStageBLiveMaximumRuntimeMs,
    maximumSinglesFallbackRequests: 39,
    maximumTopSongsRequests: 39,
    minimumRequestIntervalMs: appleMusicStageBLiveMinimumRequestIntervalMs,
    networkRequestsStarted: 0,
    requestBudget: appleMusicStageBLiveRequestBudget,
    retryAndSafetyHeadroom: 8,
    safety: {
      credentialsAccessed: false,
      databaseWrites: 0,
      developerTokenGenerated: false,
      httpClientInitialized: false,
      privateKeyAccessed: false,
    },
    watchedArtistCount: 6,
  };
}

export function authorizeAppleMusicStageBLive(input: {
  confirmation?: string;
  executeLive: boolean;
  otherProvidersDisabled: boolean;
  persistentAppleMusicEnabled: string | undefined;
  storefront: string;
}): AppleMusicStageBLiveAuthorization {
  if (!input.executeLive) throw new Error("Apple Stage B requires --execute-live.");
  if (input.confirmation !== appleMusicStageBLiveConfirmation) {
    throw new Error(`Apple Stage B requires --confirm-live ${appleMusicStageBLiveConfirmation}.`);
  }
  if (input.persistentAppleMusicEnabled !== "false") {
    throw new Error("Persistent APPLE_MUSIC_ENABLED must remain exactly false.");
  }
  if (!input.otherProvidersDisabled) {
    throw new Error("Every non-Apple provider must be disabled for Apple Stage B.");
  }
  if (input.storefront !== "us") throw new Error("Apple Stage B requires the US storefront.");
  return Object.freeze({
    [authorizationMarker]: true as const,
    confirmation: appleMusicStageBLiveConfirmation,
    persistentProviderEnabled: false as const,
    storefront: "us" as const,
  });
}

export async function runAppleMusicStageBLive(input: {
  authorization: AppleMusicStageBLiveAuthorization;
  createClient(runId: string, leaseToken: string): AppleMusicStageBLiveClient;
  implementationCommit: string;
  scope: AppleMusicStageBLiveScope;
  snapshotId: string;
  store: AppleMusicStageBLiveStore;
}): Promise<AppleMusicStageBLiveSummary> {
  assertAuthorization(input.authorization);
  assertExactScope(input.scope);
  const operational = await input.store.operationalStatus();
  if (operational.cooldownActive) throw new Error("Apple Music has an active cooldown.");
  if (operational.leaseActive) throw new Error("Apple Music has an active lease.");
  if (operational.queueDepth !== 0) throw new Error("Apple Music request queue is not empty.");
  const existing = await input.store.listDurableMappings(
    input.scope.artists.map((artist) => artist.watchedArtistId),
  );
  if (existing.length > 0) {
    throw new Error("Apple Stage B scope changed because a durable mapping already exists.");
  }
  const run = await input.store.createRun({
    implementationCommit: input.implementationCommit,
    maximumRuntimeMs: appleMusicStageBLiveMaximumRuntimeMs,
    minRequestIntervalMs: appleMusicStageBLiveMinimumRequestIntervalMs,
    requestBudget: appleMusicStageBLiveRequestBudget,
    snapshotId: input.snapshotId,
  });
  let leaseToken: string | undefined;
  let status: AppleMusicStageBLiveSummary["status"] = "failed";
  let stopReason = "unexpected_failure";
  let summary: AppleMusicStageBLiveSummary | undefined;
  const artistResults: AppleMusicStageBLiveArtistResult[] = [];
  const candidateStates = new Map<string, CandidateState>();
  let candidateBatchRequests = 0;
  let newDurableMappings = 0;
  try {
    leaseToken = await input.store.claimLease(run.id);
    const client = input.createClient(run.id, leaseToken);
    const allCandidateIds = input.scope.artists.flatMap((artist) => artist.candidateArtistIds);
    const scopeByCandidateId = new Map(
      input.scope.artists.flatMap((artist) =>
        artist.candidateArtistIds.map((candidateId) => [candidateId, artist] as const),
      ),
    );
    for (const ids of chunk(allCandidateIds, 25)) {
      candidateBatchRequests += 1;
      let response: AppleMusicBatchResult<AppleMusicArtist>;
      try {
        response = await client.getArtists(ids);
      } catch (error) {
        if (!isCandidateUnavailableError(error)) throw error;
        for (const id of ids) candidateStates.set(id, emptyCandidateState("missing"));
        continue;
      }
      const requested = new Set(ids);
      const returnedIds = response.items.map((artist) => artist.artistId);
      if (new Set(returnedIds).size !== returnedIds.length) {
        throw new AppleMusicStageBResponseError("duplicate_candidate_batch_identity");
      }
      if (returnedIds.some((id) => !requested.has(id))) {
        throw new AppleMusicStageBResponseError("extra_candidate_batch_identity");
      }
      const returned = new Map(response.items.map((artist) => [artist.artistId, artist]));
      for (const id of ids) {
        const artist = returned.get(id);
        if (!artist) {
          candidateStates.set(id, emptyCandidateState("missing"));
          continue;
        }
        const scopeArtist = scopeByCandidateId.get(id);
        if (!scopeArtist) {
          throw new AppleMusicStageBResponseError("candidate_scope_binding_failure");
        }
        const compatible =
          selectAppleMusicCatalogEvidenceCandidates({
            aliases: scopeArtist.aliases,
            candidates: [artist],
            canonicalName: scopeArtist.canonicalName,
            maximumCandidates: 1,
          }).length === 1;
        candidateStates.set(id, {
          artist,
          compatible,
          lookup: compatible ? "returned" : "incompatible",
          singles: [],
          singlesAvailable: false,
          topSongs: [],
          topSongsAvailable: false,
        });
      }
    }
    if (candidateBatchRequests !== 2 || candidateStates.size !== 39) {
      throw new AppleMusicStageBResponseError("candidate_batch_scope_mismatch");
    }
    for (const scopeArtist of input.scope.artists) {
      const lookupComplete = scopeArtist.candidateArtistIds.every(
        (id) => requiredCandidateState(candidateStates, id).lookup !== "missing",
      );
      const compatibleIds = scopeArtist.candidateArtistIds.filter(
        (id) => candidateStates.get(id)?.compatible,
      );
      let topSongsRequests = 0;
      for (const candidateId of compatibleIds) {
        const state = requiredCandidateState(candidateStates, candidateId);
        topSongsRequests += 1;
        try {
          const page = await client.getArtistTopSongsFirstPage(candidateId, `stage-b:${run.id}`);
          state.topSongs = page.items;
          state.topSongsAvailable = true;
        } catch (error) {
          if (!isCandidateUnavailableError(error)) throw error;
        }
      }
      let decision = resolveArtist(scopeArtist, compatibleIds, candidateStates);
      const topSongsComplete = compatibleIds.every(
        (candidateId) => requiredCandidateState(candidateStates, candidateId).topSongsAvailable,
      );
      let singlesFallbackRequests = 0;
      if (decision.selected && topSongsComplete) {
        // The shared resolver supplied a complete safe result, so Singles is not needed.
      } else if (compatibleIds.length >= 2 && scopeArtist.groundTruth.releases.length > 0) {
        const currentEvidence = await input.store.readEvidence(run.id);
        const remainingBudget = appleMusicStageBLiveRequestBudget - currentEvidence.requestCount;
        if (remainingBudget >= compatibleIds.length) {
          for (const candidateId of compatibleIds) {
            const state = requiredCandidateState(candidateStates, candidateId);
            singlesFallbackRequests += 1;
            try {
              const page = await client.getArtistViewFirstPage(
                candidateId,
                "singles",
                undefined,
                `stage-b:${run.id}`,
              );
              state.singles = page.items;
              state.singlesAvailable = true;
            } catch (error) {
              if (!isCandidateUnavailableError(error)) throw error;
            }
          }
          decision = resolveArtist(scopeArtist, compatibleIds, candidateStates);
        }
      }
      const singlesComplete =
        singlesFallbackRequests === 0 ||
        compatibleIds.every(
          (candidateId) => requiredCandidateState(candidateStates, candidateId).singlesAvailable,
        );
      if (decision.selected && (!lookupComplete || !topSongsComplete || !singlesComplete)) {
        decision = incompleteDecision(
          decision,
          "Candidate evidence was unavailable, so identity remains ambiguous.",
        );
      }
      await input.store.saveMapping({
        canonicalArtistId: scopeArtist.watchedArtistId,
        decision,
        runId: run.id,
      });
      let durableMappingWritten = false;
      if (decision.selected) {
        await input.store.saveDurableMapping({
          appleArtistId: decision.selected.artistId,
          artifactHash: input.scope.artifactHash,
          artistName: decision.selected.name,
          canonicalArtistId: scopeArtist.watchedArtistId,
          confirmationMethod: "catalog_evidence",
          confirmedRunId: run.id,
          sourceClassification: "ambiguous_seed",
        });
        durableMappingWritten = true;
        newDurableMappings += 1;
      }
      artistResults.push(
        createArtistResult({
          candidateStates,
          decision,
          durableMappingWritten,
          scopeArtist,
          singlesFallbackRequests,
          topSongsRequests,
        }),
      );
    }
    status = "completed";
    stopReason = "stage_b_candidate_evidence_completed";
  } catch (error) {
    const classified = classifyTerminal(error);
    status = classified.status;
    stopReason = classified.reason;
  } finally {
    try {
      const evidence = await input.store.readEvidence(run.id);
      const values = [...candidateStates.values()];
      summary = {
        artists: artistResults,
        batchValidation: {
          incompatibleCandidates: values.filter((state) => state.lookup === "incompatible").length,
          missingCandidates: values.filter((state) => state.lookup === "missing").length,
          requests: candidateBatchRequests,
          returnedCandidates: values.filter((state) => state.artist).length,
          submittedCandidates: 39,
        },
        evidence,
        mode: "stage_b_candidate_evidence_6",
        newDurableMappings,
        requestBudget: 88,
        runId: run.id,
        status,
        stopReason,
      };
      await input.store.finishRun(run.id, {
        metrics: summary as unknown as Record<string, unknown>,
        status,
        stopReason,
      });
    } finally {
      if (leaseToken) await input.store.releaseLease(leaseToken);
    }
  }
  if (!summary) throw new Error("Apple Stage B live summary was not created.");
  return summary;
}

function resolveArtist(
  scopeArtist: AppleMusicStageBLiveScopeArtist,
  compatibleIds: string[],
  states: Map<string, CandidateState>,
): AppleMusicMappingDecision {
  return resolveAppleMusicArtistFromCatalogEvidence({
    aliases: scopeArtist.aliases,
    candidateCatalogs: compatibleIds.map((candidateId) => {
      const state = requiredCandidateState(states, candidateId);
      if (!state.artist) throw new AppleMusicStageBResponseError("candidate_artist_missing");
      return {
        albums: [...albumsFromTopSongs(state.topSongs), ...state.singles],
        artist: state.artist,
        songs: state.topSongs.map(songAsCandidate),
      };
    }),
    canonicalName: scopeArtist.canonicalName,
    groundTruth: scopeArtist.groundTruth.releases,
  });
}

function createArtistResult(input: {
  candidateStates: Map<string, CandidateState>;
  decision: AppleMusicMappingDecision;
  durableMappingWritten: boolean;
  scopeArtist: AppleMusicStageBLiveScopeArtist;
  singlesFallbackRequests: number;
  topSongsRequests: number;
}): AppleMusicStageBLiveArtistResult {
  const evidenceById = new Map(input.decision.evidence.map((item) => [item.artistId, item]));
  const candidates = input.scopeArtist.candidateArtistIds.map((candidateId, index) =>
    sanitizedCandidateEvidence(index, evidenceById.get(candidateId)),
  );
  const scores = candidates.map((candidate) => candidate.score).sort((left, right) => right - left);
  const states = input.scopeArtist.candidateArtistIds.map((id) =>
    requiredCandidateState(input.candidateStates, id),
  );
  return {
    artist: input.scopeArtist.canonicalName,
    candidateCountSubmitted: input.scopeArtist.candidateArtistIds.length,
    candidateIdsReturnedCount: states.filter((state) => state.artist).length,
    candidates,
    compatibleCandidateCount: states.filter((state) => state.compatible).length,
    durableMappingWritten: input.durableMappingWritten,
    finalClassification: input.decision.status,
    manualReviewRequired: !input.decision.selected,
    singlesFallbackRequests: input.singlesFallbackRequests,
    topSongsRequests: input.topSongsRequests,
    unavailableCandidateEvidence: states.filter(
      (state) =>
        state.compatible &&
        (!state.topSongsAvailable ||
          (input.singlesFallbackRequests > 0 && !state.singlesAvailable)),
    ).length,
    ...(scores.length >= 2 ? { winningMargin: scores[0]! - scores[1]! } : {}),
  };
}

function sanitizedCandidateEvidence(index: number, evidence?: AppleMusicMappingEvidence) {
  return {
    candidate: `candidate_${index + 1}`,
    conflictCount:
      (evidence?.conflictingReleaseTitles.length ?? 0) +
      (evidence?.contradictoryIsrcCount ?? 0) +
      (evidence?.contradictoryUpcCount ?? 0),
    dateConflictCount: evidence?.conflictingReleaseTitles.length ?? 0,
    isrcMatches: evidence?.exactIsrcMatchCount ?? 0,
    releaseTitleOverlapCount: evidence?.exactReleaseTitles.length ?? 0,
    score: evidence?.score ?? 0,
    trackTitleOverlapCount: evidence?.exactTrackTitles.length ?? 0,
    upcMatches: evidence?.exactUpcMatchCount ?? 0,
  };
}

function albumsFromTopSongs(songs: AppleMusicSong[]): AppleMusicAlbumCandidate[] {
  const albums = new Map<string, AppleMusicAlbumCandidate>();
  for (const song of songs) {
    if (!song.albumId || !song.albumName) continue;
    const key = [song.albumId, song.albumName, song.releaseDate ?? ""].join(":");
    if (albums.has(key)) continue;
    albums.set(key, {
      albumId: song.albumId,
      artistIds: song.artistIds,
      artistName: song.artistName,
      paginationPath: song.paginationPath,
      pageNumber: song.pageNumber,
      ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
      sourceView: "album",
      title: song.albumName,
    });
  }
  return [...albums.values()];
}

function songAsCandidate(song: AppleMusicSong): AppleMusicSongCandidate {
  return {
    ...(song.albumId ? { albumId: song.albumId } : {}),
    ...(song.albumName ? { albumTitle: song.albumName } : {}),
    artistIds: song.artistIds,
    artistName: song.artistName,
    ...(song.discNumber === undefined ? {} : { discNumber: song.discNumber }),
    ...(song.durationMs === undefined ? {} : { durationMs: song.durationMs }),
    ...(song.isrc ? { isrc: song.isrc } : {}),
    paginationPath: song.paginationPath,
    pageNumber: song.pageNumber,
    ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
    songId: song.songId,
    title: song.title,
    ...(song.trackNumber === undefined ? {} : { trackNumber: song.trackNumber }),
  };
}

function incompleteDecision(
  decision: AppleMusicMappingDecision,
  reason: string,
): AppleMusicMappingDecision {
  return {
    candidates: decision.candidates,
    confidence: 0,
    evidence: decision.evidence,
    reason,
    status: "ambiguous",
  };
}

function emptyCandidateState(lookup: "missing"): CandidateState {
  return {
    compatible: false,
    lookup,
    singles: [],
    singlesAvailable: false,
    topSongs: [],
    topSongsAvailable: false,
  };
}

function isCandidateUnavailableError(error: unknown): boolean {
  return error instanceof AppleMusicClientError && (error.status === 400 || error.status === 404);
}

function classifyTerminal(error: unknown): {
  reason: string;
  status: AppleMusicStageBLiveSummary["status"];
} {
  if (error instanceof AppleMusicStageBResponseError) {
    return { reason: error.reason, status: "failed" };
  }
  if (error instanceof AppleMusicClientError) {
    if (error.status === 401) return { reason: "apple_unauthorized", status: "failed" };
    if (error.status === 403) return { reason: "apple_forbidden", status: "failed" };
    if (error.status === 429) return { reason: "apple_rate_limited", status: "failed" };
    if (error.classification === "request_budget_exhausted") {
      return { reason: "request_budget_exhausted", status: "controlled_partial" };
    }
    if (error.classification === "runtime_budget_exhausted") {
      return { reason: "runtime_budget_exhausted", status: "controlled_partial" };
    }
    if (error.classification === "unsafe_url") {
      return { reason: "unsafe_url", status: "failed" };
    }
    return { reason: `apple_${error.classification}`.slice(0, 500), status: "failed" };
  }
  return { reason: "database_integrity_or_unexpected_failure", status: "failed" };
}

function assertAuthorization(authorization: AppleMusicStageBLiveAuthorization): void {
  if (
    authorization[authorizationMarker] !== true ||
    authorization.confirmation !== appleMusicStageBLiveConfirmation ||
    authorization.persistentProviderEnabled !== false ||
    authorization.storefront !== "us"
  ) {
    throw new Error("Invalid Apple Stage B live authorization.");
  }
}

function assertExactScope(scope: AppleMusicStageBLiveScope): void {
  const candidates = scope.artists.flatMap((artist) => artist.candidateArtistIds);
  if (
    scope.artists.length !== 6 ||
    scope.candidateCount !== 39 ||
    candidates.length !== 39 ||
    new Set(candidates).size !== 39
  ) {
    throw new Error("Apple Stage B live execution requires exactly six artists and 39 candidates.");
  }
}

function requiredCandidateState(
  source: Map<string, CandidateState>,
  candidateId: string,
): CandidateState {
  const value = source.get(candidateId);
  if (!value) throw new AppleMusicStageBResponseError("candidate_state_missing");
  return value;
}

function candidateIdsForEntry(entry: AppleMusicIdentitySeedArtifact["entries"][number]): string[] {
  return [
    ...(entry.candidateArtistId ? [entry.candidateArtistId] : []),
    ...entry.alternateCandidateIds,
  ];
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
