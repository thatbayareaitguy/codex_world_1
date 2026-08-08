import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { reconcileSpotifySchedulerWork } from "./spotify-scheduler";
import {
  discoveryReconciliationArtists,
  discoveryReconciliationCampaigns,
  discoveryScheduleState,
  releaseProviderReconciliations,
  spotifyProviderState,
  spotifySchedulerState,
  spotifySchedulerWork,
} from "./schema";

export const discoveryScheduleStateId = "global";
export const discoveryScheduleTimezone = "America/Los_Angeles";

export type DiscoverySchedulePhase =
  "idle" | "cooldown_wait" | "playlist_inbox" | "apple_priority" | "broad_spotify" | "weekly_apple";

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

export async function markDiscoveryPlaylistInboxStatus(
  db: RadarDatabase,
  input: {
    exportRunId?: string | null;
    status: "ready" | "exporting" | "partial" | "completed" | "failed";
  },
  now = new Date(),
): Promise<void> {
  const phase: DiscoverySchedulePhase =
    input.status === "completed" ? "apple_priority" : "playlist_inbox";
  await db
    .update(discoveryScheduleState)
    .set({
      phase,
      playlistInboxExportRunId: input.exportRunId ?? null,
      playlistInboxStatus: input.status,
      updatedAt: now,
    })
    .where(eq(discoveryScheduleState.id, discoveryScheduleStateId));
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

export function nextWeeklyAppleScanAt(now: Date): Date {
  const parts = zonedParts(now, discoveryScheduleTimezone);
  const daysUntilThursday = (4 - parts.weekday + 7) % 7 || 7;
  const target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + daysUntilThursday, 21));
  return localTimeToUtc(target, discoveryScheduleTimezone);
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
