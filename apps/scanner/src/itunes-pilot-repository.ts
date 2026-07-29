import type {
  ItunesCollectionCandidate,
  ItunesMappingDecision,
  ItunesReleaseComparison,
  ItunesTrackCandidate,
} from "@radar/core";
import type { ItunesArtist } from "@radar/providers";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { RadarDatabase } from "@radar/db";
import {
  itunesPilotArtistMappings,
  itunesPilotBatchExperiments,
  itunesPilotCollections,
  itunesPilotGroundTruthReleases,
  itunesPilotMatches,
  itunesPilotRequestEvents,
  itunesPilotRuns,
  itunesPilotSnapshotArtists,
  itunesPilotSnapshots,
  itunesPilotTracks,
} from "@radar/db";
import { extractVersion, normalizeText } from "@radar/core";
import type { ItunesPilotSnapshot } from "./itunes-pilot-snapshot";

export async function importItunesSnapshot(
  db: RadarDatabase,
  snapshot: ItunesPilotSnapshot,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(itunesPilotSnapshots)
      .values({
        artistCount: snapshot.artists.length,
        mainRepositoryCommit: snapshot.mainRepositoryCommit,
        mainSchemaVersion: snapshot.mainSchemaVersion,
        releaseCount: snapshot.groundTruthReleases.length,
        snapshotHash: snapshot.snapshotHash,
        snapshotTimestamp: new Date(snapshot.snapshotTimestamp),
        windowEnd: snapshot.windowEnd,
        windowStart: snapshot.windowStart,
      })
      .onConflictDoNothing()
      .returning({ id: itunesPilotSnapshots.id });
    const existing =
      inserted ??
      (await tx.query.itunesPilotSnapshots.findFirst({
        where: eq(itunesPilotSnapshots.snapshotHash, snapshot.snapshotHash),
        columns: { id: true },
      }));
    if (!existing) throw new Error("Snapshot could not be imported.");
    const existingArtistCount = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(itunesPilotSnapshotArtists)
      .where(eq(itunesPilotSnapshotArtists.snapshotId, existing.id));
    if ((existingArtistCount[0]?.count ?? 0) === 0) {
      await tx.insert(itunesPilotSnapshotArtists).values(
        snapshot.artists.map((artist) => ({
          aliases: artist.aliases,
          canonicalArtistId: artist.canonicalArtistId,
          canonicalName: artist.canonicalName,
          cohortReason: artist.cohortReason,
          genres: artist.genres,
          inclusionState: artist.inclusionState,
          normalizedName: artist.normalizedName,
          snapshotId: existing.id,
          spotifyArtistId: artist.spotifyArtistId,
          spotifyCoverageTimestamp: new Date(artist.spotifyCoverageTimestamp),
        })),
      );
      if (snapshot.groundTruthReleases.length > 0) {
        await tx.insert(itunesPilotGroundTruthReleases).values(
          snapshot.groundTruthReleases.map((release) => ({
            canonicalArtistId: release.canonicalArtistId,
            canonicalReleaseId: release.canonicalReleaseId,
            completenessState: release.completenessState,
            creditedArtists: release.creditedArtists,
            feedEligible: release.feedEligible,
            normalizedTitle: release.normalizedTitle,
            releaseDate: release.releaseDate,
            releaseDatePrecision: release.releaseDatePrecision,
            releaseType: release.releaseType,
            snapshotId: existing.id,
            spotifyReleaseId: release.spotifyReleaseId,
            title: release.title,
            trackCount: release.trackCount,
            tracks: release.tracks,
            version: release.version,
          })),
        );
      }
    }
    return existing.id;
  });
}

export async function createItunesPilotPlan(
  db: RadarDatabase,
  input: {
    implementationCommit: string;
    maximumRuntimeMs: number;
    minRequestIntervalMs: number;
    requestBudget: number;
    snapshotId: string;
  },
) {
  const [run] = await db
    .insert(itunesPilotRuns)
    .values({
      implementationCommit: input.implementationCommit,
      maximumRuntimeMs: input.maximumRuntimeMs,
      minRequestIntervalMs: input.minRequestIntervalMs,
      requestBudget: input.requestBudget,
      snapshotId: input.snapshotId,
      status: "planned",
    })
    .returning();
  if (!run) throw new Error("Pilot plan could not be created.");
  return run;
}

export async function latestItunesSnapshot(db: RadarDatabase) {
  return db.query.itunesPilotSnapshots.findFirst({
    orderBy: desc(itunesPilotSnapshots.snapshotTimestamp),
  });
}

export async function latestItunesRun(db: RadarDatabase) {
  return db.query.itunesPilotRuns.findFirst({
    orderBy: desc(itunesPilotRuns.createdAt),
  });
}

export async function startItunesRun(db: RadarDatabase, runId: string, now = new Date()) {
  const run = await db.query.itunesPilotRuns.findFirst({
    where: eq(itunesPilotRuns.id, runId),
  });
  if (!run || run.status !== "planned") throw new Error("Expected one planned iTunes pilot run.");
  const [started] = await db
    .update(itunesPilotRuns)
    .set({
      deadlineAt: new Date(now.getTime() + run.maximumRuntimeMs),
      startedAt: now,
      status: "running",
      updatedAt: now,
    })
    .where(and(eq(itunesPilotRuns.id, runId), eq(itunesPilotRuns.status, "planned")))
    .returning();
  if (!started) throw new Error("Pilot run could not be started.");
  return started;
}

export async function finishItunesRun(
  db: RadarDatabase,
  runId: string,
  input: {
    status: "completed" | "controlled_partial" | "failed";
    stopReason: string;
  },
) {
  const now = new Date();
  await db
    .update(itunesPilotRuns)
    .set({
      completedAt: now,
      status: input.status,
      stopReason: input.stopReason.slice(0, 500),
      updatedAt: now,
    })
    .where(eq(itunesPilotRuns.id, runId));
}

export async function updateItunesRunMetrics(
  db: RadarDatabase,
  runId: string,
  metrics: Record<string, number | string | boolean>,
) {
  await db
    .update(itunesPilotRuns)
    .set({ metrics, updatedAt: new Date() })
    .where(eq(itunesPilotRuns.id, runId));
}

export async function pilotArtists(db: RadarDatabase, snapshotId: string) {
  return db
    .select()
    .from(itunesPilotSnapshotArtists)
    .where(eq(itunesPilotSnapshotArtists.snapshotId, snapshotId))
    .orderBy(
      asc(itunesPilotSnapshotArtists.cohortReason),
      asc(itunesPilotSnapshotArtists.normalizedName),
    );
}

export async function pilotGroundTruth(
  db: RadarDatabase,
  snapshotId: string,
  canonicalArtistIds?: string[],
) {
  return db
    .select()
    .from(itunesPilotGroundTruthReleases)
    .where(
      canonicalArtistIds && canonicalArtistIds.length > 0
        ? and(
            eq(itunesPilotGroundTruthReleases.snapshotId, snapshotId),
            inArray(itunesPilotGroundTruthReleases.canonicalArtistId, canonicalArtistIds),
          )
        : eq(itunesPilotGroundTruthReleases.snapshotId, snapshotId),
    );
}

export async function saveItunesMapping(
  db: RadarDatabase,
  input: {
    candidates: ItunesArtist[];
    canonicalArtistId: string;
    decision: ItunesMappingDecision;
    runId: string;
  },
) {
  await db
    .insert(itunesPilotArtistMappings)
    .values({
      ambiguityReason: input.decision.ambiguityReason,
      candidates: input.candidates,
      canonicalArtistId: input.canonicalArtistId,
      confidence: input.decision.confidence.toFixed(3),
      decisionReason: input.decision.reason,
      evidence: input.decision.candidateEvidence ?? input.decision.evidence,
      runId: input.runId,
      selectedArtistId: input.decision.selected?.artistId,
      selectedArtistName: input.decision.selected?.artistName,
      status: input.decision.status,
    })
    .onConflictDoUpdate({
      target: [itunesPilotArtistMappings.runId, itunesPilotArtistMappings.canonicalArtistId],
      set: {
        ambiguityReason: input.decision.ambiguityReason,
        candidates: input.candidates,
        confidence: input.decision.confidence.toFixed(3),
        decisionReason: input.decision.reason,
        evidence: input.decision.candidateEvidence ?? input.decision.evidence,
        selectedArtistId: input.decision.selected?.artistId,
        selectedArtistName: input.decision.selected?.artistName,
        status: input.decision.status,
        updatedAt: new Date(),
      },
    });
}

export async function saveItunesCollections(
  db: RadarDatabase,
  input: {
    canonicalArtistId: string;
    collections: ItunesCollectionCandidate[];
    runId: string;
  },
) {
  for (const collection of input.collections) {
    await db
      .insert(itunesPilotCollections)
      .values({
        artistId: collection.artistId,
        artistName: collection.artistName,
        canonicalArtistId: input.canonicalArtistId,
        collectionArtistId: collection.collectionArtistId,
        collectionArtistName: collection.collectionArtistName,
        collectionId: collection.collectionId,
        collectionName: collection.collectionName,
        explicitness: collection.explicitness,
        normalizedTitle: normalizeText(collection.collectionName),
        primaryGenreName: collection.primaryGenreName,
        releaseDate: new Date(collection.releaseDate),
        releaseType: classifyPersistedReleaseType(collection),
        runId: input.runId,
        source: collection.source,
        trackCount: collection.trackCount,
        version: extractVersion(collection.collectionName),
        viewUrl: collection.viewUrl,
      })
      .onConflictDoUpdate({
        target: [
          itunesPilotCollections.runId,
          itunesPilotCollections.canonicalArtistId,
          itunesPilotCollections.collectionId,
        ],
        set: {
          source: collection.source,
          trackCount: collection.trackCount,
          updatedAt: new Date(),
        },
      });
  }
}

export async function saveItunesTracks(
  db: RadarDatabase,
  input: {
    canonicalArtistId: string;
    mappedArtistId: string;
    runId: string;
    tracks: ItunesTrackCandidate[];
  },
) {
  for (const track of input.tracks) {
    await db
      .insert(itunesPilotTracks)
      .values({
        appearance:
          track.artistId === input.mappedArtistId &&
          Boolean(track.collectionArtistId && track.collectionArtistId !== input.mappedArtistId),
        artistId: track.artistId,
        artistName: track.artistName,
        canonicalArtistId: input.canonicalArtistId,
        collectionArtistId: track.collectionArtistId,
        collectionArtistName: track.collectionArtistName,
        collectionId: track.collectionId,
        collectionName: track.collectionName,
        discCount: track.discCount,
        discNumber: track.discNumber,
        durationMs: track.trackTimeMillis,
        explicitness: track.explicitness,
        normalizedTitle: normalizeText(track.trackName),
        releaseDate: new Date(track.releaseDate),
        runId: input.runId,
        trackCount: track.trackCount,
        trackId: track.trackId,
        trackName: track.trackName,
        trackNumber: track.trackNumber,
        viewUrl: track.viewUrl,
      })
      .onConflictDoUpdate({
        target: [
          itunesPilotTracks.runId,
          itunesPilotTracks.canonicalArtistId,
          itunesPilotTracks.trackId,
        ],
        set: {
          appearance:
            track.artistId === input.mappedArtistId &&
            Boolean(track.collectionArtistId && track.collectionArtistId !== input.mappedArtistId),
          updatedAt: new Date(),
        },
      });
  }
}

export async function saveItunesComparisons(
  db: RadarDatabase,
  input: {
    canonicalArtistId: string;
    comparisons: ItunesReleaseComparison[];
    runId: string;
  },
) {
  for (const [index, comparison] of input.comparisons.entries()) {
    const identityKey = [
      input.canonicalArtistId,
      comparison.spotifyReleaseId ?? "none",
      comparison.appleCollectionId ?? "none",
      comparison.classification,
      index,
    ].join(":");
    await db
      .insert(itunesPilotMatches)
      .values({
        appleCollectionId: comparison.appleCollectionId,
        canonicalArtistId: input.canonicalArtistId,
        classification: comparison.classification,
        dateDifferenceDays: comparison.dateDifferenceDays,
        identityKey,
        reasons: comparison.reasons,
        runId: input.runId,
        spotifyReleaseId: comparison.spotifyReleaseId,
        trackCountAgreement: comparison.trackCountAgreement,
      })
      .onConflictDoNothing();
  }
}

export async function saveBatchExperiment(
  db: RadarDatabase,
  input: {
    artistIds: string[];
    batchResultCount: number;
    batchSize: number;
    entity: "album" | "song";
    individualResultCount: number;
    reasons: string[];
    runId: string;
    safe: boolean;
  },
) {
  await db
    .insert(itunesPilotBatchExperiments)
    .values({
      artistIds: input.artistIds,
      batchResultCount: input.batchResultCount,
      batchSize: input.batchSize,
      entity: input.entity,
      individualResultCount: input.individualResultCount,
      reasons: input.reasons,
      runId: input.runId,
      safe: input.safe,
    })
    .onConflictDoUpdate({
      target: [
        itunesPilotBatchExperiments.runId,
        itunesPilotBatchExperiments.entity,
        itunesPilotBatchExperiments.batchSize,
      ],
      set: {
        batchResultCount: input.batchResultCount,
        individualResultCount: input.individualResultCount,
        reasons: input.reasons,
        safe: input.safe,
      },
    });
}

export async function pilotEvaluationRows(db: RadarDatabase, runId: string) {
  const run = await db.query.itunesPilotRuns.findFirst({
    where: eq(itunesPilotRuns.id, runId),
  });
  if (!run) throw new Error("Pilot run was not found.");
  const snapshot = await db.query.itunesPilotSnapshots.findFirst({
    where: eq(itunesPilotSnapshots.id, run.snapshotId),
  });
  if (!snapshot) throw new Error("Pilot snapshot was not found.");
  const [artists, releases, mappings, collections, tracks, matches, requests, batches] =
    await Promise.all([
      pilotArtists(db, run.snapshotId),
      pilotGroundTruth(db, run.snapshotId),
      db.select().from(itunesPilotArtistMappings).where(eq(itunesPilotArtistMappings.runId, runId)),
      db.select().from(itunesPilotCollections).where(eq(itunesPilotCollections.runId, runId)),
      db.select().from(itunesPilotTracks).where(eq(itunesPilotTracks.runId, runId)),
      db.select().from(itunesPilotMatches).where(eq(itunesPilotMatches.runId, runId)),
      db
        .select()
        .from(itunesPilotRequestEvents)
        .where(eq(itunesPilotRequestEvents.runId, runId))
        .orderBy(asc(itunesPilotRequestEvents.startedAt)),
      db
        .select()
        .from(itunesPilotBatchExperiments)
        .where(eq(itunesPilotBatchExperiments.runId, runId))
        .orderBy(
          asc(itunesPilotBatchExperiments.batchSize),
          asc(itunesPilotBatchExperiments.entity),
        ),
    ]);
  return {
    artists,
    batches,
    collections,
    mappings,
    matches,
    releases,
    requests,
    run,
    snapshot,
    tracks,
  };
}

function classifyPersistedReleaseType(collection: ItunesCollectionCandidate): string {
  const normalized = normalizeText(collection.collectionName);
  if (normalized.includes("remix")) return "remix";
  if (normalized.includes("live")) return "live";
  if ((collection.trackCount ?? 0) <= 3) return "single";
  if ((collection.trackCount ?? 0) <= 6) return "ep";
  return "album";
}
