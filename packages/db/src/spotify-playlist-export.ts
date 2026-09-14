import {
  applySpotifyPlaylistReorderMove,
  hasSpotifyPlaylistWriteScopes,
  abbreviateSpotifyPlaylistId,
  assertOwnedNonCollaborativeSpotifyPlaylist,
  assertSpotifyPlaylistWriteTarget,
  isExactSpotifyIdentity,
  planSpotifyPlaylistExport,
  planSpotifyPlaylistReleaseDateOrder,
  spotifyPlaylistIdSchema,
  spotifyTrackIdSchema,
  SpotifyHttpError,
  SpotifyPlaylistWriteDeniedError,
  spotifyAuthorizedPlaylistId,
  type SpotifyClient,
  type SpotifyPlaylistExportCandidate,
  type SpotifyPlaylistExportPlan,
  type SpotifyPlaylistWritePolicy,
} from "@radar/providers";
import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  artistFollows,
  feedItems,
  manualMatchDecisions,
  oauthAccounts,
  playlistExports,
  playlistTargets,
  providerCache,
  releaseCandidates,
  releaseExternalIds,
  releaseProviderReconciliations,
  releases,
  releaseTrackAppearances,
  spotifyPlaylistExportOperations,
  spotifyPlaylistExportRuns,
  trackCredits,
  tracks,
} from "./schema";
import {
  invalidateSpotifyPlaylistSnapshot,
  loadVerifiedSpotifyPlaylistSnapshot,
  persistSpotifyPlaylistSnapshot,
  resumeSpotifyPlaylistSnapshotRefresh,
  upsertSpotifyPlaylistTarget,
} from "./spotify-playlist-cache";
import { SpotifyCooldownError, SpotifyEndpointBudgetError } from "./spotify-request-gate";
import {
  loadSpotifyPlaylistMutationEvidence,
  recordSpotifyPlaylistMutationEvidence,
} from "./spotify-playlist-evidence";

type SpotifyPlaylistOrderingPolicy = "canonical" | "discovery_inbox" | "release_date_custom_order";

export const automaticPlaylistReconciliationIntervalMs = 24 * 60 * 60_000;

export interface SpotifyPlaylistCheckpointInspection {
  workKind: "mutations" | "uncertain" | "verification" | "none";
  verificationPending: boolean;
  uncertainOperationCount: number;
  oldestReadyAt: string | null;
  flushDeadlineAt: string | null;
  shouldDeliver: boolean;
  checkNotBefore: string | null;
  blockedCount: number;
  duplicateAppearanceCount: number;
  exportedCount: number;
  pendingAdditionCount: number;
  pendingOperationCount: number;
  reason:
    | "incomplete_run"
    | "missing_snapshot"
    | "pending_additions"
    | "pending_reorder"
    | "periodic_reconciliation"
    | "verification_pending"
    | "none";
  reorderMoveCount: number;
  shouldRun: boolean;
  skippedCount: number;
}

export interface SpotifyPlaylistExportClient {
  addPlaylistItemsAtPosition: SpotifyClient["addPlaylistItemsAtPosition"];
  getCurrentUser: SpotifyClient["getCurrentUser"];
  getPlaylist: SpotifyClient["getPlaylist"];
  getPlaylistItems: SpotifyClient["getPlaylistItems"];
  getPlaylistItemsPage?: SpotifyClient["getPlaylistItemsPage"];
  reorderPlaylistItems: SpotifyClient["reorderPlaylistItems"];
}

export interface SpotifyPlaylistExportPreview {
  cacheHit: boolean;
  plan: SpotifyPlaylistExportPlan;
  target: {
    collaborative: false;
    id: string;
    idAbbreviated: string;
    name: string;
    ownerId: string;
    public: boolean | null;
    snapshotId: string;
  };
}

export interface SpotifyPlaylistExportExecution extends SpotifyPlaylistExportPreview {
  run: {
    additionsAttempted: number;
    exported: number;
    failed: number;
    id: string;
    pending: number;
    resumed: boolean;
    skipped: number;
    status: "completed" | "failed" | "partial";
  };
}

export class SpotifyPlaylistExportError extends Error {
  constructor(
    message: string,
    readonly code:
      "missing_write_scope" | "playlist_identity_mismatch" | "playlist_operation_invalid",
  ) {
    super(message);
    this.name = "SpotifyPlaylistExportError";
  }
}

export async function previewSpotifyPlaylistExport(
  db: RadarDatabase,
  userId: string,
  client: SpotifyPlaylistExportClient,
  configuredPlaylistId: string,
  options: {
    discoveryReconciliationCampaignId?: string;
    orderingPolicy?: SpotifyPlaylistOrderingPolicy;
    retryFailedExports?: boolean;
  } = {},
): Promise<SpotifyPlaylistExportPreview> {
  const playlistId = spotifyPlaylistIdSchema.parse(configuredPlaylistId);
  const profile = await client.getCurrentUser();
  const playlist = await client.getPlaylist(playlistId);
  assertPlaylistIdentity(playlistId, playlist.id);
  assertOwnedNonCollaborativeSpotifyPlaylist(playlist, profile);
  const snapshot = await loadVerifiedSpotifyPlaylistSnapshot(db, userId, client, playlist);
  return buildPreview(
    db,
    userId,
    playlistId,
    snapshot.playlist,
    profile.id,
    snapshot.items,
    options,
    snapshot.cacheHit,
  );
}

/** Remote verification has no playlist-mutation capability. It can resume a cursor or fill
 * provenance without turning a successful delivery into another urgent write run. */
export async function verifySpotifyPlaylistCheckpoint(
  db: RadarDatabase,
  userId: string,
  client: SpotifyPlaylistExportClient,
  playlistId: string,
  maxReadPages = 6,
) {
  assertSpotifyPlaylistWriteTarget(
    { enabled: true, allowedPlaylistId: spotifyAuthorizedPlaylistId },
    playlistId,
  );
  const profile = await requireSpotifyPlaylistWriteScope(db, userId);
  const target = await db.query.playlistTargets.findFirst({
    where: and(
      eq(playlistTargets.userId, userId),
      eq(playlistTargets.provider, "spotify"),
      eq(playlistTargets.providerPlaylistId, playlistId),
    ),
  });
  const proof = target ? await loadSpotifyPlaylistMutationEvidence(db, target.id) : null;
  const policy = { enabled: true, allowedPlaylistId: playlistId };
  if (!proof)
    await resumeSpotifyPlaylistSnapshotRefresh(db, userId, client, playlistId, {
      maxReadPages,
      policy,
    });
  const playlist = await client.getPlaylist(playlistId);
  assertPlaylistIdentity(playlistId, playlist.id);
  assertOwnedNonCollaborativeSpotifyPlaylist(playlist, profile);
  const snapshot = await loadVerifiedSpotifyPlaylistSnapshot(db, userId, client, playlist, {
    forceRefresh: true,
    maxReadPages,
    policy,
  });
  const run = await loadResumableRun(
    db,
    snapshot.targetId,
    playlistId,
    null,
    "release_date_custom_order",
  );
  if (run) {
    await reconcilePendingOperations(db, run.id, snapshot.targetId, snapshot.items);
    const counts = await loadOperationCounts(db, run.id);
    if (
      counts.pending === 0 &&
      counts.failed === 0 &&
      planSpotifyPlaylistReleaseDateOrder(snapshot.items).moves.length === 0
    ) {
      await db
        .update(spotifyPlaylistExportRuns)
        .set({
          status: "completed",
          finishedAt: new Date(),
          snapshotAfter: playlist.snapshot_id,
          errorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(spotifyPlaylistExportRuns.id, run.id));
    }
  }
  return { reason: "verified" as const, itemCount: snapshot.items.length };
}

export async function executeSpotifyPlaylistExport(
  db: RadarDatabase,
  userId: string,
  client: SpotifyPlaylistExportClient,
  input: {
    maxAdditions?: number;
    maxMutations?: number;
    maxPlaylistReadPages?: number;
    discoveryReconciliationCampaignId?: string;
    orderingPolicy?: SpotifyPlaylistOrderingPolicy;
    playlistId: string;
    policy: SpotifyPlaylistWritePolicy;
    retryFailedExports?: boolean;
  },
): Promise<SpotifyPlaylistExportExecution> {
  const playlistId = assertSpotifyPlaylistWriteTarget(input.policy, input.playlistId);
  const profile = await requireSpotifyPlaylistWriteScope(db, userId);
  const cachedTarget = await db.query.playlistTargets.findFirst({
    where: and(
      eq(playlistTargets.userId, userId),
      eq(playlistTargets.provider, "spotify"),
      eq(playlistTargets.providerPlaylistId, playlistId),
    ),
  });
  const cachedProof = cachedTarget
    ? await loadSpotifyPlaylistMutationEvidence(db, cachedTarget.id)
    : null;
  if (input.maxPlaylistReadPages !== undefined && !cachedProof) {
    await resumeSpotifyPlaylistSnapshotRefresh(db, userId, client, playlistId, {
      maxReadPages: input.maxPlaylistReadPages,
      policy: input.policy,
    });
  }
  if (
    input.maxAdditions !== undefined &&
    (!Number.isInteger(input.maxAdditions) || input.maxAdditions < 1)
  ) {
    throw new SpotifyPlaylistExportError(
      "Spotify playlist export maximum additions must be a positive integer.",
      "playlist_operation_invalid",
    );
  }
  if (
    input.maxMutations !== undefined &&
    (!Number.isInteger(input.maxMutations) || input.maxMutations < 1)
  ) {
    throw new SpotifyPlaylistExportError(
      "Spotify playlist export maximum mutations must be a positive integer.",
      "playlist_operation_invalid",
    );
  }

  const playlist = await client.getPlaylist(playlistId);
  assertPlaylistIdentity(playlistId, playlist.id);
  assertOwnedNonCollaborativeSpotifyPlaylist(playlist, profile);
  const orderingPolicy = input.orderingPolicy ?? "release_date_custom_order";
  const target = await upsertSpotifyPlaylistTarget(db, userId, playlistId, playlist.name);
  let run = await loadResumableRun(
    db,
    target.id,
    playlistId,
    input.discoveryReconciliationCampaignId ?? null,
    orderingPolicy,
  );
  let trustedMutationSnapshotId: string | undefined;
  // Spotify playlist metadata can briefly lag a successful reorder response. A reorder-only
  // continuation can safely use the response snapshot because the next reorder submits it as a
  // provider-enforced precondition. Additions never take this path because they are unconditional.
  if (
    run?.status === "partial" &&
    !run.errorCode &&
    run.snapshotAfter &&
    target.snapshotId === run.snapshotAfter &&
    Array.isArray(target.snapshotItems) &&
    target.snapshotVerifiedAt !== null &&
    orderingPolicy === "release_date_custom_order" &&
    input.maxMutations !== undefined
  ) {
    const counts = await loadOperationCounts(db, run.id);
    if (
      counts.pending === 0 &&
      counts.failed === 0 &&
      planSpotifyPlaylistReleaseDateOrder(target.snapshotItems).moves.length > 0
    ) {
      trustedMutationSnapshotId = run.snapshotAfter;
    }
  }
  const snapshot = await loadVerifiedSpotifyPlaylistSnapshot(db, userId, client, playlist, {
    ...(input.maxPlaylistReadPages !== undefined
      ? { maxReadPages: input.maxPlaylistReadPages }
      : {}),
    policy: input.policy,
    ...(trustedMutationSnapshotId ? { trustedMutationSnapshotId } : {}),
  });
  assertPlaylistIdentity(playlistId, snapshot.playlist.id);
  assertOwnedNonCollaborativeSpotifyPlaylist(snapshot.playlist, profile);
  const playlistItems = snapshot.items;
  const fullReadAt = snapshot.cacheHit ? target.snapshotVerifiedAt : new Date();
  const preview = await buildPreview(
    db,
    userId,
    playlistId,
    snapshot.playlist,
    profile.id,
    playlistItems,
    {
      ...(input.discoveryReconciliationCampaignId
        ? { discoveryReconciliationCampaignId: input.discoveryReconciliationCampaignId }
        : {}),
      orderingPolicy,
      ...(input.retryFailedExports === undefined
        ? {}
        : { retryFailedExports: input.retryFailedExports }),
    },
    snapshot.cacheHit,
  );
  const resumed = Boolean(run);
  if (!run) {
    run = await createExportRun(db, target.id, preview, {
      discoveryReconciliationCampaignId: input.discoveryReconciliationCampaignId ?? null,
      orderingPolicy,
    });
  } else {
    await db
      .update(spotifyPlaylistExportRuns)
      .set({
        errorCode: null,
        startedAt: run.startedAt ?? new Date(),
        status: "running",
        updatedAt: new Date(),
      })
      .where(eq(spotifyPlaylistExportRuns.id, run.id));
    await db
      .update(spotifyPlaylistExportOperations)
      .set({ errorCode: null, status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(spotifyPlaylistExportOperations.runId, run.id),
          eq(spotifyPlaylistExportOperations.action, "add"),
          eq(spotifyPlaylistExportOperations.status, "failed"),
          lt(spotifyPlaylistExportOperations.attemptCount, 3),
        ),
      );
  }

  await reconcilePendingOperations(db, run.id, target.id, playlistItems);
  let pending = await loadPendingOperations(db, run.id);
  const additionLimit = Math.min(
    input.maxAdditions ?? Number.MAX_SAFE_INTEGER,
    input.maxMutations ?? Number.MAX_SAFE_INTEGER,
  );
  pending = pending.slice(0, additionLimit);
  let additionsAttempted = 0;
  let additionMutationCalls = 0;
  let additionSnapshotRequiresVerification = false;
  let orderingYielded = false;
  let reorderAttempted = false;
  let snapshotAfter = snapshot.playlist.snapshot_id;
  let workingItems = playlistItems.slice().sort((left, right) => left.position - right.position);

  try {
    const pendingGroups =
      input.maxMutations === undefined
        ? groupPendingOperations(pending)
        : pending.map((operation) => [operation]);
    for (const group of pendingGroups) {
      additionsAttempted += group.length;
      await markOperationsAttemptStarted(
        db,
        group.map((operation) => operation.id),
      );
      additionMutationCalls += 1;
      try {
        const snapshotBefore = snapshotAfter;
        snapshotAfter = await client.addPlaylistItemsAtPosition(
          playlistId,
          group.map((item) => item.providerTrackId),
          group[0]!.insertPosition,
        );
        additionSnapshotRequiresVerification = true;
        workingItems = insertExportedItems(workingItems, preview.plan.orderedItems, group);
        await persistAcknowledgedAddition(
          db,
          target.id,
          run.id,
          snapshotBefore,
          snapshotAfter,
          workingItems,
          group,
          fullReadAt,
        );
      } catch (error) {
        if (isDefiniteNoPlaylistWrite(error)) {
          await restoreOperationsAfterDefiniteNoWrite(db, group);
          throw error;
        }
        if (isGlobalSpotifyWriteFailure(error) || !isSafeBatchSplitFailure(error)) throw error;
        if (group.length === 1) {
          await markOperationFailed(db, group[0]!.id, safeErrorCode(error));
          continue;
        }
        let failedBefore = 0;
        for (const operation of group) {
          await markOperationsAttemptStarted(db, [operation.id]);
          additionMutationCalls += 1;
          try {
            const snapshotBefore = snapshotAfter;
            snapshotAfter = await client.addPlaylistItemsAtPosition(
              playlistId,
              [operation.providerTrackId],
              Math.max(0, operation.insertPosition - failedBefore),
            );
            additionSnapshotRequiresVerification = true;
            workingItems = insertExportedItems(workingItems, preview.plan.orderedItems, [
              {
                ...operation,
                insertPosition: Math.max(0, operation.insertPosition - failedBefore),
              },
            ]);
            await persistAcknowledgedAddition(
              db,
              target.id,
              run.id,
              snapshotBefore,
              snapshotAfter,
              workingItems,
              [operation],
              fullReadAt,
            );
          } catch (itemError) {
            if (isDefiniteNoPlaylistWrite(itemError)) {
              await restoreOperationsAfterDefiniteNoWrite(db, [operation]);
              throw itemError;
            }
            if (isGlobalSpotifyWriteFailure(itemError) || !isSafeBatchSplitFailure(itemError)) {
              throw itemError;
            }
            failedBefore += 1;
            await markOperationFailed(db, operation.id, safeErrorCode(itemError));
          }
        }
      }
    }
    const countsBeforeOrdering = await loadOperationCounts(db, run.id);
    if (
      countsBeforeOrdering.pending === 0 &&
      orderingPolicy === "release_date_custom_order" &&
      !additionSnapshotRequiresVerification
    ) {
      const orderPlan = planSpotifyPlaylistReleaseDateOrder(workingItems);
      const availableOrderingMutations =
        input.maxMutations === undefined
          ? orderPlan.moves.length
          : Math.max(0, input.maxMutations - additionMutationCalls);
      const moves = orderPlan.moves.slice(0, availableOrderingMutations);
      orderingYielded = moves.length < orderPlan.moves.length;
      for (const move of moves) {
        reorderAttempted = true;
        const snapshotBefore = snapshotAfter;
        snapshotAfter = await client.reorderPlaylistItems(playlistId, {
          ...move,
          snapshotId: snapshotAfter,
        });
        workingItems = applySpotifyPlaylistReorderMove(workingItems, move);
        await db.transaction(async (tx) => {
          await persistSpotifyPlaylistSnapshot(tx, target.id, snapshotAfter, workingItems, {
            verified: false,
          });
          await recordSpotifyPlaylistMutationEvidence(
            tx,
            target.id,
            snapshotBefore,
            snapshotAfter,
            fullReadAt,
          );
          await tx
            .update(spotifyPlaylistExportRuns)
            .set({ snapshotAfter, updatedAt: new Date() })
            .where(eq(spotifyPlaylistExportRuns.id, run.id));
        });
      }
    }
  } catch (error) {
    if (!isDefiniteNoPlaylistWrite(error) && (reorderAttempted || additionMutationCalls > 0)) {
      await invalidateSpotifyPlaylistSnapshot(db, userId, playlistId);
    }
    await db
      .update(spotifyPlaylistExportRuns)
      .set({ errorCode: safeErrorCode(error), status: "partial", updatedAt: new Date() })
      .where(eq(spotifyPlaylistExportRuns.id, run.id));
    throw error;
  }
  const mutationEvidence = await loadSpotifyPlaylistMutationEvidence(db, target.id);
  await persistSpotifyPlaylistSnapshot(db, target.id, snapshotAfter, workingItems, {
    verified: !mutationEvidence && !additionSnapshotRequiresVerification,
  });
  await reconcilePendingOperations(db, run.id, target.id, workingItems);
  await finalizeExhaustedOperations(db, run.id, target.id);
  const counts = await loadOperationCounts(db, run.id);
  const retryableFailures = await countRetryableFailedOperations(db, run.id);
  const status =
    counts.pending === 0 &&
    counts.failed === 0 &&
    !orderingYielded &&
    planSpotifyPlaylistReleaseDateOrder(workingItems).moves.length === 0
      ? "completed"
      : counts.pending === 0 && counts.failed > 0 && retryableFailures === 0
        ? "failed"
        : "partial";
  const finishedAt = status === "completed" || status === "failed" ? new Date() : null;
  await db
    .update(spotifyPlaylistExportRuns)
    .set({
      failedCount: counts.failed,
      finishedAt,
      snapshotAfter,
      status,
      updatedAt: new Date(),
    })
    .where(eq(spotifyPlaylistExportRuns.id, run.id));
  await db
    .update(playlistTargets)
    .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
    .where(eq(playlistTargets.id, target.id));

  return {
    ...preview,
    run: {
      additionsAttempted,
      exported: counts.exported,
      failed: counts.failed,
      id: run.id,
      pending: counts.pending,
      resumed,
      skipped: counts.skipped,
      status,
    },
  };
}

async function buildPreview(
  db: RadarDatabase,
  userId: string,
  playlistId: string,
  playlist: Awaited<ReturnType<SpotifyPlaylistExportClient["getPlaylist"]>>,
  ownerId: string,
  playlistItems: Awaited<ReturnType<SpotifyPlaylistExportClient["getPlaylistItems"]>>,
  options: {
    discoveryReconciliationCampaignId?: string;
    orderingPolicy?: SpotifyPlaylistOrderingPolicy;
    retryFailedExports?: boolean;
  } = {},
  cacheHit = false,
): Promise<SpotifyPlaylistExportPreview> {
  const candidates = options.discoveryReconciliationCampaignId
    ? await loadCampaignPlaylistExportCandidates(
        db,
        userId,
        options.discoveryReconciliationCampaignId,
      )
    : await loadCanonicalExportCandidates(db, userId);
  const exportRows = await db
    .select({
      appOwned: playlistExports.appOwned,
      errorCode: playlistExports.errorCode,
      providerTrackId: playlistExports.providerTrackId,
      status: playlistExports.status,
    })
    .from(playlistExports)
    .innerJoin(playlistTargets, eq(playlistTargets.id, playlistExports.playlistTargetId))
    .where(
      and(
        eq(playlistTargets.userId, userId),
        eq(playlistTargets.provider, "spotify"),
        eq(playlistTargets.providerPlaylistId, playlistId),
      ),
    );
  const terminalFailedTrackIds = new Set(
    exportRows
      .filter(
        (row) =>
          row.status === "failed" && row.errorCode === "playlist_addition_attempts_exhausted",
      )
      .map((row) => row.providerTrackId),
  );
  const plannedCandidates =
    options.retryFailedExports === false
      ? candidates.filter(
          (candidate) =>
            !candidate.providerTrackId || !terminalFailedTrackIds.has(candidate.providerTrackId),
        )
      : candidates;
  return {
    cacheHit,
    plan: planSpotifyPlaylistExport(
      plannedCandidates,
      playlistItems,
      new Set(
        exportRows
          .filter((row) => row.appOwned && row.status === "exported")
          .map((row) => row.providerTrackId),
      ),
      options.orderingPolicy ?? "release_date_custom_order",
    ),
    target: {
      collaborative: false,
      id: playlistId,
      idAbbreviated: abbreviateSpotifyPlaylistId(playlistId),
      name: playlist.name,
      ownerId,
      public: playlist.public,
      snapshotId: playlist.snapshot_id,
    },
  };
}

export async function loadCampaignPlaylistExportCandidates(
  db: RadarDatabase,
  userId: string,
  campaignId: string,
): Promise<SpotifyPlaylistExportCandidate[]> {
  const eligible = await db
    .select({
      providerReleaseId: releaseProviderReconciliations.spotifyProviderReleaseId,
      releaseId: releaseProviderReconciliations.spotifyCanonicalReleaseId,
    })
    .from(releaseProviderReconciliations)
    .where(
      and(
        eq(releaseProviderReconciliations.campaignId, campaignId),
        eq(releaseProviderReconciliations.playlistEligible, true),
      ),
    );
  const releaseIds = new Set(eligible.flatMap((row) => (row.releaseId ? [row.releaseId] : [])));
  const providerReleaseIds = new Set(
    eligible.flatMap((row) => (row.providerReleaseId ? [row.providerReleaseId] : [])),
  );
  if (releaseIds.size === 0 || providerReleaseIds.size === 0) return [];
  const exactTracks = await db
    .select({
      confidence: releaseCandidates.matchConfidence,
      matchRule: releaseCandidates.matchRule,
      providerReleaseId: releaseCandidates.providerReleaseId,
      providerTrackId: releaseCandidates.providerTrackId,
    })
    .from(releaseCandidates)
    .where(
      and(
        eq(releaseCandidates.provider, "spotify"),
        inArray(releaseCandidates.providerReleaseId, [...providerReleaseIds]),
      ),
    );
  const eligibleTrackIds = new Set(
    exactTracks
      .filter(
        (track) =>
          isExactSpotifyIdentity(track.matchRule, Number(track.confidence)) &&
          providerReleaseIds.has(track.providerReleaseId),
      )
      .map((track) => track.providerTrackId),
  );
  return (await loadCanonicalExportCandidates(db, userId)).filter(
    (candidate) =>
      releaseIds.has(candidate.releaseId) &&
      Boolean(candidate.providerTrackId && eligibleTrackIds.has(candidate.providerTrackId)),
  );
}

export async function loadCanonicalExportCandidates(
  db: RadarDatabase,
  userId: string,
): Promise<SpotifyPlaylistExportCandidate[]> {
  const feedRows = await db
    .select({
      discNumber: releaseTrackAppearances.discNumber,
      feedItemId: feedItems.id,
      feedState: feedItems.state,
      releaseDate: releases.releaseDate,
      releaseId: releases.id,
      releaseTitle: releases.title,
      releaseType: releases.releaseType,
      title: tracks.title,
      trackId: tracks.id,
      trackNumber: releaseTrackAppearances.trackNumber,
    })
    .from(feedItems)
    .innerJoin(releaseTrackAppearances, eq(feedItems.appearanceId, releaseTrackAppearances.id))
    .innerJoin(releases, eq(releaseTrackAppearances.releaseId, releases.id))
    .innerJoin(tracks, eq(releaseTrackAppearances.trackId, tracks.id))
    .where(eq(feedItems.userId, userId));
  const followedRows = await db
    .select({ trackId: trackCredits.trackId })
    .from(trackCredits)
    .innerJoin(
      artistFollows,
      and(
        eq(trackCredits.artistId, artistFollows.artistId),
        eq(artistFollows.userId, userId),
        eq(artistFollows.active, true),
      ),
    );
  const releaseExternalRows = await db
    .select({ externalId: releaseExternalIds.externalId, releaseId: releaseExternalIds.releaseId })
    .from(releaseExternalIds)
    .where(eq(releaseExternalIds.provider, "spotify"));
  const candidateRows = await db
    .select({
      candidateId: releaseCandidates.id,
      confidence: releaseCandidates.matchConfidence,
      firstSeenAt: releaseCandidates.firstSeenAt,
      matchRule: releaseCandidates.matchRule,
      providerTrackId: releaseCandidates.providerTrackId,
      trackId: releaseCandidates.matchedTrackId,
    })
    .from(releaseCandidates)
    .where(eq(releaseCandidates.provider, "spotify"));
  const decisions = await db
    .select({ candidateId: manualMatchDecisions.candidateId })
    .from(manualMatchDecisions)
    .where(
      and(eq(manualMatchDecisions.userId, userId), eq(manualMatchDecisions.decision, "confirm")),
    );
  const followedTrackIds = new Set(followedRows.map((row) => row.trackId));
  const providerReleaseIdByRelease = new Map(
    releaseExternalRows.map((row) => [row.releaseId, row.externalId]),
  );
  const confirmedCandidateIds = new Set(decisions.map((row) => row.candidateId));
  const candidateByTrack = new Map<string, (typeof candidateRows)[number]>();
  for (const candidate of candidateRows) {
    if (!candidate.trackId) continue;
    const existing = candidateByTrack.get(candidate.trackId);
    if (!existing || compareProviderCandidates(candidate, existing, confirmedCandidateIds) < 0) {
      candidateByTrack.set(candidate.trackId, candidate);
    }
  }
  return feedRows.map((feed) => {
    const candidate = candidateByTrack.get(feed.trackId);
    const providerReleaseId = providerReleaseIdByRelease.get(feed.releaseId);
    return {
      ...(candidate ? { candidateId: candidate.candidateId } : {}),
      ...(candidate ? { confidence: Number(candidate.confidence) } : {}),
      discNumber: feed.discNumber,
      feedItemId: feed.feedItemId,
      feedState: feed.feedState,
      followedArtist: followedTrackIds.has(feed.trackId),
      manuallyConfirmed: candidate ? confirmedCandidateIds.has(candidate.candidateId) : false,
      ...(candidate ? { matchRule: candidate.matchRule } : {}),
      ...(candidate ? { providerTrackId: candidate.providerTrackId } : {}),
      ...(providerReleaseId ? { providerReleaseId } : {}),
      releaseDate: feed.releaseDate,
      releaseId: feed.releaseId,
      releaseTitle: feed.releaseTitle,
      releaseType: feed.releaseType,
      title: feed.title,
      trackId: feed.trackId,
      trackNumber: feed.trackNumber,
    };
  });
}

export async function inspectSpotifyPlaylistCheckpoint(
  db: RadarDatabase,
  userId: string,
  playlistId: string,
  options: { now?: Date; reconciliationIntervalMs?: number; recordReady?: boolean } = {},
): Promise<SpotifyPlaylistCheckpointInspection> {
  const now = options.now ?? new Date();
  const deferRow = await db.query.providerCache.findFirst({
    where: and(
      eq(providerCache.provider, "spotify"),
      eq(providerCache.cacheKey, `playlist-checkpoint-defer:${userId}:${playlistId}`),
    ),
  });
  const deferredUntil =
    deferRow?.expiresAt && deferRow.expiresAt > now ? deferRow.expiresAt.toISOString() : null;
  const reconciliationIntervalMs =
    options.reconciliationIntervalMs ?? automaticPlaylistReconciliationIntervalMs;
  if (!Number.isSafeInteger(reconciliationIntervalMs) || reconciliationIntervalMs < 60_000) {
    throw new Error("Spotify playlist reconciliation interval must be at least one minute.");
  }
  const target = await db.query.playlistTargets.findFirst({
    where: and(
      eq(playlistTargets.userId, userId),
      eq(playlistTargets.provider, "spotify"),
      eq(playlistTargets.providerPlaylistId, playlistId),
    ),
  });
  if (!target || !target.snapshotId || !Array.isArray(target.snapshotItems)) {
    return {
      ...emptyCheckpointInspection("missing_snapshot", true),
      checkNotBefore: deferredUntil,
    };
  }

  const incompleteRun = await db.query.spotifyPlaylistExportRuns.findFirst({
    orderBy: [desc(spotifyPlaylistExportRuns.createdAt)],
    where: and(
      eq(spotifyPlaylistExportRuns.playlistTargetId, target.id),
      inArray(spotifyPlaylistExportRuns.status, ["planned", "running", "partial"]),
    ),
  });
  const pendingOperations = incompleteRun
    ? await db
        .select({
          id: spotifyPlaylistExportOperations.id,
          errorCode: spotifyPlaylistExportOperations.errorCode,
        })
        .from(spotifyPlaylistExportOperations)
        .where(
          and(
            eq(spotifyPlaylistExportOperations.runId, incompleteRun.id),
            inArray(spotifyPlaylistExportOperations.status, ["pending", "failed"]),
          ),
        )
    : [];
  const [candidates, exportRows] = await Promise.all([
    loadCanonicalExportCandidates(db, userId),
    db
      .select({
        appOwned: playlistExports.appOwned,
        errorCode: playlistExports.errorCode,
        providerTrackId: playlistExports.providerTrackId,
        status: playlistExports.status,
      })
      .from(playlistExports)
      .where(eq(playlistExports.playlistTargetId, target.id)),
  ]);
  const terminalFailedTrackIds = new Set(
    exportRows
      .filter(
        (row) =>
          row.status === "failed" && row.errorCode === "playlist_addition_attempts_exhausted",
      )
      .map((row) => row.providerTrackId),
  );
  const plan = planSpotifyPlaylistExport(
    candidates.filter(
      (candidate) =>
        !candidate.providerTrackId || !terminalFailedTrackIds.has(candidate.providerTrackId),
    ),
    target.snapshotItems,
    new Set(
      exportRows
        .filter((row) => row.appOwned && row.status === "exported")
        .map((row) => row.providerTrackId),
    ),
    "release_date_custom_order",
  );
  const actionableBlockedTrackIds = new Set(
    plan.skips
      .filter((skip) =>
        [
          "malformed_spotify_track_id",
          "missing_spotify_match",
          "needs_review",
          "uncertain_spotify_match",
        ].includes(skip.reason),
      )
      .map((skip) => skip.trackId),
  );
  const snapshotVerifiedAt = target.snapshotVerifiedAt?.getTime() ?? 0;
  const proof = await loadSpotifyPlaylistMutationEvidence(db, target.id);
  const fullReadAt = proof?.fullReadAt ? new Date(proof.fullReadAt).getTime() : snapshotVerifiedAt;
  const reconciliationDue = now.getTime() - fullReadAt >= reconciliationIntervalMs;
  const verificationPending = !target.snapshotVerifiedAt || reconciliationDue;
  const uncertainOperationCount = pendingOperations.filter(
    (operation) => operation.errorCode === "playlist_addition_in_flight",
  ).length;
  const batchKey = `playlist-delivery-batch:${userId}:${playlistId}`;
  const batch = await db.query.providerCache.findFirst({
    where: and(eq(providerCache.provider, "spotify"), eq(providerCache.cacheKey, batchKey)),
  });
  const storedReadyAt =
    typeof batch?.value === "object" &&
    batch.value !== null &&
    "oldestReadyAt" in batch.value &&
    typeof batch.value.oldestReadyAt === "string" &&
    Number.isFinite(Date.parse(batch.value.oldestReadyAt))
      ? batch.value.oldestReadyAt
      : null;
  const oldestReadyAt = plan.additions.length > 0 ? (storedReadyAt ?? now.toISOString()) : null;
  if (options.recordReady && oldestReadyAt !== storedReadyAt) {
    await db
      .insert(providerCache)
      .values({
        provider: "spotify",
        cacheKey: batchKey,
        value: { oldestReadyAt },
        expiresAt: new Date(now.getTime() + 30 * 86_400_000),
      })
      .onConflictDoUpdate({
        target: [providerCache.provider, providerCache.cacheKey],
        set: {
          value: { oldestReadyAt },
          updatedAt: now,
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
      });
  }
  const flushDeadlineAt = oldestReadyAt
    ? new Date(Date.parse(oldestReadyAt) + 10 * 60_000).toISOString()
    : null;
  const workKind =
    uncertainOperationCount > 0
      ? "uncertain"
      : plan.additions.length > 0 || pendingOperations.length > 0 || plan.reorderMoves.length > 0
        ? "mutations"
        : verificationPending || incompleteRun
          ? "verification"
          : "none";
  const checkNotBefore =
    [proof?.checkNotBefore, deferredUntil]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  const shouldDeliver =
    workKind === "mutations" &&
    (!checkNotBefore || new Date(checkNotBefore) <= now) &&
    (pendingOperations.length > 0 ||
      plan.reorderMoves.length > 0 ||
      plan.additions.length >= 3 ||
      Boolean(flushDeadlineAt && new Date(flushDeadlineAt) <= now));
  const reason: SpotifyPlaylistCheckpointInspection["reason"] =
    pendingOperations.length > 0
      ? "incomplete_run"
      : plan.additions.length > 0
        ? "pending_additions"
        : plan.reorderMoves.length > 0
          ? "pending_reorder"
          : verificationPending || incompleteRun
            ? reconciliationDue
              ? "periodic_reconciliation"
              : "verification_pending"
            : "none";
  return {
    workKind,
    verificationPending,
    uncertainOperationCount,
    oldestReadyAt,
    flushDeadlineAt,
    shouldDeliver,
    checkNotBefore,
    blockedCount: actionableBlockedTrackIds.size + terminalFailedTrackIds.size,
    duplicateAppearanceCount: plan.skips.filter(
      (skip) => skip.reason === "duplicate_recording_appearance",
    ).length,
    exportedCount: plan.alreadyPresent.length,
    pendingAdditionCount: plan.additions.length,
    pendingOperationCount: pendingOperations.length,
    reason,
    reorderMoveCount: plan.reorderMoves.length,
    shouldRun: reason !== "none",
    skippedCount: plan.skips.length,
  };
}

export async function deferSpotifyPlaylistCheckpoint(
  db: RadarDatabase,
  userId: string,
  playlistId: string,
  until: Date,
): Promise<void> {
  await db
    .insert(providerCache)
    .values({
      provider: "spotify",
      cacheKey: `playlist-checkpoint-defer:${userId}:${playlistId}`,
      value: { reason: "bounded_retry" },
      expiresAt: until,
    })
    .onConflictDoUpdate({
      target: [providerCache.provider, providerCache.cacheKey],
      set: { expiresAt: until, updatedAt: new Date() },
    });
}

export async function surfaceUncertainSpotifyMatchesForReview(
  db: RadarDatabase,
  userId: string,
  now = new Date(),
): Promise<{ candidatesUpdated: number; feedItemsUpdated: number }> {
  const candidates = await loadCanonicalExportCandidates(db, userId);
  const candidateIds = [
    ...new Set(
      candidates.flatMap((candidate) =>
        candidate.candidateId &&
        candidate.followedArtist &&
        candidate.feedState !== "dismissed" &&
        candidate.providerTrackId &&
        spotifyTrackIdSchema.safeParse(candidate.providerTrackId).success &&
        !candidate.manuallyConfirmed &&
        !isExactSpotifyIdentity(candidate.matchRule ?? "", candidate.confidence ?? 0)
          ? [candidate.candidateId]
          : [],
      ),
    ),
  ];
  if (candidateIds.length === 0) return { candidatesUpdated: 0, feedItemsUpdated: 0 };
  return db.transaction(async (tx) => {
    const updatedCandidates = await tx
      .update(releaseCandidates)
      .set({ matchStatus: "needs_review" })
      .where(
        and(
          inArray(releaseCandidates.id, candidateIds),
          ne(releaseCandidates.matchStatus, "needs_review"),
        ),
      )
      .returning({ id: releaseCandidates.id });
    const updatedFeedItems = await tx
      .update(feedItems)
      .set({ state: "needs_review", updatedAt: now })
      .where(
        and(
          inArray(feedItems.candidateId, candidateIds),
          inArray(feedItems.state, ["new", "upcoming"]),
        ),
      )
      .returning({ id: feedItems.id });
    return {
      candidatesUpdated: updatedCandidates.length,
      feedItemsUpdated: updatedFeedItems.length,
    };
  });
}

function emptyCheckpointInspection(
  reason: SpotifyPlaylistCheckpointInspection["reason"],
  shouldRun: boolean,
): SpotifyPlaylistCheckpointInspection {
  return {
    workKind: reason === "missing_snapshot" ? "uncertain" : "none",
    verificationPending: reason === "missing_snapshot",
    uncertainOperationCount: 0,
    oldestReadyAt: null,
    flushDeadlineAt: null,
    shouldDeliver: false,
    checkNotBefore: null,
    blockedCount: 0,
    duplicateAppearanceCount: 0,
    exportedCount: 0,
    pendingAdditionCount: 0,
    pendingOperationCount: 0,
    reason,
    reorderMoveCount: 0,
    shouldRun,
    skippedCount: 0,
  };
}

function compareProviderCandidates(
  left: {
    candidateId: string;
    confidence: string;
    firstSeenAt: Date;
    matchRule: string;
  },
  right: {
    candidateId: string;
    confidence: string;
    firstSeenAt: Date;
    matchRule: string;
  },
  confirmed: ReadonlySet<string>,
): number {
  return (
    Number(confirmed.has(right.candidateId)) - Number(confirmed.has(left.candidateId)) ||
    Number(isExactSpotifyIdentity(right.matchRule, Number(right.confidence))) -
      Number(isExactSpotifyIdentity(left.matchRule, Number(left.confidence))) ||
    Number(right.confidence) - Number(left.confidence) ||
    right.firstSeenAt.getTime() - left.firstSeenAt.getTime() ||
    left.candidateId.localeCompare(right.candidateId)
  );
}

async function requireSpotifyPlaylistWriteScope(
  db: RadarDatabase,
  userId: string,
): Promise<{ account_id: string; id: string }> {
  const account = await db.query.oauthAccounts.findFirst({
    columns: { providerAccountId: true, providerUserId: true, scopes: true },
    where: and(
      eq(oauthAccounts.userId, userId),
      eq(oauthAccounts.provider, "spotify"),
      isNull(oauthAccounts.disconnectedAt),
    ),
  });
  if (!account || !hasSpotifyPlaylistWriteScopes(account.scopes)) {
    throw new SpotifyPlaylistExportError(
      "Spotify must be reauthorized with both playlist modification scopes before live export.",
      "missing_write_scope",
    );
  }
  return {
    account_id: account.providerAccountId,
    id: account.providerUserId ?? account.providerAccountId,
  };
}

function assertPlaylistIdentity(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify returned a playlist other than the configured target",
      "playlist_id_mismatch",
    );
  }
}

async function loadResumableRun(
  db: RadarDatabase,
  targetId: string,
  playlistId: string,
  campaignId: string | null,
  orderingPolicy: SpotifyPlaylistOrderingPolicy,
) {
  return db.query.spotifyPlaylistExportRuns.findFirst({
    orderBy: [desc(spotifyPlaylistExportRuns.createdAt)],
    where: and(
      eq(spotifyPlaylistExportRuns.playlistTargetId, targetId),
      eq(spotifyPlaylistExportRuns.targetPlaylistId, playlistId),
      campaignId
        ? eq(spotifyPlaylistExportRuns.discoveryReconciliationCampaignId, campaignId)
        : isNull(spotifyPlaylistExportRuns.discoveryReconciliationCampaignId),
      eq(spotifyPlaylistExportRuns.orderingPolicy, orderingPolicy),
      inArray(spotifyPlaylistExportRuns.status, ["planned", "running", "partial"]),
    ),
  });
}

export async function loadResumableSpotifyPlaylistExportRunId(
  db: RadarDatabase,
  userId: string,
  playlistId: string,
  orderingPolicy: SpotifyPlaylistOrderingPolicy = "release_date_custom_order",
): Promise<string | null> {
  const target = await db.query.playlistTargets.findFirst({
    where: and(
      eq(playlistTargets.userId, userId),
      eq(playlistTargets.provider, "spotify"),
      eq(playlistTargets.providerPlaylistId, playlistId),
    ),
  });
  if (!target) return null;
  const run = await loadResumableRun(db, target.id, playlistId, null, orderingPolicy);
  return run?.id ?? null;
}

async function createExportRun(
  db: RadarDatabase,
  targetId: string,
  preview: SpotifyPlaylistExportPreview,
  options: {
    discoveryReconciliationCampaignId: string | null;
    orderingPolicy: SpotifyPlaylistOrderingPolicy;
  },
) {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(spotifyPlaylistExportRuns)
      .values({
        additionCount: preview.plan.additions.length,
        alreadyPresentCount: preview.plan.alreadyPresent.length,
        eligibleCount: preview.plan.desired.length,
        discoveryReconciliationCampaignId: options.discoveryReconciliationCampaignId,
        mode: "live",
        orderingPolicy: options.orderingPolicy,
        orderingConflictCount: preview.plan.reorderMoves.length,
        playlistName: preview.target.name,
        playlistTargetId: targetId,
        skippedCount: preview.plan.skips.length,
        snapshotBefore: preview.target.snapshotId,
        startedAt: new Date(),
        status: "running",
        targetPlaylistId: preview.target.id,
      })
      .returning();
    if (!run) throw new Error("Spotify playlist export run could not be created.");
    const operations = [
      ...preview.plan.additions.map((item) => ({
        action: "add" as const,
        desiredOrdinal: item.desiredOrdinal,
        feedItemId: item.feedItemId,
        insertPosition: item.position,
        providerTrackId: item.providerTrackId,
        reason: item.reason,
        runId: run.id,
        status: "pending" as const,
        trackId: item.trackId,
      })),
      ...preview.plan.alreadyPresent.map((item) => ({
        action: "already_present" as const,
        completedAt: new Date(),
        desiredOrdinal: item.desiredOrdinal,
        feedItemId: item.feedItemId,
        insertPosition: item.position,
        providerTrackId: item.providerTrackId,
        reason: item.appManaged ? "already_app_managed" : "already_user_present",
        runId: run.id,
        status: "exported" as const,
        trackId: item.trackId,
      })),
      ...preview.plan.skips.map((item) => ({
        action: "skip" as const,
        completedAt: new Date(),
        feedItemId: item.feedItemId,
        providerTrackId: item.providerTrackId,
        reason: item.reason,
        runId: run.id,
        status: "skipped" as const,
        trackId: item.trackId,
      })),
    ];
    if (operations.length > 0) await tx.insert(spotifyPlaylistExportOperations).values(operations);
    return run;
  });
}

interface PendingOperation {
  attemptCount: number;
  errorCode: string | null;
  id: string;
  insertPosition: number;
  providerTrackId: string;
  trackId: string;
}

async function loadPendingOperations(
  db: RadarDatabase,
  runId: string,
): Promise<PendingOperation[]> {
  const rows = await db
    .select({
      attemptCount: spotifyPlaylistExportOperations.attemptCount,
      errorCode: spotifyPlaylistExportOperations.errorCode,
      id: spotifyPlaylistExportOperations.id,
      insertPosition: spotifyPlaylistExportOperations.insertPosition,
      providerTrackId: spotifyPlaylistExportOperations.providerTrackId,
      trackId: spotifyPlaylistExportOperations.trackId,
    })
    .from(spotifyPlaylistExportOperations)
    .where(
      and(
        eq(spotifyPlaylistExportOperations.runId, runId),
        eq(spotifyPlaylistExportOperations.action, "add"),
        eq(spotifyPlaylistExportOperations.status, "pending"),
      ),
    )
    .orderBy(asc(spotifyPlaylistExportOperations.desiredOrdinal));
  return rows.map((row) => {
    if (row.insertPosition === null || !row.providerTrackId || !row.trackId) {
      throw new SpotifyPlaylistExportError(
        "A pending Spotify playlist operation is incomplete.",
        "playlist_operation_invalid",
      );
    }
    return {
      attemptCount: row.attemptCount,
      errorCode: row.errorCode,
      id: row.id,
      insertPosition: row.insertPosition,
      providerTrackId: row.providerTrackId,
      trackId: row.trackId,
    };
  });
}

function groupPendingOperations(operations: PendingOperation[]): PendingOperation[][] {
  const groups: PendingOperation[][] = [];
  for (const operation of operations) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    if (
      current &&
      previous &&
      current.length < 100 &&
      operation.insertPosition === previous.insertPosition + 1
    ) {
      current.push(operation);
    } else {
      groups.push([operation]);
    }
  }
  return groups;
}

function insertExportedItems(
  currentItems: SpotifyPlaylistExportPlan["orderedItems"],
  desiredItems: SpotifyPlaylistExportPlan["orderedItems"],
  operations: PendingOperation[],
): SpotifyPlaylistExportPlan["orderedItems"] {
  const next = currentItems.slice().sort((left, right) => left.position - right.position);
  const additions = operations.map((operation) => {
    const desired = desiredItems.find((item) => item.trackId === operation.providerTrackId);
    if (!desired) {
      throw new SpotifyPlaylistExportError(
        `The planned Spotify track ${operation.providerTrackId} has no ordering metadata.`,
        "playlist_operation_invalid",
      );
    }
    return { ...desired };
  });
  next.splice(Math.min(operations[0]!.insertPosition, next.length), 0, ...additions);
  return next.map((item, position) => ({ ...item, position }));
}

async function reconcilePendingOperations(
  db: RadarDatabase,
  runId: string,
  targetId: string,
  playlistItems: Array<{ trackId: string | null }>,
): Promise<void> {
  const present = new Set(
    playlistItems.map((item) => item.trackId).filter((id): id is string => id !== null),
  );
  const pending = await loadPendingOperations(db, runId);
  for (const operation of pending) {
    if (present.has(operation.providerTrackId)) {
      await markOperationExported(
        db,
        targetId,
        operation,
        operation.errorCode === "playlist_addition_in_flight",
      );
    } else if (
      operation.errorCode === "playlist_addition_in_flight" &&
      operation.attemptCount >= 3
    ) {
      await markOperationFailed(db, operation.id, "playlist_addition_attempts_exhausted");
    } else if (operation.errorCode === "playlist_addition_in_flight") {
      // A complete consistent read proves this attempted addition is absent. Clear
      // uncertainty so a later bounded mutation unit may retry it, never this read-only unit.
      await db
        .update(spotifyPlaylistExportOperations)
        .set({ errorCode: null, updatedAt: new Date() })
        .where(eq(spotifyPlaylistExportOperations.id, operation.id));
    }
  }
}

async function markOperationsAttemptStarted(
  db: RadarDatabase,
  operationIds: string[],
): Promise<void> {
  if (operationIds.length === 0) return;
  await db
    .update(spotifyPlaylistExportOperations)
    .set({
      attemptCount: sql`${spotifyPlaylistExportOperations.attemptCount} + 1`,
      completedAt: null,
      errorCode: "playlist_addition_in_flight",
      status: "pending",
      updatedAt: new Date(),
    })
    .where(inArray(spotifyPlaylistExportOperations.id, operationIds));
}

async function restoreOperationsAfterDefiniteNoWrite(
  db: RadarDatabase,
  operations: readonly PendingOperation[],
): Promise<void> {
  const now = new Date();
  for (const operation of operations) {
    await db
      .update(spotifyPlaylistExportOperations)
      .set({
        attemptCount: sql`greatest(${spotifyPlaylistExportOperations.attemptCount} - 1, 0)`,
        errorCode: operation.errorCode,
        status: "pending",
        updatedAt: now,
      })
      .where(eq(spotifyPlaylistExportOperations.id, operation.id));
  }
}

async function markOperationExported(
  db: RadarDatabase,
  targetId: string,
  operation: PendingOperation,
  appOwned: boolean,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(playlistExports)
      .values({
        appOwned,
        exportedAt: now,
        playlistTargetId: targetId,
        providerTrackId: operation.providerTrackId,
        status: "exported",
        trackId: operation.trackId,
      })
      .onConflictDoUpdate({
        target: [playlistExports.playlistTargetId, playlistExports.providerTrackId],
        set: {
          errorCode: null,
          exportedAt: now,
          status: "exported",
          ...(appOwned ? { appOwned: true } : {}),
          updatedAt: now,
        },
      });
    await tx
      .update(spotifyPlaylistExportOperations)
      .set({
        completedAt: now,
        errorCode: null,
        status: "exported",
        updatedAt: now,
      })
      .where(eq(spotifyPlaylistExportOperations.id, operation.id));
  });
}

/** An acknowledgment, its exact local delta, and ledger entries commit together. A crash before
 * this transaction leaves in-flight evidence requiring remote reconciliation, never blind replay. */
async function persistAcknowledgedAddition(
  db: RadarDatabase,
  targetId: string,
  runId: string,
  before: string,
  after: string,
  items: SpotifyPlaylistExportPlan["orderedItems"],
  operations: PendingOperation[],
  fullReadAt: Date | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    await persistSpotifyPlaylistSnapshot(tx, targetId, after, items, { verified: false });
    await recordSpotifyPlaylistMutationEvidence(tx, targetId, before, after, fullReadAt);
    for (const operation of operations) {
      await tx
        .insert(playlistExports)
        .values({
          appOwned: true,
          exportedAt: now,
          playlistTargetId: targetId,
          providerTrackId: operation.providerTrackId,
          status: "exported",
          trackId: operation.trackId,
        })
        .onConflictDoUpdate({
          target: [playlistExports.playlistTargetId, playlistExports.providerTrackId],
          set: {
            appOwned: true,
            exportedAt: now,
            status: "exported",
            errorCode: null,
            updatedAt: now,
          },
        });
      await tx
        .update(spotifyPlaylistExportOperations)
        .set({ completedAt: now, errorCode: null, status: "exported", updatedAt: now })
        .where(eq(spotifyPlaylistExportOperations.id, operation.id));
    }
    await tx
      .update(spotifyPlaylistExportRuns)
      .set({ snapshotAfter: after, updatedAt: now })
      .where(eq(spotifyPlaylistExportRuns.id, runId));
  });
}

async function markOperationFailed(
  db: RadarDatabase,
  operationId: string,
  errorCode: string,
): Promise<void> {
  await db
    .update(spotifyPlaylistExportOperations)
    .set({
      completedAt: new Date(),
      errorCode,
      status: "failed",
      updatedAt: new Date(),
    })
    .where(eq(spotifyPlaylistExportOperations.id, operationId));
}

async function finalizeExhaustedOperations(
  db: RadarDatabase,
  runId: string,
  targetId: string,
): Promise<void> {
  const exhausted = await db
    .select({
      providerTrackId: spotifyPlaylistExportOperations.providerTrackId,
      trackId: spotifyPlaylistExportOperations.trackId,
    })
    .from(spotifyPlaylistExportOperations)
    .where(
      and(
        eq(spotifyPlaylistExportOperations.runId, runId),
        eq(spotifyPlaylistExportOperations.action, "add"),
        eq(spotifyPlaylistExportOperations.status, "failed"),
        sql`${spotifyPlaylistExportOperations.attemptCount} >= 3`,
      ),
    );
  if (exhausted.length === 0) return;
  const now = new Date();
  for (const operation of exhausted) {
    if (!operation.providerTrackId || !operation.trackId) continue;
    await db
      .insert(playlistExports)
      .values({
        appOwned: true,
        errorCode: "playlist_addition_attempts_exhausted",
        playlistTargetId: targetId,
        providerTrackId: operation.providerTrackId,
        status: "failed",
        trackId: operation.trackId,
      })
      .onConflictDoUpdate({
        target: [playlistExports.playlistTargetId, playlistExports.providerTrackId],
        set: {
          errorCode: "playlist_addition_attempts_exhausted",
          exportedAt: null,
          status: "failed",
          updatedAt: now,
        },
      });
  }
}

async function countRetryableFailedOperations(db: RadarDatabase, runId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(spotifyPlaylistExportOperations)
    .where(
      and(
        eq(spotifyPlaylistExportOperations.runId, runId),
        eq(spotifyPlaylistExportOperations.action, "add"),
        eq(spotifyPlaylistExportOperations.status, "failed"),
        lt(spotifyPlaylistExportOperations.attemptCount, 3),
      ),
    );
  return Number(row?.count ?? 0);
}

async function loadOperationCounts(db: RadarDatabase, runId: string) {
  const [row] = await db
    .select({
      exported: sql<number>`count(*) filter (where ${spotifyPlaylistExportOperations.status} = 'exported')::int`,
      failed: sql<number>`count(*) filter (where ${spotifyPlaylistExportOperations.status} = 'failed')::int`,
      pending: sql<number>`count(*) filter (where ${spotifyPlaylistExportOperations.status} = 'pending')::int`,
      skipped: sql<number>`count(*) filter (where ${spotifyPlaylistExportOperations.status} = 'skipped')::int`,
    })
    .from(spotifyPlaylistExportOperations)
    .where(eq(spotifyPlaylistExportOperations.runId, runId));
  return row ?? { exported: 0, failed: 0, pending: 0, skipped: 0 };
}

function isGlobalSpotifyWriteFailure(error: unknown): boolean {
  return (
    error instanceof SpotifyPlaylistWriteDeniedError ||
    error instanceof SpotifyPlaylistExportError ||
    (error instanceof SpotifyHttpError && [401, 403, 429].includes(error.status))
  );
}

function isSafeBatchSplitFailure(error: unknown): boolean {
  return error instanceof SpotifyHttpError && error.status === 400;
}

function isDefiniteNoPlaylistWrite(error: unknown): boolean {
  if (error instanceof SpotifyCooldownError || error instanceof SpotifyEndpointBudgetError) {
    return true;
  }
  if (error instanceof SpotifyPlaylistWriteDeniedError) return true;
  if (error instanceof SpotifyHttpError) {
    return error.endpointCategory === "oauth_token" || [401, 403, 429].includes(error.status);
  }
  return error instanceof Error && error.message === "Spotify reconnect is required";
}

function safeErrorCode(error: unknown): string {
  if (error instanceof SpotifyPlaylistWriteDeniedError) return error.code;
  if (error instanceof SpotifyPlaylistExportError) return error.code;
  if (error instanceof SpotifyHttpError) {
    return error.providerReasonToken === "QUOTA_EXCEEDED" ||
      error.providerErrorClassification === "quota_exceeded"
      ? "spotify_quota_exceeded"
      : error.providerErrorClassification
        ? `spotify_${error.providerErrorClassification}`
        : `spotify_http_${error.status}`;
  }
  return "playlist_item_add_failed";
}
