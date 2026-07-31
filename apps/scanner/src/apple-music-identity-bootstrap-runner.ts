import {
  decideAppleMusicArtistMapping,
  type AppleMusicMappingDecision,
  type AppleMusicMappingEvidence,
  type resolveAppleMusicArtistFromCatalogEvidence,
} from "@radar/core";
import {
  AppleMusicClientError,
  type AppleMusicArtist,
  type AppleMusicArtistSongViewPage,
} from "@radar/providers";
import { resolveAppleMusicMappingFromTopSongs } from "./apple-music-catalog-evidence";
import {
  appleMusicIdentityBootstrapConfirmation,
  createAppleMusicIdentityBootstrapPlan,
  validateAppleMusicIdentityBootstrapArtifact,
  type AppleMusicIdentityBootstrapArtifact,
  type AppleMusicIdentityBootstrapArtist,
} from "./apple-music-identity-bootstrap";
import type { AppleMusicPilotStoredEvidence } from "./apple-music-pilot-runner";
import type { ItunesPilotSnapshot, ItunesPilotSnapshotArtist } from "./itunes-pilot-snapshot";

const authorizationMarker = Symbol("apple-music-identity-bootstrap-authorization");

export interface AppleMusicIdentityBootstrapAuthorization {
  readonly [authorizationMarker]: true;
  readonly confirmation: typeof appleMusicIdentityBootstrapConfirmation;
  readonly evidenceSourcesValidated: true;
  readonly persistentProviderEnabled: false;
  readonly storefront: "us";
}

export interface AppleMusicIdentityBootstrapClient {
  getArtist(id: string): Promise<AppleMusicArtist | undefined>;
  getArtistTopSongsFirstPage(
    artistId: string,
    identityScope: string,
    signal?: AbortSignal,
  ): Promise<AppleMusicArtistSongViewPage>;
}

export interface AppleMusicIdentityBootstrapStore {
  claimLease(runId: string): Promise<string>;
  createRun(input: {
    implementationCommit: string;
    maximumRuntimeMs: 60_000;
    minRequestIntervalMs: 1_100;
    requestBudget: 25;
    snapshotId: string;
  }): Promise<{ id: string }>;
  findConfirmedMapping(input: {
    canonicalArtistId: string;
    snapshotId: string;
  }): Promise<{ appleArtistId: string } | undefined>;
  finishRun(
    runId: string,
    input: {
      metrics: Record<string, unknown>;
      status: "completed" | "controlled_partial" | "failed";
      stopReason: string;
    },
  ): Promise<void>;
  importSnapshot(snapshot: ItunesPilotSnapshot): Promise<string>;
  operationalStatus(): Promise<{ cooldownActive: boolean; leaseActive: boolean }>;
  readEvidence(runId: string): Promise<AppleMusicPilotStoredEvidence>;
  releaseLease(leaseToken: string): Promise<void>;
  saveMapping(input: {
    canonicalArtistId: string;
    decision: AppleMusicMappingDecision;
    inheritedItunesArtistId?: string;
    runId: string;
  }): Promise<void>;
}

export interface AppleMusicIdentityBootstrapArtistResult {
  artist: string;
  candidateCount: number;
  candidates: Array<{
    conflictCount: number;
    releaseTitleOverlapCount: number;
    score: number;
    trackTitleOverlapCount: number;
  }>;
  durableMappingWritten: boolean;
  existingIdResult: "confirmed" | "not_applicable" | "rejected" | "unavailable";
  finalClassification: AppleMusicMappingDecision["status"];
  manualReviewRequired: boolean;
  path: "candidate_evidence" | "durable_existing" | "seeded_id";
  reason: string;
  requestsMade: number;
  scoreGap?: number;
  unavailableEvidenceCount: number;
}

export interface AppleMusicIdentityBootstrapSummary {
  artists: AppleMusicIdentityBootstrapArtistResult[];
  evidence: AppleMusicPilotStoredEvidence;
  evidenceConfirmed: number;
  existingMappingsReused: number;
  manualReviewCount: number;
  mode: "mapping_bootstrap_13";
  requestBudget: 25;
  runId: string;
  seededConfirmed: number;
  seededRejected: number;
  seededUnresolved: number;
  status: "completed" | "controlled_partial" | "failed";
  stopReason: string;
}

export function authorizeAppleMusicIdentityBootstrap(input: {
  confirmation?: string;
  evidenceSourcesValidated: boolean;
  executeLive: boolean;
  otherProvidersDisabled: boolean;
  persistentAppleMusicEnabled: string | undefined;
  storefront: string;
}): AppleMusicIdentityBootstrapAuthorization {
  if (!input.executeLive) throw new Error("Apple identity bootstrap requires --execute-live.");
  if (input.confirmation !== appleMusicIdentityBootstrapConfirmation) {
    throw new Error(
      `Apple identity bootstrap requires --confirm-live ${appleMusicIdentityBootstrapConfirmation}.`,
    );
  }
  if (!input.evidenceSourcesValidated) {
    throw new Error("Apple identity bootstrap evidence sources must be validated.");
  }
  if (input.persistentAppleMusicEnabled !== "false") {
    throw new Error("Persistent APPLE_MUSIC_ENABLED must remain exactly false.");
  }
  if (!input.otherProvidersDisabled) {
    throw new Error("Every non-Apple provider must be disabled.");
  }
  if (input.storefront !== "us") {
    throw new Error("Apple identity bootstrap requires the US storefront.");
  }
  return Object.freeze({
    [authorizationMarker]: true as const,
    confirmation: appleMusicIdentityBootstrapConfirmation,
    evidenceSourcesValidated: true as const,
    persistentProviderEnabled: false as const,
    storefront: "us" as const,
  });
}

export async function runAppleMusicIdentityBootstrap(input: {
  artifact: AppleMusicIdentityBootstrapArtifact;
  authorization: AppleMusicIdentityBootstrapAuthorization;
  createClient(runId: string, leaseToken: string): AppleMusicIdentityBootstrapClient;
  implementationCommit: string;
  resolver?: typeof resolveAppleMusicArtistFromCatalogEvidence;
  snapshot: ItunesPilotSnapshot;
  store: AppleMusicIdentityBootstrapStore;
}): Promise<AppleMusicIdentityBootstrapSummary> {
  assertAuthorization(input.authorization);
  const artifact = validateAppleMusicIdentityBootstrapArtifact(input.artifact, input.snapshot);
  const plan = createAppleMusicIdentityBootstrapPlan(artifact, input.snapshot);
  if (plan.requestForecast !== 21) {
    throw new Error("Apple identity bootstrap requires exactly 21 planned operations.");
  }
  const operational = await input.store.operationalStatus();
  if (operational.cooldownActive) throw new Error("Apple Music has an active cooldown.");
  if (operational.leaseActive) throw new Error("Apple Music has an active lease.");
  const snapshotId = await input.store.importSnapshot(input.snapshot);
  const run = await input.store.createRun({
    implementationCommit: input.implementationCommit,
    maximumRuntimeMs: 60_000,
    minRequestIntervalMs: 1_100,
    requestBudget: 25,
    snapshotId,
  });
  let leaseToken: string | undefined;
  let status: AppleMusicIdentityBootstrapSummary["status"] = "failed";
  let stopReason = "unexpected_failure";
  const artists: AppleMusicIdentityBootstrapArtistResult[] = [];
  let summary: AppleMusicIdentityBootstrapSummary | undefined;
  try {
    leaseToken = await input.store.claimLease(run.id);
    const client = input.createClient(run.id, leaseToken);
    for (const artifactArtist of artifact.artists) {
      const snapshotArtist = requiredSnapshotArtist(input.snapshot, artifactArtist);
      const existing = await input.store.findConfirmedMapping({
        canonicalArtistId: snapshotArtist.canonicalArtistId,
        snapshotId,
      });
      if (existing) {
        artists.push(existingResult(snapshotArtist));
        continue;
      }
      const outcome = artifactArtist.candidateArtistId
        ? await resolveSeededArtist(client, artifactArtist, snapshotArtist)
        : await resolveCandidateEvidenceArtist(
            client,
            artifactArtist,
            snapshotArtist,
            input.snapshot,
            `mapping-bootstrap:${run.id}`,
            input.resolver,
          );
      await input.store.saveMapping({
        canonicalArtistId: snapshotArtist.canonicalArtistId,
        decision: outcome.decision,
        ...(artifactArtist.candidateArtistId
          ? { inheritedItunesArtistId: artifactArtist.candidateArtistId }
          : {}),
        runId: run.id,
      });
      artists.push({
        ...outcome.result,
        durableMappingWritten: Boolean(outcome.decision.selected),
      });
    }
    status = "completed";
    stopReason = "mapping_bootstrap_completed";
  } catch (error) {
    const classified = classifyTerminal(error);
    status = classified.status;
    stopReason = classified.reason;
  } finally {
    try {
      const evidence = await input.store.readEvidence(run.id);
      summary = createSummary(artists, evidence, run.id, status, stopReason);
      await input.store.finishRun(run.id, {
        metrics: summary as unknown as Record<string, unknown>,
        status,
        stopReason,
      });
    } finally {
      if (leaseToken) await input.store.releaseLease(leaseToken);
    }
  }
  if (!summary) throw new Error("Apple identity bootstrap summary was not created.");
  return summary;
}

async function resolveSeededArtist(
  client: AppleMusicIdentityBootstrapClient,
  artifactArtist: AppleMusicIdentityBootstrapArtist,
  snapshotArtist: ItunesPilotSnapshotArtist,
): Promise<{
  decision: AppleMusicMappingDecision;
  result: AppleMusicIdentityBootstrapArtistResult;
}> {
  const candidateId = artifactArtist.candidateArtistId!;
  let resolved: AppleMusicArtist | undefined;
  try {
    resolved = await client.getArtist(candidateId);
  } catch (error) {
    if (!isCandidateLocalError(error)) throw error;
    const decision = unresolvedDecision("The approved public-ID seed was unavailable.");
    return {
      decision,
      result: resultFromDecision(snapshotArtist.canonicalName, "seeded_id", 1, decision, {
        existingIdResult: "unavailable",
        unavailableEvidenceCount: 1,
      }),
    };
  }
  if (!resolved) {
    const decision = unresolvedDecision("The approved public-ID seed returned no artist.");
    return {
      decision,
      result: resultFromDecision(snapshotArtist.canonicalName, "seeded_id", 1, decision, {
        existingIdResult: "unavailable",
        unavailableEvidenceCount: 1,
      }),
    };
  }
  const decision = decideAppleMusicArtistMapping({
    aliases: snapshotArtist.aliases,
    canonicalName: snapshotArtist.canonicalName,
    existingArtist: resolved,
    existingArtistId: candidateId,
    searchCandidates: [],
  });
  return {
    decision,
    result: resultFromDecision(snapshotArtist.canonicalName, "seeded_id", 1, decision, {
      existingIdResult: decision.selected ? "confirmed" : "rejected",
      unavailableEvidenceCount: 0,
    }),
  };
}

async function resolveCandidateEvidenceArtist(
  client: AppleMusicIdentityBootstrapClient,
  artifactArtist: AppleMusicIdentityBootstrapArtist,
  snapshotArtist: ItunesPilotSnapshotArtist,
  snapshot: ItunesPilotSnapshot,
  identityScope: string,
  resolver: typeof resolveAppleMusicArtistFromCatalogEvidence | undefined,
): Promise<{
  decision: AppleMusicMappingDecision;
  result: AppleMusicIdentityBootstrapArtistResult;
}> {
  const candidateIds = artifactArtist.candidateEvidenceArtistIds!;
  const candidateEvidence = [];
  let unavailableEvidenceCount = 0;
  for (const artistId of candidateIds) {
    try {
      const page = await client.getArtistTopSongsFirstPage(artistId, identityScope);
      candidateEvidence.push({
        artist: { artistId, name: snapshotArtist.canonicalName },
        songs: page.items,
      });
    } catch (error) {
      if (!isCandidateLocalError(error)) throw error;
      unavailableEvidenceCount += 1;
      candidateEvidence.push({
        artist: { artistId, name: snapshotArtist.canonicalName },
        songs: [],
      });
    }
  }
  let decision = resolveAppleMusicMappingFromTopSongs(
    {
      aliases: snapshotArtist.aliases,
      candidateEvidence,
      canonicalName: snapshotArtist.canonicalName,
      groundTruth: snapshot.groundTruthReleases.filter(
        (release) => release.canonicalArtistId === snapshotArtist.canonicalArtistId,
      ),
    },
    resolver,
  );
  if (unavailableEvidenceCount > 0 && decision.selected) {
    decision = {
      candidates: decision.candidates,
      confidence: 0,
      evidence: decision.evidence,
      reason: "Candidate evidence was incomplete, so identity remains ambiguous.",
      status: "ambiguous",
    };
  }
  return {
    decision,
    result: resultFromDecision(
      snapshotArtist.canonicalName,
      "candidate_evidence",
      candidateIds.length,
      decision,
      {
        existingIdResult: "not_applicable",
        unavailableEvidenceCount,
      },
    ),
  };
}

function resultFromDecision(
  artist: string,
  path: "candidate_evidence" | "seeded_id",
  requestsMade: number,
  decision: AppleMusicMappingDecision,
  extra: Pick<
    AppleMusicIdentityBootstrapArtistResult,
    "existingIdResult" | "unavailableEvidenceCount"
  >,
): AppleMusicIdentityBootstrapArtistResult {
  const candidates = decision.evidence.map(sanitizedEvidence);
  const rankedScores = candidates.map((candidate) => candidate.score).sort((a, b) => b - a);
  return {
    artist,
    candidateCount: path === "candidate_evidence" ? 2 : 1,
    candidates,
    durableMappingWritten: false,
    existingIdResult: extra.existingIdResult,
    finalClassification: decision.status,
    manualReviewRequired: !decision.selected,
    path,
    reason: decision.reason,
    requestsMade,
    ...(rankedScores.length >= 2 ? { scoreGap: rankedScores[0]! - rankedScores[1]! } : {}),
    unavailableEvidenceCount: extra.unavailableEvidenceCount,
  };
}

function sanitizedEvidence(evidence: AppleMusicMappingEvidence) {
  return {
    conflictCount: evidence.conflictingReleaseTitles.length,
    releaseTitleOverlapCount: evidence.exactReleaseTitles.length,
    score: evidence.score,
    trackTitleOverlapCount: evidence.exactTrackTitles.length,
  };
}

function existingResult(
  artist: ItunesPilotSnapshotArtist,
): AppleMusicIdentityBootstrapArtistResult {
  return {
    artist: artist.canonicalName,
    candidateCount: 0,
    candidates: [],
    durableMappingWritten: false,
    existingIdResult: "confirmed",
    finalClassification: "evidence_confirmed",
    manualReviewRequired: false,
    path: "durable_existing",
    reason: "An existing durable confirmed mapping was preserved.",
    requestsMade: 0,
    unavailableEvidenceCount: 0,
  };
}

function unresolvedDecision(reason: string): AppleMusicMappingDecision {
  return {
    candidates: [],
    confidence: 0,
    evidence: [],
    reason,
    status: "ambiguous",
  };
}

function isCandidateLocalError(error: unknown): boolean {
  return (
    error instanceof AppleMusicClientError &&
    (error.status === 400 || error.status === 404 || (error.status ?? 0) >= 500)
  );
}

function classifyTerminal(error: unknown): {
  reason: string;
  status: AppleMusicIdentityBootstrapSummary["status"];
} {
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
  return { reason: "unexpected_failure", status: "failed" };
}

function createSummary(
  artists: AppleMusicIdentityBootstrapArtistResult[],
  evidence: AppleMusicPilotStoredEvidence,
  runId: string,
  status: AppleMusicIdentityBootstrapSummary["status"],
  stopReason: string,
): AppleMusicIdentityBootstrapSummary {
  const seeded = artists.filter((artist) => artist.path === "seeded_id");
  return {
    artists,
    evidence,
    evidenceConfirmed: artists.filter(
      (artist) =>
        artist.path === "candidate_evidence" && artist.finalClassification === "evidence_confirmed",
    ).length,
    existingMappingsReused: artists.filter((artist) => artist.path === "durable_existing").length,
    manualReviewCount: artists.filter((artist) => artist.manualReviewRequired).length,
    mode: "mapping_bootstrap_13",
    requestBudget: 25,
    runId,
    seededConfirmed: seeded.filter(
      (artist) => artist.finalClassification === "existing_id_confirmed",
    ).length,
    seededRejected: seeded.filter((artist) => artist.finalClassification === "rejected").length,
    seededUnresolved: seeded.filter(
      (artist) => !["existing_id_confirmed", "rejected"].includes(artist.finalClassification),
    ).length,
    status,
    stopReason,
  };
}

function requiredSnapshotArtist(
  snapshot: ItunesPilotSnapshot,
  artifactArtist: AppleMusicIdentityBootstrapArtist,
): ItunesPilotSnapshotArtist {
  const artist = snapshot.artists.find(
    (candidate) => candidate.canonicalName === artifactArtist.canonicalArtistName,
  );
  if (!artist) throw new Error("Apple identity bootstrap artist is missing from the snapshot.");
  return artist;
}

function assertAuthorization(authorization: AppleMusicIdentityBootstrapAuthorization): void {
  if (
    authorization[authorizationMarker] !== true ||
    authorization.confirmation !== appleMusicIdentityBootstrapConfirmation ||
    authorization.persistentProviderEnabled !== false ||
    authorization.storefront !== "us"
  ) {
    throw new Error("Invalid Apple identity bootstrap authorization.");
  }
}
