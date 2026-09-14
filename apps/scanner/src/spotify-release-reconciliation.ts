import type {
  SpotifyReleaseReconciliationTarget,
  SpotifyReleaseTrackItemInput,
  SpotifyReleaseTrackProgressStatus,
} from "@radar/db";
import { SpotifyHttpError, spotifyNextOffset, type SpotifyAlbumTracksPage } from "@radar/providers";
import { randomUUID } from "node:crypto";

export interface SpotifyReleaseReconciliationOptions {
  maxPagesPerRelease: number;
  pageSize: number;
  releaseIds: string[];
}

export interface SpotifyReleaseReconciliationRepository {
  listTargets: (releaseIds: readonly string[]) => Promise<SpotifyReleaseReconciliationTarget[]>;
  markInterrupted: (input: {
    errorClassification: string;
    retryEligibleAt?: Date;
    spotifyAlbumId: string;
    status: "failed" | "paused" | "rate_limited";
  }) => Promise<void>;
  recordPage: (input: {
    errorClassification?: string;
    expectedTotalTracks: number;
    finishedAt: Date;
    items: SpotifyReleaseTrackItemInput[];
    nextOffset: number | null;
    offset: number;
    reconciliationCycleId?: string | null;
    spotifyAlbumId: string;
    startedAt: Date;
    terminal: boolean;
  }) => Promise<{ fetchedTrackCount: number; status: SpotifyReleaseTrackProgressStatus }>;
  start: (input: {
    expectedTotalTracks: number;
    reconciliationCycleId?: string | null;
    spotifyAlbumId: string;
  }) => Promise<void>;
  validateMappings: (input: {
    providerTrackIds: readonly string[];
    releaseId: string;
    spotifyAlbumId: string;
  }) => Promise<{
    missingAppearanceTrackIds: string[];
    missingCanonicalTrackIds: string[];
  }>;
}

export interface SpotifyReleaseTrackClient {
  getAlbumTracksPage: (
    id: string,
    offset: number,
    signal?: AbortSignal,
    limit?: number,
  ) => Promise<SpotifyAlbumTracksPage>;
  metrics: { failures: number; queueWaitMs: number; rateLimitWaitMs: number; requests: number };
}

export interface SpotifyReleaseReconciliationPageResult {
  duplicateProviderTrackIds: number;
  itemCount: number;
  nextOffset: number | null;
  offset: number;
  ordered: boolean;
  uniqueItemCount: number;
}

export interface SpotifyReleaseReconciliationResult {
  durationMs: number;
  expectedTotalTracks: number;
  finalFetchedTrackCount: number;
  finalNextOffset: number | null;
  finalStatus: SpotifyReleaseTrackProgressStatus;
  pages: SpotifyReleaseReconciliationPageResult[];
  releaseId: string;
  requestCount: number;
  skipped: boolean;
  spotifyAlbumId: string;
  startingFetchedTrackCount: number;
  startingOffset: number;
  title: string;
}

export interface SpotifyReleaseReconciliationSummary {
  durationMs: number;
  pageSize: number;
  queueWaitMs: number;
  releases: SpotifyReleaseReconciliationResult[];
  requests: number;
}

export async function runSpotifyReleaseReconciliation(
  options: SpotifyReleaseReconciliationOptions,
  dependencies: {
    client: SpotifyReleaseTrackClient;
    now?: () => Date;
    onProgress?: (progress: {
      nextOffset: number | null;
      offset: number;
      releaseId: string;
      status: SpotifyReleaseTrackProgressStatus;
    }) => Promise<void>;
    repository: SpotifyReleaseReconciliationRepository;
  },
): Promise<SpotifyReleaseReconciliationSummary> {
  validateOptions(options);
  const startedAtMs = Date.now();
  const now = dependencies.now ?? (() => new Date());
  const targets = await dependencies.repository.listTargets(options.releaseIds);
  const targetById = new Map(targets.map((target) => [target.releaseId, target]));
  const missing = options.releaseIds.filter((releaseId) => !targetById.has(releaseId));
  if (missing.length > 0 || targets.length !== options.releaseIds.length) {
    throw new Error(`Release reconciliation target validation failed for ${missing.join(", ")}.`);
  }

  const results: SpotifyReleaseReconciliationResult[] = [];
  for (const releaseId of options.releaseIds) {
    const target = targetById.get(releaseId)!;
    const releaseStartedAt = Date.now();
    const requestsBefore = dependencies.client.metrics.requests;
    if (target.status === "completed") {
      results.push({
        durationMs: 0,
        expectedTotalTracks: target.expectedTotalTracks,
        finalFetchedTrackCount: target.fetchedTrackCount,
        finalNextOffset: null,
        finalStatus: "completed",
        pages: [],
        releaseId,
        requestCount: 0,
        skipped: true,
        spotifyAlbumId: abbreviateSpotifyId(target.spotifyAlbumId),
        startingFetchedTrackCount: target.fetchedTrackCount,
        startingOffset: 0,
        title: target.title,
      });
      continue;
    }

    const resumesCycle = Boolean(target.reconciliationCycleId && (target.nextOffset ?? 0) > 0);
    const reconciliationCycleId = resumesCycle ? target.reconciliationCycleId! : randomUUID();
    let offset = resumesCycle ? target.nextOffset! : 0;
    const startingOffset = offset;
    let expectedTotalTracks = target.expectedTotalTracks;
    let finalFetchedTrackCount = resumesCycle ? target.fetchedTrackCount : 0;
    let finalStatus: SpotifyReleaseTrackProgressStatus = "in_progress";
    let finalNextOffset: number | null = offset;
    const pages: SpotifyReleaseReconciliationPageResult[] = [];

    await dependencies.repository.start({
      expectedTotalTracks,
      reconciliationCycleId,
      spotifyAlbumId: target.spotifyAlbumId,
    });
    try {
      for (let pageNumber = 0; pageNumber < options.maxPagesPerRelease; pageNumber += 1) {
        const pageStartedAt = now();
        const page = await dependencies.client.getAlbumTracksPage(
          target.spotifyAlbumId,
          offset,
          undefined,
          options.pageSize,
        );
        if (page.offset !== offset) {
          throw new Error(
            "Spotify album-track response offset did not match the requested offset.",
          );
        }
        expectedTotalTracks = page.total;
        const nextOffset = spotifyNextOffset(page.next, offset);
        const providerTrackIds = page.items.map((track) => track.id);
        const uniqueProviderTrackIds = [...new Set(providerTrackIds)];
        const ordered = albumTracksAreOrdered(page.items);
        if (!ordered) throw new Error("Spotify album tracks were not ordered by disc and track.");
        const mapping = await dependencies.repository.validateMappings({
          providerTrackIds: uniqueProviderTrackIds,
          releaseId,
          spotifyAlbumId: target.spotifyAlbumId,
        });
        if (
          mapping.missingCanonicalTrackIds.length > 0 ||
          mapping.missingAppearanceTrackIds.length > 0
        ) {
          throw new Error("Spotify album tracks do not match the canonical release appearances.");
        }
        const finishedAt = now();
        const persisted = await dependencies.repository.recordPage({
          expectedTotalTracks,
          finishedAt,
          items: page.items.map((track) => ({
            discNumber: track.disc_number,
            providerTrackId: track.id,
            trackNumber: track.track_number,
          })),
          nextOffset,
          offset,
          reconciliationCycleId,
          spotifyAlbumId: target.spotifyAlbumId,
          startedAt: pageStartedAt,
          terminal: page.next === null,
        });
        finalFetchedTrackCount = persisted.fetchedTrackCount;
        finalStatus = persisted.status;
        finalNextOffset = persisted.status === "completed" ? null : nextOffset;
        pages.push({
          duplicateProviderTrackIds: providerTrackIds.length - uniqueProviderTrackIds.length,
          itemCount: providerTrackIds.length,
          nextOffset,
          offset,
          ordered,
          uniqueItemCount: uniqueProviderTrackIds.length,
        });
        await dependencies.onProgress?.({
          nextOffset: finalNextOffset,
          offset,
          releaseId,
          status: finalStatus,
        });
        if (page.next === null || page.items.length === 0) break;
        offset = nextOffset!;
      }
    } catch (error) {
      await dependencies.repository.markInterrupted({
        errorClassification: classifyReconciliationError(error),
        spotifyAlbumId: target.spotifyAlbumId,
        status: isRateLimit(error) ? "rate_limited" : "failed",
      });
      throw error;
    }
    results.push({
      durationMs: Date.now() - releaseStartedAt,
      expectedTotalTracks,
      finalFetchedTrackCount,
      finalNextOffset,
      finalStatus,
      pages,
      releaseId,
      requestCount: dependencies.client.metrics.requests - requestsBefore,
      skipped: false,
      spotifyAlbumId: abbreviateSpotifyId(target.spotifyAlbumId),
      startingFetchedTrackCount: resumesCycle ? target.fetchedTrackCount : 0,
      startingOffset,
      title: target.title,
    });
  }

  return {
    durationMs: Date.now() - startedAtMs,
    pageSize: options.pageSize,
    queueWaitMs: dependencies.client.metrics.queueWaitMs,
    releases: results,
    requests: dependencies.client.metrics.requests,
  };
}

function validateOptions(options: SpotifyReleaseReconciliationOptions): void {
  if (options.releaseIds.length < 1 || options.releaseIds.length > 25) {
    throw new Error("Release reconciliation requires 1 to 25 explicit release IDs.");
  }
  if (new Set(options.releaseIds).size !== options.releaseIds.length) {
    throw new Error("Release reconciliation IDs must be unique.");
  }
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 50) {
    throw new Error("Release reconciliation page size must be an integer from 1 to 50.");
  }
  if (
    !Number.isInteger(options.maxPagesPerRelease) ||
    options.maxPagesPerRelease < 1 ||
    options.maxPagesPerRelease > 50
  ) {
    throw new Error("Maximum pages per release must be an integer from 1 to 50.");
  }
}

function albumTracksAreOrdered(items: SpotifyAlbumTracksPage["items"]): boolean {
  return items.every((track, index) => {
    const previous = items[index - 1];
    return (
      !previous ||
      track.disc_number > previous.disc_number ||
      (track.disc_number === previous.disc_number && track.track_number >= previous.track_number)
    );
  });
}

function classifyReconciliationError(error: unknown): string {
  if (error instanceof SpotifyHttpError && error.status === 429) return "rate_limited";
  if (isRecord(error) && error.code === "spotify_cooldown") return "spotify_cooldown";
  if (error instanceof Error && /mapping|appearance/i.test(error.message)) {
    return "canonical_mapping_mismatch";
  }
  if (error instanceof Error && /offset|ordered/i.test(error.message)) {
    return "invalid_album_track_page";
  }
  return "album_track_reconciliation_failed";
}

function isRateLimit(error: unknown): boolean {
  return (
    (error instanceof SpotifyHttpError && error.status === 429) ||
    (isRecord(error) && error.code === "spotify_cooldown")
  );
}

function abbreviateSpotifyId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
