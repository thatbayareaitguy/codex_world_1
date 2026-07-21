import { desc, inArray } from "drizzle-orm";
import type { RadarDatabase } from "./client";
import { musicbrainzScanBatches, scanRuns, spotifyArtistScans, spotifyScanBatches } from "./schema";

export interface ScanHistoryEntry {
  artistCount: number | null;
  artistFilter: string | null;
  batchId: string | null;
  batchMode: string | null;
  completedAt: Date | null;
  createdCount: number;
  dryRun: boolean;
  failureCount: number | null;
  id: string;
  partialArtistCount: number | null;
  provider: string | null;
  providersRequested: string[];
  requestCount: number | null;
  reviewCount: number;
  startedAt: Date;
  status: string;
  triggerType: string;
  updatedCount: number;
}

export async function listScanHistory(
  db: RadarDatabase,
  requestedLimit = 50,
): Promise<ScanHistoryEntry[]> {
  const limit = Math.max(1, Math.min(Math.trunc(requestedLimit), 100));
  const runs = await db
    .select({
      artistFilter: scanRuns.artistFilter,
      artistsProcessedCount: scanRuns.artistsProcessedCount,
      completedAt: scanRuns.completedAt,
      dryRun: scanRuns.dryRun,
      id: scanRuns.id,
      insertedCount: scanRuns.insertedCount,
      provider: scanRuns.provider,
      providersFailed: scanRuns.providersFailed,
      providersRequested: scanRuns.providersRequested,
      reviewCount: scanRuns.reviewCount,
      startedAt: scanRuns.startedAt,
      status: scanRuns.status,
      triggerType: scanRuns.triggerType,
      updatedCount: scanRuns.updatedCount,
    })
    .from(scanRuns)
    .orderBy(desc(scanRuns.startedAt))
    .limit(limit);
  if (runs.length === 0) return [];

  const runIds = runs.map((run) => run.id);
  const [spotifyBatches, musicbrainzBatches] = await Promise.all([
    db.select().from(spotifyScanBatches).where(inArray(spotifyScanBatches.scanRunId, runIds)),
    db
      .select()
      .from(musicbrainzScanBatches)
      .where(inArray(musicbrainzScanBatches.scanRunId, runIds)),
  ]);
  const spotifyBatchIds = spotifyBatches.map((batch) => batch.id);
  const spotifyArtists =
    spotifyBatchIds.length > 0
      ? await db
          .select({
            batchId: spotifyArtistScans.batchId,
            requestCount: spotifyArtistScans.requestCount,
          })
          .from(spotifyArtistScans)
          .where(inArray(spotifyArtistScans.batchId, spotifyBatchIds))
      : [];
  const spotifyByRun = new Map(
    spotifyBatches.flatMap((batch) => (batch.scanRunId ? [[batch.scanRunId, batch] as const] : [])),
  );
  const musicbrainzByRun = new Map(
    musicbrainzBatches.flatMap((batch) =>
      batch.scanRunId ? [[batch.scanRunId, batch] as const] : [],
    ),
  );
  const requestsBySpotifyBatch = new Map<string, number>();
  for (const artist of spotifyArtists) {
    requestsBySpotifyBatch.set(
      artist.batchId,
      (requestsBySpotifyBatch.get(artist.batchId) ?? 0) + artist.requestCount,
    );
  }

  return runs.map((run) => {
    const spotifyBatch = spotifyByRun.get(run.id);
    const musicbrainzBatch = musicbrainzByRun.get(run.id);
    const batch = spotifyBatch ?? musicbrainzBatch;
    return {
      artistCount:
        batch?.totalArtists ??
        (run.artistFilter ? 1 : run.artistsProcessedCount > 0 ? run.artistsProcessedCount : null),
      artistFilter: run.artistFilter,
      batchId: batch?.id ?? null,
      batchMode: spotifyBatch?.mode ?? (musicbrainzBatch ? "musicbrainz" : null),
      completedAt: run.completedAt,
      createdCount: run.insertedCount,
      dryRun: run.dryRun,
      failureCount:
        spotifyBatch?.failedArtists ??
        musicbrainzBatch?.failedArtists ??
        (run.providersFailed.length > 0 ? run.providersFailed.length : null),
      id: run.id,
      partialArtistCount: spotifyBatch?.partialArtists ?? null,
      provider:
        run.provider ?? (run.providersRequested.length === 1 ? run.providersRequested[0]! : null),
      providersRequested: run.providersRequested,
      requestCount: spotifyBatch ? (requestsBySpotifyBatch.get(spotifyBatch.id) ?? 0) : null,
      reviewCount: run.reviewCount,
      startedAt: run.startedAt,
      status: run.status,
      triggerType: run.triggerType,
      updatedCount: run.updatedCount,
    };
  });
}

export function selectDefaultScanHistoryEntry(
  history: ScanHistoryEntry[],
): ScanHistoryEntry | null {
  return (
    history.find((run) => run.status === "running") ??
    history.find((run) => !run.dryRun && (run.artistCount ?? 0) > 1) ??
    history.find((run) => !run.dryRun) ??
    history[0] ??
    null
  );
}
