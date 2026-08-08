import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  spotifyArtistCoverage,
  spotifyArtistScans,
  spotifyProviderState,
  spotifyRequestEvents,
  spotifySchedulerWork,
  spotifySyncCampaignMembers,
  spotifySyncCampaigns,
} from "./schema";
import {
  loadEligibleSpotifyArtists,
  spotifySchedulerLeaseMs,
  spotifySchedulerWindowMs,
  type SchedulerDatabase,
  type SpotifySchedulerClaim,
  type SpotifySchedulerWorkStatus,
} from "./spotify-scheduler";

export type SpotifySyncCampaignStatus =
  | "planned"
  | "running"
  | "canary_review"
  | "base_target_reached"
  | "draining"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export type SpotifySyncCampaignMemberStatus =
  "pending" | "reserved" | "succeeded" | "blocked" | "skipped" | "cancelled";

export interface SpotifySyncCampaignClaim extends SpotifySchedulerClaim {
  campaignId: string;
  campaignMemberId: string | null;
}

export interface SpotifySyncCampaignStatusView {
  activeReservations: number;
  baselineSize: number;
  blockedMembers: number;
  campaignId: string;
  campaignType: string;
  canaryPassed: boolean;
  canaryTarget: number;
  canaryReviewRequired: boolean;
  claimedMember: { artistId: string; memberId: string; ordinal: number } | null;
  completedAt: Date | null;
  createdAt: Date;
  detailBacklog: number;
  expiresAt: Date;
  failedMembers: number;
  lastError: string | null;
  nextBaseClaimAt: Date | null;
  pendingMembers: number;
  qualifyingSuccesses: number;
  skippedMembers: number;
  startedAt: Date | null;
  status: SpotifySyncCampaignStatus;
  stopReason: string | null;
  target: number;
  trackBacklog: number;
}

const activeCampaignStatuses: SpotifySyncCampaignStatus[] = [
  "planned",
  "running",
  "canary_review",
  "base_target_reached",
  "draining",
  "paused",
];

export async function createSpotifySyncCampaign(
  db: RadarDatabase,
  input: {
    canaryTarget: number;
    expiresAt: Date;
    now?: Date;
    targetSuccesses: number;
  },
): Promise<typeof spotifySyncCampaigns.$inferSelect> {
  const now = input.now ?? new Date();
  validateCampaignTargets(input.targetSuccesses, input.canaryTarget, input.expiresAt, now);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('spotify_sync_campaign_create'))`);
    const eligible = await loadEligibleSpotifyArtists(tx);
    const baseWork = await tx
      .select()
      .from(spotifySchedulerWork)
      .where(eq(spotifySchedulerWork.workType, "base_artist"));
    const workByArtist = new Map(
      baseWork.filter((work) => work.artistId).map((work) => [work.artistId!, work]),
    );
    const baseline = eligible
      .filter((artist) => artist.lastSuccessfulAt === null && workByArtist.has(artist.artistId))
      .sort((left, right) => {
        const leftWork = workByArtist.get(left.artistId)!;
        const rightWork = workByArtist.get(right.artistId)!;
        return (
          leftWork.priority - rightWork.priority ||
          leftWork.dueAt.getTime() - rightWork.dueAt.getTime() ||
          left.artistId.localeCompare(right.artistId)
        );
      });
    if (baseline.length < input.targetSuccesses) {
      throw new Error(
        `Campaign target ${input.targetSuccesses} exceeds the ${baseline.length} eligible baseline artists.`,
      );
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          artists: baseline.map((artist) => artist.artistId),
          canaryTarget: input.canaryTarget,
          targetSuccesses: input.targetSuccesses,
        }),
      )
      .digest("hex")
      .slice(0, 24);
    const campaignKey = `bounded-initial:${input.targetSuccesses}:${input.canaryTarget}:${fingerprint}`;
    const existing = await tx.query.spotifySyncCampaigns.findFirst({
      where: eq(spotifySyncCampaigns.campaignKey, campaignKey),
    });
    if (existing) return existing;
    const active = await tx
      .select({ id: spotifySyncCampaigns.id })
      .from(spotifySyncCampaigns)
      .where(inArray(spotifySyncCampaigns.status, activeCampaignStatuses))
      .limit(1)
      .for("update");
    if (active.length > 0) {
      throw new Error("Another bounded Spotify sync campaign is already active.");
    }
    const baseIntervalMs = Math.max(
      10_000,
      Math.ceil(spotifySchedulerWindowMs / Math.max(1, eligible.length)),
    );
    const configuration = {
      baseIntervalMs,
      canaryTarget: input.canaryTarget,
      maxConcurrency: 1,
      maxRequestsPerTick: 6,
      maxRuntimeMs: 90_000,
      minRequestIntervalMs: 10_000,
      reconciliationEnabled: false,
      targetSuccesses: input.targetSuccesses,
      windowHours: 24,
    };
    const [campaign] = await tx
      .insert(spotifySyncCampaigns)
      .values({
        baseIntervalMs,
        baselineArtistCount: baseline.length,
        campaignKey,
        canaryTarget: input.canaryTarget,
        effectiveConfiguration: configuration,
        expiresAt: input.expiresAt,
        nextBaseClaimAt: now,
        targetSuccesses: input.targetSuccesses,
      })
      .returning();
    if (!campaign) throw new Error("Spotify sync campaign could not be created.");
    await tx.insert(spotifySyncCampaignMembers).values(
      baseline.map((artist, index) => ({
        artistId: artist.artistId,
        baselineEligibleAt: now,
        baselineSpotifyArtistId: artist.spotifyArtistId,
        campaignId: campaign.id,
        ordinal: index + 1,
        schedulerWorkId: workByArtist.get(artist.artistId)!.id,
      })),
    );
    return campaign;
  });
}

export async function startSpotifySyncCampaign(
  db: RadarDatabase,
  campaignId: string,
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(spotifySyncCampaigns)
      .where(eq(spotifySyncCampaigns.id, campaignId))
      .limit(1)
      .for("update");
    if (
      !campaign ||
      !["planned", "paused"].includes(campaign.status) ||
      campaign.expiresAt <= now ||
      (!campaign.canaryPassedAt && campaign.qualifyingSuccessCount >= campaign.canaryTarget)
    ) {
      return false;
    }
    await tx
      .update(spotifySyncCampaigns)
      .set({
        lastError: null,
        pausedAt: null,
        startedAt: campaign.startedAt ?? now,
        status: "running",
        stopReason: null,
        updatedAt: now,
      })
      .where(eq(spotifySyncCampaigns.id, campaignId));
    return true;
  });
}

export async function resumeSpotifySyncCampaign(
  db: RadarDatabase,
  campaignId: string,
  input: { expiresAt: Date; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  validateContinuationDeadline(input.expiresAt, now);
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(spotifySyncCampaigns)
      .where(eq(spotifySyncCampaigns.id, campaignId))
      .limit(1)
      .for("update");
    if (
      !campaign ||
      !["paused", "running"].includes(campaign.status) ||
      (campaign.status === "running" && campaign.expiresAt > now) ||
      campaign.qualifyingSuccessCount >= campaign.targetSuccesses ||
      campaign.activeReservationCount !== 0 ||
      campaign.leaseOwner !== null ||
      campaign.leaseExpiresAt !== null ||
      (!campaign.canaryPassedAt && campaign.qualifyingSuccessCount >= campaign.canaryTarget)
    ) {
      return false;
    }

    const members = await tx
      .select({
        leaseExpiresAt: spotifySyncCampaignMembers.leaseExpiresAt,
        reservationToken: spotifySyncCampaignMembers.reservationToken,
        status: spotifySyncCampaignMembers.status,
      })
      .from(spotifySyncCampaignMembers)
      .where(eq(spotifySyncCampaignMembers.campaignId, campaignId));
    const succeeded = members.filter((member) => member.status === "succeeded").length;
    if (
      members.length !== campaign.baselineArtistCount ||
      succeeded !== campaign.qualifyingSuccessCount ||
      members.some(
        (member) =>
          member.status === "reserved" ||
          member.leaseExpiresAt !== null ||
          member.reservationToken !== null,
      )
    ) {
      return false;
    }

    const leasedWork = await tx
      .select({ id: spotifySchedulerWork.id })
      .from(spotifySchedulerWork)
      .where(
        and(
          eq(spotifySchedulerWork.campaignId, campaignId),
          eq(spotifySchedulerWork.status, "leased"),
        ),
      )
      .limit(1);
    if (leasedWork.length > 0) return false;

    await tx
      .update(spotifySyncCampaigns)
      .set({
        expiresAt: input.expiresAt,
        lastError: null,
        nextBaseClaimAt: now,
        pausedAt: null,
        status: "running",
        stopReason: null,
        updatedAt: now,
      })
      .where(eq(spotifySyncCampaigns.id, campaignId));
    return true;
  });
}

export async function pauseSpotifySyncCampaign(
  db: RadarDatabase,
  campaignId: string,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(spotifySyncCampaigns)
    .set({ pausedAt: now, status: "paused", stopReason: safeText(reason), updatedAt: now })
    .where(
      and(
        eq(spotifySyncCampaigns.id, campaignId),
        inArray(spotifySyncCampaigns.status, [
          "planned",
          "running",
          "canary_review",
          "base_target_reached",
          "draining",
        ]),
      ),
    )
    .returning({ id: spotifySyncCampaigns.id });
  return rows.length === 1;
}

export async function cancelSpotifySyncCampaign(
  db: RadarDatabase,
  campaignId: string,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(spotifySyncCampaigns)
      .where(eq(spotifySyncCampaigns.id, campaignId))
      .limit(1)
      .for("update");
    if (!campaign || !activeCampaignStatuses.includes(campaign.status)) return false;
    await tx
      .update(spotifySchedulerWork)
      .set({
        campaignId: null,
        campaignMemberId: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: sql`case when ${spotifySchedulerWork.workType} = 'base_artist' then 'queued'::spotify_scheduler_work_status else 'cancelled'::spotify_scheduler_work_status end`,
        updatedAt: now,
      })
      .where(
        and(
          eq(spotifySchedulerWork.campaignId, campaignId),
          inArray(spotifySchedulerWork.status, ["queued", "leased"]),
        ),
      );
    await tx
      .update(spotifySyncCampaignMembers)
      .set({
        leaseExpiresAt: null,
        reservationToken: null,
        reservedAt: null,
        status: "cancelled",
        updatedAt: now,
      })
      .where(
        and(
          eq(spotifySyncCampaignMembers.campaignId, campaignId),
          inArray(spotifySyncCampaignMembers.status, ["pending", "reserved"]),
        ),
      );
    await tx
      .update(spotifySyncCampaigns)
      .set({
        activeReservationCount: 0,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: "cancelled",
        stopReason: safeText(reason),
        updatedAt: now,
      })
      .where(eq(spotifySyncCampaigns.id, campaignId));
    return true;
  });
}

export async function advanceSpotifySyncCampaignCanary(
  db: RadarDatabase,
  campaignId: string,
  passed: boolean,
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(spotifySyncCampaigns)
      .where(eq(spotifySyncCampaigns.id, campaignId))
      .limit(1)
      .for("update");
    if (!campaign) return false;
    if (campaign.canaryPassedAt) return passed;
    if (
      campaign.status !== "canary_review" ||
      campaign.qualifyingSuccessCount !== campaign.canaryTarget ||
      campaign.activeReservationCount !== 0
    ) {
      return false;
    }
    await tx
      .update(spotifySyncCampaigns)
      .set(
        passed
          ? {
              canaryPassedAt: now,
              pausedAt: null,
              status: "running",
              stopReason: null,
              updatedAt: now,
            }
          : {
              pausedAt: now,
              status: "paused",
              stopReason: "canary_failed",
              updatedAt: now,
            },
      )
      .where(eq(spotifySyncCampaigns.id, campaignId));
    return true;
  });
}

export async function planSpotifySyncCampaignTick(
  db: RadarDatabase,
  campaignId: string,
  now = new Date(),
): Promise<SpotifySyncCampaignClaim | null> {
  const campaign = await db.query.spotifySyncCampaigns.findFirst({
    where: eq(spotifySyncCampaigns.id, campaignId),
  });
  if (!campaign || !["planned", "running"].includes(campaign.status)) return null;
  if (!campaign.nextBaseClaimAt || campaign.nextBaseClaimAt <= now) {
    const member = await selectPendingCampaignMember(db, campaignId, false);
    if (member) {
      const row = await db.query.spotifySchedulerWork.findFirst({
        where: eq(spotifySchedulerWork.id, member.schedulerWorkId),
      });
      if (row) return toCampaignClaim({ ...row, campaignMemberId: member.id }, campaignId);
    }
  }
  const work = await selectCampaignFollowUpWork(db, campaignId, now, false);
  return work ? toCampaignClaim(work, campaignId) : null;
}

export async function claimSpotifySyncCampaignWork(
  db: RadarDatabase,
  campaignId: string,
  now = new Date(),
  leaseMs = spotifySchedulerLeaseMs,
): Promise<SpotifySyncCampaignClaim | null> {
  if (!Number.isInteger(leaseMs) || leaseMs < 90_000) {
    throw new Error("Spotify campaign lease must cover the 90-second tick runtime.");
  }
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(spotifySyncCampaigns)
      .where(eq(spotifySyncCampaigns.id, campaignId))
      .limit(1)
      .for("update");
    if (!campaign) return null;
    await recoverExpiredCampaignLeases(tx, campaign, now);
    const refreshed = await tx.query.spotifySyncCampaigns.findFirst({
      where: eq(spotifySyncCampaigns.id, campaignId),
    });
    if (!refreshed) return null;
    if (refreshed.expiresAt <= now && activeCampaignStatuses.includes(refreshed.status)) {
      await tx
        .update(spotifySyncCampaigns)
        .set({
          leaseExpiresAt: null,
          leaseOwner: null,
          pausedAt: now,
          status: "paused",
          stopReason: "hard_deadline_reached",
          updatedAt: now,
        })
        .where(eq(spotifySyncCampaigns.id, campaignId));
      return null;
    }
    if (
      !["running", "canary_review", "base_target_reached", "draining"].includes(refreshed.status)
    ) {
      return null;
    }
    if (refreshed.leaseExpiresAt && refreshed.leaseExpiresAt > now) return null;
    if (!(await campaignRequestBoundaryAllows(tx, refreshed.effectiveConfiguration, now))) {
      return null;
    }

    const baseAllowed =
      refreshed.status === "running" &&
      (!refreshed.nextBaseClaimAt || refreshed.nextBaseClaimAt <= now) &&
      refreshed.qualifyingSuccessCount + refreshed.activeReservationCount <
        refreshed.targetSuccesses &&
      (refreshed.canaryPassedAt !== null ||
        refreshed.qualifyingSuccessCount + refreshed.activeReservationCount <
          refreshed.canaryTarget);
    if (baseAllowed) {
      while (true) {
        const member = await selectPendingCampaignMember(tx, campaignId, true);
        if (!member) break;
        const eligible = (await loadEligibleSpotifyArtists(tx)).find(
          (artist) => artist.artistId === member.artistId,
        );
        if (!eligible || eligible.spotifyArtistId !== member.baselineSpotifyArtistId) {
          await markMemberSkipped(tx, member.id, "artist_not_eligible", now);
          continue;
        }
        if (eligible.lastSuccessfulAt) {
          await markMemberSkipped(tx, member.id, "successful_outside_campaign", now);
          continue;
        }
        const row = await tx.query.spotifySchedulerWork.findFirst({
          where: and(
            eq(spotifySchedulerWork.id, member.schedulerWorkId),
            eq(spotifySchedulerWork.status, "queued"),
          ),
        });
        if (!row) {
          await markMemberSkipped(tx, member.id, "base_work_unavailable", now);
          continue;
        }
        const leaseOwner = randomUUID();
        const leaseExpiresAt = new Date(now.getTime() + leaseMs);
        const [claimed] = await tx
          .update(spotifySchedulerWork)
          .set({
            attemptCount: sql`${spotifySchedulerWork.attemptCount} + 1`,
            campaignId,
            campaignMemberId: member.id,
            lastStartedAt: now,
            leaseExpiresAt,
            leaseOwner,
            status: "leased",
            updatedAt: now,
          })
          .where(
            and(eq(spotifySchedulerWork.id, row.id), eq(spotifySchedulerWork.status, "queued")),
          )
          .returning();
        if (!claimed) continue;
        await tx
          .update(spotifySyncCampaignMembers)
          .set({
            attemptCount: sql`${spotifySyncCampaignMembers.attemptCount} + 1`,
            leaseExpiresAt,
            reservationToken: leaseOwner,
            reservedAt: now,
            status: "reserved",
            updatedAt: now,
          })
          .where(
            and(
              eq(spotifySyncCampaignMembers.id, member.id),
              eq(spotifySyncCampaignMembers.status, "pending"),
            ),
          );
        await tx
          .update(spotifySyncCampaigns)
          .set({
            activeReservationCount: sql`${spotifySyncCampaigns.activeReservationCount} + 1`,
            leaseExpiresAt,
            leaseOwner,
            nextBaseClaimAt: new Date(now.getTime() + refreshed.baseIntervalMs),
            updatedAt: now,
          })
          .where(eq(spotifySyncCampaigns.id, campaignId));
        return toCampaignClaim(claimed, campaignId);
      }
    }

    const followUp = await selectCampaignFollowUpWork(tx, campaignId, now, true);
    if (!followUp) {
      await finalizeCampaignIfDrained(tx, campaignId, now);
      return null;
    }
    const leaseOwner = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const [claimed] = await tx
      .update(spotifySchedulerWork)
      .set({
        attemptCount: sql`${spotifySchedulerWork.attemptCount} + 1`,
        lastStartedAt: now,
        leaseExpiresAt,
        leaseOwner,
        status: "leased",
        updatedAt: now,
      })
      .where(
        and(eq(spotifySchedulerWork.id, followUp.id), eq(spotifySchedulerWork.status, "queued")),
      )
      .returning();
    if (!claimed) return null;
    await tx
      .update(spotifySyncCampaigns)
      .set({ leaseExpiresAt, leaseOwner, updatedAt: now })
      .where(eq(spotifySyncCampaigns.id, campaignId));
    return toCampaignClaim(claimed, campaignId);
  });
}

export async function finishSpotifySyncCampaignWork(
  db: RadarDatabase,
  claim: SpotifySyncCampaignClaim,
  outcome:
    | { status: "completed" }
    | { status: "retry"; errorClassification: string }
    | { status: "blocked"; reason: string }
    | { status: "cancelled" },
  now = new Date(),
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [campaign] = await tx
      .select()
      .from(spotifySyncCampaigns)
      .where(eq(spotifySyncCampaigns.id, claim.campaignId))
      .limit(1)
      .for("update");
    const work = await tx.query.spotifySchedulerWork.findFirst({
      where: and(
        eq(spotifySchedulerWork.id, claim.id),
        eq(spotifySchedulerWork.status, "leased"),
        eq(spotifySchedulerWork.leaseOwner, claim.leaseOwner),
        eq(spotifySchedulerWork.campaignId, claim.campaignId),
      ),
    });
    if (!campaign || !work) return false;
    if (work.workType === "base_artist") {
      if (!claim.campaignMemberId) return false;
      const member = await tx.query.spotifySyncCampaignMembers.findFirst({
        where: and(
          eq(spotifySyncCampaignMembers.id, claim.campaignMemberId),
          eq(spotifySyncCampaignMembers.status, "reserved"),
          eq(spotifySyncCampaignMembers.reservationToken, claim.leaseOwner),
        ),
      });
      if (!member) return false;
      const qualified =
        outcome.status === "completed" && (await hasSuccessfulCoverage(tx, member.artistId));
      const memberStatus: SpotifySyncCampaignMemberStatus = qualified
        ? "succeeded"
        : outcome.status === "blocked"
          ? "blocked"
          : outcome.status === "cancelled"
            ? "cancelled"
            : "pending";
      await tx
        .update(spotifySyncCampaignMembers)
        .set({
          blockedReason: outcome.status === "blocked" ? safeText(outcome.reason) : null,
          lastError:
            outcome.status === "retry"
              ? safeText(outcome.errorClassification)
              : outcome.status === "completed" && !qualified
                ? "successful_coverage_not_committed"
                : null,
          leaseExpiresAt: null,
          qualifiedAt: qualified ? now : null,
          reservationToken: null,
          reservedAt: null,
          status: memberStatus,
          updatedAt: now,
        })
        .where(eq(spotifySyncCampaignMembers.id, member.id));
      await tx
        .update(spotifySchedulerWork)
        .set({
          blockedReason: outcome.status === "blocked" ? safeText(outcome.reason) : null,
          campaignId: null,
          campaignMemberId: null,
          dueAt: qualified ? new Date(now.getTime() + spotifySchedulerWindowMs) : work.dueAt,
          lastCompletedAt: qualified ? now : null,
          lastErrorClassification:
            outcome.status === "retry" ? safeText(outcome.errorClassification) : null,
          leaseExpiresAt: null,
          leaseOwner: null,
          notBefore:
            outcome.status === "retry"
              ? new Date(now.getTime() + retryDelay(work.attemptCount))
              : null,
          status: outcome.status === "blocked" ? "blocked" : "queued",
          updatedAt: now,
        })
        .where(eq(spotifySchedulerWork.id, work.id));
      const successCount = campaign.qualifyingSuccessCount + (qualified ? 1 : 0);
      const status = campaignStatusAfterBaseCompletion(campaign, successCount);
      await tx
        .update(spotifySyncCampaigns)
        .set({
          activeReservationCount: Math.max(0, campaign.activeReservationCount - 1),
          lastError:
            outcome.status === "retry"
              ? safeText(outcome.errorClassification)
              : outcome.status === "completed" && !qualified
                ? "successful_coverage_not_committed"
                : null,
          leaseExpiresAt: null,
          leaseOwner: null,
          qualifyingSuccessCount: successCount,
          status,
          stopReason: status === "canary_review" ? "canary_review_required" : null,
          updatedAt: now,
        })
        .where(eq(spotifySyncCampaigns.id, campaign.id));
      await finalizeCampaignIfDrained(tx, campaign.id, now);
      return true;
    }

    const nextStatus: SpotifySchedulerWorkStatus =
      outcome.status === "retry" ? "queued" : outcome.status;
    await tx
      .update(spotifySchedulerWork)
      .set({
        blockedReason: outcome.status === "blocked" ? safeText(outcome.reason) : null,
        lastCompletedAt: outcome.status === "completed" ? now : null,
        lastErrorClassification:
          outcome.status === "retry" ? safeText(outcome.errorClassification) : null,
        leaseExpiresAt: null,
        leaseOwner: null,
        notBefore:
          outcome.status === "retry"
            ? new Date(now.getTime() + retryDelay(work.attemptCount))
            : null,
        status: nextStatus,
        updatedAt: now,
      })
      .where(eq(spotifySchedulerWork.id, work.id));
    await tx
      .update(spotifySyncCampaigns)
      .set({ leaseExpiresAt: null, leaseOwner: null, updatedAt: now })
      .where(eq(spotifySyncCampaigns.id, campaign.id));
    await finalizeCampaignIfDrained(tx, campaign.id, now);
    return true;
  });
}

export async function getSpotifySyncCampaignStatus(
  db: RadarDatabase,
  campaignId: string,
): Promise<SpotifySyncCampaignStatusView | null> {
  const campaign = await db.query.spotifySyncCampaigns.findFirst({
    where: eq(spotifySyncCampaigns.id, campaignId),
  });
  if (!campaign) return null;
  const [members, work, failed] = await Promise.all([
    db
      .select({ status: spotifySyncCampaignMembers.status, count: count() })
      .from(spotifySyncCampaignMembers)
      .where(eq(spotifySyncCampaignMembers.campaignId, campaignId))
      .groupBy(spotifySyncCampaignMembers.status),
    db
      .select({
        status: spotifySchedulerWork.status,
        type: spotifySchedulerWork.workType,
        count: count(),
      })
      .from(spotifySchedulerWork)
      .where(eq(spotifySchedulerWork.campaignId, campaignId))
      .groupBy(spotifySchedulerWork.status, spotifySchedulerWork.workType),
    db
      .select({ count: count() })
      .from(spotifySyncCampaignMembers)
      .where(
        and(
          eq(spotifySyncCampaignMembers.campaignId, campaignId),
          eq(spotifySyncCampaignMembers.status, "pending"),
          sql`${spotifySyncCampaignMembers.lastError} is not null`,
        ),
      ),
  ]);
  const countMembers = (status: SpotifySyncCampaignMemberStatus) =>
    members.find((row) => row.status === status)?.count ?? 0;
  const backlog = (type: "release_detail" | "release_tracks") =>
    work
      .filter((row) => row.type === type && ["queued", "leased"].includes(row.status))
      .reduce((total, row) => total + row.count, 0);
  const reserved = await db.query.spotifySyncCampaignMembers.findFirst({
    where: and(
      eq(spotifySyncCampaignMembers.campaignId, campaignId),
      eq(spotifySyncCampaignMembers.status, "reserved"),
    ),
  });
  return {
    activeReservations: campaign.activeReservationCount,
    baselineSize: campaign.baselineArtistCount,
    blockedMembers: countMembers("blocked"),
    campaignId,
    campaignType: campaign.campaignType,
    canaryPassed: campaign.canaryPassedAt !== null,
    canaryReviewRequired: campaign.status === "canary_review",
    canaryTarget: campaign.canaryTarget,
    claimedMember: reserved
      ? { artistId: reserved.artistId, memberId: reserved.id, ordinal: reserved.ordinal }
      : null,
    completedAt: campaign.completedAt,
    createdAt: campaign.createdAt,
    detailBacklog: backlog("release_detail"),
    expiresAt: campaign.expiresAt,
    failedMembers: failed[0]?.count ?? 0,
    lastError: campaign.lastError,
    nextBaseClaimAt: campaign.nextBaseClaimAt,
    pendingMembers: countMembers("pending"),
    qualifyingSuccesses: campaign.qualifyingSuccessCount,
    skippedMembers: countMembers("skipped"),
    startedAt: campaign.startedAt,
    status: campaign.status,
    stopReason: campaign.stopReason,
    target: campaign.targetSuccesses,
    trackBacklog: backlog("release_tracks"),
  };
}

export async function listSpotifySyncCampaignMembers(db: RadarDatabase, campaignId: string) {
  return db
    .select()
    .from(spotifySyncCampaignMembers)
    .where(eq(spotifySyncCampaignMembers.campaignId, campaignId))
    .orderBy(asc(spotifySyncCampaignMembers.ordinal));
}

export async function listSpotifySyncCampaignWork(db: RadarDatabase, campaignId: string) {
  return db
    .select()
    .from(spotifySchedulerWork)
    .where(eq(spotifySchedulerWork.campaignId, campaignId))
    .orderBy(asc(spotifySchedulerWork.createdAt), asc(spotifySchedulerWork.id));
}

export async function queueSpotifyCampaignReleaseTrackWork(
  db: RadarDatabase,
  input: {
    campaignId: string;
    campaignMemberId?: string | null;
    dueAt?: Date;
    releaseTrackRetrievalId: string;
    source?: "initial" | "recurring" | "validation" | "repair" | "apple_priority";
    spotifyAlbumId: string;
  },
): Promise<void> {
  await db
    .insert(spotifySchedulerWork)
    .values({
      campaignId: input.campaignId,
      campaignMemberId: input.campaignMemberId ?? null,
      dueAt: input.dueAt ?? new Date(),
      priority: 20,
      releaseTrackRetrievalId: input.releaseTrackRetrievalId,
      source: input.source ?? "initial",
      spotifyAlbumId: input.spotifyAlbumId,
      workKey: `release_tracks:${input.releaseTrackRetrievalId}`,
      workType: "release_tracks",
    })
    .onConflictDoNothing();
}

async function recoverExpiredCampaignLeases(
  tx: SchedulerDatabase,
  campaign: typeof spotifySyncCampaigns.$inferSelect,
  now: Date,
): Promise<void> {
  const expiredMembers = await tx
    .select()
    .from(spotifySyncCampaignMembers)
    .where(
      and(
        eq(spotifySyncCampaignMembers.campaignId, campaign.id),
        eq(spotifySyncCampaignMembers.status, "reserved"),
        lte(spotifySyncCampaignMembers.leaseExpiresAt, now),
      ),
    )
    .for("update");
  if (expiredMembers.length > 0) {
    const ids = expiredMembers.map((member) => member.id);
    await tx
      .update(spotifySyncCampaignMembers)
      .set({
        leaseExpiresAt: null,
        reservationToken: null,
        reservedAt: null,
        status: "pending",
        updatedAt: now,
      })
      .where(inArray(spotifySyncCampaignMembers.id, ids));
    await tx
      .update(spotifySchedulerWork)
      .set({
        campaignId: null,
        campaignMemberId: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: "queued",
        updatedAt: now,
      })
      .where(
        and(
          inArray(spotifySchedulerWork.campaignMemberId, ids),
          eq(spotifySchedulerWork.status, "leased"),
        ),
      );
  }
  await tx
    .update(spotifySchedulerWork)
    .set({ leaseExpiresAt: null, leaseOwner: null, status: "queued", updatedAt: now })
    .where(
      and(
        eq(spotifySchedulerWork.campaignId, campaign.id),
        eq(spotifySchedulerWork.status, "leased"),
        lte(spotifySchedulerWork.leaseExpiresAt, now),
      ),
    );
  if (expiredMembers.length > 0 || (campaign.leaseExpiresAt && campaign.leaseExpiresAt <= now)) {
    await tx
      .update(spotifySyncCampaigns)
      .set({
        activeReservationCount: Math.max(
          0,
          campaign.activeReservationCount - expiredMembers.length,
        ),
        leaseExpiresAt: null,
        leaseOwner: null,
        updatedAt: now,
      })
      .where(eq(spotifySyncCampaigns.id, campaign.id));
  }
}

async function campaignRequestBoundaryAllows(
  tx: SchedulerDatabase,
  rawConfiguration: unknown,
  now: Date,
): Promise<boolean> {
  const provider = await tx.query.spotifyProviderState.findFirst({
    where: eq(spotifyProviderState.id, "global"),
  });
  if (
    provider?.cooldownIndefinite ||
    (provider?.cooldownUntil && provider.cooldownUntil > now) ||
    (provider?.leaseExpiresAt && provider.leaseExpiresAt > now)
  ) {
    return false;
  }
  const config = campaignConfiguration(rawConfiguration);
  const [rolling30, rolling24] = await Promise.all([
    countRequests(tx, new Date(now.getTime() - 30 * 60_000)),
    countRequests(tx, new Date(now.getTime() - spotifySchedulerWindowMs)),
  ]);
  return rolling30 < config.rolling30MinuteLimit && rolling24 < config.rolling24HourLimit;
}

async function selectPendingCampaignMember(
  db: SchedulerDatabase,
  campaignId: string,
  lock: boolean,
) {
  let query = db
    .select()
    .from(spotifySyncCampaignMembers)
    .where(
      and(
        eq(spotifySyncCampaignMembers.campaignId, campaignId),
        eq(spotifySyncCampaignMembers.status, "pending"),
      ),
    )
    .orderBy(asc(spotifySyncCampaignMembers.ordinal))
    .limit(1);
  if (lock) query = query.for("update", { skipLocked: true }) as typeof query;
  const [member] = await query;
  return member ?? null;
}

async function selectCampaignFollowUpWork(
  db: SchedulerDatabase,
  campaignId: string,
  now: Date,
  lock: boolean,
) {
  let query = db
    .select()
    .from(spotifySchedulerWork)
    .where(
      and(
        eq(spotifySchedulerWork.campaignId, campaignId),
        eq(spotifySchedulerWork.status, "queued"),
        inArray(spotifySchedulerWork.workType, ["release_detail", "release_tracks"]),
        lte(spotifySchedulerWork.dueAt, now),
        or(isNull(spotifySchedulerWork.notBefore), lte(spotifySchedulerWork.notBefore, now)),
      ),
    )
    .orderBy(
      asc(sql`case when ${spotifySchedulerWork.workType} = 'release_detail' then 0 else 1 end`),
      asc(spotifySchedulerWork.dueAt),
      asc(spotifySchedulerWork.id),
    )
    .limit(1);
  if (lock) query = query.for("update", { skipLocked: true }) as typeof query;
  const [work] = await query;
  return work ?? null;
}

async function markMemberSkipped(
  tx: SchedulerDatabase,
  memberId: string,
  reason: string,
  now: Date,
): Promise<void> {
  await tx
    .update(spotifySyncCampaignMembers)
    .set({ blockedReason: reason, status: "skipped", updatedAt: now })
    .where(eq(spotifySyncCampaignMembers.id, memberId));
}

async function hasSuccessfulCoverage(tx: SchedulerDatabase, artistId: string): Promise<boolean> {
  const [coverage, scan] = await Promise.all([
    tx.query.spotifyArtistCoverage.findFirst({
      where: and(
        eq(spotifyArtistCoverage.artistId, artistId),
        sql`${spotifyArtistCoverage.dailyScanCompletedAt} is not null`,
      ),
      columns: { artistId: true },
    }),
    tx.query.spotifyArtistScans.findFirst({
      where: and(
        eq(spotifyArtistScans.artistId, artistId),
        inArray(spotifyArtistScans.status, ["completed", "partial"]),
        sql`${spotifyArtistScans.finishedAt} is not null`,
      ),
      columns: { artistId: true },
    }),
  ]);
  return Boolean(coverage || scan);
}

function campaignStatusAfterBaseCompletion(
  campaign: typeof spotifySyncCampaigns.$inferSelect,
  successCount: number,
): SpotifySyncCampaignStatus {
  if (successCount >= campaign.targetSuccesses) return "base_target_reached";
  if (!campaign.canaryPassedAt && successCount >= campaign.canaryTarget) return "canary_review";
  return "running";
}

async function finalizeCampaignIfDrained(
  tx: SchedulerDatabase,
  campaignId: string,
  now: Date,
): Promise<void> {
  const campaign = await tx.query.spotifySyncCampaigns.findFirst({
    where: eq(spotifySyncCampaigns.id, campaignId),
  });
  if (!campaign || campaign.qualifyingSuccessCount !== campaign.targetSuccesses) return;
  const [backlog] = await tx
    .select({ count: count() })
    .from(spotifySchedulerWork)
    .where(
      and(
        eq(spotifySchedulerWork.campaignId, campaignId),
        inArray(spotifySchedulerWork.workType, ["release_detail", "release_tracks"]),
        inArray(spotifySchedulerWork.status, ["queued", "leased"]),
      ),
    );
  const complete = (backlog?.count ?? 0) === 0 && campaign.activeReservationCount === 0;
  await tx
    .update(spotifySyncCampaigns)
    .set({
      completedAt: complete ? now : null,
      leaseExpiresAt: null,
      leaseOwner: null,
      status: complete ? "completed" : "draining",
      stopReason: complete ? "target_and_campaign_work_completed" : "draining_campaign_work",
      updatedAt: now,
    })
    .where(eq(spotifySyncCampaigns.id, campaignId));
}

function toCampaignClaim(
  row: typeof spotifySchedulerWork.$inferSelect,
  campaignId: string,
): SpotifySyncCampaignClaim {
  return {
    artistId: row.artistId,
    attemptCount: row.attemptCount,
    campaignId,
    campaignMemberId: row.campaignMemberId,
    discoveryReconciliationCampaignId: null,
    dueAt: row.dueAt,
    expectedSpotifyArtistId: row.expectedSpotifyArtistId,
    id: row.id,
    leaseExpiresAt: row.leaseExpiresAt ?? new Date(0),
    leaseOwner: row.leaseOwner ?? "",
    releaseTrackRetrievalId: row.releaseTrackRetrievalId,
    source: row.source,
    spotifyAlbumId: row.spotifyAlbumId,
    workType: row.workType,
  };
}

function campaignConfiguration(value: unknown) {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    rolling24HourLimit: bounded(candidate.rolling24HourLimit, 593, 10_000, 1_200),
    rolling30MinuteLimit: bounded(candidate.rolling30MinuteLimit, 1, 1_000, 30),
  };
}

async function countRequests(tx: SchedulerDatabase, since: Date): Promise<number> {
  const [row] = await tx
    .select({ count: count() })
    .from(spotifyRequestEvents)
    .where(gt(spotifyRequestEvents.startedAt, since));
  return row?.count ?? 0;
}

function retryDelay(attempt: number): number {
  return attempt <= 1 ? 15 * 60_000 : attempt === 2 ? 60 * 60_000 : 6 * 60 * 60_000;
}

function validateCampaignTargets(target: number, canary: number, expiresAt: Date, now: Date): void {
  if (!Number.isInteger(target) || target <= 0)
    throw new Error("Campaign target must be positive.");
  if (!Number.isInteger(canary) || canary <= 0 || canary > target) {
    throw new Error("Campaign canary target must be positive and no greater than the target.");
  }
  if (expiresAt <= now) throw new Error("Campaign deadline must be in the future.");
}

function validateContinuationDeadline(expiresAt: Date, now: Date): void {
  if (expiresAt <= now) throw new Error("Campaign continuation deadline must be in the future.");
  if (expiresAt.getTime() - now.getTime() > spotifySchedulerWindowMs) {
    throw new Error("Campaign continuation deadline may be at most 24 hours.");
  }
}

function bounded(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}

function safeText(value: string): string {
  return value
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 200);
}
