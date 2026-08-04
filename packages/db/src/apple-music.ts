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
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import {
  appleMusicComparisonRuns,
  appleMusicComparisons,
  appleMusicAlbums,
  appleMusicArtistMappings,
  appleMusicDurableArtistMappings,
  appleMusicIdentityCampaignEntries,
  appleMusicIdentityCampaigns,
  appleMusicMappingCandidates,
  appleMusicProviderState,
  appleMusicRecentCandidates,
  appleMusicRequestEvents,
  appleMusicResponseCache,
  appleMusicSongs,
  itunesPilotSnapshots,
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

export async function getConfirmedAppleMusicArtistMapping(
  db: RadarDatabase,
  input: {
    canonicalArtistId: string;
    snapshotId: string;
  },
): Promise<{ appleArtistId: string } | undefined> {
  const [mapping] = await db
    .select({
      appleArtistId: appleMusicArtistMappings.selectedAppleArtistId,
    })
    .from(appleMusicArtistMappings)
    .innerJoin(
      appleMusicComparisonRuns,
      eq(appleMusicComparisonRuns.id, appleMusicArtistMappings.runId),
    )
    .where(
      and(
        eq(appleMusicArtistMappings.canonicalArtistId, input.canonicalArtistId),
        eq(appleMusicComparisonRuns.snapshotId, input.snapshotId),
        inArray(appleMusicArtistMappings.status, [
          "existing_id_confirmed",
          "search_confirmed",
          "evidence_confirmed",
        ]),
      ),
    )
    .orderBy(desc(appleMusicArtistMappings.createdAt))
    .limit(1);
  return mapping?.appleArtistId ? { appleArtistId: mapping.appleArtistId } : undefined;
}

export type AppleMusicDurableConfirmationMethod =
  | "legacy_validated"
  | "manual_confirmation"
  | "high_confidence_seed"
  | "evidence_supported_seed"
  | "catalog_evidence";

export interface AppleMusicDurableArtistMapping {
  appleArtistId: string;
  artistName: string;
  canonicalArtistId: string;
  confirmationMethod: AppleMusicDurableConfirmationMethod;
  sourceClassification: string;
}

export async function getDurableAppleMusicArtistMapping(
  db: RadarDatabase,
  canonicalArtistId: string,
): Promise<AppleMusicDurableArtistMapping | undefined> {
  const [mapping] = await db
    .select({
      appleArtistId: appleMusicDurableArtistMappings.appleArtistId,
      artistName: appleMusicDurableArtistMappings.artistName,
      canonicalArtistId: appleMusicDurableArtistMappings.canonicalArtistId,
      confirmationMethod: appleMusicDurableArtistMappings.confirmationMethod,
      sourceClassification: appleMusicDurableArtistMappings.sourceClassification,
    })
    .from(appleMusicDurableArtistMappings)
    .where(eq(appleMusicDurableArtistMappings.canonicalArtistId, canonicalArtistId))
    .limit(1);
  return mapping as AppleMusicDurableArtistMapping | undefined;
}

export async function listDurableAppleMusicArtistMappings(
  db: RadarDatabase,
  canonicalArtistIds: string[],
): Promise<AppleMusicDurableArtistMapping[]> {
  if (canonicalArtistIds.length === 0) return [];
  const mappings = await db
    .select({
      appleArtistId: appleMusicDurableArtistMappings.appleArtistId,
      artistName: appleMusicDurableArtistMappings.artistName,
      canonicalArtistId: appleMusicDurableArtistMappings.canonicalArtistId,
      confirmationMethod: appleMusicDurableArtistMappings.confirmationMethod,
      sourceClassification: appleMusicDurableArtistMappings.sourceClassification,
    })
    .from(appleMusicDurableArtistMappings)
    .where(inArray(appleMusicDurableArtistMappings.canonicalArtistId, canonicalArtistIds));
  return mappings as AppleMusicDurableArtistMapping[];
}

export async function saveDurableAppleMusicArtistMapping(
  db: RadarDatabase,
  input: {
    appleArtistId: string;
    artifactHash?: string;
    artistName: string;
    canonicalArtistId: string;
    confirmationMethod: AppleMusicDurableConfirmationMethod;
    confirmedRunId: string;
    sourceClassification: string;
  },
): Promise<AppleMusicDurableArtistMapping> {
  await db
    .insert(appleMusicDurableArtistMappings)
    .values({
      appleArtistId: input.appleArtistId,
      ...(input.artifactHash ? { artifactHash: input.artifactHash } : {}),
      artistName: input.artistName,
      canonicalArtistId: input.canonicalArtistId,
      confirmationMethod: input.confirmationMethod,
      confirmedRunId: input.confirmedRunId,
      sourceClassification: input.sourceClassification,
    })
    .onConflictDoNothing();
  const existing = await getDurableAppleMusicArtistMapping(db, input.canonicalArtistId);
  if (!existing) throw new Error("Durable Apple Music mapping persistence failed.");
  if (existing.appleArtistId !== input.appleArtistId) {
    throw new Error("A durable Apple Music mapping cannot be replaced automatically.");
  }
  return existing;
}

export async function getLatestAppleMusicOperationalSnapshotId(
  db: RadarDatabase,
): Promise<string | undefined> {
  const [snapshot] = await db
    .select({ id: itunesPilotSnapshots.id })
    .from(itunesPilotSnapshots)
    .orderBy(desc(itunesPilotSnapshots.createdAt))
    .limit(1);
  return snapshot?.id;
}

export type AppleMusicIdentityCampaignStatus =
  "planned" | "running" | "completed" | "controlled_partial" | "failed";

export type AppleMusicIdentityCampaignEntryStatus =
  "pending" | "reused" | "confirmed" | "ambiguous" | "rejected" | "missing" | "manual_review";

export interface AppleMusicIdentityCampaignRecord {
  artifactHash: string;
  id: string;
  nextBatchIndex: number;
  stage: "strong_seeds" | "ambiguous_automation";
  status: AppleMusicIdentityCampaignStatus;
  watchlistHash: string;
}

export async function getAppleMusicIdentityCampaign(
  db: RadarDatabase,
  artifactHash: string,
  stage: "strong_seeds" | "ambiguous_automation",
): Promise<AppleMusicIdentityCampaignRecord | undefined> {
  const campaign = await db.query.appleMusicIdentityCampaigns.findFirst({
    where: and(
      eq(appleMusicIdentityCampaigns.artifactHash, artifactHash),
      eq(appleMusicIdentityCampaigns.stage, stage),
    ),
  });
  return campaign
    ? {
        artifactHash: campaign.artifactHash,
        id: campaign.id,
        nextBatchIndex: campaign.nextBatchIndex,
        stage: campaign.stage as AppleMusicIdentityCampaignRecord["stage"],
        status: campaign.status as AppleMusicIdentityCampaignStatus,
        watchlistHash: campaign.watchlistHash,
      }
    : undefined;
}

export async function startAppleMusicIdentityCampaign(
  db: RadarDatabase,
  input: {
    artifactHash: string;
    implementationCommit: string;
    runId: string;
    schemaVersion: number;
    stage: "strong_seeds" | "ambiguous_automation";
    watchlistHash: string;
  },
): Promise<AppleMusicIdentityCampaignRecord> {
  const now = new Date();
  const [inserted] = await db
    .insert(appleMusicIdentityCampaigns)
    .values({
      artifactHash: input.artifactHash,
      currentRunId: input.runId,
      implementationCommit: input.implementationCommit,
      schemaVersion: input.schemaVersion,
      stage: input.stage,
      startedAt: now,
      status: "running",
      watchlistHash: input.watchlistHash,
    })
    .onConflictDoNothing()
    .returning();
  const existing =
    inserted ??
    (await db.query.appleMusicIdentityCampaigns.findFirst({
      where: and(
        eq(appleMusicIdentityCampaigns.artifactHash, input.artifactHash),
        eq(appleMusicIdentityCampaigns.stage, input.stage),
      ),
    }));
  if (!existing) throw new Error("Apple Music identity campaign could not be created.");
  if (
    existing.watchlistHash !== input.watchlistHash ||
    existing.schemaVersion !== input.schemaVersion
  ) {
    throw new Error("Apple Music identity campaign artifact metadata changed.");
  }
  if (!inserted && existing.status !== "completed") {
    await db
      .update(appleMusicIdentityCampaigns)
      .set({
        currentRunId: input.runId,
        implementationCommit: input.implementationCommit,
        startedAt: existing.startedAt ?? now,
        status: "running",
        stopReason: null,
        updatedAt: now,
      })
      .where(eq(appleMusicIdentityCampaigns.id, existing.id));
  }
  return {
    artifactHash: existing.artifactHash,
    id: existing.id,
    nextBatchIndex: existing.nextBatchIndex,
    stage: existing.stage as AppleMusicIdentityCampaignRecord["stage"],
    status: inserted ? "running" : (existing.status as AppleMusicIdentityCampaignStatus),
    watchlistHash: existing.watchlistHash,
  };
}

export async function seedAppleMusicIdentityCampaignEntries(
  db: RadarDatabase,
  campaignId: string,
  entries: Array<{
    artifactClassification: string;
    candidateCount: number;
    canonicalArtistId: string;
    manualReviewReason?: string;
    status: AppleMusicIdentityCampaignEntryStatus;
    validationPath: string;
  }>,
): Promise<void> {
  if (entries.length === 0) return;
  await db
    .insert(appleMusicIdentityCampaignEntries)
    .values(
      entries.map((entry) => ({
        artifactClassification: entry.artifactClassification,
        campaignId,
        candidateCount: entry.candidateCount,
        canonicalArtistId: entry.canonicalArtistId,
        ...(entry.manualReviewReason ? { manualReviewReason: entry.manualReviewReason } : {}),
        status: entry.status,
        validationPath: entry.validationPath,
      })),
    )
    .onConflictDoNothing();
}

export async function listAppleMusicIdentityCampaignEntries(db: RadarDatabase, campaignId: string) {
  return db
    .select()
    .from(appleMusicIdentityCampaignEntries)
    .where(eq(appleMusicIdentityCampaignEntries.campaignId, campaignId));
}

export async function updateAppleMusicIdentityCampaignEntry(
  db: RadarDatabase,
  input: {
    batchIndex?: number;
    campaignId: string;
    canonicalArtistId: string;
    evidence: Record<string, unknown>;
    manualReviewReason?: string;
    selectedAppleArtistId?: string;
    selectedArtistName?: string;
    status: AppleMusicIdentityCampaignEntryStatus;
  },
): Promise<void> {
  await db
    .update(appleMusicIdentityCampaignEntries)
    .set({
      attempts: sql`${appleMusicIdentityCampaignEntries.attempts} + 1`,
      ...(input.batchIndex === undefined ? {} : { batchIndex: input.batchIndex }),
      evidence: input.evidence,
      manualReviewReason: input.manualReviewReason ?? null,
      selectedAppleArtistId: input.selectedAppleArtistId ?? null,
      selectedArtistName: input.selectedArtistName ?? null,
      status: input.status,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appleMusicIdentityCampaignEntries.campaignId, input.campaignId),
        eq(appleMusicIdentityCampaignEntries.canonicalArtistId, input.canonicalArtistId),
      ),
    );
}

export async function advanceAppleMusicIdentityCampaign(
  db: RadarDatabase,
  campaignId: string,
  nextBatchIndex: number,
): Promise<void> {
  await db
    .update(appleMusicIdentityCampaigns)
    .set({ nextBatchIndex, updatedAt: new Date() })
    .where(eq(appleMusicIdentityCampaigns.id, campaignId));
}

export async function finishAppleMusicIdentityCampaign(
  db: RadarDatabase,
  campaignId: string,
  input: {
    metrics: Record<string, unknown>;
    status: AppleMusicIdentityCampaignStatus;
    stopReason: string;
  },
): Promise<void> {
  await db
    .update(appleMusicIdentityCampaigns)
    .set({
      completedAt: new Date(),
      metrics: input.metrics,
      status: input.status,
      stopReason: input.stopReason.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(appleMusicIdentityCampaigns.id, campaignId));
}

export async function getLastSuccessfulAppleMusicRecentScan(
  db: RadarDatabase,
): Promise<Date | undefined> {
  const [run] = await db
    .select({ completedAt: appleMusicComparisonRuns.completedAt })
    .from(appleMusicComparisonRuns)
    .where(
      and(
        eq(appleMusicComparisonRuns.status, "completed"),
        sql`${appleMusicComparisonRuns.metrics}->>'mode' = 'recent_mvp'`,
      ),
    )
    .orderBy(desc(appleMusicComparisonRuns.completedAt))
    .limit(1);
  return run?.completedAt ?? undefined;
}

export async function saveAppleMusicRecentCandidates(
  db: RadarDatabase,
  input: {
    candidates: Array<{
      albumId?: string;
      albumTitle: string;
      appleArtistName: string;
      classification: string;
      comparisonTitle: string;
      granularity: "album" | "album_and_song" | "song";
      comparisonStatus: string;
      eligible: boolean;
      evidenceStrength: string;
      namedRemixer?: string;
      releaseDate?: string;
      songId?: string;
      songTitle?: string;
      sources: string[];
      upc?: string;
    }>;
    canonicalArtistId: string;
    runId: string;
  },
): Promise<void> {
  const now = new Date();
  for (const candidate of input.candidates) {
    const identityKey = createHash("sha256")
      .update(
        candidate.granularity === "song" && candidate.songId
          ? `song:${candidate.songId}`
          : candidate.albumId
            ? `album:${candidate.albumId}`
            : candidate.songId
              ? `song:${candidate.songId}`
              : [
                  normalizeText(candidate.appleArtistName),
                  normalizeText(candidate.comparisonTitle),
                  candidate.releaseDate ?? "",
                ].join(":"),
      )
      .digest("hex");
    await db
      .insert(appleMusicRecentCandidates)
      .values({
        ...(candidate.albumId ? { appleAlbumId: candidate.albumId } : {}),
        ...(candidate.songId ? { appleSongId: candidate.songId } : {}),
        albumTitle: candidate.albumTitle,
        appleArtistName: candidate.appleArtistName,
        candidateStatus: candidate.eligible ? "eligible" : "excluded",
        canonicalArtistId: input.canonicalArtistId,
        classification: candidate.classification,
        comparisonStatus: candidate.comparisonStatus,
        evidenceStrength: candidate.evidenceStrength,
        identityKey,
        lastRunId: input.runId,
        ...(candidate.namedRemixer ? { namedRemixer: candidate.namedRemixer } : {}),
        ...(candidate.releaseDate ? { releaseDate: candidate.releaseDate } : {}),
        ...(candidate.songTitle ? { songTitle: candidate.songTitle } : {}),
        sourceArms: candidate.sources,
        ...(candidate.upc ? { upc: candidate.upc } : {}),
      })
      .onConflictDoUpdate({
        target: [
          appleMusicRecentCandidates.canonicalArtistId,
          appleMusicRecentCandidates.identityKey,
        ],
        set: {
          appleAlbumId: candidate.albumId ?? null,
          appleArtistName: candidate.appleArtistName,
          appleSongId: candidate.songId ?? null,
          albumTitle: candidate.albumTitle,
          candidateStatus: candidate.eligible ? "eligible" : "excluded",
          classification: candidate.classification,
          comparisonStatus: candidate.comparisonStatus,
          evidenceStrength: candidate.evidenceStrength,
          lastRunId: input.runId,
          lastSeenAt: now,
          namedRemixer: candidate.namedRemixer ?? null,
          releaseDate: candidate.releaseDate ?? null,
          songTitle: candidate.songTitle ?? null,
          sourceArms: candidate.sources,
          upc: candidate.upc ?? null,
          updatedAt: now,
        },
      });
  }
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
