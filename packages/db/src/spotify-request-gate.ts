import type {
  SpotifyRequestCompletion,
  SpotifyRequestGate,
  SpotifyRequestPermit,
} from "@radar/providers";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RadarDatabase } from "./client";
import { spotifyProviderState, spotifyRequestEvents } from "./schema";

const spotifyStateId = "global";
const leaseDurationMs = 30_000;

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

export function createSpotifyRequestGate(
  db: RadarDatabase,
  minRequestIntervalMs: number,
): SpotifyRequestGate {
  if (!Number.isInteger(minRequestIntervalMs) || minRequestIntervalMs < 5_000) {
    throw new Error("Spotify request interval must be at least 5000 milliseconds.");
  }
  return {
    acquire: (input) => acquireSpotifyPermit(db, minRequestIntervalMs, input),
    complete: (permit, result) => completeSpotifyRequest(db, permit, result),
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
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error("Invalid Spotify request delay.");
  await ensureSpotifyState(db);
  const nextRequestAt = new Date(now.getTime() + delayMs);
  await db
    .update(spotifyProviderState)
    .set({
      nextRequestAt: sql`greatest(coalesce(${spotifyProviderState.nextRequestAt}, ${nextRequestAt}), ${nextRequestAt})`,
      updatedAt: now,
    })
    .where(eq(spotifyProviderState.id, spotifyStateId));
  return nextRequestAt;
}

async function acquireSpotifyPermit(
  db: RadarDatabase,
  minRequestIntervalMs: number,
  input: { endpointCategory: string; method: string; signal?: AbortSignal },
): Promise<SpotifyRequestPermit> {
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
        id: eventId,
        endpointCategory: input.endpointCategory,
        method: input.method,
        queueWaitMs,
        startedAt,
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
