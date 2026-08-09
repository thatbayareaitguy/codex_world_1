import { and, asc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RadarDatabase } from "./client";
import { reconcileSpotifySchedulerWork } from "./spotify-scheduler";
import {
  discoveryReconciliationArtists,
  discoveryReconciliationCampaigns,
  discoveryScheduleJobs,
  discoveryScheduleState,
  appleMusicArtistScans,
  appleMusicScanBatches,
  artistExternalIds,
  releaseProviderReconciliations,
  spotifyProviderState,
  spotifyPlaylistExportOperations,
  spotifySchedulerState,
  spotifySchedulerWork,
} from "./schema";

export const discoveryScheduleStateId = "global";
export const discoveryScheduleTimezone = "America/Los_Angeles";
export const discoveryAppleFullWeekday = 4;
export const discoveryAppleFullHour = 21;
export const discoveryAppleCatchupWeekday = 5;
export const discoveryAppleCatchupHour = 9;
export const discoveryAppleRecoveryWindowMs = 24 * 60 * 60_000;
export const discoveryAppleJobLeaseMs = 3 * 60 * 60_000;

export type DiscoveryAppleJobType = "apple_full" | "apple_catchup";
export type DiscoveryAppleJobStatus = "scheduled" | "leased" | "completed" | "failed" | "expired";

export interface DiscoveryAppleJobClaim {
  id: string;
  jobKey: string;
  jobType: DiscoveryAppleJobType;
  leaseExpiresAt: Date;
  leaseOwner: string;
  recoveryDeadline: Date;
  scheduledFor: Date;
}

type DiscoveryScheduleTransaction = Parameters<Parameters<RadarDatabase["transaction"]>[0]>[0];

export type DiscoverySchedulePhase =
  | "idle"
  | "cooldown_wait"
  | "playlist_inbox"
  | "apple_priority"
  | "apple_catchup_priority"
  | "broad_spotify"
  | "weekly_apple";

export interface DiscoveryBootstrapTransitionResult {
  applePriorityQueued: number;
  broadSpotifyQueued: number;
  campaignId: string;
  campaignStatus: "completed_with_spotify_deferred";
  cooldownUntil: Date | null;
  nextAppleScanAt: Date;
  phase: DiscoverySchedulePhase;
}

export async function transitionAppleFirstCampaignToRecurringSchedule(
  db: RadarDatabase,
  campaignId: string,
  now = new Date(),
): Promise<DiscoveryBootstrapTransitionResult> {
  await reconcileSpotifySchedulerWork(db, now);
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(discoveryReconciliationCampaigns)
      .where(eq(discoveryReconciliationCampaigns.id, campaignId))
      .limit(1)
      .for("update");
    if (!campaign) throw new Error("Apple-first discovery campaign was not found.");
    if (campaign.appleArtistsScanned !== campaign.totalArtists) {
      throw new Error("The weekly Apple scan must be complete before campaign transition.");
    }

    const provider = await tx.query.spotifyProviderState.findFirst({
      where: eq(spotifyProviderState.id, "global"),
    });
    const cooldownUntil = provider?.cooldownUntil ?? null;
    const cooldownActive = Boolean(
      provider?.cooldownIndefinite || (cooldownUntil && cooldownUntil > now),
    );
    const existingState = await tx.query.discoveryScheduleState.findFirst({
      where: eq(discoveryScheduleState.id, discoveryScheduleStateId),
    });
    if (
      campaign.status === "completed_with_spotify_deferred" &&
      existingState?.activeCampaignId === campaignId &&
      campaign.nextAppleScanAt
    ) {
      return {
        applePriorityQueued: existingState.applePriorityQueuedCount,
        broadSpotifyQueued: existingState.broadSpotifyQueuedCount,
        campaignId,
        campaignStatus: "completed_with_spotify_deferred" as const,
        cooldownUntil,
        nextAppleScanAt: campaign.nextAppleScanAt,
        phase: parseDiscoverySchedulePhase(existingState.phase),
      };
    }
    const members = await tx
      .select()
      .from(discoveryReconciliationArtists)
      .where(eq(discoveryReconciliationArtists.campaignId, campaignId))
      .orderBy(asc(discoveryReconciliationArtists.position));
    const unresolved = await tx
      .selectDistinct({ artistId: releaseProviderReconciliations.artistId })
      .from(releaseProviderReconciliations)
      .where(
        and(
          eq(releaseProviderReconciliations.campaignId, campaignId),
          inArray(releaseProviderReconciliations.status, [
            "apple_only",
            "uncertain",
            "missing_spotify_track",
          ]),
        ),
      );
    const unresolvedArtistIds = new Set(unresolved.map((row) => row.artistId));
    const unfinishedStatuses = new Set(["pending", "selected", "rate_limited", "failed"]);
    const unfinished = members.filter((member) => unfinishedStatuses.has(member.spotifyStatus));
    const priority = members.filter(
      (member) =>
        (member.appleRecentDiscovery && unfinishedStatuses.has(member.spotifyStatus)) ||
        unresolvedArtistIds.has(member.artistId),
    );

    for (const member of priority) {
      const notBefore = latestDate(
        member.spotifyRetryEligibleAt,
        cooldownActive ? cooldownUntil : null,
      );
      await tx
        .update(spotifySchedulerWork)
        .set({
          blockedReason: "superseded_by_apple_priority",
          status: "cancelled",
          updatedAt: now,
        })
        .where(
          and(
            eq(spotifySchedulerWork.artistId, member.artistId),
            eq(spotifySchedulerWork.workType, "artist_reconciliation"),
            sql`${spotifySchedulerWork.source} <> 'apple_priority'`,
            inArray(spotifySchedulerWork.status, ["queued", "blocked"]),
          ),
        );
      await tx
        .insert(spotifySchedulerWork)
        .values({
          artistId: member.artistId,
          discoveryReconciliationCampaignId: campaignId,
          dueAt: now,
          expectedSpotifyArtistId: member.spotifyArtistId,
          notBefore,
          priority: -100,
          source: "apple_priority",
          status: "queued",
          workKey: `apple_priority:${campaignId}:${member.artistId}`,
          workType: "artist_reconciliation",
        })
        .onConflictDoUpdate({
          target: spotifySchedulerWork.workKey,
          set: {
            discoveryReconciliationCampaignId: campaignId,
            dueAt: now,
            expectedSpotifyArtistId: member.spotifyArtistId,
            notBefore,
            priority: -100,
            source: "apple_priority",
            status: sql`case when ${spotifySchedulerWork.status} in ('blocked', 'cancelled') then 'queued'::spotify_scheduler_work_status else ${spotifySchedulerWork.status} end`,
            updatedAt: now,
          },
        });
    }

    for (const member of unfinished) {
      await tx
        .update(spotifySchedulerWork)
        .set({
          discoveryReconciliationCampaignId: campaignId,
          expectedSpotifyArtistId: member.spotifyArtistId,
          updatedAt: now,
        })
        .where(eq(spotifySchedulerWork.workKey, `base_artist:${member.artistId}`));
    }

    const nextAppleScanAt = nextWeeklyAppleScanAt(now);
    const phase = cooldownActive ? "cooldown_wait" : "playlist_inbox";
    await tx
      .update(discoveryReconciliationCampaigns)
      .set({
        bootstrapWeeklyAppleScan: true,
        completedAt: now,
        deferredSpotifyArtistCount: unfinished.length,
        errorClassification: null,
        nextAppleScanAt,
        spotifyDeferredAt: now,
        stage: "completed",
        status: "completed_with_spotify_deferred",
        updatedAt: now,
      })
      .where(eq(discoveryReconciliationCampaigns.id, campaignId));
    await tx
      .insert(discoveryScheduleState)
      .values({
        activeCampaignId: campaignId,
        applePriorityQueuedCount: priority.length,
        broadSpotifyQueuedCount: unfinished.length,
        id: discoveryScheduleStateId,
        lastAppleCampaignId: campaignId,
        lastAppleScanCompletedAt: now,
        nextAppleScanAt,
        phase,
        playlistInboxStatus: "ready",
        timezone: discoveryScheduleTimezone,
        transitionedAt: now,
      })
      .onConflictDoUpdate({
        target: discoveryScheduleState.id,
        set: {
          activeCampaignId: campaignId,
          applePriorityQueuedCount: priority.length,
          broadSpotifyQueuedCount: unfinished.length,
          lastAppleCampaignId: campaignId,
          lastAppleScanCompletedAt: now,
          nextAppleScanAt,
          phase,
          playlistInboxStatus: "ready",
          timezone: discoveryScheduleTimezone,
          transitionedAt: now,
          updatedAt: now,
        },
      });

    return {
      applePriorityQueued: priority.length,
      broadSpotifyQueued: unfinished.length,
      campaignId,
      campaignStatus: "completed_with_spotify_deferred",
      cooldownUntil,
      nextAppleScanAt,
      phase,
    };
  });
}

export async function getDiscoveryScheduleStatus(db: RadarDatabase) {
  const state = await db.query.discoveryScheduleState.findFirst({
    where: eq(discoveryScheduleState.id, discoveryScheduleStateId),
  });
  if (!state) return null;
  const queue = await db
    .select({
      count: sql<number>`count(*)::int`,
      source: spotifySchedulerWork.source,
      status: spotifySchedulerWork.status,
    })
    .from(spotifySchedulerWork)
    .where(
      or(
        eq(
          spotifySchedulerWork.discoveryReconciliationCampaignId,
          state.activeCampaignId ?? "00000000-0000-0000-0000-000000000000",
        ),
        eq(spotifySchedulerWork.source, "apple_priority"),
      ),
    )
    .groupBy(spotifySchedulerWork.source, spotifySchedulerWork.status);
  return { state, queue };
}

export async function reconcileDiscoveryScheduleAfterCooldown(
  db: RadarDatabase,
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(discoveryScheduleState)
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId))
      .limit(1)
      .for("update");
    if (!state || state.phase !== "cooldown_wait") return false;

    const provider = await tx.query.spotifyProviderState.findFirst({
      where: eq(spotifyProviderState.id, "global"),
    });
    if (provider?.cooldownIndefinite || (provider?.cooldownUntil && provider.cooldownUntil > now)) {
      return false;
    }

    const [fullPriority, catchupPriority] = await Promise.all([
      countActiveApplePriority(tx, "apple_priority"),
      countActiveApplePriority(tx, "apple_catchup"),
    ]);
    const playlistPending = ["ready", "exporting", "partial", "failed"].includes(
      state.playlistInboxStatus,
    );
    const phase: DiscoverySchedulePhase = playlistPending
      ? "playlist_inbox"
      : fullPriority > 0
        ? "apple_priority"
        : catchupPriority > 0
          ? "apple_catchup_priority"
          : "broad_spotify";
    await tx
      .update(discoveryScheduleState)
      .set({
        applePriorityQueuedCount: fullPriority + catchupPriority,
        phase,
        updatedAt: now,
      })
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId));
    return true;
  });
}

export async function markDiscoveryPlaylistInboxStatus(
  db: RadarDatabase,
  input: {
    exportRunId?: string | null;
    pauseForCooldown?: boolean;
    status: "ready" | "exporting" | "partial" | "completed" | "failed";
  },
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [fullPriority, catchupPriority] = await Promise.all([
      countActiveApplePriority(tx, "apple_priority"),
      countActiveApplePriority(tx, "apple_catchup"),
    ]);
    const phase: DiscoverySchedulePhase =
      input.status !== "completed"
        ? input.pauseForCooldown
          ? "cooldown_wait"
          : "playlist_inbox"
        : fullPriority > 0
          ? "apple_priority"
          : catchupPriority > 0
            ? "apple_catchup_priority"
            : "broad_spotify";
    await tx
      .update(discoveryScheduleState)
      .set({
        applePriorityQueuedCount: fullPriority + catchupPriority,
        phase,
        playlistInboxExportRunId: input.exportRunId ?? null,
        playlistInboxStatus: input.status,
        updatedAt: now,
      })
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId));
  });
}

export async function markBroadDiscoveryPlaylistCheckpointPending(
  db: RadarDatabase,
  now = new Date(),
): Promise<boolean> {
  const [updated] = await db
    .update(discoveryScheduleState)
    .set({ playlistInboxStatus: "pending", updatedAt: now })
    .where(
      and(
        eq(discoveryScheduleState.id, discoveryScheduleStateId),
        eq(discoveryScheduleState.phase, "broad_spotify"),
        eq(discoveryScheduleState.playlistInboxStatus, "completed"),
      ),
    )
    .returning({ id: discoveryScheduleState.id });
  return Boolean(updated);
}

export async function prepareBroadDiscoveryPlaylistCheckpoint(
  db: RadarDatabase,
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(discoveryScheduleState)
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId))
      .limit(1)
      .for("update");
    if (!state || state.phase !== "broad_spotify" || state.playlistInboxStatus !== "pending") {
      return false;
    }
    const provider = await tx.query.spotifyProviderState.findFirst({
      where: eq(spotifyProviderState.id, "global"),
    });
    const cooldownActive = Boolean(
      provider?.cooldownIndefinite || (provider?.cooldownUntil && provider.cooldownUntil > now),
    );
    await tx
      .update(discoveryScheduleState)
      .set({
        phase: cooldownActive ? "cooldown_wait" : "playlist_inbox",
        playlistInboxStatus: "ready",
        updatedAt: now,
      })
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId));
    return true;
  });
}

export async function claimAutomaticDiscoveryPlaylistInboxExport(
  db: RadarDatabase,
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(discoveryScheduleState)
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId))
      .limit(1)
      .for("update");
    if (
      !state ||
      state.phase !== "playlist_inbox" ||
      !["ready", "exporting", "partial", "failed"].includes(state.playlistInboxStatus)
    ) {
      return false;
    }
    const provider = await tx.query.spotifyProviderState.findFirst({
      where: eq(spotifyProviderState.id, "global"),
    });
    if (provider?.cooldownIndefinite || (provider?.cooldownUntil && provider.cooldownUntil > now)) {
      return false;
    }
    const [claimed] = await tx
      .update(discoveryScheduleState)
      .set({
        playlistInboxStatus: "exporting",
        updatedAt: now,
      })
      .where(
        and(
          eq(discoveryScheduleState.id, discoveryScheduleStateId),
          eq(discoveryScheduleState.phase, "playlist_inbox"),
          inArray(discoveryScheduleState.playlistInboxStatus, [
            "ready",
            "exporting",
            "partial",
            "failed",
          ]),
        ),
      )
      .returning({ id: discoveryScheduleState.id });
    return Boolean(claimed);
  });
}

export async function prepareDiscoveryPlaylistInboxExport(
  db: RadarDatabase,
  campaignId: string,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(discoveryScheduleState)
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId))
      .limit(1)
      .for("update");
    if (!state || state.activeCampaignId !== campaignId) {
      throw new Error("The discovery inbox campaign is not the active bootstrap campaign.");
    }
    const campaign = await tx.query.discoveryReconciliationCampaigns.findFirst({
      where: eq(discoveryReconciliationCampaigns.id, campaignId),
    });
    if (campaign?.status !== "completed_with_spotify_deferred") {
      throw new Error("The discovery inbox campaign has not been safely finalized.");
    }
    const provider = await tx.query.spotifyProviderState.findFirst({
      where: eq(spotifyProviderState.id, "global"),
    });
    if (provider?.cooldownIndefinite || (provider?.cooldownUntil && provider.cooldownUntil > now)) {
      throw new Error(
        `Spotify cooldown remains active until ${provider.cooldownUntil?.toISOString() ?? "manual review"}.`,
      );
    }
    if (!["ready", "partial", "failed"].includes(state.playlistInboxStatus)) {
      throw new Error(`Discovery inbox export cannot start from ${state.playlistInboxStatus}.`);
    }
    await tx
      .update(discoveryScheduleState)
      .set({
        phase: "playlist_inbox",
        playlistInboxStatus: "exporting",
        updatedAt: now,
      })
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId));
  });
}

export async function activateDiscoverySpotifyPriorityScheduler(
  db: RadarDatabase,
  campaignId: string,
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const [state] = await tx
      .select()
      .from(discoveryScheduleState)
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId))
      .limit(1)
      .for("update");
    if (!state || state.activeCampaignId !== campaignId) {
      throw new Error("The discovery campaign is not the active bootstrap campaign.");
    }
    const campaign = await tx.query.discoveryReconciliationCampaigns.findFirst({
      where: eq(discoveryReconciliationCampaigns.id, campaignId),
    });
    if (campaign?.status !== "completed_with_spotify_deferred") {
      throw new Error("The discovery campaign has not been safely finalized.");
    }
    if (state.playlistInboxStatus !== "completed" || state.phase !== "apple_priority") {
      throw new Error("The discovery playlist inbox must complete before Spotify priority work.");
    }
    const provider = await tx.query.spotifyProviderState.findFirst({
      where: eq(spotifyProviderState.id, "global"),
    });
    if (provider?.cooldownIndefinite || (provider?.cooldownUntil && provider.cooldownUntil > now)) {
      throw new Error(
        `Spotify cooldown remains active until ${provider.cooldownUntil?.toISOString() ?? "manual review"}.`,
      );
    }
    const updated = await tx
      .update(spotifySchedulerState)
      .set({ mode: "automatic", updatedAt: now })
      .where(eq(spotifySchedulerState.id, "global"))
      .returning({ id: spotifySchedulerState.id });
    if (updated.length !== 1) {
      throw new Error("Spotify scheduler state is unavailable.");
    }
  });
}

export async function reconcileDiscoveryScheduleJobs(
  db: RadarDatabase,
  now = new Date(),
): Promise<void> {
  const state = await db.query.discoveryScheduleState.findFirst({
    where: eq(discoveryScheduleState.id, discoveryScheduleStateId),
  });
  const definitions: Array<{ hour: number; jobType: DiscoveryAppleJobType; weekday: number }> = [
    { hour: discoveryAppleFullHour, jobType: "apple_full", weekday: discoveryAppleFullWeekday },
    {
      hour: discoveryAppleCatchupHour,
      jobType: "apple_catchup",
      weekday: discoveryAppleCatchupWeekday,
    },
  ];

  await db.transaction(async (tx) => {
    await tx
      .update(discoveryScheduleJobs)
      .set({
        leaseExpiresAt: null,
        leaseOwner: null,
        status: sql`case when ${discoveryScheduleJobs.recoveryDeadline} >= ${now.toISOString()}::timestamptz then 'scheduled'::discovery_schedule_job_status else 'expired'::discovery_schedule_job_status end`,
        updatedAt: now,
      })
      .where(
        and(
          eq(discoveryScheduleJobs.status, "leased"),
          lte(discoveryScheduleJobs.leaseExpiresAt, now),
        ),
      );
    await tx
      .update(discoveryScheduleJobs)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(discoveryScheduleJobs.status, "scheduled"),
          lte(discoveryScheduleJobs.recoveryDeadline, now),
        ),
      );

    for (const definition of definitions) {
      const occurrence = weeklyOccurrenceAround(now, definition.weekday, definition.hour);
      for (const scheduledFor of [occurrence.previous, occurrence.next]) {
        const recoveryDeadline = new Date(scheduledFor.getTime() + discoveryAppleRecoveryWindowMs);
        const catchupCoveredByFullScan =
          definition.jobType === "apple_catchup" &&
          state?.lastAppleScanCompletedAt &&
          state.lastAppleScanCompletedAt >= scheduledFor &&
          state.lastAppleScanCompletedAt < occurrence.next;
        const completedByBootstrap =
          (definition.jobType === "apple_full" &&
            state?.lastAppleScanCompletedAt &&
            state.lastAppleScanCompletedAt >= scheduledFor &&
            state.lastAppleScanCompletedAt < occurrence.next) ||
          catchupCoveredByFullScan;
        const status: DiscoveryAppleJobStatus = completedByBootstrap
          ? "completed"
          : recoveryDeadline <= now
            ? "expired"
            : "scheduled";
        await tx
          .insert(discoveryScheduleJobs)
          .values({
            ...(completedByBootstrap
              ? {
                  completedAt: state.lastAppleScanCompletedAt,
                  ...(catchupCoveredByFullScan
                    ? { errorClassification: "covered_by_later_full_scan" }
                    : {}),
                }
              : {}),
            jobKey: discoveryAppleJobKey(definition.jobType, scheduledFor),
            jobType: definition.jobType,
            recoveryDeadline,
            scheduledFor,
            status,
          })
          .onConflictDoNothing();
        if (catchupCoveredByFullScan) {
          await tx
            .update(discoveryScheduleJobs)
            .set({
              completedAt: state.lastAppleScanCompletedAt,
              errorClassification: "covered_by_later_full_scan",
              status: "completed",
              updatedAt: now,
            })
            .where(
              and(
                eq(
                  discoveryScheduleJobs.jobKey,
                  discoveryAppleJobKey(definition.jobType, scheduledFor),
                ),
                eq(discoveryScheduleJobs.status, "scheduled"),
              ),
            );
        }
      }
    }

    const nextFull = weeklyOccurrenceAround(
      now,
      discoveryAppleFullWeekday,
      discoveryAppleFullHour,
    ).next;
    await tx
      .insert(discoveryScheduleState)
      .values({
        id: discoveryScheduleStateId,
        nextAppleScanAt: nextFull,
        phase: "idle",
      })
      .onConflictDoUpdate({
        target: discoveryScheduleState.id,
        set: { nextAppleScanAt: nextFull, updatedAt: now },
      });
  });
}

export async function claimDiscoveryScheduleAppleJob(
  db: RadarDatabase,
  now = new Date(),
): Promise<DiscoveryAppleJobClaim | null> {
  await reconcileDiscoveryScheduleJobs(db, now);
  return db.transaction(async (tx) => {
    let query = tx
      .select()
      .from(discoveryScheduleJobs)
      .where(
        and(
          eq(discoveryScheduleJobs.status, "scheduled"),
          lte(discoveryScheduleJobs.scheduledFor, now),
          gte(discoveryScheduleJobs.recoveryDeadline, now),
        ),
      )
      .orderBy(asc(discoveryScheduleJobs.scheduledFor), asc(discoveryScheduleJobs.id))
      .limit(1);
    query = query.for("update", { skipLocked: true }) as typeof query;
    const [job] = await query;
    if (!job) return null;
    const leaseOwner = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + discoveryAppleJobLeaseMs);
    const [claimed] = await tx
      .update(discoveryScheduleJobs)
      .set({
        errorClassification: null,
        leaseExpiresAt,
        leaseOwner,
        startedAt: now,
        status: "leased",
        updatedAt: now,
      })
      .where(
        and(eq(discoveryScheduleJobs.id, job.id), eq(discoveryScheduleJobs.status, "scheduled")),
      )
      .returning();
    if (!claimed?.leaseOwner || !claimed.leaseExpiresAt) return null;
    await tx
      .update(discoveryScheduleState)
      .set({ phase: "weekly_apple", updatedAt: now })
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId));
    return {
      id: claimed.id,
      jobKey: claimed.jobKey,
      jobType: claimed.jobType,
      leaseExpiresAt: claimed.leaseExpiresAt,
      leaseOwner: claimed.leaseOwner,
      recoveryDeadline: claimed.recoveryDeadline,
      scheduledFor: claimed.scheduledFor,
    };
  });
}

export async function finishDiscoveryScheduleAppleJob(
  db: RadarDatabase,
  claim: DiscoveryAppleJobClaim,
  input:
    | { appleMusicBatchId: string; scanRunId?: string | null; status: "completed" }
    | { errorClassification: string; status: "failed" },
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(discoveryScheduleJobs)
      .set({
        ...(input.status === "completed"
          ? {
              appleMusicBatchId: input.appleMusicBatchId,
              completedAt: now,
              errorClassification: null,
              scanRunId: input.scanRunId ?? null,
            }
          : { errorClassification: input.errorClassification.slice(0, 100) }),
        leaseExpiresAt: null,
        leaseOwner: null,
        status: input.status,
        updatedAt: now,
      })
      .where(
        and(
          eq(discoveryScheduleJobs.id, claim.id),
          eq(discoveryScheduleJobs.status, "leased"),
          eq(discoveryScheduleJobs.leaseOwner, claim.leaseOwner),
        ),
      )
      .returning({ id: discoveryScheduleJobs.id });
    if (!updated) return false;

    if (input.status === "completed") {
      await queueAppleBatchSpotifyPriority(tx, {
        batchId: input.appleMusicBatchId,
        jobId: claim.id,
        source: claim.jobType === "apple_catchup" ? "apple_catchup" : "apple_priority",
        now,
      });
    }
    const [fullPriority, catchupPriority, scheduleState, providerState] = await Promise.all([
      countActiveApplePriority(tx, "apple_priority"),
      countActiveApplePriority(tx, "apple_catchup"),
      tx.query.discoveryScheduleState.findFirst({
        where: eq(discoveryScheduleState.id, discoveryScheduleStateId),
      }),
      tx.query.spotifyProviderState.findFirst({
        where: eq(spotifyProviderState.id, "global"),
      }),
    ]);
    const priorityActive = fullPriority + catchupPriority;
    const cooldownActive = Boolean(
      providerState?.cooldownIndefinite ||
      (providerState?.cooldownUntil && providerState.cooldownUntil > now),
    );
    const playlistPending =
      scheduleState &&
      ["ready", "exporting", "partial", "failed"].includes(scheduleState.playlistInboxStatus);
    const completedAppleJob = input.status === "completed";
    const phase: DiscoverySchedulePhase = cooldownActive
      ? "cooldown_wait"
      : playlistPending
        ? "playlist_inbox"
        : fullPriority > 0
          ? "apple_priority"
          : catchupPriority > 0
            ? "apple_catchup_priority"
            : completedAppleJob
              ? "playlist_inbox"
              : "broad_spotify";
    await tx
      .update(discoveryScheduleState)
      .set({
        applePriorityQueuedCount: priorityActive,
        ...(input.status === "completed" && claim.jobType === "apple_full"
          ? { lastAppleScanCompletedAt: now }
          : {}),
        phase,
        ...(completedAppleJob
          ? {
              playlistInboxExportRunId: null,
              playlistInboxStatus: priorityActive > 0 ? "pending" : "ready",
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(discoveryScheduleState.id, discoveryScheduleStateId));
    return true;
  });
}

export async function getRecurringDiscoveryScheduleStatus(db: RadarDatabase, now = new Date()) {
  await reconcileDiscoveryScheduleJobs(db, now);
  const [state, jobs] = await Promise.all([
    db.query.discoveryScheduleState.findFirst({
      where: eq(discoveryScheduleState.id, discoveryScheduleStateId),
    }),
    db
      .select({
        appleMusicBatchId: discoveryScheduleJobs.appleMusicBatchId,
        completedAt: discoveryScheduleJobs.completedAt,
        errorClassification: discoveryScheduleJobs.errorClassification,
        jobType: discoveryScheduleJobs.jobType,
        recoveryDeadline: discoveryScheduleJobs.recoveryDeadline,
        scheduledFor: discoveryScheduleJobs.scheduledFor,
        status: discoveryScheduleJobs.status,
        batchCompletedArtists: appleMusicScanBatches.completedArtists,
        batchFailedArtists: appleMusicScanBatches.failedArtists,
        batchTotalArtists: appleMusicScanBatches.totalArtists,
      })
      .from(discoveryScheduleJobs)
      .leftJoin(
        appleMusicScanBatches,
        eq(appleMusicScanBatches.id, discoveryScheduleJobs.appleMusicBatchId),
      )
      .orderBy(asc(discoveryScheduleJobs.scheduledFor)),
  ]);
  const latest = (type: DiscoveryAppleJobType) =>
    jobs
      .filter((job) => job.jobType === type && job.scheduledFor <= now)
      .sort((left, right) => right.scheduledFor.getTime() - left.scheduledFor.getTime())[0] ?? null;
  const next = (type: DiscoveryAppleJobType) =>
    jobs
      .filter((job) => job.jobType === type && job.scheduledFor > now)
      .sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime())[0] ?? null;
  const pendingExport = state?.playlistInboxExportRunId
    ? await db
        .select({ count: sql<number>`count(*)::int` })
        .from(spotifyPlaylistExportOperations)
        .where(
          and(
            eq(spotifyPlaylistExportOperations.runId, state.playlistInboxExportRunId),
            inArray(spotifyPlaylistExportOperations.status, ["pending", "failed"]),
          ),
        )
    : [];
  return {
    catchup: { latest: latest("apple_catchup"), next: next("apple_catchup") },
    full: { latest: latest("apple_full"), next: next("apple_full") },
    phase: state ? parseDiscoverySchedulePhase(state.phase) : "idle",
    playlistInbox: {
      exportRunId: state?.playlistInboxExportRunId ?? null,
      pendingCount: Number(pendingExport[0]?.count ?? 0),
      status: state?.playlistInboxStatus ?? "pending",
    },
    timezone: discoveryScheduleTimezone,
  };
}

export function nextWeeklyAppleScanAt(now: Date): Date {
  return weeklyOccurrenceAround(now, discoveryAppleFullWeekday, discoveryAppleFullHour).next;
}

export function nextAppleCatchupScanAt(now: Date): Date {
  return weeklyOccurrenceAround(now, discoveryAppleCatchupWeekday, discoveryAppleCatchupHour).next;
}

async function queueAppleBatchSpotifyPriority(
  db: DiscoveryScheduleTransaction,
  input: {
    batchId: string;
    jobId: string;
    now: Date;
    source: "apple_priority" | "apple_catchup";
  },
): Promise<number> {
  const discoveries = await db
    .select({
      artistId: appleMusicArtistScans.artistId,
      spotifyArtistId: artistExternalIds.externalId,
    })
    .from(appleMusicArtistScans)
    .innerJoin(
      artistExternalIds,
      and(
        eq(artistExternalIds.artistId, appleMusicArtistScans.artistId),
        eq(artistExternalIds.provider, "spotify"),
        eq(artistExternalIds.confirmed, true),
      ),
    )
    .where(
      and(
        eq(appleMusicArtistScans.batchId, input.batchId),
        eq(appleMusicArtistScans.status, "completed"),
        sql`${appleMusicArtistScans.candidateCount} > 0`,
      ),
    );
  let queued = 0;
  for (const discovery of discoveries) {
    const inserted = await db
      .insert(spotifySchedulerWork)
      .values({
        artistId: discovery.artistId,
        dueAt: input.now,
        expectedSpotifyArtistId: discovery.spotifyArtistId,
        priority: input.source === "apple_priority" ? -100 : -80,
        source: input.source,
        status: "queued",
        workKey: `${input.source}:${input.jobId}:${discovery.artistId}`,
        workType: "artist_reconciliation",
      })
      .onConflictDoNothing()
      .returning({ id: spotifySchedulerWork.id });
    queued += inserted.length;
  }
  return queued;
}

async function countActiveApplePriority(
  db: DiscoveryScheduleTransaction,
  source?: "apple_priority" | "apple_catchup",
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(spotifySchedulerWork)
    .where(
      and(
        source
          ? eq(spotifySchedulerWork.source, source)
          : inArray(spotifySchedulerWork.source, ["apple_priority", "apple_catchup"]),
        inArray(spotifySchedulerWork.status, ["queued", "leased"]),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

function discoveryAppleJobKey(jobType: DiscoveryAppleJobType, scheduledFor: Date): string {
  const parts = zonedParts(scheduledFor, discoveryScheduleTimezone);
  return `${jobType}:${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function weeklyOccurrenceAround(now: Date, weekday: number, hour: number) {
  const parts = zonedParts(now, discoveryScheduleTimezone);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + weekday - parts.weekday));
  const currentWeekLocal = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour),
  );
  const currentWeek = localTimeToUtc(currentWeekLocal, discoveryScheduleTimezone);
  if (currentWeek > now) {
    const previousLocal = new Date(currentWeekLocal);
    previousLocal.setUTCDate(previousLocal.getUTCDate() - 7);
    return {
      next: currentWeek,
      previous: localTimeToUtc(previousLocal, discoveryScheduleTimezone),
    };
  }
  const nextLocal = new Date(currentWeekLocal);
  nextLocal.setUTCDate(nextLocal.getUTCDate() + 7);
  return {
    next: localTimeToUtc(nextLocal, discoveryScheduleTimezone),
    previous: currentWeek,
  };
}

function latestDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function parseDiscoverySchedulePhase(value: string): DiscoverySchedulePhase {
  switch (value) {
    case "idle":
    case "cooldown_wait":
    case "playlist_inbox":
    case "apple_priority":
    case "apple_catchup_priority":
    case "broad_spotify":
    case "weekly_apple":
      return value;
    default:
      throw new Error(`Unknown discovery schedule phase: ${value}`);
  }
}

function zonedParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour12: false,
    month: "numeric",
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    day: Number(values.day),
    month: Number(values.month),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday ?? ""),
    year: Number(values.year),
  };
}

function localTimeToUtc(localAsUtc: Date, timezone: string): Date {
  let guess = new Date(localAsUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: timezone,
      year: "numeric",
    });
    const values = Object.fromEntries(
      formatter.formatToParts(guess).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour) % 24,
      Number(values.minute),
      Number(values.second),
    );
    guess = new Date(guess.getTime() + localAsUtc.getTime() - represented);
  }
  return guess;
}
