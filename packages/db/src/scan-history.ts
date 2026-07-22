import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
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

export interface ScanHistoryPage {
  entries: ScanHistoryEntry[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function listScanHistory(
  db: RadarDatabase,
  requestedLimit = 50,
): Promise<ScanHistoryEntry[]> {
  return (await listScanHistoryPage(db, { limit: requestedLimit })).entries;
}

export async function listScanHistoryPage(
  db: RadarDatabase,
  options: { cursor?: string; limit?: number } = {},
): Promise<ScanHistoryPage> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 20), 50));
  const cursor = options.cursor ? decodeScanHistoryCursor(options.cursor) : null;
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
    .where(
      cursor
        ? or(
            lt(scanRuns.startedAt, cursor.startedAt),
            and(eq(scanRuns.startedAt, cursor.startedAt), lt(scanRuns.id, cursor.id)),
          )
        : undefined,
    )
    .orderBy(desc(scanRuns.startedAt), desc(scanRuns.id))
    .limit(limit + 1);
  const hasMore = runs.length > limit;
  const selectedRuns = runs.slice(0, limit);
  if (selectedRuns.length === 0) return { entries: [], hasMore: false, nextCursor: null };

  const runIds = selectedRuns.map((run) => run.id);
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

  const entries = selectedRuns.map((run) => {
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
  const last = selectedRuns.at(-1)!;
  return {
    entries,
    hasMore,
    nextCursor: hasMore ? encodeScanHistoryCursor(last.startedAt, last.id) : null,
  };
}

function encodeScanHistoryCursor(startedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ id, startedAt: startedAt.toISOString() })).toString(
    "base64url",
  );
}

function decodeScanHistoryCursor(value: string): { id: string; startedAt: Date } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Scan history cursor is malformed");
  }
  if (!isCursorRecord(parsed) || !isUuid(parsed.id)) {
    throw new Error("Scan history cursor is malformed");
  }
  const startedAt = new Date(parsed.startedAt);
  if (!Number.isFinite(startedAt.getTime())) throw new Error("Scan history cursor is malformed");
  return { id: parsed.id, startedAt };
}

function isCursorRecord(value: unknown): value is { id: string; startedAt: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "startedAt" in value &&
    typeof value.startedAt === "string"
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
