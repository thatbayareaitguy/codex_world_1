import { createHash } from "node:crypto";
import {
  createSpotifyReleaseArtwork,
  extractVersion,
  normalizeText,
  type ArtistCreditInput,
  type ReleaseType,
  type TrackCandidate,
} from "@radar/core";
import type { DiscoveryProvider, ProviderReleaseObservation, ScanContext } from "./contracts";
import type {
  SpotifyAlbum,
  SpotifyAlbumSummary,
  SpotifyClient,
  SpotifyTrackSummary,
} from "./spotify";

export interface SpotifyArtistMapping {
  artistId: string;
  name: string;
  spotifyArtistId: string;
}

interface SpotifyProviderOptions {
  client: SpotifyClient;
  mappings: SpotifyArtistMapping[];
  maxPagesPerArtist?: number;
  knownReleaseIds?: ReadonlySet<string>;
  now?: () => Date;
  region?: string;
}

export class SpotifyProvider implements DiscoveryProvider {
  readonly name = "spotify" as const;
  private readonly client: SpotifyClient;
  private readonly mappings: SpotifyArtistMapping[];
  private readonly maxPagesPerArtist: number;
  private readonly knownReleaseIds: ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly region: string;

  constructor(options: SpotifyProviderOptions) {
    this.client = options.client;
    this.mappings = options.mappings;
    this.maxPagesPerArtist = options.maxPagesPerArtist ?? 1;
    this.knownReleaseIds = options.knownReleaseIds ?? new Set();
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
    for (const [index, mapping] of mappings.entries()) {
      if (context.signal?.aborted) throw context.signal.reason;
      if (
        (await context.onUnitStart?.({
          currentUnit: mapping.name,
          currentUnitId: mapping.artistId,
          position: index,
          totalUnits: mappings.length,
        })) === false
      ) {
        break;
      }
      const albums = await this.client.getArtistAlbumsBounded(
        mapping.spotifyArtistId,
        this.maxPagesPerArtist,
        context.signal,
      );
      const releases = albums.items.map((album) =>
        releaseObservation(album, this.knownReleaseIds, context.filter),
      );
      const selected = albums.items.filter(
        (album) =>
          releases.find((release) => release.externalReleaseId === album.id)?.selectedForDetails,
      );
      const batchCandidates: TrackCandidate[] = [];
      for (const album of selected) {
        const candidates = await this.scanAlbum(mapping, album, context.signal);
        batchCandidates.push(...candidates);
        const release = releases.find((entry) => entry.externalReleaseId === album.id);
        if (release) release.candidateCount += candidates.length;
      }
      if (context.onBatch) {
        await context.onBatch({
          candidates: batchCandidates,
          completedUnits: index + 1,
          currentUnit: mapping.name,
          currentUnitId: mapping.artistId,
          pagesScanned: albums.pagesScanned,
          partial: albums.partial,
          providerMetrics: {
            failures: this.client.metrics.failures,
            requests: this.client.metrics.requests,
            waitMs: this.client.metrics.rateLimitWaitMs,
          },
          releases,
          totalUnits: mappings.length,
        });
      } else {
        candidates.push(...batchCandidates);
      }
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
    const album = await this.client.getAlbum(summary.id, signal);
    const tracks = [...album.tracks.items];
    if (album.tracks.next) {
      tracks.push(...(await this.client.getAlbumTracks(summary.id, signal, tracks.length)));
    }
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

function releaseObservation(
  album: SpotifyAlbumSummary,
  knownReleaseIds: ReadonlySet<string>,
  filter: ScanContext["filter"],
): ProviderReleaseObservation {
  const releaseDate = normalizeSpotifyDate(album.release_date).date;
  const backfillEligible = !filter.since || releaseDate >= filter.since;
  const known = knownReleaseIds.has(album.id);
  const selectedForDetails = Boolean(filter.full || (!known && backfillEligible));
  const reasons = selectedForDetails
    ? [
        filter.full
          ? "Explicit reconciliation includes the release"
          : `Release date is on or after backfill start ${filter.since ?? "unbounded"}`,
        ...(known ? ["Provider release ID is already known"] : ["Provider release ID is new"]),
      ]
    : [
        ...(known ? ["Provider release ID is already known"] : []),
        ...(!backfillEligible && filter.since
          ? [`Release date is before backfill start ${filter.since}`]
          : []),
      ];
  return {
    backfillEligible,
    candidateCount: 0,
    externalReleaseId: album.id,
    reasons,
    releaseDate,
    releaseDatePrecision: album.release_date_precision,
    releaseType: album.album_type,
    selectedForDetails,
    title: album.name,
  };
}

function spotifyCandidate(
  mapping: SpotifyArtistMapping,
  album: SpotifyAlbum,
  track: SpotifyTrackSummary,
  firstSeen: Date,
  region: string,
): TrackCandidate {
  const credits = spotifyCredits(track, mapping.spotifyArtistId);
  const normalizedDate = normalizeSpotifyDate(album.release_date);
  const watchedPrimary = track.artists[0]?.id === mapping.spotifyArtistId;
  const releaseType = watchedPrimary ? classifySpotifyRelease(album, track.name) : "feature";
  const providerUrl = track.external_urls.spotify;
  const version = extractVersion(track.name);
  const spotifyRelease = createSpotifyReleaseArtwork({
    albumId: album.id,
    albumUrl: album.external_urls.spotify,
    images: album.images,
    observedAt: firstSeen,
  });
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
    ...(spotifyRelease ? { spotifyRelease } : {}),
    ...(album.external_ids?.upc ? { upc: album.external_ids.upc } : {}),
    ...(album.external_ids?.ean ? { ean: album.external_ids.ean } : {}),
    ...(version ? { version } : {}),
  } satisfies Omit<TrackCandidate, "payloadHash">;
  return {
    ...base,
    payloadHash: createHash("sha256").update(JSON.stringify(base)).digest("hex"),
  };
}

function spotifyCredits(track: SpotifyTrackSummary, watchedArtistId: string): ArtistCreditInput[] {
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
