import {
  abbreviateSpotifyPlaylistId,
  assertOwnedPrivateSpotifyPlaylist,
  assertSpotifyPlaylistWriteTarget,
  isExactSpotifyIdentity,
  planSpotifyPlaylistExport,
  spotifyPlaylistIdSchema,
  SpotifyHttpError,
  SpotifyPlaylistWriteDeniedError,
  type SpotifyClient,
  type SpotifyPlaylistExportCandidate,
  type SpotifyPlaylistExportPlan,
  type SpotifyPlaylistWritePolicy,
} from "@radar/providers";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  artistFollows,
  feedItems,
  manualMatchDecisions,
  oauthAccounts,
  playlistExports,
  playlistTargets,
  releaseCandidates,
  releases,
  releaseTrackAppearances,
  spotifyPlaylistExportOperations,
  spotifyPlaylistExportRuns,
  trackCredits,
  tracks,
} from "./schema";

export interface SpotifyPlaylistExportClient {
  addPlaylistItemsAtPosition: SpotifyClient["addPlaylistItemsAtPosition"];
  getCurrentUser: SpotifyClient["getCurrentUser"];
  getPlaylist: SpotifyClient["getPlaylist"];
  getPlaylistItems: SpotifyClient["getPlaylistItems"];
}

export interface SpotifyPlaylistExportPreview {
  plan: SpotifyPlaylistExportPlan;
  target: {
    collaborative: false;
    id: string;
    idAbbreviated: string;
    name: string;
    ownerId: string;
    private: true;
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
    status: "completed" | "partial";
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
): Promise<SpotifyPlaylistExportPreview> {
  const playlistId = spotifyPlaylistIdSchema.parse(configuredPlaylistId);
  const profile = await client.getCurrentUser();
  const playlist = await client.getPlaylist(playlistId);
  assertPlaylistIdentity(playlistId, playlist.id);
  assertOwnedPrivateSpotifyPlaylist(playlist, profile);
  const playlistItems = await client.getPlaylistItems(playlistId);
  return buildPreview(db, userId, playlistId, playlist, profile.id, playlistItems);
}

export async function executeSpotifyPlaylistExport(
  db: RadarDatabase,
  userId: string,
  client: SpotifyPlaylistExportClient,
  input: {
    maxAdditions?: number;
    playlistId: string;
    policy: SpotifyPlaylistWritePolicy;
  },
): Promise<SpotifyPlaylistExportExecution> {
  const playlistId = assertSpotifyPlaylistWriteTarget(input.policy, input.playlistId);
  await requireSpotifyPlaylistWriteScope(db, userId);
  if (
    input.maxAdditions !== undefined &&
    (!Number.isInteger(input.maxAdditions) || input.maxAdditions < 1)
  ) {
    throw new SpotifyPlaylistExportError(
      "Spotify playlist export maximum additions must be a positive integer.",
      "playlist_operation_invalid",
    );
  }

  const profile = await client.getCurrentUser();
  const playlist = await client.getPlaylist(playlistId);
  assertPlaylistIdentity(playlistId, playlist.id);
  assertOwnedPrivateSpotifyPlaylist(playlist, profile);
  const playlistItems = await client.getPlaylistItems(playlistId);
  const preview = await buildPreview(db, userId, playlistId, playlist, profile.id, playlistItems);
  const target = await upsertPlaylistTarget(db, userId, playlistId, playlist.name);
  let run = await loadResumableRun(db, target.id, playlistId);
  const resumed = Boolean(run);
  if (!run) {
    run = await createExportRun(db, target.id, preview);
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
  if (input.maxAdditions !== undefined) pending = pending.slice(0, input.maxAdditions);
  let additionsAttempted = 0;
  let snapshotAfter = playlist.snapshot_id;

  try {
    for (const group of groupPendingOperations(pending)) {
      additionsAttempted += group.length;
      try {
        snapshotAfter = await client.addPlaylistItemsAtPosition(
          playlistId,
          group.map((item) => item.providerTrackId),
          group[0]!.insertPosition,
        );
        for (const operation of group) {
          await markOperationExported(db, target.id, operation, true);
        }
      } catch (error) {
        if (isGlobalSpotifyWriteFailure(error)) throw error;
        let failedBefore = 0;
        for (const operation of group) {
          try {
            snapshotAfter = await client.addPlaylistItemsAtPosition(
              playlistId,
              [operation.providerTrackId],
              Math.max(0, operation.insertPosition - failedBefore),
            );
            await markOperationExported(db, target.id, operation, true);
          } catch (itemError) {
            if (isGlobalSpotifyWriteFailure(itemError)) throw itemError;
            failedBefore += 1;
            await markOperationFailed(db, operation.id, safeErrorCode(itemError));
          }
        }
      }
    }
  } catch (error) {
    await db
      .update(spotifyPlaylistExportRuns)
      .set({ errorCode: safeErrorCode(error), status: "partial", updatedAt: new Date() })
      .where(eq(spotifyPlaylistExportRuns.id, run.id));
    throw error;
  }

  const finalItems = await client.getPlaylistItems(playlistId);
  await reconcilePendingOperations(db, run.id, target.id, finalItems);
  const counts = await loadOperationCounts(db, run.id);
  const status = counts.pending === 0 && counts.failed === 0 ? "completed" : "partial";
  const finishedAt = status === "completed" ? new Date() : null;
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
    .set({ lastSyncedAt: new Date(), snapshotId: snapshotAfter, updatedAt: new Date() })
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
): Promise<SpotifyPlaylistExportPreview> {
  const candidates = await loadCanonicalExportCandidates(db, userId);
  const managedRows = await db
    .select({ providerTrackId: playlistExports.providerTrackId })
    .from(playlistExports)
    .innerJoin(playlistTargets, eq(playlistTargets.id, playlistExports.playlistTargetId))
    .where(
      and(
        eq(playlistTargets.userId, userId),
        eq(playlistTargets.provider, "spotify"),
        eq(playlistTargets.providerPlaylistId, playlistId),
        eq(playlistExports.appOwned, true),
        eq(playlistExports.status, "exported"),
      ),
    );
  return {
    plan: planSpotifyPlaylistExport(
      candidates,
      playlistItems,
      new Set(managedRows.map((row) => row.providerTrackId)),
    ),
    target: {
      collaborative: false,
      id: playlistId,
      idAbbreviated: abbreviateSpotifyPlaylistId(playlistId),
      name: playlist.name,
      ownerId,
      private: true,
      snapshotId: playlist.snapshot_id,
    },
  };
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
    return {
      ...(candidate ? { confidence: Number(candidate.confidence) } : {}),
      discNumber: feed.discNumber,
      feedItemId: feed.feedItemId,
      feedState: feed.feedState,
      followedArtist: followedTrackIds.has(feed.trackId),
      manuallyConfirmed: candidate ? confirmedCandidateIds.has(candidate.candidateId) : false,
      ...(candidate ? { matchRule: candidate.matchRule } : {}),
      ...(candidate ? { providerTrackId: candidate.providerTrackId } : {}),
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

async function requireSpotifyPlaylistWriteScope(db: RadarDatabase, userId: string): Promise<void> {
  const account = await db.query.oauthAccounts.findFirst({
    columns: { scopes: true },
    where: and(
      eq(oauthAccounts.userId, userId),
      eq(oauthAccounts.provider, "spotify"),
      isNull(oauthAccounts.disconnectedAt),
    ),
  });
  if (!account?.scopes.includes("playlist-modify-private")) {
    throw new SpotifyPlaylistExportError(
      "Spotify must be reauthorized with playlist-modify-private before live export.",
      "missing_write_scope",
    );
  }
}

function assertPlaylistIdentity(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new SpotifyPlaylistWriteDeniedError(
      "Spotify returned a playlist other than the configured target",
      "playlist_id_mismatch",
    );
  }
}

async function upsertPlaylistTarget(
  db: RadarDatabase,
  userId: string,
  playlistId: string,
  name: string,
) {
  const [target] = await db
    .insert(playlistTargets)
    .values({
      autoAddExactMatches: false,
      enabled: true,
      name,
      provider: "spotify",
      providerPlaylistId: playlistId,
      userId,
    })
    .onConflictDoUpdate({
      target: [playlistTargets.userId, playlistTargets.provider],
      set: {
        autoAddExactMatches: false,
        enabled: true,
        name,
        providerPlaylistId: playlistId,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!target) throw new Error("Spotify playlist target could not be persisted.");
  return target;
}

async function loadResumableRun(db: RadarDatabase, targetId: string, playlistId: string) {
  return db.query.spotifyPlaylistExportRuns.findFirst({
    orderBy: [desc(spotifyPlaylistExportRuns.createdAt)],
    where: and(
      eq(spotifyPlaylistExportRuns.playlistTargetId, targetId),
      eq(spotifyPlaylistExportRuns.targetPlaylistId, playlistId),
      inArray(spotifyPlaylistExportRuns.status, ["planned", "running", "partial"]),
    ),
  });
}

async function createExportRun(
  db: RadarDatabase,
  targetId: string,
  preview: SpotifyPlaylistExportPreview,
) {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(spotifyPlaylistExportRuns)
      .values({
        additionCount: preview.plan.additions.length,
        alreadyPresentCount: preview.plan.alreadyPresent.length,
        eligibleCount: preview.plan.desired.length,
        mode: "live",
        orderingConflictCount: preview.plan.orderingConflicts.length,
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
      await markOperationExported(db, targetId, operation, false);
    }
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
        attemptCount: sql`${spotifyPlaylistExportOperations.attemptCount} + 1`,
        completedAt: now,
        errorCode: null,
        status: "exported",
        updatedAt: now,
      })
      .where(eq(spotifyPlaylistExportOperations.id, operation.id));
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
      attemptCount: sql`${spotifyPlaylistExportOperations.attemptCount} + 1`,
      completedAt: new Date(),
      errorCode,
      status: "failed",
      updatedAt: new Date(),
    })
    .where(eq(spotifyPlaylistExportOperations.id, operationId));
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
