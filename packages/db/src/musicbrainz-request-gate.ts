import type {
  MusicBrainzRequestCompletion,
  MusicBrainzRequestGate,
  MusicBrainzRequestPermit,
} from "@radar/providers";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RadarDatabase } from "./client";
import { musicbrainzProviderState, musicbrainzRequestEvents } from "./schema";

const stateId = "global";
const leaseDurationMs = 30_000;
const leaseStateRecheckMs = 250;

export function createMusicBrainzRequestGate(
  db: RadarDatabase,
  minRequestIntervalMs = 1_000,
): MusicBrainzRequestGate {
  if (!Number.isInteger(minRequestIntervalMs) || minRequestIntervalMs < 1_000) {
    throw new Error("MusicBrainz request interval must be at least 1000 milliseconds.");
  }
  return {
    acquire: (input) => acquirePermit(db, minRequestIntervalMs, input),
    complete: (permit, result) => completeRequest(db, permit, result),
  };
}

async function acquirePermit(
  db: RadarDatabase,
  minRequestIntervalMs: number,
  input: {
    endpointCategory: string;
    method: "GET";
    retryAttempt: number;
    signal?: AbortSignal;
  },
): Promise<MusicBrainzRequestPermit> {
  await ensureState(db);
  await db
    .update(musicbrainzProviderState)
    .set({ queueDepth: sql`${musicbrainzProviderState.queueDepth} + 1`, updatedAt: new Date() })
    .where(eq(musicbrainzProviderState.id, stateId));
  const queuedAt = Date.now();
  let claimed = false;
  try {
    while (true) {
      throwIfAborted(input.signal);
      const now = new Date();
      const state = await db.query.musicbrainzProviderState.findFirst({
        where: eq(musicbrainzProviderState.id, stateId),
      });
      const waitUntil = Math.max(
        state?.nextRequestAt?.getTime() ?? 0,
        state?.leaseExpiresAt && state.leaseExpiresAt > now ? state.leaseExpiresAt.getTime() : 0,
      );
      if (waitUntil > now.getTime()) {
        await cancellableDelay(
          Math.min(waitUntil - now.getTime(), leaseStateRecheckMs),
          input.signal,
        );
        continue;
      }

      const leaseToken = randomUUID();
      const startedAt = new Date();
      const [row] = await db
        .update(musicbrainzProviderState)
        .set({
          lastRequestStartedAt: startedAt,
          leaseExpiresAt: new Date(startedAt.getTime() + leaseDurationMs),
          leaseOwner: leaseToken,
          nextRequestAt: new Date(startedAt.getTime() + minRequestIntervalMs),
          queueDepth: sql`greatest(${musicbrainzProviderState.queueDepth} - 1, 0)`,
          requestCount: sql`${musicbrainzProviderState.requestCount} + 1`,
          updatedAt: startedAt,
        })
        .where(
          and(
            eq(musicbrainzProviderState.id, stateId),
            or(
              isNull(musicbrainzProviderState.leaseExpiresAt),
              lte(musicbrainzProviderState.leaseExpiresAt, startedAt),
            ),
            or(
              isNull(musicbrainzProviderState.nextRequestAt),
              lte(musicbrainzProviderState.nextRequestAt, startedAt),
            ),
          ),
        )
        .returning({ queueDepth: musicbrainzProviderState.queueDepth });
      if (!row) continue;
      claimed = true;
      const eventId = randomUUID();
      const queueWaitMs = Math.max(0, startedAt.getTime() - queuedAt);
      await db.insert(musicbrainzRequestEvents).values({
        endpointCategory: input.endpointCategory,
        id: eventId,
        method: input.method,
        queueWaitMs,
        retryAttempt: input.retryAttempt,
        startedAt,
      });
      return { eventId, leaseToken, queueLength: row.queueDepth, queueWaitMs, startedAt };
    }
  } finally {
    if (!claimed) {
      await db
        .update(musicbrainzProviderState)
        .set({
          queueDepth: sql`greatest(${musicbrainzProviderState.queueDepth} - 1, 0)`,
          updatedAt: new Date(),
        })
        .where(eq(musicbrainzProviderState.id, stateId));
    }
  }
}

async function completeRequest(
  db: RadarDatabase,
  permit: MusicBrainzRequestPermit,
  result: MusicBrainzRequestCompletion,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(musicbrainzRequestEvents)
      .set({
        completedAt: now,
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.errorClassification
          ? { errorClassification: result.errorClassification.slice(0, 100) }
          : {}),
      })
      .where(eq(musicbrainzRequestEvents.id, permit.eventId));
    await tx
      .update(musicbrainzProviderState)
      .set({ leaseExpiresAt: null, leaseOwner: null, updatedAt: now })
      .where(
        and(
          eq(musicbrainzProviderState.id, stateId),
          eq(musicbrainzProviderState.leaseOwner, permit.leaseToken),
        ),
      );
  });
}

async function ensureState(db: RadarDatabase): Promise<void> {
  await db.insert(musicbrainzProviderState).values({ id: stateId }).onConflictDoNothing();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("MusicBrainz request cancelled.");
}

function cancellableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error ? signal.reason : new Error("MusicBrainz request cancelled."),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("MusicBrainz request cancelled."),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
