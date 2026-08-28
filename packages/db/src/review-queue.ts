import { and, asc, eq, inArray } from "drizzle-orm";
import { planSpotifyPlaylistExport } from "@radar/providers";
import type { RadarDatabase } from "./client";
import { loadCanonicalExportCandidates } from "./spotify-playlist-export";
import {
  feedItems,
  manualMatchDecisions,
  releaseCandidates,
  releases,
  spotifySchedulerWork,
  tracks,
} from "./schema";

export interface SystemWaitingReviewItem {
  attemptCount: number;
  dueAt: Date;
  id: string;
  notBefore: Date | null;
  reason: string;
  releaseTitle: string;
  source: string;
  status: string;
  title: string;
  trackId: string;
}

export interface ReleaseReviewQueueStatus {
  actionableCount: number;
  blockedExport: {
    stale: number;
    systemWaiting: number;
    terminal: number;
    total: number;
    userActionable: number;
  };
  deferredCount: number;
  staleCount: number;
  systemWaiting: SystemWaitingReviewItem[];
  systemWaitingCount: number;
  terminalCount: number;
}

export async function getReleaseReviewQueueStatus(
  db: RadarDatabase,
  userId: string,
  now = new Date(),
): Promise<ReleaseReviewQueueStatus> {
  const [reviewRows, decisionRows, waitingRows, exportCandidates] = await Promise.all([
    db
      .select({
        candidateId: releaseCandidates.id,
        feedItemId: feedItems.id,
        provider: releaseCandidates.provider,
        trackId: feedItems.trackId,
      })
      .from(feedItems)
      .innerJoin(releaseCandidates, eq(releaseCandidates.id, feedItems.candidateId))
      .where(
        and(
          eq(feedItems.userId, userId),
          eq(feedItems.state, "needs_review"),
          eq(releaseCandidates.matchStatus, "needs_review"),
        ),
      ),
    db.select().from(manualMatchDecisions).where(eq(manualMatchDecisions.userId, userId)),
    db
      .select({
        attemptCount: spotifySchedulerWork.attemptCount,
        blockedReason: spotifySchedulerWork.blockedReason,
        dueAt: spotifySchedulerWork.dueAt,
        id: spotifySchedulerWork.id,
        lastErrorClassification: spotifySchedulerWork.lastErrorClassification,
        notBefore: spotifySchedulerWork.notBefore,
        releaseTitle: releases.title,
        source: spotifySchedulerWork.source,
        status: spotifySchedulerWork.status,
        title: tracks.title,
        trackId: tracks.id,
      })
      .from(spotifySchedulerWork)
      .innerJoin(tracks, eq(tracks.id, spotifySchedulerWork.targetTrackId))
      .innerJoin(releases, eq(releases.id, tracks.releaseId))
      .innerJoin(feedItems, and(eq(feedItems.trackId, tracks.id), eq(feedItems.userId, userId)))
      .where(
        and(
          eq(spotifySchedulerWork.workType, "track_resolution"),
          inArray(spotifySchedulerWork.status, ["queued", "leased", "blocked"]),
        ),
      )
      .orderBy(asc(spotifySchedulerWork.dueAt)),
    loadCanonicalExportCandidates(db, userId),
  ]);
  const activeDeferrals = new Set(
    decisionRows
      .filter(
        (row) =>
          row.decision === "defer" &&
          row.deferredUntil &&
          row.deferredUntil.getTime() > now.getTime(),
      )
      .map((row) => row.candidateId),
  );
  const exportPlan = planSpotifyPlaylistExport(
    exportCandidates,
    [],
    new Set<string>(),
    "release_date_custom_order",
  );
  const blockedTrackIds = new Set(
    exportPlan.skips
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
  const userActionableTrackIds = new Set(
    reviewRows.flatMap((row) =>
      row.trackId && blockedTrackIds.has(row.trackId) && !activeDeferrals.has(row.candidateId)
        ? [row.trackId]
        : [],
    ),
  );
  const terminalTrackIds = new Set(
    decisionRows.flatMap((row) =>
      row.decision === "no_equivalent" && row.selectedTrackId ? [row.selectedTrackId] : [],
    ),
  );
  const uniqueWaiting = new Map<string, SystemWaitingReviewItem>();
  for (const row of waitingRows) {
    if (!blockedTrackIds.has(row.trackId)) continue;
    if (userActionableTrackIds.has(row.trackId) || terminalTrackIds.has(row.trackId)) continue;
    if (uniqueWaiting.has(row.trackId)) continue;
    uniqueWaiting.set(row.trackId, {
      attemptCount: row.attemptCount,
      dueAt: row.dueAt,
      id: row.id,
      notBefore: row.notBefore,
      reason: waitingReason(row, now),
      releaseTitle: row.releaseTitle,
      source: row.source,
      status: row.status,
      title: row.title,
      trackId: row.trackId,
    });
  }
  const staleTrackIds = [...blockedTrackIds].filter(
    (trackId) =>
      !userActionableTrackIds.has(trackId) &&
      !uniqueWaiting.has(trackId) &&
      !terminalTrackIds.has(trackId),
  );
  return {
    actionableCount: new Set(
      reviewRows
        .filter((row) => !activeDeferrals.has(row.candidateId))
        .map((row) => row.feedItemId),
    ).size,
    blockedExport: {
      stale: staleTrackIds.length,
      systemWaiting: uniqueWaiting.size,
      terminal: [...terminalTrackIds].filter((trackId) => blockedTrackIds.has(trackId)).length,
      total: blockedTrackIds.size,
      userActionable: userActionableTrackIds.size,
    },
    deferredCount: activeDeferrals.size,
    staleCount: staleTrackIds.length,
    systemWaiting: [...uniqueWaiting.values()],
    systemWaitingCount: uniqueWaiting.size,
    terminalCount: decisionRows.filter((row) => row.decision === "no_equivalent").length,
  };
}

function waitingReason(
  row: {
    blockedReason: string | null;
    lastErrorClassification: string | null;
    notBefore: Date | null;
    status: string;
  },
  now: Date,
): string {
  if (row.status === "leased") return "Spotify verification is currently running.";
  if (row.blockedReason) return row.blockedReason.replaceAll("_", " ");
  if (row.lastErrorClassification) {
    return `Retry queued after ${row.lastErrorClassification.replaceAll("_", " ")}.`;
  }
  if (row.notBefore && row.notBefore > now) {
    return `Waiting until ${row.notBefore.toISOString()} before retrying.`;
  }
  return "Queued for guarded Spotify track resolution when provider capacity is available.";
}
