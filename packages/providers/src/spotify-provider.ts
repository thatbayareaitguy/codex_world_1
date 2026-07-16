import { createHash } from "node:crypto";
import {
  extractVersion,
  normalizeText,
  type ArtistCreditInput,
  type ReleaseType,
  type TrackCandidate,
} from "@radar/core";
import type { DiscoveryProvider, ScanContext } from "./contracts";
import type { SpotifyAlbum, SpotifyAlbumSummary, SpotifyClient, SpotifyTrack } from "./spotify";

export interface SpotifyArtistMapping {
  artistId: string;
  name: string;
  spotifyArtistId: string;
}

interface SpotifyProviderOptions {
  client: SpotifyClient;
  concurrency?: number;
  mappings: SpotifyArtistMapping[];
  now?: () => Date;
  region?: string;
}

export class SpotifyProvider implements DiscoveryProvider {
  readonly name = "spotify" as const;
  private readonly client: SpotifyClient;
  private readonly concurrency: number;
  private readonly mappings: SpotifyArtistMapping[];
  private readonly now: () => Date;
  private readonly region: string;

  constructor(options: SpotifyProviderOptions) {
    this.client = options.client;
    this.concurrency = options.concurrency ?? 4;
    this.mappings = options.mappings;
    this.now = options.now ?? (() => new Date());
    this.region = options.region ?? "US";
  }

  async scan(context: ScanContext): Promise<{
    candidates: TrackCandidate[];
    providerMetrics: { failures: number; requests: number; waitMs: number };
  }> {
    const mappings = this.mappings.filter(
      (mapping) =>
        (!context.filter.artistId || context.filter.artistId === mapping.artistId) &&
        (!context.filter.artistExternalId ||
          context.filter.artistExternalId === mapping.spotifyArtistId),
    );
    const candidates: TrackCandidate[] = [];
    for (const mapping of mappings) {
      const albums = await this.client.getArtistAlbums(mapping.spotifyArtistId, context.signal);
      const selected = albums.filter(
        (album) =>
          context.filter.full ||
          !context.filter.since ||
          normalizeSpotifyDate(album.release_date).date >= context.filter.since,
      );
      const discovered = await mapWithConcurrency(selected, this.concurrency, (album) =>
        this.scanAlbum(mapping, album, context.signal),
      );
      candidates.push(...discovered.flat());
    }
    return {
      candidates,
      providerMetrics: {
        failures: this.client.metrics.failures,
        requests: this.client.metrics.requests,
        waitMs: this.client.metrics.rateLimitWaitMs,
      },
    };
  }

  private async scanAlbum(
    mapping: SpotifyArtistMapping,
    summary: SpotifyAlbumSummary,
    signal?: AbortSignal,
  ): Promise<TrackCandidate[]> {
    const [album, trackSummaries] = await Promise.all([
      this.client.getAlbum(summary.id, signal),
      this.client.getAlbumTracks(summary.id, signal),
    ]);
    const tracks = await mapWithConcurrency(trackSummaries, this.concurrency, (track) =>
      this.client.getTrack(track.id, signal),
    );
    const releasePrimarilyWatched = album.artists.some(
      (artist) => artist.id === mapping.spotifyArtistId,
    );
    return tracks
      .filter(
        (track) =>
          releasePrimarilyWatched ||
          track.artists.some((artist) => artist.id === mapping.spotifyArtistId),
      )
      .map((track) => spotifyCandidate(mapping, album, track, this.now(), this.region));
  }
}

function spotifyCandidate(
  mapping: SpotifyArtistMapping,
  album: SpotifyAlbum,
  track: SpotifyTrack,
  firstSeen: Date,
  region: string,
): TrackCandidate {
  const credits = spotifyCredits(track, mapping.spotifyArtistId);
  const normalizedDate = normalizeSpotifyDate(album.release_date);
  const watchedPrimary = track.artists[0]?.id === mapping.spotifyArtistId;
  const releaseType = watchedPrimary ? classifySpotifyRelease(album, track.name) : "feature";
  const providerUrl = track.external_urls.spotify;
  const version = extractVersion(track.name);
  const base = {
    artistExternalId: mapping.spotifyArtistId,
    artistName: mapping.name,
    availability:
      track.is_playable === true
        ? ("playable" as const)
        : track.restrictions
          ? ("blocked" as const)
          : ("unavailable" as const),
    credits,
    discNumber: track.disc_number,
    durationMs: track.duration_ms,
    evidenceType: "spotify_track",
    evidenceUrl: providerUrl,
    externalReleaseId: album.id,
    externalTrackId: track.id,
    firstSeenAt: firstSeen.toISOString(),
    provider: "spotify" as const,
    providerUrl,
    region,
    releaseDate: normalizedDate.date,
    releaseDatePrecision: album.release_date_precision,
    releaseTitle: album.name,
    releaseType,
    sourceLabel: "Spotify catalog",
    title: track.name,
    trackNumber: track.track_number,
    ...(album.external_ids?.upc ? { upc: album.external_ids.upc } : {}),
    ...(album.external_ids?.ean ? { ean: album.external_ids.ean } : {}),
    ...(track.external_ids?.isrc ? { isrc: track.external_ids.isrc } : {}),
    ...(version ? { version } : {}),
  } satisfies Omit<TrackCandidate, "payloadHash">;
  return {
    ...base,
    payloadHash: createHash("sha256").update(JSON.stringify(base)).digest("hex"),
  };
}

function spotifyCredits(track: SpotifyTrack, watchedArtistId: string): ArtistCreditInput[] {
  return track.artists.map((artist, index) => ({
    name: artist.name,
    role: artist.id === watchedArtistId && index > 0 ? "featured" : "primary",
  }));
}

function classifySpotifyRelease(album: SpotifyAlbum, trackTitle: string): ReleaseType {
  const text = normalizeText(`${album.name} ${trackTitle}`);
  if (text.includes("remix")) return "remix";
  if (text.includes("live")) return "live";
  if (album.album_type === "single") return album.total_tracks > 1 ? "ep" : "single";
  if (album.album_type === "album") return "album";
  return "other";
}

function normalizeSpotifyDate(value: string): { date: string } {
  if (/^\d{4}$/.test(value)) return { date: `${value}-01-01` };
  if (/^\d{4}-\d{2}$/.test(value)) return { date: `${value}-01` };
  return { date: value };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  });
  await Promise.all(workers);
  return results;
}
