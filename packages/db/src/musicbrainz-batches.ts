import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { musicbrainzArtistScans, musicbrainzScanBatches } from "./schema";

export type MusicBrainzStage =
  "artist_start" | "release_groups" | "primary_releases" | "track_appearances";

export async function createMusicBrainzBatch(
  db: RadarDatabase,
  artistIds: string[],
): Promise<string> {
  const [batch] = await db
    .insert(musicbrainzScanBatches)
    .values({ status: "running", startedAt: new Date(), totalArtists: artistIds.length })
    .returning({ id: musicbrainzScanBatches.id });
  if (!batch) throw new Error("Unable to create MusicBrainz scan batch.");
  if (artistIds.length > 0) {
    await db
      .insert(musicbrainzArtistScans)
      .values(artistIds.map((artistId, position) => ({ artistId, batchId: batch.id, position })));
  }
  return batch.id;
}

export async function loadMusicBrainzBatchArtistIds(
  db: RadarDatabase,
  batchId: string,
): Promise<string[]> {
  const rows = await db
    .select({ artistId: musicbrainzArtistScans.artistId })
    .from(musicbrainzArtistScans)
    .where(
      and(
        eq(musicbrainzArtistScans.batchId, batchId),
        inArray(musicbrainzArtistScans.status, ["pending", "paused", "cancelled", "failed"]),
      ),
    )
    .orderBy(asc(musicbrainzArtistScans.position));
  return rows.map((row) => row.artistId);
}

export async function startMusicBrainzArtist(
  db: RadarDatabase,
  batchId: string,
  artistId: string,
): Promise<boolean> {
  const rows = await db
    .update(musicbrainzArtistScans)
    .set({
      errorClassification: null,
      lastHeartbeatAt: new Date(),
      stage: "artist_start",
      startedAt: new Date(),
      status: "running",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(musicbrainzArtistScans.batchId, batchId),
        eq(musicbrainzArtistScans.artistId, artistId),
        inArray(musicbrainzArtistScans.status, ["pending", "paused", "cancelled", "failed"]),
      ),
    )
    .returning({ id: musicbrainzArtistScans.id });
  return rows.length === 1;
}

export async function recordMusicBrainzStage(
  db: RadarDatabase,
  input: {
    artistId: string;
    batchId: string;
    candidateCount: number;
    releaseCount?: number;
    releaseGroupCount?: number;
    requestCount: number;
    stage: MusicBrainzStage;
  },
): Promise<void> {
  const completed = input.stage === "track_appearances";
  await db.transaction(async (tx) => {
    await tx
      .update(musicbrainzArtistScans)
      .set({
        candidateCount: sql`${musicbrainzArtistScans.candidateCount} + ${input.candidateCount}`,
        ...(completed ? { finishedAt: new Date(), status: "completed" as const } : {}),
        lastHeartbeatAt: new Date(),
        lastPersistedAt: new Date(),
        releaseCount: sql`${musicbrainzArtistScans.releaseCount} + ${input.releaseCount ?? 0}`,
        releaseGroupCount: sql`${musicbrainzArtistScans.releaseGroupCount} + ${input.releaseGroupCount ?? 0}`,
        requestCount: input.requestCount,
        stage: input.stage,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(musicbrainzArtistScans.batchId, input.batchId),
          eq(musicbrainzArtistScans.artistId, input.artistId),
        ),
      );
    if (completed) {
      await tx
        .update(musicbrainzScanBatches)
        .set({
          completedArtists: sql`${musicbrainzScanBatches.completedArtists} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(musicbrainzScanBatches.id, input.batchId));
    }
  });
}

export async function finishMusicBrainzBatch(
  db: RadarDatabase,
  batchId: string,
  status: "completed" | "cancelled" | "failed",
): Promise<void> {
  await db.transaction(async (tx) => {
    if (status === "cancelled" || status === "failed") {
      await tx
        .update(musicbrainzArtistScans)
        .set({
          errorClassification: status === "failed" ? "provider_failure" : null,
          finishedAt: new Date(),
          status,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(musicbrainzArtistScans.batchId, batchId),
            inArray(musicbrainzArtistScans.status, ["pending", "running"]),
          ),
        );
    }
    await tx
      .update(musicbrainzScanBatches)
      .set({
        cancelledArtists: sql`(select count(*)::int from ${musicbrainzArtistScans} where ${musicbrainzArtistScans.batchId} = ${batchId} and ${musicbrainzArtistScans.status} = 'cancelled')`,
        completedArtists: sql`(select count(*)::int from ${musicbrainzArtistScans} where ${musicbrainzArtistScans.batchId} = ${batchId} and ${musicbrainzArtistScans.status} = 'completed')`,
        failedArtists: sql`(select count(*)::int from ${musicbrainzArtistScans} where ${musicbrainzArtistScans.batchId} = ${batchId} and ${musicbrainzArtistScans.status} = 'failed')`,
        finishedAt: new Date(),
        status,
        updatedAt: new Date(),
      })
      .where(eq(musicbrainzScanBatches.id, batchId));
  });
}

export async function attachMusicBrainzBatchScanRun(
  db: RadarDatabase,
  batchId: string,
  scanRunId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(musicbrainzArtistScans)
      .set({
        candidateCount: 0,
        errorClassification: null,
        finishedAt: null,
        lastHeartbeatAt: null,
        lastPersistedAt: null,
        releaseCount: 0,
        releaseGroupCount: 0,
        requestCount: 0,
        stage: "pending",
        startedAt: null,
        status: "pending",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(musicbrainzArtistScans.batchId, batchId),
          inArray(musicbrainzArtistScans.status, ["paused", "cancelled", "failed"]),
        ),
      );
    await tx
      .update(musicbrainzScanBatches)
      .set({
        cancelRequested: false,
        cancelledArtists: 0,
        completedArtists: sql`(select count(*)::int from ${musicbrainzArtistScans} where ${musicbrainzArtistScans.batchId} = ${batchId} and ${musicbrainzArtistScans.status} = 'completed')`,
        failedArtists: 0,
        finishedAt: null,
        pauseRequested: false,
        scanRunId,
        startedAt: new Date(),
        status: "running",
        updatedAt: new Date(),
      })
      .where(eq(musicbrainzScanBatches.id, batchId));
  });
}
