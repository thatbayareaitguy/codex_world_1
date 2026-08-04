import {
  decideAppleMusicArtistMapping,
  resolveAppleMusicArtistFromCatalogEvidence,
  type AppleMusicMappingDecision,
  type AppleMusicMappingStatus,
  type SpotifyGroundTruthRelease,
} from "@radar/core";
import {
  AppleMusicClientError,
  type AppleMusicAlbum,
  type AppleMusicArtist,
  type AppleMusicBatchResult,
  type AppleMusicSong,
} from "@radar/providers";
import type {
  AppleMusicDurableArtistMapping,
  AppleMusicDurableConfirmationMethod,
  AppleMusicIdentityCampaignEntryStatus,
  AppleMusicIdentityCampaignRecord,
  AppleMusicIdentityCampaignStatus,
} from "@radar/db";
import {
  validateApprovedAppleMusicIdentitySeedArtifact,
  type AppleMusicIdentitySeedArtifact,
} from "./apple-music-identity-seed-artifact";
import type { AppleMusicPilotStoredEvidence } from "./apple-music-pilot-runner";

export const appleMusicFullWatchlistConfirmation = "APPLE_PUBLIC_CATALOG_STRONG_SEEDS_320" as const;
export const appleMusicFullWatchlistRequestBudget = 40 as const;
export const appleMusicFullWatchlistMaximumRuntimeMs = 600_000 as const;
export const appleMusicFullWatchlistMinRequestIntervalMs = 1_100 as const;

const strongClassifications = new Set(["high_confidence_seed", "evidence_supported_seed"]);
const authorizationMarker = Symbol("apple-full-watchlist-mapping-authorization");

export interface AppleMusicFullWatchlistPlan {
  artifact: {
    artifactSelfHash: string;
    classificationCounts: AppleMusicIdentitySeedArtifact["classificationCounts"];
    inputWatchlistHash: string;
    schemaVersion: 1;
    totalArtists: 593;
  };
  categories: {
    alreadyConfirmed: number;
    ambiguousSeeds: number;
    evidenceSupportedSeeds: number;
    highConfidenceSeeds: number;
    manualReview: number;
  };
  mode: "full_watchlist_mapping_plan";
  safety: {
    credentialsAccessed: false;
    databaseWrites: 0;
    developerTokenGenerated: false;
    networkRequestsStarted: 0;
    providerClientInitialized: false;
    releaseDiscoveryReachable: false;
  };
  stageA: {
    batchRequests: number;
    concurrency: 1;
    existingStrongMappings: number;
    maximumRuntimeMs: 600_000;
    minRequestIntervalMs: 1_100;
    minimumPacingRuntimeMs: number;
    noNameSearch: true;
    noPagination: true;
    requestBudget: 40;
    retryAndSafetyHeadroom: number;
    strongSeeds: 320;
    seedsToValidate: number;
  };
  stageB: {
    batches: Array<{
      artistCount: number;
      batchNumber: number;
      candidateIds: number;
      candidateLookupRequests: number;
      maximumSinglesFallbackRequests: number;
      maximumTopSongsRequests: number;
    }>;
    candidateIds: number;
    candidateLookupRequests: number;
    executionAuthorized: false;
    maximumSinglesFallbackRequests: number;
    maximumTopSongsRequests: number;
    remainingAmbiguousArtists: number;
  };
}

export interface AppleMusicFullWatchlistAuthorization {
  readonly [authorizationMarker]: true;
  readonly confirmation: typeof appleMusicFullWatchlistConfirmation;
  readonly persistentProviderEnabled: false;
  readonly stage: "strong_seeds";
  readonly storefront: "us";
}

export interface AppleMusicFullWatchlistClient {
  getArtists(ids: string[]): Promise<AppleMusicBatchResult<AppleMusicArtist>>;
}

export interface AppleMusicFullWatchlistCampaignEntry {
  artifactClassification: string;
  attempts: number;
  batchIndex: number | null;
  candidateCount: number;
  canonicalArtistId: string;
  evidence: unknown;
  manualReviewReason: string | null;
  selectedAppleArtistId: string | null;
  selectedArtistName: string | null;
  status: AppleMusicIdentityCampaignEntryStatus;
  validationPath: string;
}

export interface AppleMusicFullWatchlistStore {
  advanceCampaign(campaignId: string, nextBatchIndex: number): Promise<void>;
  claimLease(runId: string): Promise<string>;
  createRun(input: {
    implementationCommit: string;
    maximumRuntimeMs: 600_000;
    minRequestIntervalMs: 1_100;
    requestBudget: 40;
    snapshotId: string;
  }): Promise<{ id: string }>;
  findCampaign(
    artifactHash: string,
    stage: "strong_seeds",
  ): Promise<AppleMusicIdentityCampaignRecord | undefined>;
  finishCampaign(
    campaignId: string,
    input: {
      metrics: Record<string, unknown>;
      status: AppleMusicIdentityCampaignStatus;
      stopReason: string;
    },
  ): Promise<void>;
  finishRun(
    runId: string,
    input: {
      metrics: Record<string, unknown>;
      status: "completed" | "controlled_partial" | "failed";
      stopReason: string;
    },
  ): Promise<void>;
  latestOperationalSnapshotId(): Promise<string | undefined>;
  listCampaignEntries(campaignId: string): Promise<AppleMusicFullWatchlistCampaignEntry[]>;
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
    confirmationMethod: AppleMusicDurableConfirmationMethod;
    confirmedRunId: string;
    sourceClassification: string;
  }): Promise<AppleMusicDurableArtistMapping>;
  saveMapping(input: {
    canonicalArtistId: string;
    decision: AppleMusicMappingDecision;
    inheritedItunesArtistId?: string;
    runId: string;
  }): Promise<void>;
  seedCampaignEntries(
    campaignId: string,
    entries: Array<{
      artifactClassification: string;
      candidateCount: number;
      canonicalArtistId: string;
      manualReviewReason?: string;
      status: AppleMusicIdentityCampaignEntryStatus;
      validationPath: string;
    }>,
  ): Promise<void>;
  startCampaign(input: {
    artifactHash: string;
    implementationCommit: string;
    runId: string;
    schemaVersion: number;
    stage: "strong_seeds";
    watchlistHash: string;
  }): Promise<AppleMusicIdentityCampaignRecord>;
  updateCampaignEntry(input: {
    batchIndex?: number;
    campaignId: string;
    canonicalArtistId: string;
    evidence: Record<string, unknown>;
    manualReviewReason?: string;
    selectedAppleArtistId?: string;
    selectedArtistName?: string;
    status: AppleMusicIdentityCampaignEntryStatus;
  }): Promise<void>;
}

export interface AppleMusicFullWatchlistSummary {
  ambiguous: number;
  artifactHash: string;
  batchesCompleted: number;
  confirmed: number;
  cooldownActive: boolean;
  evidence: AppleMusicPilotStoredEvidence;
  existingMappingsReused: number;
  highConfidenceConfirmed: number;
  evidenceSupportedConfirmed: number;
  manualReview: number;
  missing: number;
  mode: "full_watchlist_strong_seed_validation";
  rejected: number;
  requestBudget: 40;
  runId: string;
  status: "completed" | "controlled_partial" | "failed";
  stopReason: string;
  totalDurableMappings: number;
  watchlistHash: string;
}

export function createAppleMusicFullWatchlistPlan(
  artifact: AppleMusicIdentitySeedArtifact,
  durableMappings: AppleMusicDurableArtistMapping[],
  validateArtifact: (
    value: AppleMusicIdentitySeedArtifact,
  ) => AppleMusicIdentitySeedArtifact = validateApprovedAppleMusicIdentitySeedArtifact,
): AppleMusicFullWatchlistPlan {
  const valid = validateArtifact(artifact);
  const known = new Set(durableMappings.map((mapping) => mapping.canonicalArtistId));
  const strong = valid.entries.filter((entry) => strongClassifications.has(entry.classification));
  const ambiguous = valid.entries.filter((entry) => entry.classification === "ambiguous_seed");
  const strongExisting = strong.filter((entry) => known.has(entry.watchedArtistId)).length;
  const seedsToValidate = strong.length - strongExisting;
  const batchRequests = Math.ceil(seedsToValidate / 25);
  const remainingAmbiguous = ambiguous.filter((entry) => !known.has(entry.watchedArtistId));
  const stageBBatches = chunk(remainingAmbiguous, 50).map((entries, index) => {
    const candidateIds = entries.reduce(
      (total, entry) => total + entry.alternateCandidateIds.length,
      0,
    );
    const evidenceRequests = entries.reduce(
      (total, entry) => total + entry.alternateCandidateIds.length,
      0,
    );
    return {
      artistCount: entries.length,
      batchNumber: index + 1,
      candidateIds,
      candidateLookupRequests: Math.ceil(candidateIds / 25),
      maximumSinglesFallbackRequests: evidenceRequests,
      maximumTopSongsRequests: evidenceRequests,
    };
  });
  return {
    artifact: {
      artifactSelfHash: valid.artifactSelfHash,
      classificationCounts: valid.classificationCounts,
      inputWatchlistHash: valid.inputWatchlistHash,
      schemaVersion: 1,
      totalArtists: 593,
    },
    categories: {
      alreadyConfirmed: known.size,
      ambiguousSeeds: valid.classificationCounts.ambiguous_seed,
      evidenceSupportedSeeds: valid.classificationCounts.evidence_supported_seed,
      highConfidenceSeeds: valid.classificationCounts.high_confidence_seed,
      manualReview:
        valid.classificationCounts.manual_review_required + valid.classificationCounts.no_candidate,
    },
    mode: "full_watchlist_mapping_plan",
    safety: {
      credentialsAccessed: false,
      databaseWrites: 0,
      developerTokenGenerated: false,
      networkRequestsStarted: 0,
      providerClientInitialized: false,
      releaseDiscoveryReachable: false,
    },
    stageA: {
      batchRequests,
      concurrency: 1,
      existingStrongMappings: strongExisting,
      maximumRuntimeMs: 600_000,
      minRequestIntervalMs: 1_100,
      minimumPacingRuntimeMs: Math.max(0, batchRequests - 1) * 1_100,
      noNameSearch: true,
      noPagination: true,
      requestBudget: 40,
      retryAndSafetyHeadroom: 40 - batchRequests,
      strongSeeds: 320,
      seedsToValidate,
    },
    stageB: {
      batches: stageBBatches,
      candidateIds: sum(stageBBatches.map((batch) => batch.candidateIds)),
      candidateLookupRequests: sum(stageBBatches.map((batch) => batch.candidateLookupRequests)),
      executionAuthorized: false,
      maximumSinglesFallbackRequests: sum(
        stageBBatches.map((batch) => batch.maximumSinglesFallbackRequests),
      ),
      maximumTopSongsRequests: sum(stageBBatches.map((batch) => batch.maximumTopSongsRequests)),
      remainingAmbiguousArtists: remainingAmbiguous.length,
    },
  };
}

export function authorizeAppleMusicFullWatchlist(input: {
  confirmation?: string;
  executeLive: boolean;
  otherProvidersDisabled: boolean;
  persistentAppleMusicEnabled: string | undefined;
  stage: string;
  storefront: string;
}): AppleMusicFullWatchlistAuthorization {
  if (!input.executeLive) throw new Error("Strong-seed validation requires --execute-live.");
  if (input.confirmation !== appleMusicFullWatchlistConfirmation) {
    throw new Error(
      `Strong-seed validation requires --confirm-live ${appleMusicFullWatchlistConfirmation}.`,
    );
  }
  if (input.stage !== "strong_seeds") {
    throw new Error("Only the strong_seeds stage is authorized.");
  }
  if (input.persistentAppleMusicEnabled !== "false") {
    throw new Error("Persistent APPLE_MUSIC_ENABLED must remain exactly false.");
  }
  if (!input.otherProvidersDisabled) throw new Error("Every non-Apple provider must be disabled.");
  if (input.storefront !== "us") throw new Error("Strong-seed validation requires US storefront.");
  return Object.freeze({
    [authorizationMarker]: true as const,
    confirmation: appleMusicFullWatchlistConfirmation,
    persistentProviderEnabled: false as const,
    stage: "strong_seeds" as const,
    storefront: "us" as const,
  });
}

export async function runAppleMusicFullWatchlistStrongSeeds(input: {
  artifact: AppleMusicIdentitySeedArtifact;
  authorization: AppleMusicFullWatchlistAuthorization;
  createClient(runId: string, leaseToken: string): AppleMusicFullWatchlistClient;
  implementationCommit: string;
  store: AppleMusicFullWatchlistStore;
  validateArtifact?: (value: AppleMusicIdentitySeedArtifact) => AppleMusicIdentitySeedArtifact;
}): Promise<AppleMusicFullWatchlistSummary> {
  assertAuthorization(input.authorization);
  const artifact = (input.validateArtifact ?? validateApprovedAppleMusicIdentitySeedArtifact)(
    input.artifact,
  );
  const existingCampaign = await input.store.findCampaign(
    artifact.artifactSelfHash,
    "strong_seeds",
  );
  if (existingCampaign?.status === "completed") {
    throw new Error("Strong-seed validation is already complete for this artifact.");
  }
  const operational = await input.store.operationalStatus();
  if (operational.cooldownActive) throw new Error("Apple Music has an active cooldown.");
  if (operational.leaseActive || operational.queueDepth > 0) {
    throw new Error("Apple Music has active or queued work.");
  }
  const durableBefore = await input.store.listDurableMappings(
    artifact.entries.map((entry) => entry.watchedArtistId),
  );
  const plan = createAppleMusicFullWatchlistPlan(
    artifact,
    durableBefore,
    input.validateArtifact ?? validateApprovedAppleMusicIdentitySeedArtifact,
  );
  if (plan.stageA.batchRequests > appleMusicFullWatchlistRequestBudget) {
    throw new Error("Strong-seed forecast exceeds the authorized request ceiling.");
  }
  const snapshotId = await input.store.latestOperationalSnapshotId();
  if (!snapshotId) throw new Error("The isolated Apple database has no operational snapshot.");
  const run = await input.store.createRun({
    implementationCommit: input.implementationCommit,
    maximumRuntimeMs: appleMusicFullWatchlistMaximumRuntimeMs,
    minRequestIntervalMs: appleMusicFullWatchlistMinRequestIntervalMs,
    requestBudget: appleMusicFullWatchlistRequestBudget,
    snapshotId,
  });
  let campaign: AppleMusicIdentityCampaignRecord | undefined;
  let leaseToken: string | undefined;
  let status: AppleMusicFullWatchlistSummary["status"] = "failed";
  let stopReason = "unexpected_failure";
  let summary: AppleMusicFullWatchlistSummary | undefined;
  try {
    leaseToken = await input.store.claimLease(run.id);
    campaign = await input.store.startCampaign({
      artifactHash: artifact.artifactSelfHash,
      implementationCommit: input.implementationCommit,
      runId: run.id,
      schemaVersion: artifact.schemaVersion,
      stage: "strong_seeds",
      watchlistHash: artifact.inputWatchlistHash,
    });
    const durableByArtist = new Map(
      durableBefore.map((mapping) => [mapping.canonicalArtistId, mapping]),
    );
    await input.store.seedCampaignEntries(
      campaign.id,
      artifact.entries.map((entry) => {
        const existing = durableByArtist.has(entry.watchedArtistId);
        const strong = strongClassifications.has(entry.classification);
        return {
          artifactClassification: entry.classification,
          candidateCount: (entry.candidateArtistId ? 1 : 0) + entry.alternateCandidateIds.length,
          canonicalArtistId: entry.watchedArtistId,
          ...(entry.manualReviewReason ? { manualReviewReason: entry.manualReviewReason } : {}),
          status: existing ? "reused" : strong ? "pending" : "manual_review",
          validationPath: existing
            ? "durable_existing"
            : strong
              ? "batched_artist_lookup"
              : "stage_b_or_manual_review",
        };
      }),
    );
    let persistedEntries = await input.store.listCampaignEntries(campaign.id);
    for (const entry of persistedEntries) {
      if (entry.status === "pending" && durableByArtist.has(entry.canonicalArtistId)) {
        await input.store.updateCampaignEntry({
          campaignId: campaign.id,
          canonicalArtistId: entry.canonicalArtistId,
          evidence: { reusedDurableMapping: true },
          status: "reused",
        });
      }
    }
    persistedEntries = await input.store.listCampaignEntries(campaign.id);
    const pendingIds = new Set(
      persistedEntries
        .filter((entry) => entry.status === "pending")
        .map((entry) => entry.canonicalArtistId),
    );
    const pending = artifact.entries.filter(
      (entry) =>
        pendingIds.has(entry.watchedArtistId) &&
        strongClassifications.has(entry.classification) &&
        entry.candidateArtistId,
    );
    const client = input.createClient(run.id, leaseToken);
    let nextBatchIndex = campaign.nextBatchIndex;
    for (const batch of chunk(pending, 25)) {
      const batchIndex = nextBatchIndex;
      const requestedIds = batch.map((entry) => entry.candidateArtistId!);
      const response = await client.getArtists(requestedIds);
      assertSafeBatchResponse(requestedIds, response);
      const returned = new Map(response.items.map((artist) => [artist.artistId, artist]));
      for (const entry of batch) {
        const candidateArtistId = entry.candidateArtistId;
        if (!candidateArtistId) throw new Error("A strong seed has no candidate artist ID.");
        const artist = returned.get(candidateArtistId);
        const outcome = decideStrongSeed(entry, artist);
        await input.store.saveMapping({
          canonicalArtistId: entry.watchedArtistId,
          decision: outcome.decision,
          inheritedItunesArtistId: candidateArtistId,
          runId: run.id,
        });
        if (outcome.decision.selected) {
          await input.store.saveDurableMapping({
            appleArtistId: outcome.decision.selected.artistId,
            artifactHash: artifact.artifactSelfHash,
            artistName: outcome.decision.selected.name,
            canonicalArtistId: entry.watchedArtistId,
            confirmationMethod:
              entry.classification === "high_confidence_seed"
                ? "high_confidence_seed"
                : "evidence_supported_seed",
            confirmedRunId: run.id,
            sourceClassification: entry.classification,
          });
        }
        await input.store.updateCampaignEntry({
          batchIndex,
          campaignId: campaign.id,
          canonicalArtistId: entry.watchedArtistId,
          evidence: outcome.safeEvidence,
          ...(outcome.decision.selected
            ? {
                selectedAppleArtistId: outcome.decision.selected.artistId,
                selectedArtistName: outcome.decision.selected.name,
              }
            : {}),
          ...(outcome.manualReviewReason ? { manualReviewReason: outcome.manualReviewReason } : {}),
          status: outcome.entryStatus,
        });
      }
      nextBatchIndex += 1;
      await input.store.advanceCampaign(campaign.id, nextBatchIndex);
    }
    status = "completed";
    stopReason = "strong_seed_validation_completed";
  } catch (error) {
    const classified = classifyTerminal(error);
    status = classified.status;
    stopReason = classified.reason;
  } finally {
    try {
      const evidence = await input.store.readEvidence(run.id);
      const entries = campaign ? await input.store.listCampaignEntries(campaign.id) : [];
      const durableAfter = await input.store.listDurableMappings(
        artifact.entries.map((entry) => entry.watchedArtistId),
      );
      summary = createSummary({
        artifact,
        cooldownActive: (await input.store.operationalStatus()).cooldownActive,
        durableAfter,
        entries,
        evidence,
        runId: run.id,
        status,
        stopReason,
      });
      if (campaign) {
        await input.store.finishCampaign(campaign.id, {
          metrics: summary as unknown as Record<string, unknown>,
          status,
          stopReason,
        });
      }
      await input.store.finishRun(run.id, {
        metrics: summary as unknown as Record<string, unknown>,
        status,
        stopReason,
      });
    } finally {
      if (leaseToken) await input.store.releaseLease(leaseToken);
    }
  }
  if (!summary) throw new Error("Strong-seed validation summary was not created.");
  return summary;
}

export function resolveFullWatchlistAmbiguousCandidate(input: {
  aliases: string[];
  candidateCatalogs: Array<{
    albums: AppleMusicAlbum[];
    artist: AppleMusicArtist;
    songs: AppleMusicSong[];
  }>;
  canonicalName: string;
  groundTruth: SpotifyGroundTruthRelease[];
}): AppleMusicMappingDecision {
  return resolveAppleMusicArtistFromCatalogEvidence(input);
}

export function createAppleMusicManualReviewArtifacts(
  artifact: AppleMusicIdentitySeedArtifact,
  entries: AppleMusicFullWatchlistCampaignEntry[],
): { localJson: string; markdown: string } {
  const byArtist = new Map(entries.map((entry) => [entry.canonicalArtistId, entry]));
  const unresolved = artifact.entries.filter((entry) => {
    const status = byArtist.get(entry.watchedArtistId)?.status;
    return !status || !["reused", "confirmed"].includes(status);
  });
  const local = unresolved.map((entry) => {
    const persisted = byArtist.get(entry.watchedArtistId);
    return {
      aliases: entry.aliases,
      candidateArtistIds: [
        ...(entry.candidateArtistId ? [entry.candidateArtistId] : []),
        ...entry.alternateCandidateIds,
      ],
      canonicalArtistName: entry.canonicalArtistName,
      finalStatus: persisted?.status ?? "not_attempted",
      publicArtistPageUrl: entry.publicArtistPageUrl,
      reason:
        persisted?.manualReviewReason ?? entry.manualReviewReason ?? "Manual validation required.",
      watchedArtistId: entry.watchedArtistId,
    };
  });
  const rows = unresolved.map((entry) => {
    const persisted = byArtist.get(entry.watchedArtistId);
    const candidates = (entry.candidateArtistId ? 1 : 0) + entry.alternateCandidateIds.length;
    const evaluated = persisted && persisted.attempts > 0 ? candidates : 0;
    return `| ${escapeCell(entry.canonicalArtistName)} | ${escapeCell(entry.aliases.join(", ") || "None")} | ${evaluated} | ${escapeCell(persisted?.validationPath ?? "Not attempted")} | ${entry.releaseTitleOverlapCount} | ${entry.trackTitleOverlapCount} | ${entry.conflictingEvidenceCount} | Not available | ${escapeCell(persisted?.status ?? "not_attempted")} | ${escapeCell(persisted?.manualReviewReason ?? entry.manualReviewReason ?? "Evidence did not establish one safe identity.")} | Compare the bounded candidate pages and confirm the exact artist identity. |`;
  });
  const markdown = [
    "# Apple Music Full-Watchlist Mapping Review",
    "",
    "This queue contains only unresolved identities. Numeric catalog IDs remain in the local machine-readable artifact and are intentionally omitted here.",
    "",
    `Unresolved artists: ${unresolved.length}`,
    "",
    "| Artist | Aliases | Candidates evaluated | Path | Release overlaps | Track overlaps | Conflicts | Score gap | Status | Reason | User verification |",
    "| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
  return { localJson: `${JSON.stringify(local, null, 2)}\n`, markdown };
}

function decideStrongSeed(
  entry: AppleMusicIdentitySeedArtifact["entries"][number],
  artist: AppleMusicArtist | undefined,
): {
  decision: AppleMusicMappingDecision;
  entryStatus: AppleMusicIdentityCampaignEntryStatus;
  manualReviewReason?: string;
  safeEvidence: Record<string, unknown>;
} {
  const candidateArtistId = entry.candidateArtistId;
  if (!candidateArtistId) throw new Error("A strong seed has no candidate artist ID.");
  if (!artist) {
    return {
      decision: unresolvedDecision("The supplied candidate ID was absent from the batch response."),
      entryStatus: "missing",
      manualReviewReason: "Apple omitted the supplied candidate ID.",
      safeEvidence: { conflictCount: entry.conflictingEvidenceCount, idReturned: false },
    };
  }
  if (entry.conflictingEvidenceCount > 0) {
    return {
      decision: rejectedDecision(artist, "Imported supporting evidence contains a conflict."),
      entryStatus: "rejected",
      manualReviewReason: "Imported supporting evidence conflicts with automatic confirmation.",
      safeEvidence: { conflictCount: entry.conflictingEvidenceCount, idReturned: true },
    };
  }
  let decision = decideAppleMusicArtistMapping({
    aliases: entry.aliases,
    canonicalName: entry.canonicalArtistName,
    existingArtist: artist,
    existingArtistId: candidateArtistId,
    searchCandidates: [],
  });
  if (decision.selected && entry.classification === "evidence_supported_seed") {
    decision = {
      ...decision,
      confidence: 0.95,
      reason: "The evidence-supported seed resolved to a compatible Apple catalog artist.",
      status: "evidence_confirmed",
    };
  }
  return {
    decision,
    entryStatus: decision.selected ? "confirmed" : "rejected",
    ...(decision.selected
      ? {}
      : {
          manualReviewReason: "The returned artist name did not match the canonical name or alias.",
        }),
    safeEvidence: {
      conflictCount: entry.conflictingEvidenceCount,
      idReturned: true,
      nameCompatible: Boolean(decision.selected),
      sourceClassification: entry.classification,
    },
  };
}

function assertSafeBatchResponse(
  requestedIds: string[],
  response: AppleMusicBatchResult<AppleMusicArtist>,
): void {
  const requested = new Set(requestedIds);
  const returnedIds = response.items.map((artist) => artist.artistId);
  if (new Set(returnedIds).size !== returnedIds.length) {
    throw new Error("Apple batch response duplicated an artist identity.");
  }
  if (returnedIds.some((id) => !requested.has(id))) {
    throw new Error("Apple batch response contained an unrequested artist identity.");
  }
  if (response.missingIds.some((id) => !requested.has(id))) {
    throw new Error("Apple batch response reported an unrequested missing identity.");
  }
  const accounted = new Set([...returnedIds, ...response.missingIds]);
  if (accounted.size !== requested.size || [...requested].some((id) => !accounted.has(id))) {
    throw new Error("Apple batch response did not account for every requested identity.");
  }
}

function unresolvedDecision(reason: string): AppleMusicMappingDecision {
  return { candidates: [], confidence: 0, evidence: [], reason, status: "ambiguous" };
}

function rejectedDecision(artist: AppleMusicArtist, reason: string): AppleMusicMappingDecision {
  return { candidates: [artist], confidence: 0, evidence: [], reason, status: "rejected" };
}

function classifyTerminal(error: unknown): {
  reason: string;
  status: AppleMusicFullWatchlistSummary["status"];
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
    if ((error.status ?? 0) >= 500) {
      return { reason: "apple_server_error", status: "controlled_partial" };
    }
    return { reason: `apple_${error.classification}`.slice(0, 500), status: "failed" };
  }
  const message = error instanceof Error ? error.message : "unexpected failure";
  return {
    reason: message.includes("batch response") ? "unsafe_batch_response" : "unexpected_failure",
    status: "failed",
  };
}

function createSummary(input: {
  artifact: AppleMusicIdentitySeedArtifact;
  cooldownActive: boolean;
  durableAfter: AppleMusicDurableArtistMapping[];
  entries: AppleMusicFullWatchlistCampaignEntry[];
  evidence: AppleMusicPilotStoredEvidence;
  runId: string;
  status: AppleMusicFullWatchlistSummary["status"];
  stopReason: string;
}): AppleMusicFullWatchlistSummary {
  const confirmedEntries = input.entries.filter((entry) => entry.status === "confirmed");
  const countStatus = (status: AppleMusicIdentityCampaignEntryStatus) =>
    input.entries.filter((entry) => entry.status === status).length;
  return {
    ambiguous: countStatus("ambiguous"),
    artifactHash: input.artifact.artifactSelfHash,
    batchesCompleted: new Set(
      input.entries.flatMap((entry) => (entry.batchIndex === null ? [] : [entry.batchIndex])),
    ).size,
    confirmed: confirmedEntries.length,
    cooldownActive: input.cooldownActive,
    evidence: input.evidence,
    evidenceSupportedConfirmed: confirmedEntries.filter(
      (entry) => entry.artifactClassification === "evidence_supported_seed",
    ).length,
    existingMappingsReused: countStatus("reused"),
    highConfidenceConfirmed: confirmedEntries.filter(
      (entry) => entry.artifactClassification === "high_confidence_seed",
    ).length,
    manualReview:
      countStatus("manual_review") +
      countStatus("ambiguous") +
      countStatus("rejected") +
      countStatus("missing"),
    missing: countStatus("missing"),
    mode: "full_watchlist_strong_seed_validation",
    rejected: countStatus("rejected"),
    requestBudget: 40,
    runId: input.runId,
    status: input.status,
    stopReason: input.stopReason,
    totalDurableMappings: input.durableAfter.length,
    watchlistHash: input.artifact.inputWatchlistHash,
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function assertAuthorization(authorization: AppleMusicFullWatchlistAuthorization): void {
  if (
    authorization[authorizationMarker] !== true ||
    authorization.confirmation !== appleMusicFullWatchlistConfirmation ||
    authorization.persistentProviderEnabled !== false ||
    authorization.stage !== "strong_seeds" ||
    authorization.storefront !== "us"
  ) {
    throw new Error("Invalid Apple full-watchlist authorization.");
  }
}

export function isConfirmedMappingStatus(status: AppleMusicMappingStatus): boolean {
  return ["existing_id_confirmed", "search_confirmed", "evidence_confirmed"].includes(status);
}
