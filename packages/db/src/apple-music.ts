import {
  normalizeText,
  type AppleMusicMappingDecision,
  type AppleMusicReleaseComparison,
} from "@radar/core";
import type {
  AppleMusicAlbum,
  AppleMusicRequestPersistence,
  AppleMusicSong,
} from "@radar/providers";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  appleMusicComparisonRuns,
  appleMusicComparisons,
  appleMusicAlbums,
  appleMusicArtistMappings,
  appleMusicMappingCandidates,
  appleMusicProviderState,
  appleMusicRequestEvents,
  appleMusicResponseCache,
  appleMusicSongs,
} from "./schema";

const stateId = "global";
const leaseDurationMs = 30_000;

export class AppleMusicGateError extends Error {
  constructor(
    message: string,
    readonly classification:
      | "provider_cooldown"
      | "request_budget_exhausted"
      | "runtime_budget_exhausted"
      | "run_inactive",
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

export interface AppleMusicRequestPersistenceOptions {
  runLeaseToken?: string;
}

export function createAppleMusicRequestPersistence(
  db: RadarDatabase,
  options: AppleMusicRequestPersistenceOptions = {},
): AppleMusicRequestPersistence {
  return {
    acquire: async (input) => {
      if (!Number.isInteger(input.minIntervalMs) || input.minIntervalMs < 1_100) {
        throw new AppleMusicGateError(
          "Apple Music request interval must be at least 1100 milliseconds.",
          "run_inactive",
        );
      }
      await ensureState(db);
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
          const run = await db.query.appleMusicComparisonRuns.findFirst({
            where: eq(appleMusicComparisonRuns.id, input.runId),
          });
          if (!run || run.status !== "running") {
            throw new AppleMusicGateError(
              "The Apple Music comparison run is not active.",
              "run_inactive",
            );
          }
          if (run.deadlineAt && run.deadlineAt <= now) {
            throw new AppleMusicGateError(
              "The Apple Music runtime budget is exhausted.",
              "runtime_budget_exhausted",
            );
          }
          if (run.requestCount >= Math.min(run.requestBudget, input.maxRequests)) {
            throw new AppleMusicGateError(
              "The Apple Music request budget is exhausted.",
              "request_budget_exhausted",
            );
          }
          const state = await db.query.appleMusicProviderState.findFirst({
            where: eq(appleMusicProviderState.id, stateId),
          });
          if (state?.cooldownIndefinite || (state?.cooldownUntil && state.cooldownUntil > now)) {
            throw new AppleMusicGateError(
              "Apple Music requests are blocked by a persisted cooldown.",
              "provider_cooldown",
            );
          }
          if (
            options.runLeaseToken &&
            (state?.leaseOwner !== options.runLeaseToken ||
              !state.leaseExpiresAt ||
              state.leaseExpiresAt <= now)
          ) {
            throw new AppleMusicGateError(
              "The Apple Music pilot run lease is not active.",
              "run_inactive",
            );
          }
          const waitUntil = Math.max(
            state?.nextRequestAt?.getTime() ?? 0,
            !options.runLeaseToken && state?.leaseExpiresAt && state.leaseExpiresAt > now
              ? state.leaseExpiresAt.getTime()
              : 0,
          );
          if (waitUntil > now.getTime()) {
            await delay(Math.min(100, waitUntil - now.getTime()));
            continue;
          }
          const leaseToken = options.runLeaseToken ?? randomUUID();
          const eventId = randomUUID();
          const startedAt = new Date();
          const claimedRow = await db.transaction(async (tx) => {
            const [stateRow] = await tx
              .update(appleMusicProviderState)
              .set({
                lastRequestStartedAt: startedAt,
                ...(options.runLeaseToken
                  ? {}
                  : {
                      leaseExpiresAt: new Date(startedAt.getTime() + leaseDurationMs),
                      leaseOwner: leaseToken,
                    }),
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
                  options.runLeaseToken
                    ? and(
                        eq(appleMusicProviderState.leaseOwner, options.runLeaseToken),
                        gt(appleMusicProviderState.leaseExpiresAt, startedAt),
                      )
                    : or(
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
            const [runRow] = await tx
              .update(appleMusicComparisonRuns)
              .set({
                requestCount: sql`${appleMusicComparisonRuns.requestCount} + 1`,
                updatedAt: startedAt,
              })
              .where(
                and(
                  eq(appleMusicComparisonRuns.id, input.runId),
                  eq(appleMusicComparisonRuns.status, "running"),
                  sql`${appleMusicComparisonRuns.requestCount} < least(${appleMusicComparisonRuns.requestBudget}, ${input.maxRequests})`,
                ),
              )
              .returning({ id: appleMusicComparisonRuns.id });
            if (!runRow) {
              if (!options.runLeaseToken) {
                await tx
                  .update(appleMusicProviderState)
                  .set({
                    leaseExpiresAt: null,
                    leaseOwner: null,
                    updatedAt: startedAt,
                  })
                  .where(eq(appleMusicProviderState.leaseOwner, leaseToken));
              }
              return false;
            }
            await tx.insert(appleMusicRequestEvents).values({
              endpointCategory: input.endpointCategory,
              id: eventId,
              requestIdentity: input.identity,
              runId: input.runId,
              startedAt,
            });
            return true;
          });
          if (claimedRow) {
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
            ...(options.runLeaseToken ? {} : { leaseExpiresAt: null, leaseOwner: null }),
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
            columns: { requestIdentity: true },
          });
          if (event) {
            const serialized = JSON.stringify(input.cacheValue);
            const responseHash = createHash("sha256").update(serialized).digest("hex");
            await tx
              .insert(appleMusicResponseCache)
              .values({
                requestIdentity: event.requestIdentity,
                response: input.cacheValue,
                responseHash,
                storedAt: input.completedAt,
              })
              .onConflictDoUpdate({
                target: appleMusicResponseCache.requestIdentity,
                set: {
                  response: input.cacheValue,
                  responseHash,
                  storedAt: input.completedAt,
                  updatedAt: input.completedAt,
                },
              });
          }
        }
      });
    },
    loadCache: async (identity) => {
      const row = await db.query.appleMusicResponseCache.findFirst({
        where: eq(appleMusicResponseCache.requestIdentity, identity),
      });
      return row?.response ?? null;
    },
    recordCacheHit: async (input) => {
      const now = new Date();
      await db.insert(appleMusicRequestEvents).values({
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

export async function createAppleMusicComparisonRun(
  db: RadarDatabase,
  input: {
    implementationCommit: string;
    maximumRuntimeMs: number;
    minRequestIntervalMs: number;
    requestBudget: number;
    snapshotId: string;
  },
  now = new Date(),
) {
  const active = await db.query.appleMusicComparisonRuns.findFirst({
    where: eq(appleMusicComparisonRuns.status, "running"),
    columns: { id: true },
  });
  if (active) throw new Error("An Apple Music comparison run is already active.");
  const [run] = await db
    .insert(appleMusicComparisonRuns)
    .values({
      deadlineAt: new Date(now.getTime() + input.maximumRuntimeMs),
      implementationCommit: input.implementationCommit,
      maximumRuntimeMs: input.maximumRuntimeMs,
      minRequestIntervalMs: input.minRequestIntervalMs,
      requestBudget: input.requestBudget,
      snapshotId: input.snapshotId,
      startedAt: now,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("The Apple Music comparison run could not be created.");
  return run;
}

export async function claimAppleMusicPilotLease(
  db: RadarDatabase,
  runId: string,
  now = new Date(),
): Promise<string> {
  await ensureState(db);
  const run = await db.query.appleMusicComparisonRuns.findFirst({
    where: eq(appleMusicComparisonRuns.id, runId),
  });
  if (!run || run.status !== "running" || !run.deadlineAt || run.deadlineAt <= now) {
    throw new AppleMusicGateError("The Apple Music comparison run is not active.", "run_inactive");
  }
  const token = `pilot:${runId}:${randomUUID()}`;
  const [claimed] = await db
    .update(appleMusicProviderState)
    .set({
      leaseExpiresAt: run.deadlineAt,
      leaseOwner: token,
      updatedAt: now,
    })
    .where(
      and(
        eq(appleMusicProviderState.id, stateId),
        eq(appleMusicProviderState.cooldownIndefinite, false),
        or(
          isNull(appleMusicProviderState.cooldownUntil),
          lte(appleMusicProviderState.cooldownUntil, now),
        ),
        or(
          isNull(appleMusicProviderState.leaseExpiresAt),
          lte(appleMusicProviderState.leaseExpiresAt, now),
        ),
      ),
    )
    .returning({ id: appleMusicProviderState.id });
  if (!claimed) {
    const status = await getAppleMusicOperationalStatus(db, now);
    throw new AppleMusicGateError(
      status.cooldownActive
        ? "Apple Music requests are blocked by a persisted cooldown."
        : "An Apple Music request lease is already active.",
      status.cooldownActive ? "provider_cooldown" : "run_inactive",
    );
  }
  return token;
}

export async function releaseAppleMusicPilotLease(
  db: RadarDatabase,
  leaseToken: string,
  now = new Date(),
): Promise<void> {
  await db
    .update(appleMusicProviderState)
    .set({
      leaseExpiresAt: null,
      leaseOwner: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(appleMusicProviderState.id, stateId),
        eq(appleMusicProviderState.leaseOwner, leaseToken),
      ),
    );
}

export async function finishAppleMusicComparisonRun(
  db: RadarDatabase,
  runId: string,
  input: {
    metrics: Record<string, unknown>;
    status: "canary_completed" | "completed" | "controlled_partial" | "failed";
    stopReason: string;
  },
  now = new Date(),
): Promise<void> {
  await db
    .update(appleMusicComparisonRuns)
    .set({
      completedAt: now,
      metrics: input.metrics,
      status: input.status,
      stopReason: input.stopReason.slice(0, 500),
      updatedAt: now,
    })
    .where(eq(appleMusicComparisonRuns.id, runId));
}

export async function resetAppleMusicStateForTest(db: RadarDatabase): Promise<void> {
  await db.delete(appleMusicRequestEvents);
  await db.delete(appleMusicResponseCache);
  await db.delete(appleMusicProviderState);
}

export async function saveAppleMusicArtistMapping(
  db: RadarDatabase,
  input: {
    canonicalArtistId: string;
    decision: AppleMusicMappingDecision;
    inheritedItunesArtistId?: string;
    runId: string;
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [mapping] = await tx
      .insert(appleMusicArtistMappings)
      .values({
        canonicalArtistId: input.canonicalArtistId,
        confidence: input.decision.confidence.toFixed(3),
        decisionReason: input.decision.reason,
        evidence: input.decision.evidence,
        ...(input.inheritedItunesArtistId
          ? { inheritedItunesArtistId: input.inheritedItunesArtistId }
          : {}),
        runId: input.runId,
        ...(input.decision.selected
          ? {
              selectedAppleArtistId: input.decision.selected.artistId,
              selectedArtistName: input.decision.selected.name,
            }
          : {}),
        status: input.decision.status,
      })
      .onConflictDoUpdate({
        target: [appleMusicArtistMappings.runId, appleMusicArtistMappings.canonicalArtistId],
        set: {
          confidence: input.decision.confidence.toFixed(3),
          decisionReason: input.decision.reason,
          evidence: input.decision.evidence,
          inheritedItunesArtistId: input.inheritedItunesArtistId ?? null,
          selectedAppleArtistId: input.decision.selected?.artistId ?? null,
          selectedArtistName: input.decision.selected?.name ?? null,
          status: input.decision.status,
          updatedAt: now,
        },
      })
      .returning({ id: appleMusicArtistMappings.id });
    if (!mapping) throw new Error("Apple Music mapping persistence failed.");
    await tx
      .delete(appleMusicMappingCandidates)
      .where(eq(appleMusicMappingCandidates.mappingId, mapping.id));
    if (input.decision.candidates.length > 0) {
      await tx.insert(appleMusicMappingCandidates).values(
        input.decision.candidates.map((candidate) => {
          const evidence = input.decision.evidence.find(
            (item) => item.artistId === candidate.artistId,
          );
          return {
            appleArtistId: candidate.artistId,
            artistName: candidate.name,
            decision:
              candidate.artistId === input.decision.selected?.artistId
                ? "selected"
                : "not_selected",
            ...(candidate.evidenceUrl ? { evidenceUrl: candidate.evidenceUrl } : {}),
            evidence: evidence ?? {},
            mappingId: mapping.id,
            score: evidence?.score ?? 0,
          };
        }),
      );
    }
    return mapping.id;
  });
}

export async function saveAppleMusicCatalog(
  db: RadarDatabase,
  input: {
    albums: AppleMusicAlbum[];
    canonicalArtistId: string;
    runId: string;
    songs: AppleMusicSong[];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    for (const album of input.albums) {
      await tx
        .insert(appleMusicAlbums)
        .values({
          appleAlbumId: album.albumId,
          artistIds: album.artistIds,
          artistName: album.artistName,
          canonicalArtistId: input.canonicalArtistId,
          ...(album.contentRating ? { contentRating: album.contentRating } : {}),
          ...(album.evidenceUrl ? { evidenceUrl: album.evidenceUrl } : {}),
          ...(album.isCompilation === undefined ? {} : { isCompilation: album.isCompilation }),
          ...(album.isSingle === undefined ? {} : { isSingle: album.isSingle }),
          normalizedTitle: normalizeText(album.title),
          pageNumber: album.pageNumber,
          paginationPath: album.paginationPath,
          ...(album.releaseDate ? { releaseDate: album.releaseDate } : {}),
          runId: input.runId,
          sourceView: album.sourceView,
          title: album.title,
          ...(album.trackCount === undefined ? {} : { trackCount: album.trackCount }),
          ...(album.upc ? { upc: album.upc } : {}),
        })
        .onConflictDoUpdate({
          target: [
            appleMusicAlbums.runId,
            appleMusicAlbums.canonicalArtistId,
            appleMusicAlbums.appleAlbumId,
            appleMusicAlbums.sourceView,
          ],
          set: {
            artistIds: album.artistIds,
            artistName: album.artistName,
            contentRating: album.contentRating ?? null,
            evidenceUrl: album.evidenceUrl ?? null,
            isCompilation: album.isCompilation ?? null,
            isSingle: album.isSingle ?? null,
            normalizedTitle: normalizeText(album.title),
            pageNumber: album.pageNumber,
            paginationPath: album.paginationPath,
            releaseDate: album.releaseDate ?? null,
            title: album.title,
            trackCount: album.trackCount ?? null,
            upc: album.upc ?? null,
            updatedAt: now,
          },
        });
    }
    for (const song of input.songs) {
      await tx
        .insert(appleMusicSongs)
        .values({
          ...(song.albumId ? { appleAlbumId: song.albumId } : {}),
          appleSongId: song.songId,
          artistIds: song.artistIds,
          artistName: song.artistName,
          canonicalArtistId: input.canonicalArtistId,
          ...(song.contentRating ? { contentRating: song.contentRating } : {}),
          ...(song.discNumber === undefined ? {} : { discNumber: song.discNumber }),
          ...(song.durationMs === undefined ? {} : { durationMs: song.durationMs }),
          ...(song.evidenceUrl ? { evidenceUrl: song.evidenceUrl } : {}),
          ...(song.isrc ? { isrc: song.isrc } : {}),
          normalizedTitle: normalizeText(song.title),
          pageNumber: song.pageNumber,
          paginationPath: song.paginationPath,
          ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
          runId: input.runId,
          title: song.title,
          ...(song.trackNumber === undefined ? {} : { trackNumber: song.trackNumber }),
        })
        .onConflictDoUpdate({
          target: [
            appleMusicSongs.runId,
            appleMusicSongs.canonicalArtistId,
            appleMusicSongs.appleSongId,
          ],
          set: {
            appleAlbumId: song.albumId ?? null,
            artistIds: song.artistIds,
            artistName: song.artistName,
            contentRating: song.contentRating ?? null,
            discNumber: song.discNumber ?? null,
            durationMs: song.durationMs ?? null,
            evidenceUrl: song.evidenceUrl ?? null,
            isrc: song.isrc ?? null,
            normalizedTitle: normalizeText(song.title),
            pageNumber: song.pageNumber,
            paginationPath: song.paginationPath,
            releaseDate: song.releaseDate ?? null,
            title: song.title,
            trackNumber: song.trackNumber ?? null,
            updatedAt: now,
          },
        });
    }
  });
}

export async function saveAppleMusicComparisons(
  db: RadarDatabase,
  input: {
    canonicalArtistId: string;
    comparisons: AppleMusicReleaseComparison[];
    runId: string;
  },
): Promise<void> {
  for (const comparison of input.comparisons) {
    const appleAlbumId = comparison.apple?.collectionId;
    const identityKey = `${input.canonicalArtistId}:${comparison.spotifyReleaseId}`;
    await db
      .insert(appleMusicComparisons)
      .values({
        ...(appleAlbumId ? { appleAlbumId } : {}),
        canonicalArtistId: input.canonicalArtistId,
        classification: comparison.classification,
        ...(comparison.dateDifferenceDays === undefined
          ? {}
          : { dateDifferenceDays: comparison.dateDifferenceDays }),
        identityKey,
        reasons: comparison.reasons,
        runId: input.runId,
        spotifyReleaseId: comparison.spotifyReleaseId,
        ...(comparison.trackCountAgreement === undefined
          ? {}
          : { trackCountAgreement: comparison.trackCountAgreement }),
      })
      .onConflictDoNothing();
  }
}

async function ensureState(db: RadarDatabase): Promise<void> {
  await db.insert(appleMusicProviderState).values({ id: stateId }).onConflictDoNothing();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
