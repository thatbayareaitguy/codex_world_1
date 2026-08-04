import type { AppleMusicRequestPersistence } from "@radar/providers";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  appleMusicArtistScans,
  appleMusicArtistState,
  appleMusicProviderState,
  appleMusicRequestEvents,
  appleMusicResponseCache,
  appleMusicScanBatches,
  artistExternalIds,
  artistMappingReviews,
  scanRuns,
} from "./schema";

const stateId = "global";
const leaseDurationMs = 30_000;

export class AppleMusicGateError extends Error {
  constructor(
    message: string,
    readonly classification: "provider_cooldown" | "run_inactive",
  ) {
    super(message);
    this.name = "AppleMusicGateError";
  }
}

export interface AppleMusicOperationalStatus {
  cooldownActive: boolean;
  cooldownIndefinite: boolean;
  cooldownUntil: Date | null;
  lastRequestStartedAt: Date | null;
  leaseActive: boolean;
  nextRequestAt: Date | null;
  queueDepth: number;
  requestCount: number;
}

export function createAppleMusicRequestPersistence(
  db: RadarDatabase,
  options: { batchId: string; scanRunId: string },
): AppleMusicRequestPersistence {
  return {
    acquire: async (input) => {
      if (input.runId !== options.scanRunId || input.minIntervalMs < 1_100) {
        throw new AppleMusicGateError("The Apple Music scan request is invalid.", "run_inactive");
      }
      await ensureAppleMusicState(db);
      await db
        .update(appleMusicProviderState)
        .set({
          queueDepth: sql`${appleMusicProviderState.queueDepth} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(appleMusicProviderState.id, stateId));
      let claimed = false;
      try {
        while (true) {
          const now = new Date();
          const [run, batch, state] = await Promise.all([
            db.query.scanRuns.findFirst({ where: eq(scanRuns.id, options.scanRunId) }),
            db.query.appleMusicScanBatches.findFirst({
              where: eq(appleMusicScanBatches.id, options.batchId),
            }),
            db.query.appleMusicProviderState.findFirst({
              where: eq(appleMusicProviderState.id, stateId),
            }),
          ]);
          if (run?.status !== "running" || batch?.status !== "running") {
            throw new AppleMusicGateError("The Apple Music scan is not active.", "run_inactive");
          }
          if (state?.cooldownIndefinite || (state?.cooldownUntil && state.cooldownUntil > now)) {
            throw new AppleMusicGateError(
              "Apple Music requests are blocked by a persisted cooldown.",
              "provider_cooldown",
            );
          }
          const waitUntil = Math.max(
            state?.nextRequestAt?.getTime() ?? 0,
            state?.leaseExpiresAt && state.leaseExpiresAt > now
              ? state.leaseExpiresAt.getTime()
              : 0,
          );
          if (waitUntil > now.getTime()) {
            await delay(Math.min(100, waitUntil - now.getTime()));
            continue;
          }
          const leaseToken = randomUUID();
          const eventId = randomUUID();
          const startedAt = new Date();
          const acquired = await db.transaction(async (tx) => {
            const [stateRow] = await tx
              .update(appleMusicProviderState)
              .set({
                lastRequestStartedAt: startedAt,
                leaseExpiresAt: new Date(startedAt.getTime() + leaseDurationMs),
                leaseOwner: leaseToken,
                nextRequestAt: new Date(startedAt.getTime() + input.minIntervalMs),
                queueDepth: sql`greatest(${appleMusicProviderState.queueDepth} - 1, 0)`,
                requestCount: sql`${appleMusicProviderState.requestCount} + 1`,
                updatedAt: startedAt,
              })
              .where(
                and(
                  eq(appleMusicProviderState.id, stateId),
                  eq(appleMusicProviderState.cooldownIndefinite, false),
                  or(
                    isNull(appleMusicProviderState.cooldownUntil),
                    lte(appleMusicProviderState.cooldownUntil, startedAt),
                  ),
                  or(
                    isNull(appleMusicProviderState.leaseExpiresAt),
                    lte(appleMusicProviderState.leaseExpiresAt, startedAt),
                  ),
                  or(
                    isNull(appleMusicProviderState.nextRequestAt),
                    lte(appleMusicProviderState.nextRequestAt, startedAt),
                  ),
                ),
              )
              .returning({ id: appleMusicProviderState.id });
            if (!stateRow) return false;
            const [batchRow] = await tx
              .update(appleMusicScanBatches)
              .set({
                requestCount: sql`${appleMusicScanBatches.requestCount} + 1`,
                updatedAt: startedAt,
              })
              .where(
                and(
                  eq(appleMusicScanBatches.id, options.batchId),
                  eq(appleMusicScanBatches.status, "running"),
                ),
              )
              .returning({ id: appleMusicScanBatches.id });
            if (!batchRow) return false;
            await tx.insert(appleMusicRequestEvents).values({
              batchId: options.batchId,
              endpointCategory: input.endpointCategory,
              id: eventId,
              requestIdentity: input.identity,
              scanRunId: options.scanRunId,
              startedAt,
            });
            return true;
          });
          if (acquired) {
            claimed = true;
            return { eventId, leaseToken, startedAt };
          }
        }
      } finally {
        if (!claimed) {
          await db
            .update(appleMusicProviderState)
            .set({
              queueDepth: sql`greatest(${appleMusicProviderState.queueDepth} - 1, 0)`,
              updatedAt: new Date(),
            })
            .where(eq(appleMusicProviderState.id, stateId));
        }
      }
    },
    complete: async (input) => {
      await db.transaction(async (tx) => {
        await tx
          .update(appleMusicRequestEvents)
          .set({
            completedAt: input.completedAt,
            ...(input.cooldownUntil ? { cooldownUntil: input.cooldownUntil } : {}),
            ...(input.errorClassification
              ? { errorClassification: input.errorClassification.slice(0, 100) }
              : {}),
            responseBytes: input.bodyBytes,
            ...(input.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: input.retryAfterSeconds }),
            ...(input.status === undefined ? {} : { status: input.status }),
          })
          .where(eq(appleMusicRequestEvents.id, input.eventId));
        await tx
          .update(appleMusicProviderState)
          .set({
            ...(input.status === 429
              ? {
                  cooldownErrorClassification:
                    input.errorClassification?.slice(0, 100) ?? "rate_limited",
                  cooldownIndefinite: input.cooldownUntil === undefined,
                  cooldownObservedAt: input.completedAt,
                  cooldownUntil: input.cooldownUntil ?? null,
                  retryAfterSeconds: input.retryAfterSeconds ?? null,
                }
              : {}),
            leaseExpiresAt: null,
            leaseOwner: null,
            updatedAt: input.completedAt,
          })
          .where(
            and(
              eq(appleMusicProviderState.id, stateId),
              eq(appleMusicProviderState.leaseOwner, input.leaseToken),
            ),
          );
        if (input.cacheValue !== undefined) {
          const event = await tx.query.appleMusicRequestEvents.findFirst({
            where: eq(appleMusicRequestEvents.id, input.eventId),
          });
          if (!event) throw new Error("Apple Music request telemetry was not found.");
          const serialized = JSON.stringify(input.cacheValue);
          await tx
            .insert(appleMusicResponseCache)
            .values({
              requestIdentity: event.requestIdentity,
              response: input.cacheValue,
              responseHash: createHash("sha256").update(serialized).digest("hex"),
              storedAt: input.completedAt,
            })
            .onConflictDoUpdate({
              target: appleMusicResponseCache.requestIdentity,
              set: {
                response: input.cacheValue,
                responseHash: createHash("sha256").update(serialized).digest("hex"),
                storedAt: input.completedAt,
                updatedAt: input.completedAt,
              },
            });
        }
      });
    },
    loadCache: async (identity) =>
      (
        await db.query.appleMusicResponseCache.findFirst({
          where: eq(appleMusicResponseCache.requestIdentity, identity),
        })
      )?.response ?? null,
    recordCacheHit: async (input) => {
      const now = new Date();
      await db.insert(appleMusicRequestEvents).values({
        batchId: options.batchId,
        cacheHit: true,
        completedAt: now,
        endpointCategory: input.endpointCategory,
        id: randomUUID(),
        requestIdentity: input.identity,
        scanRunId: options.scanRunId,
        startedAt: now,
        status: 200,
      });
    },
  };
}

export async function getAppleMusicOperationalStatus(
  db: RadarDatabase,
  now = new Date(),
): Promise<AppleMusicOperationalStatus> {
  const state = await db.query.appleMusicProviderState.findFirst({
    where: eq(appleMusicProviderState.id, stateId),
  });
  return {
    cooldownActive: Boolean(
      state?.cooldownIndefinite || (state?.cooldownUntil && state.cooldownUntil > now),
    ),
    cooldownIndefinite: state?.cooldownIndefinite ?? false,
    cooldownUntil: state?.cooldownUntil ?? null,
    lastRequestStartedAt: state?.lastRequestStartedAt ?? null,
    leaseActive: Boolean(state?.leaseExpiresAt && state.leaseExpiresAt > now),
    nextRequestAt: state?.nextRequestAt ?? null,
    queueDepth: state?.queueDepth ?? 0,
    requestCount: state?.requestCount ?? 0,
  };
}

export interface AppleMusicSeedEntry {
  candidateArtistId?: string;
  canonicalArtistName: string;
  classification:
    | "ambiguous_seed"
    | "evidence_supported_seed"
    | "high_confidence_seed"
    | "manual_review_required";
  evidenceSources: string[];
  manualReviewReason?: string;
  alternateCandidateIds: string[];
  watchedArtistId: string;
}

export async function bootstrapAppleMusicIdentity(
  db: RadarDatabase,
  entries: AppleMusicSeedEntry[],
): Promise<{ mappings: number; reviewArtists: number; reviews: number; candidateFree: number }> {
  return db.transaction(async (tx) => {
    let mappings = 0;
    const reviewArtistIds = new Set<string>();
    let reviews = 0;
    let candidateFree = 0;
    for (const entry of entries) {
      if (
        (entry.classification === "high_confidence_seed" ||
          entry.classification === "evidence_supported_seed") &&
        entry.candidateArtistId
      ) {
        const inserted = await tx
          .insert(artistExternalIds)
          .values({
            artistId: entry.watchedArtistId,
            confirmed: true,
            confirmedAt: new Date(),
            externalId: entry.candidateArtistId,
            mappingSource: `apple_${entry.classification}`,
            matchReasons: entry.evidenceSources,
            matchScore: entry.classification === "high_confidence_seed" ? "1.000" : "0.950",
            provider: "apple_music",
            providerUrl: `https://music.apple.com/us/artist/${entry.candidateArtistId}`,
          })
          .onConflictDoNothing()
          .returning({ id: artistExternalIds.id });
        mappings += inserted.length;
        continue;
      }
      reviewArtistIds.add(entry.watchedArtistId);
      if (entry.alternateCandidateIds.length === 0) {
        const existing = await tx.query.artistMappingReviews.findFirst({
          where: and(
            eq(artistMappingReviews.artistId, entry.watchedArtistId),
            eq(artistMappingReviews.provider, "apple_music"),
            isNull(artistMappingReviews.proposedExternalId),
          ),
        });
        if (!existing) {
          await tx.insert(artistMappingReviews).values({
            artistId: entry.watchedArtistId,
            matchReasons: [
              ...entry.evidenceSources,
              entry.manualReviewReason ?? "No safe Apple Music candidate was found.",
            ],
            matchScore: "0.000",
            proposedExternalId: null,
            provider: "apple_music",
            providerName: "No Apple Music candidate found",
          });
          reviews += 1;
          candidateFree += 1;
        }
        continue;
      }
      for (const candidateId of entry.alternateCandidateIds) {
        const inserted = await tx
          .insert(artistMappingReviews)
          .values({
            artistId: entry.watchedArtistId,
            matchReasons: [
              ...entry.evidenceSources,
              entry.manualReviewReason ?? "Multiple Apple Music identities require review.",
            ],
            matchScore: "0.500",
            proposedExternalId: candidateId,
            provider: "apple_music",
            providerName: entry.canonicalArtistName,
          })
          .onConflictDoNothing()
          .returning({ id: artistMappingReviews.id });
        reviews += inserted.length;
      }
    }
    return { candidateFree, mappings, reviewArtists: reviewArtistIds.size, reviews };
  });
}

export async function createAppleMusicBatch(
  db: RadarDatabase,
  mappings: Array<{ appleArtistId: string; artistId: string }>,
  now = new Date(),
): Promise<string> {
  const existing = await db.query.appleMusicScanBatches.findFirst({
    where: inArray(appleMusicScanBatches.status, [
      "pending",
      "running",
      "partial",
      "paused",
      "rate_limited",
    ]),
    orderBy: [desc(appleMusicScanBatches.createdAt)],
  });
  if (existing) {
    const existingItems = await db
      .select({ artistId: appleMusicArtistScans.artistId })
      .from(appleMusicArtistScans)
      .where(eq(appleMusicArtistScans.batchId, existing.id));
    const requestedIds = new Set(mappings.map((mapping) => mapping.artistId));
    const compatible =
      existingItems.length === requestedIds.size &&
      existingItems.every((item) => requestedIds.has(item.artistId));
    if (!compatible) return createNewAppleMusicBatch(db, mappings, now);
    await db
      .update(appleMusicArtistScans)
      .set({ status: "retryable", updatedAt: now })
      .where(
        and(
          eq(appleMusicArtistScans.batchId, existing.id),
          eq(appleMusicArtistScans.status, "running"),
        ),
      );
    return existing.id;
  }
  return createNewAppleMusicBatch(db, mappings, now);
}

async function createNewAppleMusicBatch(
  db: RadarDatabase,
  mappings: Array<{ appleArtistId: string; artistId: string }>,
  now: Date,
): Promise<string> {
  const states = await db.select().from(appleMusicArtistState);
  const stateByArtist = new Map(states.map((state) => [state.artistId, state]));
  const windowEnd = now.toISOString().slice(0, 10);
  const floor = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const [batch] = await db
    .insert(appleMusicScanBatches)
    .values({ totalArtists: mappings.length, windowDays: 30 })
    .returning({ id: appleMusicScanBatches.id });
  if (!batch) throw new Error("Apple Music batch creation failed.");
  if (mappings.length) {
    await db.insert(appleMusicArtistScans).values(
      mappings.map((mapping, position) => {
        const previous = stateByArtist.get(mapping.artistId)?.lastSuccessfulAt;
        return {
          artistId: mapping.artistId,
          batchId: batch.id,
          position,
          providerArtistId: mapping.appleArtistId,
          windowEnd,
          windowStart: previous
            ? new Date(Math.max(previous.getTime(), Date.parse(`${floor}T00:00:00Z`)))
                .toISOString()
                .slice(0, 10)
            : floor,
        };
      }),
    );
  }
  return batch.id;
}

export async function attachAppleMusicBatchScanRun(
  db: RadarDatabase,
  batchId: string,
  scanRunId: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(appleMusicScanBatches)
    .set({
      scanRunId,
      startedAt: sql`coalesce(${appleMusicScanBatches.startedAt}, ${now.toISOString()}::timestamptz)`,
      status: "running",
      updatedAt: now,
    })
    .where(eq(appleMusicScanBatches.id, batchId));
}

export async function loadAppleMusicBatchItems(db: RadarDatabase, batchId: string) {
  return db
    .select()
    .from(appleMusicArtistScans)
    .where(
      and(
        eq(appleMusicArtistScans.batchId, batchId),
        inArray(appleMusicArtistScans.status, ["pending", "retryable"]),
        or(
          isNull(appleMusicArtistScans.retryEligibleAt),
          lte(appleMusicArtistScans.retryEligibleAt, new Date()),
        ),
      ),
    )
    .orderBy(asc(appleMusicArtistScans.position));
}

export async function startAppleMusicArtist(db: RadarDatabase, id: string): Promise<boolean> {
  const [row] = await db
    .update(appleMusicArtistScans)
    .set({
      errorClassification: null,
      startedAt: new Date(),
      status: "running",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appleMusicArtistScans.id, id),
        inArray(appleMusicArtistScans.status, ["pending", "retryable"]),
      ),
    )
    .returning({ id: appleMusicArtistScans.id });
  return Boolean(row);
}

export async function finishAppleMusicArtist(
  db: RadarDatabase,
  input: {
    candidateCount: number;
    errorClassification?: string;
    id: string;
    releaseCount: number;
    requestCount: number;
    retryEligibleAt?: Date;
    status: "completed" | "retryable" | "terminal";
  },
): Promise<void> {
  const row = await db.query.appleMusicArtistScans.findFirst({
    where: eq(appleMusicArtistScans.id, input.id),
  });
  if (!row) throw new Error("Apple Music artist scan was not found.");
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(appleMusicArtistScans)
      .set({
        candidateCount: input.candidateCount,
        ...(input.errorClassification ? { errorClassification: input.errorClassification } : {}),
        finishedAt: now,
        lastPersistedAt: now,
        releaseCount: input.releaseCount,
        requestCount: input.requestCount,
        ...(input.retryEligibleAt ? { retryEligibleAt: input.retryEligibleAt } : {}),
        status: input.status,
        updatedAt: now,
      })
      .where(eq(appleMusicArtistScans.id, input.id));
    await tx
      .insert(appleMusicArtistState)
      .values({
        artistId: row.artistId,
        ...(input.errorClassification ? { errorClassification: input.errorClassification } : {}),
        lastAttemptAt: now,
        ...(input.status === "completed" ? { lastSuccessfulAt: now } : {}),
        lastStatus: input.status,
        providerArtistId: row.providerArtistId,
        ...(input.retryEligibleAt ? { retryEligibleAt: input.retryEligibleAt } : {}),
      })
      .onConflictDoUpdate({
        target: appleMusicArtistState.artistId,
        set: {
          errorClassification: input.errorClassification ?? null,
          lastAttemptAt: now,
          ...(input.status === "completed" ? { lastSuccessfulAt: now } : {}),
          lastStatus: input.status,
          providerArtistId: row.providerArtistId,
          retryEligibleAt: input.retryEligibleAt ?? null,
          updatedAt: now,
        },
      });
    const totals = await tx
      .select({
        completed: sql<number>`count(*) filter (where ${appleMusicArtistScans.status} = 'completed')`,
        failed: sql<number>`count(*) filter (where ${appleMusicArtistScans.status} in ('retryable', 'terminal'))`,
      })
      .from(appleMusicArtistScans)
      .where(eq(appleMusicArtistScans.batchId, row.batchId));
    await tx
      .update(appleMusicScanBatches)
      .set({
        completedArtists: Number(totals[0]?.completed ?? 0),
        failedArtists: Number(totals[0]?.failed ?? 0),
        updatedAt: now,
      })
      .where(eq(appleMusicScanBatches.id, row.batchId));
  });
}

export async function finishAppleMusicBatch(
  db: RadarDatabase,
  batchId: string,
  status: "completed" | "partial" | "paused" | "rate_limited" | "failed",
): Promise<void> {
  const unfinished = await db
    .select({ count: sql<number>`count(*)` })
    .from(appleMusicArtistScans)
    .where(
      and(
        eq(appleMusicArtistScans.batchId, batchId),
        inArray(appleMusicArtistScans.status, ["pending", "running", "retryable"]),
      ),
    );
  const isFinished =
    status === "completed" ||
    status === "failed" ||
    (status === "partial" && Number(unfinished[0]?.count ?? 0) === 0);
  await db
    .update(appleMusicScanBatches)
    .set({
      finishedAt: isFinished ? new Date() : null,
      status,
      updatedAt: new Date(),
    })
    .where(eq(appleMusicScanBatches.id, batchId));
}

export async function countAppleMusicRequests(db: RadarDatabase, batchId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*) filter (where not ${appleMusicRequestEvents.cacheHit})` })
    .from(appleMusicRequestEvents)
    .where(eq(appleMusicRequestEvents.batchId, batchId));
  return Number(rows[0]?.count ?? 0);
}

async function ensureAppleMusicState(db: RadarDatabase): Promise<void> {
  await db.insert(appleMusicProviderState).values({ id: stateId }).onConflictDoNothing();
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
