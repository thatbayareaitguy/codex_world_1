import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { spotifyArtistScans, spotifyScanBatches } from "./schema";

export type SpotifyScanMode = "initial" | "daily" | "reconciliation";
export type SpotifyArtistProgressStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "paused"
  | "cancelled"
  | "rate_limited"
  | "blocked_mapping"
  | "failed";

export interface SpotifyBatchArtistInput {
  artistId: string;
  spotifyArtistId?: string;
}

export async function createSpotifyScanBatch(
  db: RadarDatabase,
  input: {
    artists: SpotifyBatchArtistInput[];
    confirmationRequired: boolean;
    estimatedRequests: number;
    mode: SpotifyScanMode;
    pageLimit: number;
    scanRunId?: string;
  },
): Promise<string> {
  if (input.artists.length === 0) throw new Error("A Spotify batch requires at least one artist.");
  const [batch] = await db
    .insert(spotifyScanBatches)
    .values({
      ...(input.scanRunId ? { scanRunId: input.scanRunId } : {}),
      confirmationRequired: input.confirmationRequired,
      estimatedRequests: input.estimatedRequests,
      mode: input.mode,
      pageLimit: input.pageLimit,
      status: input.confirmationRequired ? "paused" : "pending",
      totalArtists: input.artists.length,
    })
    .returning({ id: spotifyScanBatches.id });
  if (!batch) throw new Error("Failed to create Spotify scan batch.");
  await db.insert(spotifyArtistScans).values(
    input.artists.map((artist, position) => ({
      artistId: artist.artistId,
      batchId: batch.id,
      position,
      providerArtistId: artist.spotifyArtistId,
      status: input.confirmationRequired ? ("paused" as const) : ("pending" as const),
    })),
  );
  return batch.id;
}

export async function recoverSpotifyBatch(db: RadarDatabase, batchId: string): Promise<void> {
  await db
    .update(spotifyArtistScans)
    .set({ status: "pending", startedAt: null, updatedAt: new Date() })
    .where(and(eq(spotifyArtistScans.batchId, batchId), eq(spotifyArtistScans.status, "running")));
}

export async function attachSpotifyBatchScanRun(
  db: RadarDatabase,
  batchId: string,
  scanRunId: string,
): Promise<void> {
  await db
    .update(spotifyScanBatches)
    .set({ scanRunId, updatedAt: new Date() })
    .where(eq(spotifyScanBatches.id, batchId));
}

export async function claimNextSpotifyArtist(db: RadarDatabase, batchId: string) {
  return db.transaction(async (tx) => {
    const batch = await tx.query.spotifyScanBatches.findFirst({
      where: eq(spotifyScanBatches.id, batchId),
    });
    if (!batch || batch.cancelRequested || batch.pauseRequested || batch.status === "cancelled") {
      return null;
    }
    const next = await tx.query.spotifyArtistScans.findFirst({
      where: and(eq(spotifyArtistScans.batchId, batchId), eq(spotifyArtistScans.status, "pending")),
      orderBy: [asc(spotifyArtistScans.position)],
    });
    if (!next) return null;
    const now = new Date();
    const [claimed] = await tx
      .update(spotifyArtistScans)
      .set({ lastHeartbeatAt: now, startedAt: now, status: "running", updatedAt: now })
      .where(and(eq(spotifyArtistScans.id, next.id), eq(spotifyArtistScans.status, "pending")))
      .returning();
    if (!claimed) return null;
    await tx
      .update(spotifyScanBatches)
      .set({ startedAt: batch.startedAt ?? now, status: "running", updatedAt: now })
      .where(eq(spotifyScanBatches.id, batchId));
    return claimed;
  });
}

export async function finishSpotifyArtistScan(
  db: RadarDatabase,
  input: {
    artistScanId: string;
    backfillReleaseCount?: number;
    candidateCount: number;
    errorClassification?: string;
    pagesScanned: number;
    releaseCount?: number;
    requestCount: number;
    retryEligibleAt?: Date;
    status: Exclude<SpotifyArtistProgressStatus, "pending" | "running">;
  },
): Promise<void> {
  const artist = await db.query.spotifyArtistScans.findFirst({
    where: eq(spotifyArtistScans.id, input.artistScanId),
    columns: { batchId: true },
  });
  if (!artist) throw new Error("Spotify artist scan progress was not found.");
  await db
    .update(spotifyArtistScans)
    .set({
      backfillReleaseCount: input.backfillReleaseCount ?? null,
      candidateCount: input.candidateCount,
      errorClassification: input.errorClassification?.slice(0, 100) ?? null,
      finishedAt: new Date(),
      pagesScanned: input.pagesScanned,
      releaseCount: input.releaseCount ?? null,
      requestCount: input.requestCount,
      retryEligibleAt: input.retryEligibleAt ?? null,
      status: input.status,
      updatedAt: new Date(),
    })
    .where(eq(spotifyArtistScans.id, input.artistScanId));
  await refreshSpotifyBatchCounts(db, artist.batchId);
}

export async function requestSpotifyBatchPause(
  db: RadarDatabase,
  batchId: string,
): Promise<boolean> {
  const rows = await db
    .update(spotifyScanBatches)
    .set({ pauseRequested: true, status: "paused", updatedAt: new Date() })
    .where(and(eq(spotifyScanBatches.id, batchId), eq(spotifyScanBatches.status, "running")))
    .returning({ id: spotifyScanBatches.id });
  return rows.length === 1;
}

export async function cancelSpotifyBatch(db: RadarDatabase, batchId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(spotifyScanBatches)
      .set({ cancelRequested: true, status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(spotifyScanBatches.id, batchId),
          inArray(spotifyScanBatches.status, ["pending", "running", "paused", "rate_limited"]),
        ),
      )
      .returning({ id: spotifyScanBatches.id });
    if (rows.length === 0) return false;
    await tx
      .update(spotifyArtistScans)
      .set({ finishedAt: new Date(), status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(spotifyArtistScans.batchId, batchId),
          inArray(spotifyArtistScans.status, ["pending", "paused"]),
        ),
      );
    return true;
  });
}

export async function resumeSpotifyBatch(db: RadarDatabase, batchId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(spotifyScanBatches)
      .set({
        confirmationRequired: false,
        pauseRequested: false,
        status: "pending",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(spotifyScanBatches.id, batchId),
          inArray(spotifyScanBatches.status, ["paused", "rate_limited", "pending"]),
        ),
      )
      .returning({ id: spotifyScanBatches.id });
    if (rows.length === 0) return false;
    await tx
      .update(spotifyArtistScans)
      .set({ status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(spotifyArtistScans.batchId, batchId),
          inArray(spotifyArtistScans.status, ["paused", "rate_limited"]),
        ),
      );
    return true;
  });
}

export async function retrySpotifyArtist(
  db: RadarDatabase,
  artistScanId: string,
): Promise<boolean> {
  const rows = await db
    .update(spotifyArtistScans)
    .set({
      errorClassification: null,
      finishedAt: null,
      retryEligibleAt: null,
      startedAt: null,
      status: "pending",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(spotifyArtistScans.id, artistScanId),
        inArray(spotifyArtistScans.status, [
          "failed",
          "rate_limited",
          "cancelled",
          "blocked_mapping",
        ]),
      ),
    )
    .returning({ id: spotifyArtistScans.id });
  return rows.length === 1;
}

export async function reconcileSpotifyBatchMappings(
  db: RadarDatabase,
  batchId: string,
  mappings: Array<{ artistId: string; spotifyArtistId: string }>,
): Promise<void> {
  const currentByArtist = new Map(
    mappings.map((mapping) => [mapping.artistId, mapping.spotifyArtistId] as const),
  );
  const rows = await db.query.spotifyArtistScans.findMany({
    where: and(
      eq(spotifyArtistScans.batchId, batchId),
      inArray(spotifyArtistScans.status, [
        "pending",
        "running",
        "paused",
        "rate_limited",
        "blocked_mapping",
      ]),
    ),
  });
  for (const row of rows) {
    const current = currentByArtist.get(row.artistId);
    const expected = row.providerArtistId;
    if (!current || (expected !== null && expected !== current)) {
      await db
        .update(spotifyArtistScans)
        .set({
          errorClassification: current ? "spotify_mapping_changed" : "spotify_mapping_missing",
          finishedAt: new Date(),
          lastHeartbeatAt: new Date(),
          status: "blocked_mapping",
          updatedAt: new Date(),
        })
        .where(eq(spotifyArtistScans.id, row.id));
      continue;
    }
    if (row.status === "blocked_mapping" || expected === null) {
      await db
        .update(spotifyArtistScans)
        .set({
          errorClassification: null,
          finishedAt: null,
          providerArtistId: current,
          startedAt: null,
          status: "pending",
          updatedAt: new Date(),
        })
        .where(eq(spotifyArtistScans.id, row.id));
    }
  }
  await refreshSpotifyBatchCounts(db, batchId);
}

export async function latestSpotifyBatch(db: RadarDatabase) {
  const batch = await db.query.spotifyScanBatches.findFirst({
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
  if (!batch) return null;
  const artistScans = await db.query.spotifyArtistScans.findMany({
    where: eq(spotifyArtistScans.batchId, batch.id),
    orderBy: (table, { asc }) => [asc(table.position)],
  });
  return { ...batch, artistScans };
}

async function refreshSpotifyBatchCounts(db: RadarDatabase, batchId: string): Promise<void> {
  const batch = await db.query.spotifyScanBatches.findFirst({
    where: eq(spotifyScanBatches.id, batchId),
    columns: { cancelRequested: true, pauseRequested: true },
  });
  const counts = await db
    .select({ status: spotifyArtistScans.status, count: sql<number>`count(*)::int` })
    .from(spotifyArtistScans)
    .where(eq(spotifyArtistScans.batchId, batchId))
    .groupBy(spotifyArtistScans.status);
  const count = (status: SpotifyArtistProgressStatus) =>
    counts.find((row) => row.status === status)?.count ?? 0;
  const remaining = count("pending") + count("running") + count("paused");
  const batchStatus = batch?.cancelRequested
    ? "cancelled"
    : batch?.pauseRequested
      ? "paused"
      : count("rate_limited") > 0
        ? "rate_limited"
        : remaining > 0
          ? "running"
          : count("blocked_mapping") > 0
            ? "blocked_mapping"
            : count("failed") > 0
              ? "failed"
              : "completed";
  await db
    .update(spotifyScanBatches)
    .set({
      cancelledArtists: count("cancelled"),
      blockedMappingArtists: count("blocked_mapping"),
      completedArtists: count("completed"),
      failedArtists: count("failed"),
      finishedAt: remaining === 0 ? new Date() : null,
      partialArtists: count("partial"),
      rateLimitedArtists: count("rate_limited"),
      status: batchStatus,
      updatedAt: new Date(),
    })
    .where(eq(spotifyScanBatches.id, batchId));
}
