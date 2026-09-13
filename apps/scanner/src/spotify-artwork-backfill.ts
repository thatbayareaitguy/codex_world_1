import { createSpotifyReleaseArtwork, type SpotifyReleaseArtwork } from "@radar/core";
import {
  artworkBackfillCompleted,
  hasValidSpotifyArtwork,
  type SpotifyArtworkBackfillRelease,
  type SpotifyArtworkBackfillRepository,
} from "@radar/db";
import { SpotifyHttpError, type SpotifyAlbum } from "@radar/providers";

export const spotifyArtworkBackfillMaximum = 25;

export interface SpotifyArtworkBackfillOptions {
  apply: boolean;
  limit: number;
  resume: boolean;
}

export interface SpotifyArtworkAlbumClient {
  getAlbum(id: string): Promise<SpotifyAlbum>;
  metrics: { queueWaitMs: number; requests: number };
}

export interface SpotifyArtworkBackfillSelection {
  internalReleaseId: string;
  title: string;
}

export interface SpotifyArtworkBackfillSummary {
  dryRun: boolean;
  durationMs: number;
  failed: number;
  processed: number;
  queueWaitMs: number;
  remaining: number;
  requests: number;
  selected: SpotifyArtworkBackfillSelection[];
  skipped: number;
  stoppedReason: "completed" | "cooldown" | "failed" | "rate_limited";
  unavailable: number;
  updated: number;
  wouldUpdate: number;
}

export function parseSpotifyArtworkBackfillOptions(args: string[]): SpotifyArtworkBackfillOptions {
  let apply = false;
  let dryRun = false;
  let limit: number | undefined;
  let resume = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--resume") resume = true;
    else if (arg === "--limit") {
      const value = args[index + 1];
      if (!value) throw new Error("--limit requires an integer value.");
      limit = Number(value);
      index += 1;
    } else {
      throw new Error(`Unknown artwork backfill option: ${arg ?? ""}`);
    }
  }
  if (apply && dryRun) throw new Error("Choose either --apply or --dry-run, not both.");
  if (
    !Number.isInteger(limit) ||
    (limit ?? 0) < 1 ||
    (limit ?? 0) > spotifyArtworkBackfillMaximum
  ) {
    throw new Error(`--limit must be an integer from 1 to ${spotifyArtworkBackfillMaximum}.`);
  }
  return { apply, limit: limit!, resume };
}

export async function runSpotifyArtworkBackfill(
  options: SpotifyArtworkBackfillOptions,
  dependencies: {
    client: SpotifyArtworkAlbumClient;
    now?: () => Date;
    repository: SpotifyArtworkBackfillRepository;
  },
): Promise<SpotifyArtworkBackfillSummary> {
  const startedAt = Date.now();
  const now = dependencies.now ?? (() => new Date());
  const all = await dependencies.repository.listReleases();
  const releases = canonicalBackfillWork(all);
  const cursor = options.resume ? await dependencies.repository.loadCursor() : null;
  const cursorIndex = cursor
    ? releases.findIndex((release) => release.externalRowId === cursor)
    : -1;
  const candidates = releases
    .slice(cursorIndex + 1)
    .filter((release) => !artworkBackfillCompleted(release.providerFields))
    .slice(0, options.limit);
  const summary: SpotifyArtworkBackfillSummary = {
    dryRun: !options.apply,
    durationMs: 0,
    failed: 0,
    processed: 0,
    queueWaitMs: 0,
    remaining: releases.filter((release) => !artworkBackfillCompleted(release.providerFields))
      .length,
    requests: 0,
    selected: candidates.map(({ releaseId, title }) => ({ internalReleaseId: releaseId, title })),
    skipped: releases.filter((release) => hasValidSpotifyArtwork(release.providerFields)).length,
    stoppedReason: "completed",
    unavailable: 0,
    updated: 0,
    wouldUpdate: 0,
  };

  for (const release of candidates) {
    summary.processed += 1;
    if (!isSpotifyAlbumId(release.externalId)) {
      summary.unavailable += 1;
      if (options.apply) {
        await dependencies.repository.markUnavailable(release, now());
        await dependencies.repository.persistCursor(release.externalRowId);
        summary.remaining -= 1;
      }
      continue;
    }

    try {
      const album = await dependencies.client.getAlbum(release.externalId);
      const artwork = albumArtwork(album, release, now());
      if (!artwork) {
        summary.unavailable += 1;
        if (options.apply) {
          await dependencies.repository.markUnavailable(release, now());
          await dependencies.repository.persistCursor(release.externalRowId);
          summary.remaining -= 1;
        }
        continue;
      }
      summary.wouldUpdate += 1;
      if (options.apply) {
        await dependencies.repository.persistArtwork(release, artwork);
        await dependencies.repository.persistCursor(release.externalRowId);
        summary.updated += 1;
        summary.remaining -= 1;
      }
    } catch (error) {
      summary.failed += 1;
      summary.stoppedReason = classifyStop(error);
      break;
    }
  }

  summary.requests = dependencies.client.metrics.requests;
  summary.queueWaitMs = dependencies.client.metrics.queueWaitMs;
  summary.durationMs = Date.now() - startedAt;
  return summary;
}

function canonicalBackfillWork(
  rows: SpotifyArtworkBackfillRelease[],
): SpotifyArtworkBackfillRelease[] {
  const groups = new Map<string, SpotifyArtworkBackfillRelease[]>();
  for (const row of rows) {
    const group = groups.get(row.releaseId);
    if (group) group.push(row);
    else groups.set(row.releaseId, [row]);
  }
  return [...groups.values()].flatMap((group) => {
    const withArtwork = group.find((release) => hasValidSpotifyArtwork(release.providerFields));
    if (withArtwork) return [withArtwork];
    const incomplete = group.find((release) => !artworkBackfillCompleted(release.providerFields));
    return incomplete ? [incomplete] : [group[0]!];
  });
}

function albumArtwork(
  album: SpotifyAlbum,
  release: SpotifyArtworkBackfillRelease,
  observedAt: Date,
): SpotifyReleaseArtwork | null {
  if (album.id !== release.externalId) return null;
  return createSpotifyReleaseArtwork({
    albumId: album.id,
    albumUrl: album.external_urls.spotify,
    images: album.images,
    observedAt,
  });
}

function classifyStop(error: unknown): SpotifyArtworkBackfillSummary["stoppedReason"] {
  if (error instanceof SpotifyHttpError && error.status === 429) return "rate_limited";
  if (isRecord(error) && error.code === "spotify_cooldown") return "cooldown";
  return "failed";
}

function isSpotifyAlbumId(value: string): boolean {
  return /^[A-Za-z0-9]{22}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
