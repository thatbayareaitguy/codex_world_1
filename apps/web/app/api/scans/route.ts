import {
  createDatabase,
  getAppleMusicOperationalStatus,
  getSpotifyOperationalStatus,
  getSpotifySchedulerStatus,
  latestSpotifyBatch,
  listScanHistoryPage,
  musicbrainzArtistScans,
  musicbrainzProviderState,
  musicbrainzScanBatches,
  operationLocks,
  requestOperationCancellation,
  scanRuns,
  selectDefaultScanHistoryEntry,
  spotifyCoverageSummary,
  appleMusicArtistScans,
  appleMusicScanBatches,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, enforceRateLimit } from "../../../lib/request-security";
import { launchScanNow } from "../../../lib/scan-launcher";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const startScanSchema = z.object({
  artistId: z.uuid().optional(),
  musicbrainzBatchId: z.uuid().optional(),
  provider: z.enum(["apple_music", "mock", "musicbrainz", "spotify"]).optional(),
  since: z.iso.date().optional(),
});

const historyQuerySchema = z.object({
  historyCursor: z.string().min(1).max(1024).optional(),
  historyLimit: z.coerce.number().int().min(10).max(50).default(20),
});

interface ActiveScanLock {
  acquiredAt: Date;
  expiresAt: Date;
  metadata: unknown;
}

interface ScanProgressRun {
  provider: string | null;
  providersCompleted: string[];
  providersFailed: string[];
  startedAt: Date;
  status: string;
}

export async function GET(request?: NextRequest): Promise<NextResponse> {
  const configuration = loadProviderConfiguration();
  if (!configuration.databaseUrl) {
    return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
  }
  const connection = createDatabase(configuration.databaseUrl);
  try {
    const historyQuery = historyQuerySchema.parse(
      request ? Object.fromEntries(request.nextUrl.searchParams.entries()) : {},
    );
    const [
      runs,
      activeScanLock,
      spotifyOperational,
      spotifyBatch,
      history,
      musicbrainzState,
      musicbrainzBatch,
      spotifyCoverage,
      spotifyScheduler,
      appleMusicOperational,
      appleMusicBatch,
    ] = await Promise.all([
      connection.db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(20),
      connection.db.query.operationLocks.findFirst({
        where: and(
          eq(operationLocks.lockKey, "scan:global"),
          gt(operationLocks.expiresAt, new Date()),
        ),
        columns: { acquiredAt: true, expiresAt: true, metadata: true },
      }),
      getSpotifyOperationalStatus(connection.db),
      latestSpotifyBatch(connection.db),
      listScanHistoryPage(connection.db, {
        ...(historyQuery.historyCursor ? { cursor: historyQuery.historyCursor } : {}),
        limit: historyQuery.historyLimit,
      }),
      configuration.musicbrainz.enabled
        ? connection.db.query.musicbrainzProviderState.findFirst({
            where: eq(musicbrainzProviderState.id, "global"),
          })
        : Promise.resolve(undefined),
      configuration.musicbrainz.enabled
        ? connection.db.query.musicbrainzScanBatches.findFirst({
            orderBy: [desc(musicbrainzScanBatches.createdAt)],
          })
        : Promise.resolve(undefined),
      spotifyCoverageSummary(connection.db),
      getSpotifySchedulerStatus(connection.db),
      getAppleMusicOperationalStatus(connection.db),
      connection.db.query.appleMusicScanBatches.findFirst({
        orderBy: [desc(appleMusicScanBatches.createdAt)],
      }),
    ]);
    const appleMusicArtistRows = appleMusicBatch
      ? await connection.db
          .select()
          .from(appleMusicArtistScans)
          .where(eq(appleMusicArtistScans.batchId, appleMusicBatch.id))
          .orderBy(asc(appleMusicArtistScans.position))
      : [];
    const musicbrainzArtistRows =
      configuration.musicbrainz.enabled && musicbrainzBatch
        ? await connection.db
            .select()
            .from(musicbrainzArtistScans)
            .where(eq(musicbrainzArtistScans.batchId, musicbrainzBatch.id))
            .orderBy(asc(musicbrainzArtistScans.position))
        : [];
    const visibleRuns = configuration.musicbrainz.enabled
      ? runs
      : runs.filter((run) => run.provider !== "musicbrainz");
    const visibleHistory = configuration.musicbrainz.enabled
      ? history.entries
      : history.entries.filter((entry) => entry.provider !== "musicbrainz");
    const defaultHistory = selectDefaultScanHistoryEntry(visibleHistory);
    const requestedProviders = configuredScanProviders(configuration, activeScanLock?.metadata);
    return NextResponse.json(
      {
        appleMusic: {
          batch: appleMusicBatch ? { ...appleMusicBatch, artistScans: appleMusicArtistRows } : null,
          operational: appleMusicOperational,
        },
        active: activeScanLock
          ? describeActiveScan(activeScanLock, visibleRuns, requestedProviders)
          : null,
        defaultHistoryId: defaultHistory?.id ?? null,
        history: visibleHistory,
        historyHasMore: history.hasMore,
        historyNextCursor: history.nextCursor,
        latest: visibleRuns[0] ?? null,
        ...(configuration.musicbrainz.enabled
          ? {
              musicbrainz: {
                batch: musicbrainzBatch
                  ? { ...musicbrainzBatch, artistScans: musicbrainzArtistRows }
                  : null,
                operational: {
                  lastRequestStartedAt: musicbrainzState?.lastRequestStartedAt ?? null,
                  nextRequestAt: musicbrainzState?.nextRequestAt ?? null,
                  queueDepth: musicbrainzState?.queueDepth ?? 0,
                  requestCount: musicbrainzState?.requestCount ?? 0,
                },
              },
            }
          : {}),
        running: Boolean(activeScanLock),
        runs: visibleRuns,
        spotify: {
          batch: spotifyBatch,
          coverage: spotifyCoverage,
          limiter: {
            artistsPerBatch: configuration.spotify.artistsPerBatch,
            batchPauseSeconds: configuration.spotify.batchPauseSeconds,
            distributionHours: configuration.spotify.scanDistributionHours,
            minRequestIntervalMs: configuration.spotify.minRequestIntervalMs,
            maxRequestsPerRun: configuration.spotify.maxRequestsPerRun,
            reconciliationArtistsPerBatch: configuration.spotify.reconciliationArtistsPerBatch,
            reconciliationCycleDays: configuration.spotify.reconciliationCycleDays,
            reconciliationMaxPagesPerRun: configuration.spotify.reconciliationMaxPagesPerRun,
          },
          operational: spotifyOperational,
          scheduler: spotifyScheduler,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Unable to load scan history" }, { status: 500 });
  } finally {
    await connection.client.end();
  }
}

export function describeActiveScan(
  lock: ActiveScanLock,
  runs: ScanProgressRun[],
  providersRequested: string[],
) {
  const activeRuns = runs.filter((run) => run.startedAt >= lock.acquiredAt);
  const providersCompleted = uniqueProviders(
    activeRuns.flatMap((run) =>
      run.providersCompleted.length > 0
        ? run.providersCompleted
        : run.status === "completed" && run.provider
          ? [run.provider]
          : [],
    ),
  );
  const providersFailed = uniqueProviders(
    activeRuns.flatMap((run) =>
      run.providersFailed.length > 0
        ? run.providersFailed
        : run.status === "failed" && run.provider
          ? [run.provider]
          : [],
    ),
  );
  const metadata = isRecord(lock.metadata) ? lock.metadata : {};
  const metadataCompleted = stringArray(metadata.providersCompleted);
  const metadataFailed = stringArray(metadata.providersFailed);
  providersCompleted.push(
    ...metadataCompleted.filter((provider) => !providersCompleted.includes(provider)),
  );
  providersFailed.push(...metadataFailed.filter((provider) => !providersFailed.includes(provider)));
  const finished = new Set([...providersCompleted, ...providersFailed]);

  return {
    cancelRequested: metadata.cancelRequested === true,
    completedUnits: finiteNumber(metadata.completedUnits),
    currentProvider:
      stringValue(metadata.currentProvider) ??
      providersRequested.find((provider) => !finished.has(provider)) ??
      null,
    currentUnit: stringValue(metadata.currentUnit),
    currentStage: stringValue(metadata.currentStage),
    expiresAt: lock.expiresAt,
    heartbeatAt: stringValue(metadata.heartbeatAt),
    lastPersistedResult: stringValue(metadata.lastPersistedResult),
    phase: stringValue(metadata.phase),
    providersCompleted,
    providersFailed,
    providersRequested,
    rateLimitWaitMs: finiteNumber(metadata.rateLimitWaitMs),
    requests: finiteNumber(metadata.requests),
    retryAfterMs: finiteNumber(metadata.retryAfterMs),
    startedAt: lock.acquiredAt,
    totalUnits: finiteNumber(metadata.totalUnits),
  };
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 3);
    const configuration = loadProviderConfiguration();
    if (!configuration.databaseUrl) {
      return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
    }
    const connection = createDatabase(configuration.databaseUrl);
    try {
      const accepted = await requestOperationCancellation(connection.db, "scan:global");
      return accepted
        ? NextResponse.json({ accepted: true }, { status: 202 })
        : NextResponse.json({ error: "No active scan" }, { status: 404 });
    } finally {
      await connection.client.end();
    }
  } catch {
    return NextResponse.json({ error: "Unable to cancel the scan" }, { status: 500 });
  }
}

function configuredScanProviders(
  configuration: ReturnType<typeof loadProviderConfiguration>,
  metadata: unknown,
): string[] {
  const requested = scanProviderFromMetadata(metadata);
  if (requested && requested !== "all") return [requested];
  const configured = [
    ...(configuration.appleMusic.configured ? ["apple_music"] : []),
    ...(configuration.spotify.configured ? ["spotify"] : []),
    ...(configuration.musicbrainz.configured ? ["musicbrainz"] : []),
  ];
  return configured.length > 0 ? configured : ["mock"];
}

function scanProviderFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || !("provider" in metadata)) return null;
  const provider = metadata.provider;
  return typeof provider === "string" ? provider : null;
}

function uniqueProviders(providers: string[]): string[] {
  return [...new Set(providers)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    enforceRateLimit(request, 3);
    const body = startScanSchema.parse(await request.json().catch(() => ({})));
    if (body.musicbrainzBatchId && body.provider !== "musicbrainz") {
      return NextResponse.json(
        { error: "MusicBrainz batches require a MusicBrainz-only scan" },
        { status: 400 },
      );
    }
    const configuration = loadProviderConfiguration();
    if (
      (body.provider === "musicbrainz" || body.musicbrainzBatchId) &&
      !configuration.musicbrainz.enabled
    ) {
      return NextResponse.json(
        {
          error:
            "MusicBrainz is disabled. Set MUSICBRAINZ_ENABLED=true only for separately validated advanced use.",
        },
        { status: 403 },
      );
    }
    if (!configuration.databaseUrl) {
      return NextResponse.json({ error: "Database is not configured" }, { status: 503 });
    }

    const connection = createDatabase(configuration.databaseUrl);
    try {
      const activeScanLock = await connection.db.query.operationLocks.findFirst({
        where: and(
          eq(operationLocks.lockKey, "scan:global"),
          gt(operationLocks.expiresAt, new Date()),
        ),
        columns: { lockKey: true },
      });
      if (activeScanLock) {
        return NextResponse.json({ error: "A scan is already running" }, { status: 409 });
      }
    } finally {
      await connection.client.end();
    }

    const scanArguments = [
      ...(body.provider ? ["--provider", body.provider] : []),
      ...(body.artistId ? ["--artist", body.artistId] : []),
      ...(body.since ? ["--since", body.since] : []),
      ...(body.musicbrainzBatchId ? ["--musicbrainz-batch", body.musicbrainzBatchId] : []),
    ];
    await launchScanNow(undefined, undefined, undefined, scanArguments);
    return NextResponse.json(
      { accepted: true },
      { headers: { "Cache-Control": "no-store" }, status: 202 },
    );
  } catch {
    return NextResponse.json({ error: "Unable to start the scan" }, { status: 500 });
  }
}
