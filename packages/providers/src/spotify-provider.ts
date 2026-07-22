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
  deferReleaseDetails?: boolean;
  mappings: SpotifyArtistMapping[];
  maxPagesPerArtist?: number;
  knownReleaseIds?: ReadonlySet<string>;
  knownReleaseSummaries?: ReadonlyMap<string, string>;
  incompleteReleaseIds?: ReadonlySet<string>;
  now?: () => Date;
  region?: string;
  startOffsets?: ReadonlyMap<string, number>;
  releaseTrackResume?: ReadonlyMap<
    string,
    { nextOffset: number; status: "partial" | "paused" | "rate_limited" | "failed" }
  >;
}

export class SpotifyProvider implements DiscoveryProvider {
  readonly name = "spotify" as const;
  private readonly client: SpotifyClient;
  private readonly deferReleaseDetails: boolean;
  private readonly mappings: SpotifyArtistMapping[];
  private readonly maxPagesPerArtist: number;
  private readonly knownReleaseIds: ReadonlySet<string>;
  private readonly knownReleaseSummaries: ReadonlyMap<string, string>;
  private readonly incompleteReleaseIds: ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly region: string;
  private readonly startOffsets: ReadonlyMap<string, number>;
  private readonly releaseTrackResume: ReadonlyMap<
    string,
    { nextOffset: number; status: "partial" | "paused" | "rate_limited" | "failed" }
  >;

  constructor(options: SpotifyProviderOptions) {
    this.client = options.client;
    this.deferReleaseDetails = options.deferReleaseDetails ?? false;
    this.mappings = options.mappings;
    this.maxPagesPerArtist = options.maxPagesPerArtist ?? 1;
    this.knownReleaseIds = options.knownReleaseIds ?? new Set();
    this.knownReleaseSummaries = options.knownReleaseSummaries ?? new Map();
    this.incompleteReleaseIds = options.incompleteReleaseIds ?? new Set();
    this.now = options.now ?? (() => new Date());
    this.region = options.region ?? "US";
    this.startOffsets = options.startOffsets ?? new Map();
    this.releaseTrackResume = options.releaseTrackResume ?? new Map();
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
      const batchCandidates: TrackCandidate[] = [];
      const batchReleases: ProviderReleaseObservation[] = [];
      const seenReleaseIds = new Set<string>();
      let offset = this.startOffsets.get(mapping.artistId) ?? 0;
      let pagesScanned = 0;
      let partial = false;
      while (pagesScanned < this.maxPagesPerArtist) {
        const pageStartedAt = this.now();
        const page = await this.client.getArtistAlbumsPage(
          mapping.spotifyArtistId,
          offset,
          context.signal,
        );
        const pageNumber = Math.floor(offset / 10) + 1;
        const releases = page.items.map((album) =>
          releaseObservation(
            mapping.artistId,
            album,
            this.knownReleaseIds,
            this.knownReleaseSummaries,
            context.filter,
            seenReleaseIds.has(album.id),
            this.incompleteReleaseIds.has(album.id),
          ),
        );
        const pageCandidates: TrackCandidate[] = [];
        let albumDetailRequests = 0;
        for (const album of page.items) {
          const release = releases.find((entry) => entry.externalReleaseId === album.id);
          if (!release?.selectedForDetails || this.deferReleaseDetails) continue;
          const requestsBeforeAlbum = this.client.metrics.requests;
          const candidates = await this.scanReleaseDetails(mapping, album, context);
          albumDetailRequests += this.client.metrics.requests - requestsBeforeAlbum;
          pageCandidates.push(...candidates);
          release.candidateCount += candidates.length;
        }
        page.items.forEach((album) => seenReleaseIds.add(album.id));
        batchCandidates.push(...pageCandidates);
        batchReleases.push(...releases);
        pagesScanned += 1;
        const pageFinishedAt = this.now();
        await context.onPage?.({
          albumDetailRequests,
          candidates: pageCandidates,
          currentUnit: mapping.name,
          currentUnitId: mapping.artistId,
          durationMs: Math.max(0, pageFinishedAt.getTime() - pageStartedAt.getTime()),
          finishedAt: pageFinishedAt,
          itemCount: page.items.length,
          nextOffset: page.nextOffset,
          offset,
          pageNumber,
          providerMetrics: {
            failures: this.client.metrics.failures,
            requests: this.client.metrics.requests,
            waitMs: this.client.metrics.rateLimitWaitMs,
          },
          releases,
          startedAt: pageStartedAt,
          totalItems: page.total,
        });
        partial = page.nextOffset !== null;
        if (page.nextOffset === null || page.items.length === 0) break;
        offset = page.nextOffset;
      }
      if (context.onBatch) {
        await context.onBatch({
          candidates: batchCandidates,
          completedUnits: index + 1,
          currentUnit: mapping.name,
          currentUnitId: mapping.artistId,
          pagesScanned,
          partial,
          providerMetrics: {
            failures: this.client.metrics.failures,
            requests: this.client.metrics.requests,
            waitMs: this.client.metrics.rateLimitWaitMs,
          },
          releases: batchReleases,
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

  async scanReleaseDetails(
    mapping: SpotifyArtistMapping,
    summary: Pick<SpotifyAlbumSummary, "id" | "total_tracks">,
    context: ScanContext,
  ): Promise<TrackCandidate[]> {
    const resume = this.releaseTrackResume.get(summary.id);
    const resumeOffset = resume?.nextOffset ?? 0;
    await context.onReleaseTrackStart?.({
      currentUnitId: mapping.artistId,
      expectedTotalTracks: summary.total_tracks,
      externalReleaseId: summary.id,
      resumeOffset,
    });
    let album: SpotifyAlbum;
    try {
      album = await this.client.getAlbum(summary.id, context.signal);
    } catch (error) {
      await context.onReleaseTrackError?.({
        classification: releaseTrackErrorClassification(error),
        externalReleaseId: summary.id,
        status: releaseTrackErrorStatus(error),
      });
      throw error;
    }
    const releasePrimarilyWatched = album.artists.some(
      (artist) => artist.id === mapping.spotifyArtistId,
    );
    const candidates: TrackCandidate[] = [];
    let offset = resumeOffset;
    let firstPage = true;
    while (true) {
      const startedAt = this.now();
      let tracks: SpotifyTrackSummary[];
      let rawNext: string | null;
      if (firstPage && offset === 0) {
        tracks = album.tracks.items;
        rawNext = album.tracks.next;
        offset = album.tracks.offset ?? 0;
      } else {
        try {
          const page = await this.client.getAlbumTracksPage(summary.id, offset, context.signal);
          tracks = page.items;
          rawNext = page.next;
          offset = page.offset;
        } catch (error) {
          await context.onReleaseTrackError?.({
            classification: releaseTrackErrorClassification(error),
            externalReleaseId: summary.id,
            status: releaseTrackErrorStatus(error),
          });
          throw error;
        }
      }
      firstPage = false;
      const pageCandidates = tracks
        .filter(
          (track) =>
            releasePrimarilyWatched ||
            track.artists.some((artist) => artist.id === mapping.spotifyArtistId),
        )
        .map((track) => spotifyCandidate(mapping, album, track, this.now(), this.region));
      candidates.push(...pageCandidates);
      let nextOffset: number | null = null;
      let errorClassification: string | undefined;
      try {
        nextOffset = spotifyTrackNextOffset(rawNext, offset);
      } catch {
        errorClassification = "malformed_next_cursor";
      }
      await context.onReleaseTrackPage?.({
        candidates: pageCandidates,
        currentUnitId: mapping.artistId,
        ...(errorClassification ? { errorClassification } : {}),
        expectedTotalTracks: album.total_tracks,
        externalReleaseId: summary.id,
        finishedAt: this.now(),
        items: tracks.map((track) => ({
          discNumber: track.disc_number,
          providerTrackId: track.id,
          trackNumber: track.track_number,
        })),
        nextOffset,
        offset,
        pageNumber: Math.floor(offset / Math.max(1, album.tracks.limit || 50)) + 1,
        startedAt,
        terminal: rawNext === null && !errorClassification,
      });
      if (errorClassification) throw new Error("Spotify returned a malformed album track cursor.");
      if (nextOffset === null || tracks.length === 0) break;
      offset = nextOffset;
    }
    return candidates;
  }
}

export function spotifyTrackNextOffset(next: string | null, currentOffset: number): number | null {
  if (!next) return null;
  const parsed = new URL(next);
  const value = parsed.searchParams.get("offset");
  const offset = value === null ? Number.NaN : Number(value);
  if (!Number.isInteger(offset) || offset <= currentOffset) {
    throw new Error("Spotify returned an invalid album track next-page offset.");
  }
  return offset;
}

function releaseTrackErrorStatus(error: unknown): "failed" | "paused" | "rate_limited" {
  if (isNamedError(error, "SpotifyRequestBudgetError")) return "paused";
  if (isNamedError(error, "SpotifyCooldownError")) return "rate_limited";
  if (isRecord(error) && error.status === 429) return "rate_limited";
  return "failed";
}

function releaseTrackErrorClassification(error: unknown): string {
  const status = releaseTrackErrorStatus(error);
  if (status === "paused") return "request_budget_exhausted";
  if (status === "rate_limited") return "rate_limited";
  return "provider_failure";
}

function isNamedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function releaseObservation(
  artistId: string,
  album: SpotifyAlbumSummary,
  knownReleaseIds: ReadonlySet<string>,
  knownReleaseSummaries: ReadonlyMap<string, string>,
  filter: ScanContext["filter"],
  duplicateInRun: boolean,
  incompleteTrackRetrieval: boolean,
): ProviderReleaseObservation {
  const releaseDate = normalizeSpotifyDate(album.release_date).date;
  const backfillEligible = !filter.since || releaseDate >= filter.since;
  const knownSummary = knownReleaseSummaries.get(`${artistId}:${album.id}`);
  const summaryChanged = Boolean(knownSummary && knownSummary !== spotifySummaryHash(album));
  const known = knownReleaseIds.has(album.id) || Boolean(knownSummary);
  const selectedForDetails = Boolean(
    backfillEligible && !duplicateInRun && (!known || summaryChanged || incompleteTrackRetrieval),
  );
  const reasons = selectedForDetails
    ? [
        `Release date is on or after backfill start ${filter.since ?? "unbounded"}`,
        ...(known ? ["Provider release ID is already known"] : ["Provider release ID is new"]),
        ...(summaryChanged ? ["Observed Spotify release summary changed"] : []),
        ...(incompleteTrackRetrieval ? ["Album track retrieval is incomplete"] : []),
      ]
    : [
        ...(duplicateInRun ? ["Provider release ID already appeared earlier in this run"] : []),
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
    totalTracks: album.total_tracks,
  };
}

function spotifySummaryHash(album: SpotifyAlbumSummary): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        releaseDate: normalizeSpotifyDate(album.release_date).date,
        releaseDatePrecision: album.release_date_precision,
        releaseType: album.album_type,
        title: album.name,
        totalTracks: album.total_tracks,
      }),
    )
    .digest("hex");
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
