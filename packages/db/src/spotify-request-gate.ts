import type {
  Spotify429Classification,
  SpotifyRequestCompletion,
  SpotifyRequestGate,
  SpotifyRequestPermit,
} from "@radar/providers";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RadarDatabase } from "./client";
import { spotifyProviderState, spotifyRequestEvents, spotifySchedulerWork } from "./schema";

const spotifyStateId = "global";
const leaseDurationMs = 30_000;
const trailing24HoursMs = 24 * 60 * 60_000;

type SpotifyRequestGateTransaction = Parameters<Parameters<RadarDatabase["transaction"]>[0]>[0];
type SpotifyRequestGateDatabase = RadarDatabase | SpotifyRequestGateTransaction;

export type SpotifyQuotaLane = "priority" | "broad" | "playlist" | "other";

export interface SpotifyArtistAlbumsBudgetLimits {
  limit: number;
  priorityReserve: number;
  reserveReleaseAfterHours: number;
}

export interface SpotifyRequestGateOptions {
  artistAlbumsBudget?: SpotifyArtistAlbumsBudgetLimits;
  quotaLane?: SpotifyQuotaLane;
}

export interface SpotifyEndpointBudgetStatus {
  artistAlbums: {
    allowance: number;
    broadAllowance: number;
    broadRemaining: number;
    broadUsed: number;
    calls: number;
    nextCapacityAt: Date | null;
    priorityRemaining: number;
    priorityReserve: number;
    priorityUsed: number;
    remaining: number;
    reserveRemaining: number;
    reserveReleased: boolean;
  };
  playlist: {
    reads: number;
    writes: number;
  };
}

export const defaultSpotifyArtistAlbumsBudget: SpotifyArtistAlbumsBudgetLimits = {
  limit: 80,
  priorityReserve: 20,
  reserveReleaseAfterHours: 20,
};

export class SpotifyEndpointBudgetError extends Error {
  readonly code = "spotify_endpoint_budget";

  constructor(
    readonly endpointCategory: "artist_albums",
    readonly nextCapacityAt: Date | null,
    readonly quotaLane: SpotifyQuotaLane,
  ) {
    super(
      `Spotify Artist Albums trailing-24-hour budget is exhausted${nextCapacityAt ? ` until capacity returns after ${nextCapacityAt.toISOString()}` : ""}.`,
    );
    this.name = "SpotifyEndpointBudgetError";
  }
}

export class SpotifyCooldownError extends Error {
  readonly code = "spotify_cooldown";

  constructor(
    readonly cooldownUntil: Date | null,
    readonly indefinite: boolean,
  ) {
    super(
      indefinite
        ? "Spotify requests are blocked by an indefinite provider cooldown."
        : `Spotify requests are blocked until ${cooldownUntil?.toISOString() ?? "the cooldown ends"}.`,
    );
    this.name = "SpotifyCooldownError";
  }
}

export interface SpotifyOperationalStatus {
  canManualClear: boolean;
  cooldownActive: boolean;
  cooldownEndpointCategory: string | null;
  cooldownErrorClassification: string | null;
  cooldownIndefinite: boolean;
  cooldownObservedAt: Date | null;
  cooldownUntil: Date | null;
  lastRequestStartedAt: Date | null;
  nextRequestAt: Date | null;
  parsedRetryAfterSeconds: string | null;
  queueDepth: number;
  rawRetryAfter: string | null;
  requestCount: number;
}

export type StoredSpotify429Classification = Spotify429Classification | "legacy_unknown";

export interface Spotify429Telemetry {
  counts: {
    allTime: Record<StoredSpotify429Classification, number>;
    last24Hours: Record<StoredSpotify429Classification, number>;
    last30Minutes: Record<StoredSpotify429Classification, number>;
  };
  historicalUnclassifiedCount: number;
  latest: {
    classification: StoredSpotify429Classification;
    endpointCategory: string;
    observedAt: Date;
    parsedRetryAfterSeconds: string | null;
    providerReasonToken: string | null;
    rawRetryAfter: string | null;
  } | null;
}

export function createSpotifyRequestGate(
  db: RadarDatabase,
  minRequestIntervalMs: number,
  schedulerContext?: {
    source?: "initial" | "recurring" | "validation" | "repair" | "apple_priority" | "apple_catchup";
    workId: string;
    workType:
      | "base_artist"
      | "release_detail"
      | "release_tracks"
      | "artist_reconciliation"
      | "track_resolution";
  },
  discoveryReconciliationCampaignId?: string,
  options: SpotifyRequestGateOptions = {},
): SpotifyRequestGate {
  if (!Number.isInteger(minRequestIntervalMs) || minRequestIntervalMs < 10_000) {
    throw new Error("Spotify request interval must be at least 10000 milliseconds.");
  }
  return {
    acquire: (input) =>
      acquireSpotifyPermit(
        db,
        minRequestIntervalMs,
        input,
        schedulerContext,
        discoveryReconciliationCampaignId,
        options,
      ),
    complete: (permit, result) => completeSpotifyRequest(db, permit, result),
  };
}

export async function getSpotifyEndpointBudgetStatus(
  db: SpotifyRequestGateDatabase,
  limits: SpotifyArtistAlbumsBudgetLimits = defaultSpotifyArtistAlbumsBudget,
  now = new Date(),
): Promise<SpotifyEndpointBudgetStatus> {
  const validated = validateArtistAlbumsBudget(limits);
  const windowStart = new Date(now.getTime() - trailing24HoursMs);
  const [events, priorityRows] = await Promise.all([
    db
      .select({
        endpointCategory: spotifyRequestEvents.endpointCategory,
        quotaLane: spotifyRequestEvents.quotaLane,
        startedAt: spotifyRequestEvents.startedAt,
      })
      .from(spotifyRequestEvents)
      .where(
        and(
          gt(spotifyRequestEvents.startedAt, windowStart),
          inArray(spotifyRequestEvents.endpointCategory, [
            "artist_albums",
            "playlist_read",
            "playlist_write",
          ]),
        ),
      )
      .orderBy(asc(spotifyRequestEvents.startedAt)),
    db
      .select({ id: spotifySchedulerWork.id })
      .from(spotifySchedulerWork)
      .where(
        and(
          inArray(spotifySchedulerWork.source, ["apple_priority", "apple_catchup"]),
          inArray(spotifySchedulerWork.status, ["queued", "leased"]),
        ),
      )
      .limit(1),
  ]);
  const artistAlbums = events.filter((event) => event.endpointCategory === "artist_albums");
  const priorityUsed = artistAlbums.filter((event) => event.quotaLane === "priority").length;
  const broadUsed = artistAlbums.length - priorityUsed;
  const broadAllowance = validated.limit - validated.priorityReserve;
  const oldest = artistAlbums[0]?.startedAt ?? null;
  const reserveReleased = Boolean(
    priorityRows.length === 0 &&
    oldest &&
    now.getTime() - oldest.getTime() >= validated.reserveReleaseAfterHours * 60 * 60_000,
  );
  const effectiveBroadAllowance = reserveReleased ? validated.limit : broadAllowance;
  const totalRemaining = Math.max(0, validated.limit - artistAlbums.length);
  const reserveRemaining = Math.max(
    0,
    Math.min(
      validated.priorityReserve - Math.min(priorityUsed, validated.priorityReserve),
      totalRemaining,
    ),
  );
  return {
    artistAlbums: {
      allowance: validated.limit,
      broadAllowance,
      broadRemaining: Math.max(0, Math.min(effectiveBroadAllowance - broadUsed, totalRemaining)),
      broadUsed,
      calls: artistAlbums.length,
      nextCapacityAt: oldest ? new Date(oldest.getTime() + trailing24HoursMs) : null,
      priorityRemaining: totalRemaining,
      priorityReserve: validated.priorityReserve,
      priorityUsed,
      remaining: totalRemaining,
      reserveRemaining,
      reserveReleased,
    },
    playlist: {
      reads: events.filter((event) => event.endpointCategory === "playlist_read").length,
      writes: events.filter((event) => event.endpointCategory === "playlist_write").length,
    },
  };
}

export async function getSpotifyOperationalStatus(
  db: RadarDatabase,
  now = new Date(),
): Promise<SpotifyOperationalStatus> {
  const state = await db.query.spotifyProviderState.findFirst({
    where: eq(spotifyProviderState.id, spotifyStateId),
  });
  const cooldownActive = Boolean(
    state?.cooldownIndefinite || (state?.cooldownUntil && state.cooldownUntil > now),
  );
  const classification = state?.cooldownErrorClassification ?? null;
  return {
    canManualClear: Boolean(
      cooldownActive && classification && /(?:missing|malformed|http_date)/.test(classification),
    ),
    cooldownActive,
    cooldownEndpointCategory: state?.cooldownEndpointCategory ?? null,
    cooldownErrorClassification: classification,
    cooldownIndefinite: state?.cooldownIndefinite ?? false,
    cooldownObservedAt: state?.cooldownObservedAt ?? null,
    cooldownUntil: state?.cooldownUntil ?? null,
    lastRequestStartedAt: state?.lastRequestStartedAt ?? null,
    nextRequestAt: state?.nextRequestAt ?? null,
    parsedRetryAfterSeconds: state?.parsedRetryAfterSeconds ?? null,
    queueDepth: state?.queueDepth ?? 0,
    rawRetryAfter: state?.rawRetryAfter ?? null,
    requestCount: state?.requestCount ?? 0,
  };
}

export async function getSpotify429Telemetry(
  db: RadarDatabase,
  now = new Date(),
): Promise<Spotify429Telemetry> {
  const rows = await db
    .select({
      endpointCategory: spotifyRequestEvents.endpointCategory,
      parsedRetryAfterSeconds: spotifyRequestEvents.parsedRetryAfterSeconds,
      providerReasonToken: spotifyRequestEvents.providerReasonToken,
      rateLimitClassification: spotifyRequestEvents.rateLimitClassification,
      rawRetryAfter: spotifyRequestEvents.rawRetryAfter,
      startedAt: spotifyRequestEvents.startedAt,
    })
    .from(spotifyRequestEvents)
    .where(eq(spotifyRequestEvents.status, 429))
    .orderBy(sql`${spotifyRequestEvents.startedAt} desc`);
  const counts = {
    allTime: emptySpotify429Counts(),
    last24Hours: emptySpotify429Counts(),
    last30Minutes: emptySpotify429Counts(),
  };
  const last24Hours = new Date(now.getTime() - 24 * 60 * 60_000);
  const last30Minutes = new Date(now.getTime() - 30 * 60_000);
  for (const row of rows) {
    const classification = storedSpotify429Classification(row.rateLimitClassification);
    counts.allTime[classification] += 1;
    if (row.startedAt >= last24Hours) counts.last24Hours[classification] += 1;
    if (row.startedAt >= last30Minutes) counts.last30Minutes[classification] += 1;
  }
  const latest = rows[0];
  return {
    counts,
    historicalUnclassifiedCount: counts.allTime.legacy_unknown,
    latest: latest
      ? {
          classification: storedSpotify429Classification(latest.rateLimitClassification),
          endpointCategory: latest.endpointCategory,
          observedAt: latest.startedAt,
          parsedRetryAfterSeconds: latest.parsedRetryAfterSeconds,
          providerReasonToken: latest.providerReasonToken,
          rawRetryAfter: latest.rawRetryAfter,
        }
      : null,
  };
}

export async function clearInvalidSpotifyCooldown(
  db: RadarDatabase,
  reason: string,
): Promise<boolean> {
  if (reason.trim().length < 20) throw new Error("A specific correction reason is required.");
  const status = await getSpotifyOperationalStatus(db);
  if (!status.canManualClear) return false;
  const rows = await db
    .update(spotifyProviderState)
    .set({
      cooldownUntil: null,
      cooldownIndefinite: false,
      manualClearAt: new Date(),
      manualClearReason: reason.trim().slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(spotifyProviderState.id, spotifyStateId))
    .returning({ id: spotifyProviderState.id });
  return rows.length === 1;
}

export async function deferSpotifyRequests(
  db: RadarDatabase,
  delayMs: number,
  now = new Date(),
): Promise<Date> {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error("Invalid Spotify request delay.");
  }
  const targetTime = now.getTime() + delayMs;
  if (!Number.isFinite(now.getTime()) || targetTime > 8_640_000_000_000_000) {
    throw new Error("Spotify request delay exceeds the supported timestamp range.");
  }
  await ensureSpotifyState(db);
  const requestedNextRequestAt = new Date(targetTime);
  return db.transaction(async (tx) => {
    const [state] = await tx
      .select({ nextRequestAt: spotifyProviderState.nextRequestAt })
      .from(spotifyProviderState)
      .where(eq(spotifyProviderState.id, spotifyStateId))
      .for("update");
    if (!state) throw new Error("Spotify provider state is unavailable.");
    const nextRequestAt =
      state.nextRequestAt && state.nextRequestAt > requestedNextRequestAt
        ? state.nextRequestAt
        : requestedNextRequestAt;
    await tx
      .update(spotifyProviderState)
      .set({ nextRequestAt, updatedAt: now })
      .where(eq(spotifyProviderState.id, spotifyStateId));
    return nextRequestAt;
  });
}

async function acquireSpotifyPermit(
  db: RadarDatabase,
  minRequestIntervalMs: number,
  input: { endpointCategory: string; method: string; signal?: AbortSignal },
  schedulerContext?: {
    source?: "initial" | "recurring" | "validation" | "repair" | "apple_priority" | "apple_catchup";
    workId: string;
    workType:
      | "base_artist"
      | "release_detail"
      | "release_tracks"
      | "artist_reconciliation"
      | "track_resolution";
  },
  discoveryReconciliationCampaignId?: string,
  options: SpotifyRequestGateOptions = {},
): Promise<SpotifyRequestPermit> {
  const endpointCategory = spotifyQuotaCategory(input.endpointCategory);
  const quotaLane = spotifyQuotaLane(endpointCategory, schedulerContext?.source, options.quotaLane);
  const artistAlbumsBudget = validateArtistAlbumsBudget(
    options.artistAlbumsBudget ?? defaultSpotifyArtistAlbumsBudget,
  );
  await ensureSpotifyState(db);
  await db
    .update(spotifyProviderState)
    .set({ queueDepth: sql`${spotifyProviderState.queueDepth} + 1`, updatedAt: new Date() })
    .where(eq(spotifyProviderState.id, spotifyStateId));
  const queuedAt = Date.now();
  let claimed = false;
  try {
    while (true) {
      throwIfAborted(input.signal);
      const now = new Date();
      const status = await getSpotifyOperationalStatus(db, now);
      if (status.cooldownActive) {
        throw new SpotifyCooldownError(status.cooldownUntil, status.cooldownIndefinite);
      }
      if (endpointCategory === "artist_albums") {
        const budget = await getSpotifyEndpointBudgetStatus(db, artistAlbumsBudget, now);
        const exhausted = budget.artistAlbums.calls >= budget.artistAlbums.allowance;
        const broadBlocked = quotaLane !== "priority" && budget.artistAlbums.broadRemaining === 0;
        if (exhausted || broadBlocked) {
          throw new SpotifyEndpointBudgetError(
            "artist_albums",
            budget.artistAlbums.nextCapacityAt,
            quotaLane,
          );
        }
      }
      const waitUntil = Math.max(
        status.nextRequestAt?.getTime() ?? 0,
        await activeLeaseExpiry(db, now),
      );
      if (waitUntil > now.getTime()) {
        await cancellableDelay(waitUntil - now.getTime(), input.signal);
        continue;
      }

      const leaseToken = randomUUID();
      const startedAt = new Date();
      const [permit] = await db
        .update(spotifyProviderState)
        .set({
          lastRequestStartedAt: startedAt,
          leaseExpiresAt: new Date(startedAt.getTime() + leaseDurationMs),
          leaseOwner: leaseToken,
          nextRequestAt: new Date(startedAt.getTime() + minRequestIntervalMs),
          queueDepth: sql`greatest(${spotifyProviderState.queueDepth} - 1, 0)`,
          requestCount: sql`${spotifyProviderState.requestCount} + 1`,
          updatedAt: startedAt,
        })
        .where(
          and(
            eq(spotifyProviderState.id, spotifyStateId),
            eq(spotifyProviderState.cooldownIndefinite, false),
            or(
              isNull(spotifyProviderState.cooldownUntil),
              lte(spotifyProviderState.cooldownUntil, startedAt),
            ),
            or(
              isNull(spotifyProviderState.leaseExpiresAt),
              lte(spotifyProviderState.leaseExpiresAt, startedAt),
            ),
            or(
              isNull(spotifyProviderState.nextRequestAt),
              lte(spotifyProviderState.nextRequestAt, startedAt),
            ),
          ),
        )
        .returning({ queueDepth: spotifyProviderState.queueDepth });
      if (!permit) continue;
      claimed = true;
      const eventId = randomUUID();
      const queueWaitMs = Math.max(0, startedAt.getTime() - queuedAt);
      await db.insert(spotifyRequestEvents).values({
        ...(discoveryReconciliationCampaignId ? { discoveryReconciliationCampaignId } : {}),
        id: eventId,
        endpointCategory,
        method: input.method,
        quotaLane,
        queueWaitMs,
        startedAt,
        ...(schedulerContext
          ? {
              schedulerWorkId: schedulerContext.workId,
              schedulerWorkType: schedulerContext.workType,
            }
          : {}),
      });
      return {
        eventId,
        leaseToken,
        queueLength: permit.queueDepth,
        queueWaitMs,
        startedAt,
      };
    }
  } finally {
    if (!claimed) {
      await db
        .update(spotifyProviderState)
        .set({
          queueDepth: sql`greatest(${spotifyProviderState.queueDepth} - 1, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(spotifyProviderState.id, spotifyStateId));
    }
  }
}

function validateArtistAlbumsBudget(
  value: SpotifyArtistAlbumsBudgetLimits,
): SpotifyArtistAlbumsBudgetLimits {
  if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 1_000) {
    throw new Error("Spotify Artist Albums limit must be an integer from 1 to 1000.");
  }
  if (
    !Number.isInteger(value.priorityReserve) ||
    value.priorityReserve < 0 ||
    value.priorityReserve >= value.limit
  ) {
    throw new Error("Spotify Artist Albums priority reserve must be below the total limit.");
  }
  if (
    !Number.isInteger(value.reserveReleaseAfterHours) ||
    value.reserveReleaseAfterHours < 1 ||
    value.reserveReleaseAfterHours > 24
  ) {
    throw new Error("Spotify Artist Albums reserve release must be from 1 to 24 hours.");
  }
  return value;
}

function spotifyQuotaCategory(value: string): string {
  switch (value) {
    case "artist_albums":
    case "album_detail":
    case "album_tracks":
    case "playlist_read":
    case "playlist_write":
    case "oauth_or_other":
      return value;
    case "album":
      return "album_detail";
    case "playlist":
    case "playlist_items":
    case "user_playlists":
      return "playlist_read";
    case "playlist_add_items":
      return "playlist_write";
    default:
      return "oauth_or_other";
  }
}

function spotifyQuotaLane(
  endpointCategory: string,
  source:
    | "initial"
    | "recurring"
    | "validation"
    | "repair"
    | "apple_priority"
    | "apple_catchup"
    | undefined,
  explicit: SpotifyQuotaLane | undefined,
): SpotifyQuotaLane {
  if (endpointCategory === "playlist_read" || endpointCategory === "playlist_write") {
    return "playlist";
  }
  if (explicit) return explicit;
  if (source === "apple_priority" || source === "apple_catchup") return "priority";
  if (source) return "broad";
  return "other";
}

async function completeSpotifyRequest(
  db: RadarDatabase,
  permit: SpotifyRequestPermit,
  result: SpotifyRequestCompletion,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(spotifyRequestEvents)
      .set({
        completedAt: now,
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.rawRetryAfter === undefined
          ? {}
          : { rawRetryAfter: result.rawRetryAfter.slice(0, 200) }),
        ...(result.parsedRetryAfterSeconds === undefined
          ? {}
          : { parsedRetryAfterSeconds: result.parsedRetryAfterSeconds }),
        ...(result.cooldownUntil ? { cooldownUntil: result.cooldownUntil } : {}),
        ...(result.errorClassification
          ? { errorClassification: result.errorClassification.slice(0, 100) }
          : {}),
        ...(safeSpotifyProviderReasonToken(result.providerReasonToken)
          ? { providerReasonToken: safeSpotifyProviderReasonToken(result.providerReasonToken) }
          : {}),
        ...(result.rateLimitClassification
          ? { rateLimitClassification: result.rateLimitClassification }
          : {}),
        ...(result.responseClassification
          ? { responseClassification: result.responseClassification.slice(0, 100) }
          : {}),
      })
      .where(eq(spotifyRequestEvents.id, permit.eventId));

    await tx
      .update(spotifyProviderState)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(result.status === 429
          ? {
              cooldownEndpointCategory: await requestEndpointCategory(tx, permit.eventId),
              cooldownErrorClassification: result.errorClassification ?? "rate_limited_unknown",
              cooldownIndefinite: result.cooldownIndefinite ?? false,
              cooldownObservedAt: now,
              cooldownResponseClassification: result.responseClassification ?? null,
              cooldownStatus: 429,
              cooldownUntil: result.cooldownUntil ?? null,
              parsedRetryAfterSeconds: result.parsedRetryAfterSeconds ?? null,
              rawRetryAfter: result.rawRetryAfter?.slice(0, 200) ?? null,
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(spotifyProviderState.id, spotifyStateId),
          eq(spotifyProviderState.leaseOwner, permit.leaseToken),
        ),
      );
  });
}

function emptySpotify429Counts(): Record<StoredSpotify429Classification, number> {
  return {
    legacy_unknown: 0,
    quota_exceeded: 0,
    unknown_reason: 0,
    unspecified_429: 0,
  };
}

function storedSpotify429Classification(value: string | null): StoredSpotify429Classification {
  if (value === "quota_exceeded" || value === "unknown_reason" || value === "unspecified_429") {
    return value;
  }
  return "legacy_unknown";
}

function safeSpotifyProviderReasonToken(value: string | undefined): string | undefined {
  return value && /^[A-Z0-9_]{1,64}$/.test(value) ? value : undefined;
}

async function requestEndpointCategory(
  db: Pick<RadarDatabase, "query">,
  eventId: string,
): Promise<string | null> {
  const event = await db.query.spotifyRequestEvents.findFirst({
    where: eq(spotifyRequestEvents.id, eventId),
    columns: { endpointCategory: true },
  });
  return event?.endpointCategory ?? null;
}

async function activeLeaseExpiry(db: RadarDatabase, now: Date): Promise<number> {
  const state = await db.query.spotifyProviderState.findFirst({
    where: eq(spotifyProviderState.id, spotifyStateId),
    columns: { leaseExpiresAt: true },
  });
  return state?.leaseExpiresAt && state.leaseExpiresAt > now ? state.leaseExpiresAt.getTime() : 0;
}

async function ensureSpotifyState(db: RadarDatabase): Promise<void> {
  await db.insert(spotifyProviderState).values({ id: spotifyStateId }).onConflictDoNothing();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Spotify request cancelled.");
}

function cancellableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("Spotify request cancelled."),
    );
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(
        signal.reason instanceof Error ? signal.reason : new Error("Spotify request cancelled."),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
