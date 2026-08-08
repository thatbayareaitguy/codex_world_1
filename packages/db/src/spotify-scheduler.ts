import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RadarDatabase } from "./client";
import {
  artistExternalIds,
  artistFollows,
  releaseCandidates,
  spotifyArtistCoverage,
  spotifyCatalogReleases,
  discoveryScheduleState,
  spotifyArtistScans,
  spotifyProviderState,
  spotifyReleaseTrackRetrievals,
  spotifyRequestEvents,
  spotifySchedulerDailyArtists,
  spotifySchedulerState,
  spotifySchedulerWork,
} from "./schema";

export const spotifySchedulerStateId = "global";
export const spotifySchedulerWindowMs = 24 * 60 * 60_000;
export const spotifySchedulerLeaseMs = 120_000;

type SchedulerTransaction = Parameters<Parameters<RadarDatabase["transaction"]>[0]>[0];
export type SchedulerDatabase = RadarDatabase | SchedulerTransaction;

export type SpotifySchedulerMode = "disabled" | "planning" | "validation" | "automatic" | "paused";
export type SpotifySchedulerWorkType =
  "base_artist" | "release_detail" | "release_tracks" | "artist_reconciliation";
export type SpotifySchedulerWorkStatus =
  "queued" | "leased" | "blocked" | "completed" | "cancelled";

export interface SpotifySchedulerLimits {
  maxBroadArtistsPerLocalDay: number;
  maxBroadRequestsPerLocalDay: number;
  maxArtistsPerTick: 1;
  maxRequestsPerTick: number;
  maxRuntimeMs: number;
  minRequestIntervalMs: number;
  rolling24HourLimit: number;
  rolling30MinuteLimit: number;
  playlistRequestReserve: number;
  priorityRequestReserve: number;
  windowHours: 24;
}

export interface SpotifySchedulerClaim {
  artistId: string | null;
  attemptCount: number;
  campaignId: string | null;
  campaignMemberId: string | null;
  discoveryReconciliationCampaignId: string | null;
  dueAt: Date;
  expectedSpotifyArtistId: string | null;
  id: string;
  leaseExpiresAt: Date;
  leaseOwner: string;
  releaseTrackRetrievalId: string | null;
  source: "initial" | "recurring" | "validation" | "repair" | "apple_priority" | "apple_catchup";
  spotifyAlbumId: string | null;
  workType: SpotifySchedulerWorkType;
}

export interface SpotifySchedulerStatus {
  activeLease: {
    artistId: string | null;
    expiresAt: Date;
    workId: string;
    workType: SpotifySchedulerWorkType;
  } | null;
  artistsCheckedLast24Hours: number;
  artistsCheckedLastHour: number;
  applePriorityCount: number;
  appleCatchupPriorityCount: number;
  backlog: Record<SpotifySchedulerWorkType, number>;
  blockedCount: number;
  blockedReasons: string[];
  cooldownActive: boolean;
  cooldownUntil: Date | null;
  dailyBudget: {
    broadArtistsLimit: number;
    broadArtistsUsed: number;
    broadRequestsLimit: number;
    broadRequestsUsed: number;
    localDate: string;
    playlistRequestReserve: number;
    priorityRequestReserve: number;
  };
  dueArtistCount: number;
  eligibleArtistCount: number;
  estimatedCompletion: {
    earliest: Date | null;
    latest: Date | null;
    state: "available" | "blocked";
  };
  http429Last24Hours: number;
  mode: SpotifySchedulerMode;
  nextBaseSlotAt: Date | null;
  oldestOverdueAgeMs: number | null;
  overdueArtistCount: number;
  partialArtistCount: number;
  requestCounts: {
    last24Hours: number;
    last30Minutes: number;
    byWorkType: Partial<Record<SpotifySchedulerWorkType, number>>;
  };
  recentWork: {
    artistId: string | null;
    completedAt: Date;
    workId: string;
    workType: SpotifySchedulerWorkType;
  } | null;
  targetArtistCount: number;
}

export async function reconcileSpotifySchedulerWork(
  db: RadarDatabase,
  now = new Date(),
): Promise<SpotifySchedulerStatus> {
  await db
    .insert(spotifySchedulerState)
    .values({ id: spotifySchedulerStateId })
    .onConflictDoNothing();
  const eligible = await loadEligibleSpotifyArtists(db);

  await db.transaction(async (tx) => {
    for (const artist of eligible) {
      const dueAt = artist.lastSuccessfulAt
        ? new Date(artist.lastSuccessfulAt.getTime() + spotifySchedulerWindowMs)
        : now;
      await tx
        .insert(spotifySchedulerWork)
        .values({
          artistId: artist.artistId,
          dueAt,
          expectedSpotifyArtistId: artist.spotifyArtistId,
          priority: artist.lastSuccessfulAt ? 10 : 0,
          source: artist.lastSuccessfulAt ? "recurring" : "initial",
          status: "queued",
          workKey: `base_artist:${artist.artistId}`,
          workType: "base_artist",
        })
        .onConflictDoUpdate({
          target: spotifySchedulerWork.workKey,
          set: {
            blockedReason: null,
            expectedSpotifyArtistId: artist.spotifyArtistId,
            source: artist.lastSuccessfulAt ? "recurring" : "initial",
            status: sql`case when ${spotifySchedulerWork.status} in ('blocked', 'cancelled') then 'queued'::spotify_scheduler_work_status else ${spotifySchedulerWork.status} end`,
            updatedAt: now,
          },
        });
    }

    const eligibleIds = eligible.map((artist) => artist.artistId);
    await tx
      .update(spotifySchedulerWork)
      .set({
        blockedReason: "artist_not_eligible",
        leaseExpiresAt: null,
        leaseOwner: null,
        status: "blocked",
        updatedAt: now,
      })
      .where(
        and(
          eq(spotifySchedulerWork.workType, "base_artist"),
          eligibleIds.length > 0
            ? notInArray(spotifySchedulerWork.artistId, eligibleIds)
            : sql`true`,
          sql`${spotifySchedulerWork.status} <> 'leased'`,
        ),
      );

    const partialCoverage = await tx
      .select({
        artistId: spotifyArtistCoverage.artistId,
        cycleId: spotifyArtistCoverage.reconciliationCycleId,
        spotifyArtistId: artistExternalIds.externalId,
        updatedAt: spotifyArtistCoverage.updatedAt,
      })
      .from(spotifyArtistCoverage)
      .innerJoin(artistFollows, eq(artistFollows.artistId, spotifyArtistCoverage.artistId))
      .innerJoin(
        artistExternalIds,
        and(
          eq(artistExternalIds.artistId, spotifyArtistCoverage.artistId),
          eq(artistExternalIds.provider, "spotify"),
          eq(artistExternalIds.confirmed, true),
        ),
      )
      .where(and(eq(artistFollows.active, true), eq(spotifyArtistCoverage.partial, true)));
    for (const coverage of partialCoverage) {
      await tx
        .insert(spotifySchedulerWork)
        .values({
          artistId: coverage.artistId,
          dueAt: coverage.updatedAt,
          expectedSpotifyArtistId: coverage.spotifyArtistId,
          priority: 400,
          reconciliationCycleId: coverage.cycleId,
          source: "recurring",
          workKey: `artist_reconciliation:${coverage.artistId}`,
          workType: "artist_reconciliation",
        })
        .onConflictDoNothing();
    }

    const recentCutoff = new Date(now.getTime() - 60 * 86_400_000).toISOString().slice(0, 10);
    const [catalogWithoutDetails, candidateReleases] = await Promise.all([
      tx
        .select({
          artistId: spotifyCatalogReleases.artistId,
          externalReleaseId: spotifyCatalogReleases.externalReleaseId,
          lastObservedAt: spotifyCatalogReleases.lastObservedAt,
        })
        .from(spotifyCatalogReleases)
        .where(
          and(
            isNull(spotifyCatalogReleases.detailsFetchedAt),
            sql`${spotifyCatalogReleases.releaseDate} >= ${recentCutoff}`,
          ),
        ),
      tx
        .select({ externalReleaseId: releaseCandidates.providerReleaseId })
        .from(releaseCandidates)
        .where(eq(releaseCandidates.provider, "spotify")),
    ]);
    const releasesWithCandidates = new Set(
      candidateReleases.map((candidate) => candidate.externalReleaseId),
    );
    for (const release of catalogWithoutDetails) {
      if (releasesWithCandidates.has(release.externalReleaseId)) continue;
      await insertSpotifyReleaseDetailWork(tx, {
        artistId: release.artistId,
        dueAt: release.lastObservedAt,
        spotifyAlbumId: release.externalReleaseId,
      });
    }

    const incompleteReleases = await tx
      .select()
      .from(spotifyReleaseTrackRetrievals)
      .where(sql`${spotifyReleaseTrackRetrievals.status} <> 'completed'`);
    for (const retrieval of incompleteReleases) {
      await tx
        .insert(spotifySchedulerWork)
        .values({
          dueAt: retrieval.retryEligibleAt ?? retrieval.updatedAt,
          priority: 20,
          releaseTrackRetrievalId: retrieval.id,
          source: "repair",
          spotifyAlbumId: retrieval.spotifyAlbumId,
          workKey: `release_tracks:${retrieval.id}`,
          workType: "release_tracks",
        })
        .onConflictDoNothing();
    }

    await tx
      .update(spotifySchedulerState)
      .set({
        cycleTargetArtists: eligible.length,
        effectiveConfiguration: defaultSchedulerLimits(),
        updatedAt: now,
      })
      .where(eq(spotifySchedulerState.id, spotifySchedulerStateId));
  });
  return getSpotifySchedulerStatus(db, now);
}

export async function queueSpotifyReleaseDetailWork(
  db: RadarDatabase,
  input: {
    artistId: string;
    campaignId?: string | null;
    campaignMemberId?: string | null;
    discoveryReconciliationCampaignId?: string | null;
    dueAt?: Date;
    spotifyAlbumId: string;
    source?: "initial" | "recurring" | "validation" | "repair" | "apple_priority" | "apple_catchup";
  },
): Promise<void> {
  await insertSpotifyReleaseDetailWork(db, {
    ...input,
    dueAt: input.dueAt ?? new Date(),
  });
}

export async function markSpotifyReleaseDetailsFetched(
  db: RadarDatabase,
  input: { artistId: string; fetchedAt?: Date; spotifyAlbumId: string },
): Promise<void> {
  await db
    .update(spotifyCatalogReleases)
    .set({
      detailsFetchedAt: input.fetchedAt ?? new Date(),
      updatedAt: input.fetchedAt ?? new Date(),
    })
    .where(
      and(
        eq(spotifyCatalogReleases.artistId, input.artistId),
        eq(spotifyCatalogReleases.externalReleaseId, input.spotifyAlbumId),
      ),
    );
}

async function insertSpotifyReleaseDetailWork(
  db: SchedulerDatabase,
  input: {
    artistId: string;
    campaignId?: string | null;
    campaignMemberId?: string | null;
    discoveryReconciliationCampaignId?: string | null;
    dueAt: Date;
    spotifyAlbumId: string;
    source?: "initial" | "recurring" | "validation" | "repair" | "apple_priority" | "apple_catchup";
  },
): Promise<void> {
  await db
    .insert(spotifySchedulerWork)
    .values({
      artistId: input.artistId,
      campaignId: input.campaignId ?? null,
      campaignMemberId: input.campaignMemberId ?? null,
      discoveryReconciliationCampaignId: input.discoveryReconciliationCampaignId ?? null,
      dueAt: input.dueAt,
      priority: 30,
      source: input.source ?? "recurring",
      spotifyAlbumId: input.spotifyAlbumId,
      workKey: `release_detail:${input.artistId}:${input.spotifyAlbumId}`,
      workType: "release_detail",
    })
    .onConflictDoNothing();
}

export async function queueSpotifyReleaseTrackWork(
  db: RadarDatabase,
  input: {
    discoveryReconciliationCampaignId?: string | null;
    dueAt?: Date;
    releaseTrackRetrievalId: string;
    source?: "initial" | "recurring" | "validation" | "repair" | "apple_priority" | "apple_catchup";
    spotifyAlbumId: string;
  },
): Promise<void> {
  await db
    .insert(spotifySchedulerWork)
    .values({
      discoveryReconciliationCampaignId: input.discoveryReconciliationCampaignId ?? null,
      dueAt: input.dueAt ?? new Date(),
      priority: 20,
      releaseTrackRetrievalId: input.releaseTrackRetrievalId,
      source: input.source ?? "repair",
      spotifyAlbumId: input.spotifyAlbumId,
      workKey: `release_tracks:${input.releaseTrackRetrievalId}`,
      workType: "release_tracks",
    })
    .onConflictDoNothing();
}

export async function planSpotifySchedulerTick(
  db: RadarDatabase,
  now = new Date(),
): Promise<{ selected: SpotifySchedulerClaim | null; status: SpotifySchedulerStatus }> {
  const status = await getSpotifySchedulerStatus(db, now);
  const selected = await selectSpotifySchedulerCandidate(db, now, false);
  return { selected, status };
}

export async function claimSpotifySchedulerWork(
  db: RadarDatabase,
  now = new Date(),
  leaseMs = spotifySchedulerLeaseMs,
): Promise<SpotifySchedulerClaim | null> {
  if (!Number.isInteger(leaseMs) || leaseMs < 90_000) {
    throw new Error("Spotify scheduler lease must cover the 90-second tick runtime.");
  }
  return db.transaction(async (tx) => {
    await tx
      .update(spotifySchedulerWork)
      .set({ leaseExpiresAt: null, leaseOwner: null, status: "queued", updatedAt: now })
      .where(
        and(
          eq(spotifySchedulerWork.status, "leased"),
          lte(spotifySchedulerWork.leaseExpiresAt, now),
        ),
      );
    const state = await tx.query.spotifySchedulerState.findFirst({
      where: eq(spotifySchedulerState.id, spotifySchedulerStateId),
    });
    if (!state || !["validation", "automatic"].includes(state.mode)) return null;
    const provider = await tx.query.spotifyProviderState.findFirst({
      where: eq(spotifyProviderState.id, "global"),
    });
    if (
      provider?.cooldownIndefinite ||
      (provider?.cooldownUntil && provider.cooldownUntil > now) ||
      (provider?.leaseExpiresAt && provider.leaseExpiresAt > now)
    ) {
      return null;
    }
    const limits = schedulerLimits(state.effectiveConfiguration);
    const [rolling30, rolling24] = await Promise.all([
      countSpotifyRequests(tx, new Date(now.getTime() - 30 * 60_000)),
      countSpotifyRequests(tx, new Date(now.getTime() - spotifySchedulerWindowMs)),
    ]);
    if (rolling30 >= limits.rolling30MinuteLimit || rolling24 >= limits.rolling24HourLimit) {
      return null;
    }

    await resumeDiscoveryScheduleAfterCooldown(tx, now);
    await advanceDiscoverySchedulePhaseIfDrained(tx, now);
    const candidate = await selectSpotifySchedulerCandidate(tx, now, true, state.mode);
    if (!candidate) return null;
    const localDay = spotifySchedulerLocalDayWindow(now);
    if (isBroadSpotifyWork(candidate.source)) {
      if (!isBroadSpotifyDay(localDay.weekday)) return null;
      const [broadRequests, broadArtists] = await Promise.all([
        countBroadSpotifyRequests(tx, localDay.start, localDay.end),
        countBroadSpotifyArtists(tx, localDay.localDate),
      ]);
      if (
        broadRequests + limits.maxRequestsPerTick > limits.maxBroadRequestsPerLocalDay ||
        rolling24 + limits.maxRequestsPerTick >
          limits.rolling24HourLimit - limits.priorityRequestReserve - limits.playlistRequestReserve
      ) {
        return null;
      }
      if (
        candidate.workType === "base_artist" &&
        candidate.artistId &&
        broadArtists >= limits.maxBroadArtistsPerLocalDay &&
        !(await hasBroadArtistStarted(tx, localDay.localDate, candidate.artistId))
      ) {
        await tx
          .update(spotifySchedulerState)
          .set({ nextBaseSlotAt: localDay.end, updatedAt: now })
          .where(eq(spotifySchedulerState.id, spotifySchedulerStateId));
        return null;
      }
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
        and(eq(spotifySchedulerWork.id, candidate.id), eq(spotifySchedulerWork.status, "queued")),
      )
      .returning();
    if (!claimed) return null;
    if (
      claimed.workType === "base_artist" &&
      claimed.artistId &&
      isBroadSpotifyWork(claimed.source)
    ) {
      await tx
        .insert(spotifySchedulerDailyArtists)
        .values({
          artistId: claimed.artistId,
          localDate: localDay.localDate,
          schedulerWorkId: claimed.id,
          startedAt: now,
        })
        .onConflictDoNothing();
    }
    if (claimed.workType === "base_artist") {
      const target = Math.max(1, state.cycleTargetArtists);
      const slotMs = spotifySchedulerWindowMs / target;
      const previousSlot = state.nextBaseSlotAt;
      const slotAnchor =
        previousSlot && previousSlot.getTime() + slotMs > now.getTime() ? previousSlot : now;
      await tx
        .update(spotifySchedulerState)
        .set({
          nextBaseSlotAt: new Date(slotAnchor.getTime() + slotMs),
          updatedAt: now,
        })
        .where(eq(spotifySchedulerState.id, spotifySchedulerStateId));
    }
    return toClaim(claimed);
  });
}

export async function finishSpotifySchedulerWork(
  db: RadarDatabase,
  claim: SpotifySchedulerClaim,
  outcome:
    | { status: "completed" }
    | { status: "retry"; errorClassification: string }
    | { status: "blocked"; reason: string }
    | { status: "cancelled" },
  now = new Date(),
): Promise<boolean> {
  const retryDelayMs = retryDelay(claim.attemptCount);
  const nextStatus: SpotifySchedulerWorkStatus =
    outcome.status === "retry" ? "queued" : outcome.status;
  const rows = await db
    .update(spotifySchedulerWork)
    .set({
      blockedReason: outcome.status === "blocked" ? outcome.reason.slice(0, 100) : null,
      lastCompletedAt: outcome.status === "completed" ? now : null,
      lastErrorClassification:
        outcome.status === "retry" ? outcome.errorClassification.slice(0, 100) : null,
      leaseExpiresAt: null,
      leaseOwner: null,
      notBefore: outcome.status === "retry" ? new Date(now.getTime() + retryDelayMs) : null,
      ...(outcome.status === "completed" && claim.workType === "base_artist"
        ? {
            discoveryReconciliationCampaignId: null,
            dueAt: new Date(now.getTime() + spotifySchedulerWindowMs),
            status: "queued" as const,
          }
        : { status: nextStatus }),
      updatedAt: now,
    })
    .where(
      and(
        eq(spotifySchedulerWork.id, claim.id),
        eq(spotifySchedulerWork.status, "leased"),
        eq(spotifySchedulerWork.leaseOwner, claim.leaseOwner),
      ),
    )
    .returning({ id: spotifySchedulerWork.id });
  return rows.length === 1;
}

export async function renewSpotifySchedulerLease(
  db: RadarDatabase,
  claim: SpotifySchedulerClaim,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(spotifySchedulerWork)
    .set({ leaseExpiresAt: new Date(now.getTime() + spotifySchedulerLeaseMs), updatedAt: now })
    .where(
      and(
        eq(spotifySchedulerWork.id, claim.id),
        eq(spotifySchedulerWork.status, "leased"),
        eq(spotifySchedulerWork.leaseOwner, claim.leaseOwner),
      ),
    )
    .returning({ id: spotifySchedulerWork.id });
  return rows.length === 1;
}

export async function setSpotifySchedulerMode(
  db: RadarDatabase,
  mode: SpotifySchedulerMode,
  now = new Date(),
): Promise<void> {
  await db
    .update(spotifySchedulerState)
    .set({ mode, updatedAt: now })
    .where(eq(spotifySchedulerState.id, spotifySchedulerStateId));
}

export async function recordSpotifySchedulerTick(
  db: RadarDatabase,
  input: { completedAt?: Date; errorClassification?: string; startedAt?: Date },
): Promise<void> {
  await db
    .update(spotifySchedulerState)
    .set({
      ...(input.startedAt ? { lastTickStartedAt: input.startedAt } : {}),
      ...(input.completedAt ? { lastTickCompletedAt: input.completedAt } : {}),
      lastTickErrorClassification: input.errorClassification?.slice(0, 100) ?? null,
      updatedAt: input.completedAt ?? input.startedAt ?? new Date(),
    })
    .where(eq(spotifySchedulerState.id, spotifySchedulerStateId));
}

export async function getSpotifySchedulerStatus(
  db: RadarDatabase,
  now = new Date(),
): Promise<SpotifySchedulerStatus> {
  const state = await db.query.spotifySchedulerState.findFirst({
    where: eq(spotifySchedulerState.id, spotifySchedulerStateId),
  });
  const limits = schedulerLimits(state?.effectiveConfiguration);
  const localDay = spotifySchedulerLocalDayWindow(now);
  const provider = await db.query.spotifyProviderState.findFirst({
    where: eq(spotifyProviderState.id, "global"),
  });
  const eligible = await loadEligibleSpotifyArtists(db);
  const work = await db.select().from(spotifySchedulerWork);
  const requests = await db
    .select({
      startedAt: spotifyRequestEvents.startedAt,
      status: spotifyRequestEvents.status,
      workType: spotifyRequestEvents.schedulerWorkType,
    })
    .from(spotifyRequestEvents)
    .where(gt(spotifyRequestEvents.startedAt, new Date(now.getTime() - spotifySchedulerWindowMs)));
  const [broadArtistsUsed, broadRequestsUsed] = await Promise.all([
    countBroadSpotifyArtists(db, localDay.localDate),
    countBroadSpotifyRequests(db, localDay.start, localDay.end),
  ]);
  const last30 = requests.filter(
    (request) => request.startedAt > new Date(now.getTime() - 30 * 60_000),
  );
  const completedLast24 = eligible.filter(
    (artist) =>
      artist.lastSuccessfulAt &&
      artist.lastSuccessfulAt > new Date(now.getTime() - spotifySchedulerWindowMs),
  );
  const completedLastHour = completedLast24.filter(
    (artist) => artist.lastSuccessfulAt! > new Date(now.getTime() - 60 * 60_000),
  );
  const baseWork = work.filter((item) => item.workType === "base_artist");
  const dueBase = baseWork.filter(
    (item) =>
      item.status === "queued" && item.dueAt <= now && (!item.notBefore || item.notBefore <= now),
  );
  const oldestDue = dueBase.reduce<Date | null>(
    (oldest, item) => (!oldest || item.dueAt < oldest ? item.dueAt : oldest),
    null,
  );
  const activeLease = work.find(
    (item) => item.status === "leased" && item.leaseExpiresAt && item.leaseExpiresAt > now,
  );
  const recentWork = work
    .filter((item) => item.lastCompletedAt !== null)
    .sort((left, right) => right.lastCompletedAt!.getTime() - left.lastCompletedAt!.getTime())[0];
  const cooldownActive = Boolean(
    provider?.cooldownIndefinite || (provider?.cooldownUntil && provider.cooldownUntil > now),
  );
  const queuedCount = work.filter((item) => item.status === "queued").length;
  const slotMs = spotifySchedulerWindowMs / Math.max(1, eligible.length);
  const earliest = cooldownActive
    ? (provider?.cooldownUntil ?? null)
    : new Date(now.getTime() + dueBase.length * slotMs);
  const latest = earliest
    ? new Date(earliest.getTime() + Math.max(queuedCount, dueBase.length) * slotMs)
    : null;
  const byWorkType: Partial<Record<SpotifySchedulerWorkType, number>> = {};
  for (const request of requests) {
    if (request.workType) byWorkType[request.workType] = (byWorkType[request.workType] ?? 0) + 1;
  }
  return {
    activeLease: activeLease?.leaseExpiresAt
      ? {
          artistId: activeLease.artistId,
          expiresAt: activeLease.leaseExpiresAt,
          workId: activeLease.id,
          workType: activeLease.workType,
        }
      : null,
    artistsCheckedLast24Hours: completedLast24.length,
    artistsCheckedLastHour: completedLastHour.length,
    applePriorityCount: work.filter(
      (item) => item.source === "apple_priority" && ["queued", "leased"].includes(item.status),
    ).length,
    appleCatchupPriorityCount: work.filter(
      (item) => item.source === "apple_catchup" && ["queued", "leased"].includes(item.status),
    ).length,
    backlog: {
      artist_reconciliation: work.filter(
        (item) => item.workType === "artist_reconciliation" && item.status === "queued",
      ).length,
      base_artist: baseWork.filter((item) => item.status === "queued").length,
      release_detail: work.filter(
        (item) => item.workType === "release_detail" && item.status === "queued",
      ).length,
      release_tracks: work.filter(
        (item) => item.workType === "release_tracks" && item.status === "queued",
      ).length,
    },
    blockedCount: work.filter((item) => item.status === "blocked").length,
    blockedReasons: [
      ...new Set(
        work
          .filter((item) => item.status === "blocked" && item.blockedReason)
          .map((item) => item.blockedReason!),
      ),
    ].sort(),
    cooldownActive,
    cooldownUntil: provider?.cooldownUntil ?? null,
    dailyBudget: {
      broadArtistsLimit: limits.maxBroadArtistsPerLocalDay,
      broadArtistsUsed,
      broadRequestsLimit: limits.maxBroadRequestsPerLocalDay,
      broadRequestsUsed,
      localDate: localDay.localDate,
      playlistRequestReserve: limits.playlistRequestReserve,
      priorityRequestReserve: limits.priorityRequestReserve,
    },
    dueArtistCount: dueBase.length,
    eligibleArtistCount: eligible.length,
    estimatedCompletion: {
      earliest,
      latest,
      state: cooldownActive && !provider?.cooldownUntil ? "blocked" : "available",
    },
    http429Last24Hours: requests.filter((request) => request.status === 429).length,
    mode: state?.mode ?? "disabled",
    nextBaseSlotAt: state?.nextBaseSlotAt ?? null,
    oldestOverdueAgeMs: oldestDue ? Math.max(0, now.getTime() - oldestDue.getTime()) : null,
    overdueArtistCount: dueBase.filter((item) => now.getTime() - item.dueAt.getTime() > slotMs)
      .length,
    partialArtistCount: work.filter(
      (item) =>
        item.workType === "artist_reconciliation" &&
        item.status !== "completed" &&
        item.status !== "cancelled",
    ).length,
    requestCounts: { byWorkType, last24Hours: requests.length, last30Minutes: last30.length },
    recentWork: recentWork?.lastCompletedAt
      ? {
          artistId: recentWork.artistId,
          completedAt: recentWork.lastCompletedAt,
          workId: recentWork.id,
          workType: recentWork.workType,
        }
      : null,
    targetArtistCount: state?.cycleTargetArtists ?? eligible.length,
  };
}

async function selectSpotifySchedulerCandidate(
  db: SchedulerDatabase,
  now: Date,
  lock: boolean,
  mode?: SpotifySchedulerMode,
): Promise<SpotifySchedulerClaim | null> {
  const state = await db.query.spotifySchedulerState.findFirst({
    where: eq(spotifySchedulerState.id, spotifySchedulerStateId),
  });
  const discoveryState = await db.query.discoveryScheduleState.findFirst({
    where: eq(discoveryScheduleState.id, "global"),
  });
  if (
    discoveryState &&
    ["cooldown_wait", "playlist_inbox", "weekly_apple"].includes(discoveryState.phase)
  ) {
    return null;
  }
  const baseSlotOpen = !state?.nextBaseSlotAt || state.nextBaseSlotAt <= now;
  const broadDay = isBroadSpotifyDay(spotifySchedulerLocalDayWindow(now).weekday);
  const conditions = [
    eq(spotifySchedulerWork.status, "queued"),
    lte(spotifySchedulerWork.dueAt, now),
    or(isNull(spotifySchedulerWork.notBefore), lte(spotifySchedulerWork.notBefore, now)),
    mode === "validation" ? eq(spotifySchedulerWork.source, "validation") : undefined,
    broadDay
      ? undefined
      : inArray(spotifySchedulerWork.source, ["apple_priority", "apple_catchup", "validation"]),
    discoveryState?.phase === "apple_priority"
      ? eq(spotifySchedulerWork.source, "apple_priority")
      : discoveryState?.phase === "apple_catchup_priority"
        ? eq(spotifySchedulerWork.source, "apple_catchup")
        : discoveryState?.phase === "broad_spotify"
          ? notInArray(spotifySchedulerWork.source, ["apple_priority", "apple_catchup"])
          : undefined,
    baseSlotOpen ? undefined : sql`${spotifySchedulerWork.workType} <> 'base_artist'`,
  ].filter((condition) => condition !== undefined);
  let query = db
    .select()
    .from(spotifySchedulerWork)
    .where(and(...conditions))
    .orderBy(
      asc(
        sql`case
          when ${spotifySchedulerWork.source} = 'apple_priority' and ${spotifySchedulerWork.workType} = 'release_tracks' then 0
          when ${spotifySchedulerWork.source} = 'apple_priority' and ${spotifySchedulerWork.workType} = 'release_detail' then 1
          when ${spotifySchedulerWork.source} = 'apple_priority' then 2
          when ${spotifySchedulerWork.source} = 'apple_catchup' and ${spotifySchedulerWork.workType} = 'release_tracks' then 3
          when ${spotifySchedulerWork.source} = 'apple_catchup' and ${spotifySchedulerWork.workType} = 'release_detail' then 4
          when ${spotifySchedulerWork.source} = 'apple_catchup' then 5
          when ${spotifySchedulerWork.source} = 'initial' and ${spotifySchedulerWork.workType} = 'base_artist' and ${baseSlotOpen} then 6
          when ${spotifySchedulerWork.source} = 'recurring' and ${spotifySchedulerWork.workType} = 'base_artist' and ${baseSlotOpen} then 7
          when ${spotifySchedulerWork.workType} = 'release_tracks' and ${spotifySchedulerWork.source} <> 'repair' then 8
          when ${spotifySchedulerWork.workType} = 'release_detail' and ${spotifySchedulerWork.source} <> 'repair' then 9
          when ${spotifySchedulerWork.workType} = 'base_artist' then 10
          else 11 end`,
      ),
      asc(spotifySchedulerWork.dueAt),
      asc(spotifySchedulerWork.priority),
      asc(spotifySchedulerWork.artistId),
      asc(spotifySchedulerWork.id),
    )
    .limit(1);
  if (lock) query = query.for("update", { skipLocked: true }) as typeof query;
  const [row] = await query;
  if (!row) return null;
  return toClaim({
    ...row,
    leaseExpiresAt: row.leaseExpiresAt ?? new Date(0),
    leaseOwner: row.leaseOwner ?? "",
  });
}

export async function loadEligibleSpotifyArtists(db: SchedulerDatabase) {
  const rows = await db
    .select({
      artistId: artistFollows.artistId,
      coverageCompletedAt: spotifyArtistCoverage.dailyScanCompletedAt,
      followedAt: artistFollows.followedAt,
      spotifyArtistId: artistExternalIds.externalId,
    })
    .from(artistFollows)
    .innerJoin(
      artistExternalIds,
      and(
        eq(artistExternalIds.artistId, artistFollows.artistId),
        eq(artistExternalIds.provider, "spotify"),
        eq(artistExternalIds.confirmed, true),
      ),
    )
    .leftJoin(spotifyArtistCoverage, eq(spotifyArtistCoverage.artistId, artistFollows.artistId))
    .where(eq(artistFollows.active, true))
    .orderBy(asc(artistFollows.followedAt), asc(artistFollows.artistId));
  const successful = await db
    .select({ artistId: spotifyArtistScans.artistId, finishedAt: spotifyArtistScans.finishedAt })
    .from(spotifyArtistScans)
    .where(inArray(spotifyArtistScans.status, ["completed", "partial"]))
    .orderBy(asc(spotifyArtistScans.artistId), asc(spotifyArtistScans.finishedAt));
  const latest = new Map<string, Date>();
  for (const item of successful) if (item.finishedAt) latest.set(item.artistId, item.finishedAt);
  return rows.map((row) => ({
    artistId: row.artistId,
    followedAt: row.followedAt,
    lastSuccessfulAt: row.coverageCompletedAt ?? latest.get(row.artistId) ?? null,
    spotifyArtistId: row.spotifyArtistId,
  }));
}

async function countSpotifyRequests(db: SchedulerDatabase, since: Date): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(spotifyRequestEvents)
    .where(gt(spotifyRequestEvents.startedAt, since));
  return rows[0]?.count ?? 0;
}

async function countBroadSpotifyRequests(
  db: SchedulerDatabase,
  start: Date,
  end: Date,
): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(spotifyRequestEvents)
    .innerJoin(
      spotifySchedulerWork,
      eq(spotifySchedulerWork.id, spotifyRequestEvents.schedulerWorkId),
    )
    .where(
      and(
        gte(spotifyRequestEvents.startedAt, start),
        lt(spotifyRequestEvents.startedAt, end),
        inArray(spotifySchedulerWork.source, ["initial", "recurring", "repair"]),
      ),
    );
  return rows[0]?.count ?? 0;
}

async function countBroadSpotifyArtists(db: SchedulerDatabase, localDate: string): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(spotifySchedulerDailyArtists)
    .where(eq(spotifySchedulerDailyArtists.localDate, localDate));
  return rows[0]?.count ?? 0;
}

async function hasBroadArtistStarted(
  db: SchedulerDatabase,
  localDate: string,
  artistId: string,
): Promise<boolean> {
  const rows = await db
    .select({ artistId: spotifySchedulerDailyArtists.artistId })
    .from(spotifySchedulerDailyArtists)
    .where(
      and(
        eq(spotifySchedulerDailyArtists.localDate, localDate),
        eq(spotifySchedulerDailyArtists.artistId, artistId),
      ),
    )
    .limit(1);
  return rows.length === 1;
}

function isBroadSpotifyWork(source: SpotifySchedulerClaim["source"]): boolean {
  return ["initial", "recurring", "repair"].includes(source);
}

function isBroadSpotifyDay(weekday: number): boolean {
  return weekday !== 4 && weekday !== 5;
}

function spotifySchedulerLocalDayWindow(now: Date) {
  const parts = zonedDateParts(now, "America/Los_Angeles");
  const startLocal = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const endLocal = new Date(startLocal);
  endLocal.setUTCDate(endLocal.getUTCDate() + 1);
  return {
    end: localTimeToUtc(endLocal, "America/Los_Angeles"),
    localDate: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    start: localTimeToUtc(startLocal, "America/Los_Angeles"),
    weekday: parts.weekday,
  };
}

function zonedDateParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
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

function toClaim(row: typeof spotifySchedulerWork.$inferSelect): SpotifySchedulerClaim {
  if (!row.leaseExpiresAt) throw new Error("Scheduler claim is missing a lease expiration.");
  return {
    artistId: row.artistId,
    attemptCount: row.attemptCount,
    campaignId: row.campaignId,
    campaignMemberId: row.campaignMemberId,
    discoveryReconciliationCampaignId: row.discoveryReconciliationCampaignId,
    dueAt: row.dueAt,
    expectedSpotifyArtistId: row.expectedSpotifyArtistId,
    id: row.id,
    leaseExpiresAt: row.leaseExpiresAt,
    leaseOwner: row.leaseOwner ?? "",
    releaseTrackRetrievalId: row.releaseTrackRetrievalId,
    source: row.source,
    spotifyAlbumId: row.spotifyAlbumId,
    workType: row.workType,
  };
}

async function advanceDiscoverySchedulePhaseIfDrained(
  db: SchedulerDatabase,
  now: Date,
): Promise<void> {
  const state = await db.query.discoveryScheduleState.findFirst({
    where: eq(discoveryScheduleState.id, "global"),
  });
  if (!state || !["apple_priority", "apple_catchup_priority"].includes(state.phase)) return;
  const activeSource =
    state.phase === "apple_catchup_priority" ? "apple_catchup" : "apple_priority";
  const active = await db
    .select({ count: count() })
    .from(spotifySchedulerWork)
    .where(
      and(
        eq(spotifySchedulerWork.source, activeSource),
        inArray(spotifySchedulerWork.status, ["queued", "leased"]),
      ),
    );
  const activeCount = active[0]?.count ?? 0;
  if (activeCount > 0) {
    await db
      .update(discoveryScheduleState)
      .set({ applePriorityQueuedCount: activeCount, updatedAt: now })
      .where(eq(discoveryScheduleState.id, "global"));
    return;
  }
  const remaining = await db
    .select({ count: count() })
    .from(spotifySchedulerWork)
    .where(
      and(
        inArray(spotifySchedulerWork.source, ["apple_priority", "apple_catchup"]),
        inArray(spotifySchedulerWork.status, ["queued", "leased"]),
      ),
    );
  await db
    .update(discoveryScheduleState)
    .set({
      applePriorityQueuedCount: remaining[0]?.count ?? 0,
      phase: "playlist_inbox",
      playlistInboxStatus: "ready",
      updatedAt: now,
    })
    .where(eq(discoveryScheduleState.id, "global"));
}

async function resumeDiscoveryScheduleAfterCooldown(
  db: SchedulerDatabase,
  now: Date,
): Promise<void> {
  const state = await db.query.discoveryScheduleState.findFirst({
    where: eq(discoveryScheduleState.id, "global"),
  });
  if (state?.phase !== "cooldown_wait") return;
  const [fullPriority, catchupPriority] = await Promise.all([
    countActivePrioritySource(db, "apple_priority"),
    countActivePrioritySource(db, "apple_catchup"),
  ]);
  const playlistPending = ["ready", "exporting", "partial", "failed"].includes(
    state.playlistInboxStatus,
  );
  const phase = playlistPending
    ? "playlist_inbox"
    : fullPriority > 0
      ? "apple_priority"
      : catchupPriority > 0
        ? "apple_catchup_priority"
        : "broad_spotify";
  await db
    .update(discoveryScheduleState)
    .set({
      applePriorityQueuedCount: fullPriority + catchupPriority,
      phase,
      updatedAt: now,
    })
    .where(eq(discoveryScheduleState.id, "global"));
}

async function countActivePrioritySource(
  db: SchedulerDatabase,
  source: "apple_priority" | "apple_catchup",
): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(spotifySchedulerWork)
    .where(
      and(
        eq(spotifySchedulerWork.source, source),
        inArray(spotifySchedulerWork.status, ["queued", "leased"]),
      ),
    );
  return rows[0]?.count ?? 0;
}

function retryDelay(attemptCount: number): number {
  if (attemptCount <= 1) return 15 * 60_000;
  if (attemptCount === 2) return 60 * 60_000;
  return 6 * 60 * 60_000;
}

export function defaultSchedulerLimits(): SpotifySchedulerLimits {
  return {
    maxBroadArtistsPerLocalDay: 75,
    maxBroadRequestsPerLocalDay: 300,
    maxArtistsPerTick: 1,
    maxRequestsPerTick: 6,
    maxRuntimeMs: 90_000,
    minRequestIntervalMs: 10_000,
    rolling24HourLimit: 1_200,
    rolling30MinuteLimit: 30,
    playlistRequestReserve: 20,
    priorityRequestReserve: 200,
    windowHours: 24,
  };
}

export function staggerSpotifyArtistsAcrossWindow<T extends { artistId: string; followedAt: Date }>(
  artistsToSchedule: T[],
  now: Date,
): Array<T & { dueAt: Date }> {
  const ordered = [...artistsToSchedule].sort(
    (left, right) =>
      left.followedAt.getTime() - right.followedAt.getTime() ||
      left.artistId.localeCompare(right.artistId),
  );
  return ordered.map((artist, index) => ({
    ...artist,
    dueAt: new Date(
      now.getTime() + (index * spotifySchedulerWindowMs) / Math.max(1, ordered.length),
    ),
  }));
}

function schedulerLimits(value: unknown): SpotifySchedulerLimits {
  if (!value || typeof value !== "object") return defaultSchedulerLimits();
  const limits = value as Partial<SpotifySchedulerLimits>;
  return {
    maxBroadArtistsPerLocalDay: boundedInteger(limits.maxBroadArtistsPerLocalDay, 1, 75, 75),
    maxBroadRequestsPerLocalDay: boundedInteger(limits.maxBroadRequestsPerLocalDay, 1, 1_000, 300),
    maxArtistsPerTick: 1,
    maxRequestsPerTick: boundedInteger(limits.maxRequestsPerTick, 1, 6, 6),
    maxRuntimeMs: boundedInteger(limits.maxRuntimeMs, 10_000, 90_000, 90_000),
    minRequestIntervalMs: boundedInteger(limits.minRequestIntervalMs, 10_000, 300_000, 10_000),
    rolling24HourLimit: boundedInteger(limits.rolling24HourLimit, 593, 10_000, 1_200),
    rolling30MinuteLimit: boundedInteger(limits.rolling30MinuteLimit, 1, 1_000, 30),
    playlistRequestReserve: boundedInteger(limits.playlistRequestReserve, 1, 100, 20),
    priorityRequestReserve: boundedInteger(limits.priorityRequestReserve, 1, 1_000, 200),
    windowHours: 24,
  };
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : fallback;
}
