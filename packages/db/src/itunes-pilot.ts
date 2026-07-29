import type { ItunesRequestPersistence } from "@radar/providers";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  itunesPilotProviderState,
  itunesPilotRequestEvents,
  itunesPilotResponseCache,
  itunesPilotRuns,
} from "./schema";

const stateId = "global";
const leaseDurationMs = 30_000;

export class ItunesPilotGateError extends Error {
  constructor(
    message: string,
    readonly classification: "request_budget_exhausted" | "pilot_deadline_reached" | "run_inactive",
  ) {
    super(message);
    this.name = "ItunesPilotGateError";
  }
}

export function createItunesRequestPersistence(db: RadarDatabase): ItunesRequestPersistence {
  return {
    acquire: async (input) => {
      await ensureState(db);
      while (true) {
        const run = await db.query.itunesPilotRuns.findFirst({
          where: eq(itunesPilotRuns.id, input.runId),
        });
        if (!run || run.status !== "running") {
          throw new ItunesPilotGateError("The iTunes pilot run is not active.", "run_inactive");
        }
        const now = new Date();
        if (run.deadlineAt && run.deadlineAt <= now) {
          throw new ItunesPilotGateError(
            "The iTunes pilot deadline has been reached.",
            "pilot_deadline_reached",
          );
        }
        if (run.requestCount >= Math.min(run.requestBudget, input.maxRequests)) {
          throw new ItunesPilotGateError(
            "The iTunes pilot request budget is exhausted.",
            "request_budget_exhausted",
          );
        }
        const state = await db.query.itunesPilotProviderState.findFirst({
          where: eq(itunesPilotProviderState.id, stateId),
        });
        const waitUntil = Math.max(
          state?.nextRequestAt?.getTime() ?? 0,
          state?.leaseExpiresAt && state.leaseExpiresAt > now ? state.leaseExpiresAt.getTime() : 0,
        );
        if (waitUntil > now.getTime()) {
          await delay(Math.min(100, waitUntil - now.getTime()));
          continue;
        }
        const leaseToken = randomUUID();
        const eventId = randomUUID();
        const startedAt = new Date();
        const claimed = await db.transaction(async (tx) => {
          const [stateRow] = await tx
            .update(itunesPilotProviderState)
            .set({
              lastRequestStartedAt: startedAt,
              leaseExpiresAt: new Date(startedAt.getTime() + leaseDurationMs),
              leaseOwner: leaseToken,
              nextRequestAt: new Date(startedAt.getTime() + Math.max(3200, input.minIntervalMs)),
              requestCount: sql`${itunesPilotProviderState.requestCount} + 1`,
              updatedAt: startedAt,
            })
            .where(
              and(
                eq(itunesPilotProviderState.id, stateId),
                or(
                  isNull(itunesPilotProviderState.leaseExpiresAt),
                  lte(itunesPilotProviderState.leaseExpiresAt, startedAt),
                ),
                or(
                  isNull(itunesPilotProviderState.nextRequestAt),
                  lte(itunesPilotProviderState.nextRequestAt, startedAt),
                ),
              ),
            )
            .returning({ id: itunesPilotProviderState.id });
          if (!stateRow) return false;
          const [runRow] = await tx
            .update(itunesPilotRuns)
            .set({
              requestCount: sql`${itunesPilotRuns.requestCount} + 1`,
              updatedAt: startedAt,
            })
            .where(
              and(
                eq(itunesPilotRuns.id, input.runId),
                eq(itunesPilotRuns.status, "running"),
                sql`${itunesPilotRuns.requestCount} < least(${itunesPilotRuns.requestBudget}, ${input.maxRequests})`,
              ),
            )
            .returning({ id: itunesPilotRuns.id });
          if (!runRow) {
            await tx
              .update(itunesPilotProviderState)
              .set({ leaseExpiresAt: null, leaseOwner: null, updatedAt: startedAt })
              .where(eq(itunesPilotProviderState.leaseOwner, leaseToken));
            return false;
          }
          await tx.insert(itunesPilotRequestEvents).values({
            endpointCategory: input.endpointCategory,
            id: eventId,
            requestIdentity: input.identity,
            runId: input.runId,
            startedAt,
          });
          return true;
        });
        if (claimed) return { eventId, leaseToken, startedAt };
      }
    },
    complete: async (input) => {
      await db.transaction(async (tx) => {
        await tx
          .update(itunesPilotRequestEvents)
          .set({
            completedAt: input.completedAt,
            errorClassification: input.errorClassification?.slice(0, 100),
            responseBytes: input.bodyBytes,
            retryAfterSeconds: input.retryAfterSeconds,
            status: input.status,
          })
          .where(eq(itunesPilotRequestEvents.id, input.eventId));
        await tx
          .update(itunesPilotProviderState)
          .set({ leaseExpiresAt: null, leaseOwner: null, updatedAt: input.completedAt })
          .where(
            and(
              eq(itunesPilotProviderState.id, stateId),
              eq(itunesPilotProviderState.leaseOwner, input.leaseToken),
            ),
          );
        if (input.cacheValue) {
          const event = await tx.query.itunesPilotRequestEvents.findFirst({
            where: eq(itunesPilotRequestEvents.id, input.eventId),
            columns: { requestIdentity: true },
          });
          if (event) {
            const serialized = JSON.stringify(input.cacheValue);
            await tx
              .insert(itunesPilotResponseCache)
              .values({
                requestIdentity: event.requestIdentity,
                response: input.cacheValue,
                responseHash: createHash("sha256").update(serialized).digest("hex"),
                storedAt: input.completedAt,
              })
              .onConflictDoUpdate({
                target: itunesPilotResponseCache.requestIdentity,
                set: {
                  response: input.cacheValue,
                  responseHash: createHash("sha256").update(serialized).digest("hex"),
                  storedAt: input.completedAt,
                  updatedAt: input.completedAt,
                },
              });
          }
        }
      });
    },
    loadCache: async (identity) => {
      const row = await db.query.itunesPilotResponseCache.findFirst({
        where: eq(itunesPilotResponseCache.requestIdentity, identity),
      });
      return row?.response ?? null;
    },
    recordCacheHit: async (input) => {
      const now = new Date();
      await db.insert(itunesPilotRequestEvents).values({
        cacheHit: true,
        completedAt: now,
        endpointCategory: input.endpointCategory,
        requestIdentity: input.identity,
        runId: input.runId,
        startedAt: now,
        status: 200,
      });
    },
  };
}

export async function resetExpiredItunesLeaseForTest(
  db: RadarDatabase,
  now = new Date(),
): Promise<void> {
  await db
    .update(itunesPilotProviderState)
    .set({ leaseExpiresAt: null, leaseOwner: null, updatedAt: now })
    .where(
      and(
        eq(itunesPilotProviderState.id, stateId),
        lte(itunesPilotProviderState.leaseExpiresAt, now),
      ),
    );
}

async function ensureState(db: RadarDatabase): Promise<void> {
  await db.insert(itunesPilotProviderState).values({ id: stateId }).onConflictDoNothing();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
