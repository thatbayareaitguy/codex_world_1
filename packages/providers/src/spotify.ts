import { log, normalizeSpotifyArtworkUrl } from "@radar/core";
import { z } from "zod";
import {
  abbreviateSpotifyPlaylistId,
  assertOwnedNonCollaborativeSpotifyPlaylist,
  assertSpotifyPlaylistWriteTarget,
  assertSpotifyTrackIds,
  SpotifyPlaylistWriteDeniedError,
  type SpotifyPlaylistWritePolicy,
} from "./spotify-playlist-policy";

const spotifyUrl = z.string().url();
const externalUrlsSchema = z.object({ spotify: spotifyUrl }).passthrough();
const simplifiedArtistSchema = z
  .object({
    external_urls: externalUrlsSchema,
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal("artist"),
    uri: z.string().startsWith("spotify:artist:"),
  })
  .passthrough();
const imageSchema = z
  .object({
    height: z.number().int().positive().nullable(),
    url: z.string(),
    width: z.number().int().positive().nullable(),
  })
  .passthrough();
export const spotifyImagesSchema = z.unknown().transform((value) =>
  (Array.isArray(value) ? value : []).flatMap((image) => {
    const parsed = imageSchema.safeParse(image);
    if (!parsed.success) return [];
    const url = normalizeSpotifyArtworkUrl(parsed.data.url);
    return url ? [{ height: parsed.data.height, url, width: parsed.data.width }] : [];
  }),
);
const artistSchema = simplifiedArtistSchema
  .extend({ images: spotifyImagesSchema.default([]) })
  .passthrough();
const pagingBaseSchema = z.object({
  href: spotifyUrl,
  limit: z.number().int().nonnegative(),
  next: spotifyUrl.nullable(),
  offset: z.number().int().nonnegative().optional(),
  previous: spotifyUrl.nullable().optional(),
  total: z.number().int().nonnegative(),
});
const albumSummarySchema = z
  .object({
    album_group: z.enum(["album", "single", "appears_on", "compilation"]).optional(),
    album_type: z.enum(["album", "single", "compilation"]),
    artists: z.array(simplifiedArtistSchema),
    external_urls: externalUrlsSchema,
    id: z.string().min(1),
    images: spotifyImagesSchema.default([]),
    name: z.string(),
    release_date: z.string().min(4),
    release_date_precision: z.enum(["year", "month", "day"]),
    restrictions: z.object({ reason: z.string() }).passthrough().optional(),
    total_tracks: z.number().int().nonnegative(),
    type: z.literal("album"),
    uri: z.string().startsWith("spotify:album:"),
  })
  .passthrough();
const trackSummarySchema = z
  .object({
    artists: z.array(simplifiedArtistSchema),
    disc_number: z.number().int().positive(),
    duration_ms: z.number().int().nonnegative(),
    explicit: z.boolean(),
    external_urls: externalUrlsSchema,
    id: z.string().min(1),
    is_local: z.boolean().default(false),
    is_playable: z.boolean().optional(),
    name: z.string(),
    restrictions: z.object({ reason: z.string() }).passthrough().optional(),
    track_number: z.number().int().positive(),
    type: z.literal("track"),
    uri: z.string().startsWith("spotify:track:"),
  })
  .passthrough();
const albumTracksPageSchema = pagingBaseSchema.extend({
  items: z.array(trackSummarySchema),
});
const albumSchema = albumSummarySchema
  .extend({
    external_ids: z
      .object({
        ean: z.string().optional(),
        isrc: z.string().optional(),
        upc: z.string().optional(),
      })
      .passthrough()
      .optional(),
    tracks: albumTracksPageSchema,
  })
  .passthrough();
const trackSchema = trackSummarySchema
  .extend({
    album: albumSummarySchema,
    external_ids: z
      .object({
        ean: z.string().optional(),
        isrc: z.string().optional(),
        upc: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const playlistSchema = z
  .object({
    collaborative: z.boolean(),
    description: z.string().nullable().optional(),
    external_urls: externalUrlsSchema,
    id: z.string().min(1),
    images: spotifyImagesSchema.optional(),
    name: z.string().min(1),
    owner: z
      .object({ account_id: z.string().optional(), id: z.string().optional() })
      .passthrough()
      .optional(),
    public: z.boolean().nullable(),
    snapshot_id: z.string(),
    uri: z.string().startsWith("spotify:playlist:"),
  })
  .passthrough();

export const spotifyProfileSchema = z
  .object({
    account_id: z.string().min(1),
    display_name: z.string().nullable(),
    external_urls: externalUrlsSchema,
    id: z.string().min(1),
    type: z.literal("user"),
    uri: z.string().startsWith("spotify:user:"),
  })
  .passthrough();
export const spotifyFollowedArtistsSchema = z.object({
  artists: pagingBaseSchema.extend({
    cursors: z.object({
      after: z.string().nullable().optional(),
      before: z.string().nullable().optional(),
    }),
    items: z.array(artistSchema),
  }),
});
export const spotifyArtistAlbumsSchema = pagingBaseSchema.extend({
  items: z.array(albumSummarySchema),
});
export const spotifyAlbumTracksSchema = albumTracksPageSchema;
export const spotifySearchArtistsSchema = z.object({
  artists: pagingBaseSchema.extend({ items: z.array(artistSchema) }),
});
export const spotifySearchTracksSchema = z.object({
  tracks: pagingBaseSchema.extend({ items: z.array(trackSchema) }),
});
export const spotifyPlaylistsSchema = pagingBaseSchema.extend({ items: z.array(playlistSchema) });
export const spotifyPlaylistItemsSchema = pagingBaseSchema.extend({
  items: z.array(
    z
      .object({
        added_at: z.string().nullable().optional(),
        added_by: z
          .object({ account_id: z.string().optional(), id: z.string().optional() })
          .passthrough()
          .nullable()
          .optional(),
        item: z.union([trackSchema, z.null()]).optional(),
      })
      .passthrough(),
  ),
});
export const spotifyTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(""),
  token_type: z.literal("Bearer"),
});

export type SpotifyArtist = z.infer<typeof artistSchema>;
export type SpotifyAlbum = z.infer<typeof albumSchema>;
export type SpotifyAlbumSummary = z.infer<typeof albumSummarySchema>;
export type SpotifyPlaylist = z.infer<typeof playlistSchema>;
export type SpotifyProfile = z.infer<typeof spotifyProfileSchema>;
export type SpotifyTrack = z.infer<typeof trackSchema>;
export type SpotifyTrackSummary = z.infer<typeof trackSummarySchema>;
export type SpotifyTokenResponse = z.infer<typeof spotifyTokenSchema>;

export interface SpotifyPlaylistItemSnapshot {
  addedAt?: string;
  addedById?: string;
  albumId?: string;
  albumTitle?: string;
  artistNames?: string[];
  discNumber?: number;
  position: number;
  releaseDate?: string;
  trackId: string | null;
  trackNumber?: number;
  title?: string;
}

export interface SpotifyPlaylistReorderInput {
  insertBefore: number;
  rangeLength: number;
  rangeStart: number;
  snapshotId: string;
}

export interface SpotifyArtistAlbumsPage {
  items: SpotifyAlbumSummary[];
  nextOffset: number | null;
  offset: number;
  total: number;
}

export type SpotifyArtistAlbumGroup = "album" | "single" | "appears_on" | "compilation";

export interface SpotifyAlbumTracksPage {
  items: SpotifyTrackSummary[];
  next: string | null;
  offset: number;
  total: number;
}

export const SPOTIFY_READ_SCOPES = ["user-follow-read", "playlist-read-private"] as const;
export const SPOTIFY_PRIVATE_PLAYLIST_WRITE_SCOPE = "playlist-modify-private" as const;
export const SPOTIFY_PUBLIC_PLAYLIST_WRITE_SCOPE = "playlist-modify-public" as const;
export const SPOTIFY_PLAYLIST_WRITE_SCOPES = [
  SPOTIFY_PRIVATE_PLAYLIST_WRITE_SCOPE,
  SPOTIFY_PUBLIC_PLAYLIST_WRITE_SCOPE,
] as const;
export const SPOTIFY_SCOPES = SPOTIFY_READ_SCOPES;

export function spotifyAuthorizationScopes(playlistWritesEnabled: boolean): readonly string[] {
  return playlistWritesEnabled
    ? [...SPOTIFY_READ_SCOPES, ...SPOTIFY_PLAYLIST_WRITE_SCOPES]
    : [...SPOTIFY_READ_SCOPES];
}

export function hasSpotifyPlaylistWriteScopes(scopes: readonly string[]): boolean {
  return SPOTIFY_PLAYLIST_WRITE_SCOPES.every((scope) => scopes.includes(scope));
}

export class SpotifyHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: SpotifyRetryAfterEvidence,
    readonly endpointCategory?: string,
    readonly responseClassification?: string,
    readonly providerReasonToken?: string,
    readonly providerErrorClassification?: SpotifyProviderErrorClassification,
  ) {
    super(message);
    this.name = "SpotifyHttpError";
  }
}

export interface SpotifyRequestMetrics {
  failures: number;
  queueWaitMs: number;
  rateLimitWaitMs: number;
  requests: number;
}

export interface SpotifyRequestTelemetry extends SpotifyRequestMetrics {
  endpointCategory?: string;
  phase: "queued" | "request" | "rate_limit_wait";
  queueLength?: number;
  retryAfterMs?: number;
}

export interface SpotifyRequestPermit {
  eventId: string;
  leaseToken: string;
  queueLength: number;
  queueWaitMs: number;
  startedAt: Date;
}

export interface SpotifyRequestCompletion {
  cooldownIndefinite?: boolean;
  cooldownUntil?: Date;
  errorClassification?: string;
  parsedRetryAfterSeconds?: string;
  providerReasonToken?: string;
  rateLimitClassification?: Spotify429Classification;
  rawRetryAfter?: string;
  responseClassification?: string;
  status?: number;
}

export type Spotify429Classification = "quota_exceeded" | "unspecified_429" | "unknown_reason";

export interface Spotify429ResponseEvidence {
  classification: Spotify429Classification;
  providerReasonToken?: string;
}

export interface SpotifyErrorResponseEvidence {
  providerErrorClassification?: SpotifyProviderErrorClassification;
  providerReasonToken?: string;
  rateLimit?: Spotify429ResponseEvidence;
  responseClassification: string;
}

export type SpotifyProviderErrorClassification =
  | "forbidden"
  | "insufficient_scope"
  | "premium_required"
  | "quota_exceeded"
  | "restriction_violated";

export interface SpotifyRequestGate {
  acquire(input: {
    endpointCategory: string;
    method: string;
    signal?: AbortSignal;
  }): Promise<SpotifyRequestPermit>;
  complete(permit: SpotifyRequestPermit, result: SpotifyRequestCompletion): Promise<void>;
}

export interface SpotifyRetryAfterEvidence {
  cooldownIndefinite: boolean;
  cooldownUntil?: Date;
  interpretation: "integer_seconds" | "missing" | "malformed" | "http_date" | "overflow";
  parsedSeconds?: string;
  rawValue: string | null;
  waitMs?: number;
}

interface SpotifyClientOptions {
  accessToken: () => Promise<string>;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
  onUnauthorized?: () => Promise<void>;
  onTelemetry?: (telemetry: SpotifyRequestTelemetry) => Promise<void>;
  playlistWritePolicy?: SpotifyPlaylistWritePolicy;
  random?: () => number;
  requestGate?: SpotifyRequestGate;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

interface RequestOptions {
  body?: unknown;
  method?: "GET" | "POST" | "PUT";
  responseBody?: "empty" | "json";
  signal?: AbortSignal | undefined;
}

export class SpotifyClient {
  readonly metrics: SpotifyRequestMetrics = {
    failures: 0,
    queueWaitMs: 0,
    rateLimitWaitMs: 0,
    requests: 0,
  };
  private readonly accessToken: () => Promise<string>;
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly onUnauthorized: (() => Promise<void>) | undefined;
  private readonly onTelemetry: ((telemetry: SpotifyRequestTelemetry) => Promise<void>) | undefined;
  private readonly playlistWritePolicy: SpotifyPlaylistWritePolicy;
  private readonly random: () => number;
  private readonly requestGate: SpotifyRequestGate | undefined;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: SpotifyClientOptions) {
    this.accessToken = options.accessToken;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.spotify.com/v1";
    this.fetcher = options.fetcher ?? fetch;
    this.onUnauthorized = options.onUnauthorized;
    this.onTelemetry = options.onTelemetry;
    this.playlistWritePolicy = options.playlistWritePolicy ?? { enabled: false };
    this.random = options.random ?? Math.random;
    this.requestGate = options.requestGate;
    this.sleep = options.sleep
      ? (milliseconds, signal) => abortableSleep(options.sleep!, milliseconds, signal)
      : cancellableSleep;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  getCurrentUser(signal?: AbortSignal): Promise<SpotifyProfile> {
    return this.request("/me", spotifyProfileSchema, { signal });
  }

  async getFollowedArtists(signal?: AbortSignal): Promise<SpotifyArtist[]> {
    const results: SpotifyArtist[] = [];
    let after: string | undefined;
    do {
      const query = new URLSearchParams({ type: "artist", limit: "50" });
      if (after) query.set("after", after);
      const page = await this.request(`/me/following?${query}`, spotifyFollowedArtistsSchema, {
        signal,
      });
      results.push(...page.artists.items);
      after = page.artists.cursors.after ?? undefined;
      if (!page.artists.next) after = undefined;
    } while (after);
    return results;
  }

  getArtist(id: string, signal?: AbortSignal): Promise<SpotifyArtist> {
    return this.request(`/artists/${encodeURIComponent(id)}`, artistSchema, { signal });
  }

  async getArtistAlbums(
    id: string,
    signal?: AbortSignal,
    maxPages = Number.POSITIVE_INFINITY,
  ): Promise<SpotifyAlbumSummary[]> {
    return (await this.getArtistAlbumsBounded(id, maxPages, signal)).items;
  }

  async getArtistAlbumsBounded(
    id: string,
    maxPages: number,
    signal?: AbortSignal,
    startOffset = 0,
  ): Promise<{ items: SpotifyAlbumSummary[]; pagesScanned: number; partial: boolean }> {
    const results: SpotifyAlbumSummary[] = [];
    let offset = startOffset;
    let pages = 0;
    let hasNext = false;
    while (pages < maxPages) {
      const page = await this.getArtistAlbumsPage(id, offset, signal);
      pages += 1;
      results.push(...page.items);
      hasNext = page.nextOffset !== null;
      if (page.nextOffset === null || page.items.length === 0) break;
      offset = page.nextOffset;
    }
    return { items: results, pagesScanned: pages, partial: hasNext && pages >= maxPages };
  }

  async getArtistAlbumsPage(
    id: string,
    offset: number,
    signal?: AbortSignal,
    includeGroups: readonly SpotifyArtistAlbumGroup[] = [
      "album",
      "single",
      "appears_on",
      "compilation",
    ],
  ): Promise<SpotifyArtistAlbumsPage> {
    if (!Number.isInteger(offset) || offset < 0) throw new Error("Spotify offset is invalid.");
    if (includeGroups.length === 0) throw new Error("Spotify album groups cannot be empty.");
    const query = new URLSearchParams({
      include_groups: includeGroups.join(","),
      limit: "10",
      offset: String(offset),
    });
    const page = await this.request(
      `/artists/${encodeURIComponent(id)}/albums?${query}`,
      spotifyArtistAlbumsSchema,
      { signal },
    );
    return {
      items: page.items,
      nextOffset: spotifyNextOffset(page.next, offset),
      offset,
      total: page.total,
    };
  }

  getAlbum(id: string, signal?: AbortSignal): Promise<SpotifyAlbum> {
    return this.request(`/albums/${encodeURIComponent(id)}`, albumSchema, { signal });
  }

  async getAlbumTracks(
    id: string,
    signal?: AbortSignal,
    startOffset = 0,
  ): Promise<SpotifyTrackSummary[]> {
    const results: SpotifyTrackSummary[] = [];
    let offset = startOffset;
    while (true) {
      const page = await this.request(
        `/albums/${encodeURIComponent(id)}/tracks?limit=50&offset=${offset}`,
        spotifyAlbumTracksSchema,
        { signal },
      );
      results.push(...page.items);
      if (!page.next || page.items.length === 0) break;
      offset += page.items.length;
    }
    return results;
  }

  async getAlbumTracksPage(
    id: string,
    offset: number,
    signal?: AbortSignal,
    limit = 50,
  ): Promise<SpotifyAlbumTracksPage> {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("Spotify album track offset is invalid.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Spotify album track limit must be an integer from 1 to 50.");
    }
    const page = await this.request(
      `/albums/${encodeURIComponent(id)}/tracks?limit=${limit}&offset=${offset}`,
      spotifyAlbumTracksSchema,
      { signal },
    );
    return {
      items: page.items,
      next: page.next,
      offset: page.offset ?? offset,
      total: page.total,
    };
  }

  getTrack(id: string, signal?: AbortSignal): Promise<SpotifyTrack> {
    return this.request(`/tracks/${encodeURIComponent(id)}`, trackSchema, { signal });
  }

  async searchTracksByIsrc(isrc: string, signal?: AbortSignal): Promise<SpotifyTrack[]> {
    const normalized = isrc.replaceAll(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized)) {
      throw new Error("Spotify ISRC search requires a valid 12-character ISRC.");
    }
    const query = new URLSearchParams({ limit: "10", q: `isrc:${normalized}`, type: "track" });
    const result = await this.request(`/search?${query}`, spotifySearchTracksSchema, { signal });
    return result.tracks.items;
  }

  async searchArtists(queryValue: string, signal?: AbortSignal): Promise<SpotifyArtist[]> {
    const query = new URLSearchParams({ q: queryValue, type: "artist", limit: "10" });
    const response = await this.request(`/search?${query}`, spotifySearchArtistsSchema, { signal });
    return response.artists.items;
  }

  async getMyPlaylists(signal?: AbortSignal): Promise<SpotifyPlaylist[]> {
    const results: SpotifyPlaylist[] = [];
    let offset = 0;
    while (true) {
      const page = await this.request(
        `/me/playlists?limit=50&offset=${offset}`,
        spotifyPlaylistsSchema,
        {
          signal,
        },
      );
      results.push(...page.items);
      if (!page.next || page.items.length === 0) break;
      offset += page.items.length;
    }
    return results;
  }

  getPlaylist(id: string, signal?: AbortSignal): Promise<SpotifyPlaylist> {
    return this.request(`/playlists/${encodeURIComponent(id)}`, playlistSchema, { signal });
  }

  async getPlaylistItems(id: string, signal?: AbortSignal): Promise<SpotifyPlaylistItemSnapshot[]> {
    const items: SpotifyPlaylistItemSnapshot[] = [];
    let offset = 0;
    while (true) {
      const page = await this.request(
        `/playlists/${encodeURIComponent(id)}/items?limit=50&offset=${offset}`,
        spotifyPlaylistItemsSchema,
        { signal },
      );
      for (const [index, entry] of page.items.entries()) {
        const track = entry.item;
        const addedById = entry.added_by?.account_id ?? entry.added_by?.id;
        items.push({
          ...(entry.added_at ? { addedAt: entry.added_at } : {}),
          ...(addedById ? { addedById } : {}),
          ...(track
            ? {
                albumId: track.album.id,
                albumTitle: track.album.name,
                artistNames: track.artists.map((artist) => artist.name),
                discNumber: track.disc_number,
                releaseDate: track.album.release_date,
                title: track.name,
                trackNumber: track.track_number,
              }
            : {}),
          position: offset + index,
          trackId: track?.id ?? null,
        });
      }
      if (!page.next || page.items.length === 0) break;
      offset += page.items.length;
    }
    return items;
  }

  async getPlaylistTrackIds(id: string, signal?: AbortSignal): Promise<Set<string>> {
    return new Set(
      (await this.getPlaylistItems(id, signal))
        .map((item) => item.trackId)
        .filter((trackId): trackId is string => trackId !== null),
    );
  }

  async addPlaylistItems(id: string, trackIds: string[], signal?: AbortSignal): Promise<string[]> {
    const targetPlaylistId = assertSpotifyPlaylistWriteTarget(this.playlistWritePolicy, id);
    assertSpotifyTrackIds(trackIds);
    if (trackIds.length === 0) return [];
    const [profile, playlist] = await Promise.all([
      this.getCurrentUser(signal),
      this.getPlaylist(targetPlaylistId, signal),
    ]);
    assertOwnedNonCollaborativeSpotifyPlaylist(playlist, profile);
    log("info", "spotify.playlist_addition_started", {
      itemCount: trackIds.length,
      playlistId: abbreviateSpotifyPlaylistId(targetPlaylistId),
    });
    const snapshots: string[] = [];
    for (let offset = 0; offset < trackIds.length; offset += 100) {
      const batch = trackIds.slice(offset, offset + 100);
      const response = await this.request(
        `/playlists/${encodeURIComponent(targetPlaylistId)}/items`,
        z.object({ snapshot_id: z.string() }),
        {
          body: { uris: batch.map((trackId) => `spotify:track:${trackId}`) },
          method: "POST",
          signal,
        },
      );
      snapshots.push(response.snapshot_id);
    }
    return snapshots;
  }

  async addPlaylistItemsAtPosition(
    id: string,
    trackIds: string[],
    position: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const targetPlaylistId = assertSpotifyPlaylistWriteTarget(this.playlistWritePolicy, id);
    assertSpotifyTrackIds(trackIds);
    if (trackIds.length < 1 || trackIds.length > 100) {
      throw new SpotifyPlaylistWriteDeniedError(
        "Spotify positional additions require from 1 to 100 tracks",
        "playlist_addition_invalid",
      );
    }
    if (!Number.isInteger(position) || position < 0) {
      throw new Error("Spotify playlist insertion position must be a nonnegative integer.");
    }
    const [profile, playlist] = await Promise.all([
      this.getCurrentUser(signal),
      this.getPlaylist(targetPlaylistId, signal),
    ]);
    assertOwnedNonCollaborativeSpotifyPlaylist(playlist, profile);
    log("info", "spotify.playlist_positional_addition_started", {
      itemCount: trackIds.length,
      playlistId: abbreviateSpotifyPlaylistId(targetPlaylistId),
      position,
    });
    const response = await this.request(
      `/playlists/${encodeURIComponent(targetPlaylistId)}/items`,
      z.object({ snapshot_id: z.string() }),
      {
        body: {
          position,
          uris: trackIds.map((trackId) => `spotify:track:${trackId}`),
        },
        method: "POST",
        signal,
      },
    );
    return response.snapshot_id;
  }

  async reorderPlaylistItems(
    id: string,
    input: SpotifyPlaylistReorderInput,
    signal?: AbortSignal,
  ): Promise<string> {
    const targetPlaylistId = assertSpotifyPlaylistWriteTarget(this.playlistWritePolicy, id);
    if (
      !Number.isInteger(input.rangeStart) ||
      input.rangeStart < 0 ||
      !Number.isInteger(input.insertBefore) ||
      input.insertBefore < 0 ||
      !Number.isInteger(input.rangeLength) ||
      input.rangeLength < 1 ||
      input.rangeLength > 100 ||
      !input.snapshotId.trim()
    ) {
      throw new SpotifyPlaylistWriteDeniedError(
        "Spotify playlist reorder parameters are invalid",
        "playlist_reorder_invalid",
      );
    }
    log("info", "spotify.playlist_reorder_started", {
      insertBefore: input.insertBefore,
      playlistId: abbreviateSpotifyPlaylistId(targetPlaylistId),
      rangeLength: input.rangeLength,
      rangeStart: input.rangeStart,
    });
    const response = await this.request(
      `/playlists/${encodeURIComponent(targetPlaylistId)}/items`,
      z.object({ snapshot_id: z.string().min(1) }),
      {
        body: {
          insert_before: input.insertBefore,
          range_length: input.rangeLength,
          range_start: input.rangeStart,
          snapshot_id: input.snapshotId,
        },
        method: "PUT",
        signal,
      },
    );
    return response.snapshot_id;
  }

  async setAuthorizedPlaylistPublic(id: string, signal?: AbortSignal): Promise<void> {
    const targetPlaylistId = assertSpotifyPlaylistWriteTarget(this.playlistWritePolicy, id);
    const [profile, playlist] = await Promise.all([
      this.getCurrentUser(signal),
      this.getPlaylist(targetPlaylistId, signal),
    ]);
    assertOwnedNonCollaborativeSpotifyPlaylist(playlist, profile);
    log("info", "spotify.playlist_visibility_update_started", {
      playlistId: abbreviateSpotifyPlaylistId(targetPlaylistId),
      public: true,
    });
    await this.request(`/playlists/${encodeURIComponent(targetPlaylistId)}`, z.undefined(), {
      body: { collaborative: false, public: true },
      method: "PUT",
      responseBody: "empty",
      signal,
    });
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    let refreshed = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const method = options.method ?? "GET";
      const endpointCategory = spotifyEndpointCategory(path, method);
      let permit: SpotifyRequestPermit | undefined;
      let permitCompleted = false;
      try {
        // Token refresh uses the same global gate. Resolve it before claiming an API lease.
        const accessToken = await this.accessToken();
        if (this.requestGate) {
          await this.emitTelemetry({ endpointCategory, phase: "queued" });
          permit = await this.requestGate.acquire({
            endpointCategory,
            method,
            ...(options.signal ? { signal: options.signal } : {}),
          });
          this.metrics.queueWaitMs += permit.queueWaitMs;
        }
        this.metrics.requests += 1;
        await this.emitTelemetry({
          endpointCategory,
          phase: "request",
          ...(permit ? { queueLength: permit.queueLength } : {}),
        });
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
        const response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
          method,
          signal,
        });

        const errorResponse = response.ok ? undefined : await inspectSpotifyErrorResponse(response);
        const responseClassification = errorResponse?.responseClassification;
        const providerReasonToken = errorResponse?.providerReasonToken;
        const providerErrorClassification = errorResponse?.providerErrorClassification;
        const retryEvidence =
          response.status === 429
            ? parseSpotifyRetryAfter(response.headers.get("retry-after"), new Date())
            : undefined;
        if (permit && this.requestGate) {
          await this.requestGate.complete(permit, {
            status: response.status,
            ...(providerErrorClassification
              ? { errorClassification: providerErrorClassification }
              : {}),
            ...(providerReasonToken ? { providerReasonToken } : {}),
            ...(responseClassification ? { responseClassification } : {}),
            ...(retryEvidence
              ? {
                  cooldownIndefinite: retryEvidence.cooldownIndefinite,
                  ...(retryEvidence.cooldownUntil
                    ? { cooldownUntil: retryEvidence.cooldownUntil }
                    : {}),
                  ...(retryEvidence.parsedSeconds
                    ? { parsedRetryAfterSeconds: retryEvidence.parsedSeconds }
                    : {}),
                  ...(retryEvidence.rawValue !== null
                    ? { rawRetryAfter: retryEvidence.rawValue }
                    : {}),
                  errorClassification: `rate_limited_${retryEvidence.interpretation}`,
                  rateLimitClassification:
                    errorResponse?.rateLimit?.classification ?? "unspecified_429",
                }
              : {}),
          });
          permitCompleted = true;
        }

        if (response.status === 401 && this.onUnauthorized && !refreshed) {
          refreshed = true;
          await this.onUnauthorized();
          attempt -= 1;
          continue;
        }
        if (!response.ok) {
          throw new SpotifyHttpError(
            `Spotify request failed with status ${response.status}`,
            response.status,
            retryEvidence,
            endpointCategory,
            responseClassification,
            providerReasonToken,
            providerErrorClassification,
          );
        }
        return schema.parse(options.responseBody === "empty" ? undefined : await response.json());
      } catch (error) {
        if (permit && !permitCompleted) {
          await this.requestGate?.complete(permit, {
            errorClassification:
              error instanceof Error && error.name === "AbortError"
                ? "request_aborted"
                : "request_failed",
          });
        }
        const retryable =
          (error instanceof SpotifyHttpError && error.status >= 500) ||
          (!(error instanceof SpotifyHttpError) && !(error instanceof z.ZodError));
        if (!retryable || attempt >= 3) {
          this.metrics.failures += 1;
          throw error;
        }
        const delay = Math.floor(250 * 2 ** (attempt - 1) * (0.5 + this.random() * 0.5));
        await this.sleep(delay, options.signal);
      }
    }
    throw new Error("Spotify retry loop exhausted");
  }

  private emitTelemetry(
    event: Pick<
      SpotifyRequestTelemetry,
      "endpointCategory" | "phase" | "queueLength" | "retryAfterMs"
    >,
  ): Promise<void> {
    if (!this.onTelemetry) return Promise.resolve();
    return this.onTelemetry({
      failures: this.metrics.failures,
      phase: event.phase,
      queueWaitMs: this.metrics.queueWaitMs,
      rateLimitWaitMs: this.metrics.rateLimitWaitMs,
      requests: this.metrics.requests,
      ...(event.endpointCategory ? { endpointCategory: event.endpointCategory } : {}),
      ...(event.queueLength === undefined ? {} : { queueLength: event.queueLength }),
      ...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
    });
  }
}

export function spotifyNextOffset(nextUrl: string | null, currentOffset: number): number | null {
  if (!nextUrl) return null;
  const value = Number(new URL(nextUrl).searchParams.get("offset"));
  if (!Number.isInteger(value) || value <= currentOffset) {
    throw new Error("Spotify returned an invalid next-page offset.");
  }
  return value;
}

interface SpotifyOAuthClientOptions {
  accountsBaseUrl?: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
  playlistWritesEnabled?: boolean;
  redirectUri: string;
  requestGate?: SpotifyRequestGate;
}

export class SpotifyOAuthClient {
  private readonly accountsBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetcher: typeof fetch;
  private readonly playlistWritesEnabled: boolean;
  private readonly redirectUri: string;
  private readonly requestGate: SpotifyRequestGate | undefined;

  constructor(options: SpotifyOAuthClientOptions) {
    this.accountsBaseUrl = options.accountsBaseUrl ?? "https://accounts.spotify.com";
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetcher = options.fetcher ?? fetch;
    this.playlistWritesEnabled = options.playlistWritesEnabled ?? false;
    this.redirectUri = options.redirectUri;
    this.requestGate = options.requestGate;
  }

  authorizationUrl(state: string, codeChallenge: string): string {
    const url = new URL("/authorize", this.accountsBaseUrl);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: spotifyAuthorizationScopes(this.playlistWritesEnabled).join(" "),
      ...(this.playlistWritesEnabled ? { show_dialog: "true" } : {}),
      state,
    }).toString();
    return url.toString();
  }

  exchangeCode(code: string, codeVerifier: string): Promise<SpotifyTokenResponse> {
    return this.tokenRequest(
      new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: this.redirectUri,
      }),
    );
  }

  refresh(refreshToken: string): Promise<SpotifyTokenResponse> {
    return this.tokenRequest(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    );
  }

  private async tokenRequest(body: URLSearchParams): Promise<SpotifyTokenResponse> {
    const permit = await this.requestGate?.acquire({
      endpointCategory: "oauth_or_other",
      method: "POST",
    });
    let completed = false;
    try {
      const response = await this.fetcher(`${this.accountsBaseUrl}/api/token`, {
        body,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        signal: AbortSignal.timeout(15_000),
      });
      const errorResponse = response.ok ? undefined : await inspectSpotifyErrorResponse(response);
      const responseClassification = errorResponse?.responseClassification;
      const providerReasonToken = errorResponse?.providerReasonToken;
      const providerErrorClassification = errorResponse?.providerErrorClassification;
      const retryEvidence =
        response.status === 429
          ? parseSpotifyRetryAfter(response.headers.get("retry-after"), new Date())
          : undefined;
      if (permit && this.requestGate) {
        await this.requestGate.complete(permit, {
          status: response.status,
          ...(providerErrorClassification
            ? { errorClassification: providerErrorClassification }
            : {}),
          ...(providerReasonToken ? { providerReasonToken } : {}),
          ...(responseClassification ? { responseClassification } : {}),
          ...(retryEvidence
            ? {
                cooldownIndefinite: retryEvidence.cooldownIndefinite,
                ...(retryEvidence.cooldownUntil
                  ? { cooldownUntil: retryEvidence.cooldownUntil }
                  : {}),
                ...(retryEvidence.parsedSeconds
                  ? { parsedRetryAfterSeconds: retryEvidence.parsedSeconds }
                  : {}),
                ...(retryEvidence.rawValue !== null
                  ? { rawRetryAfter: retryEvidence.rawValue }
                  : {}),
                errorClassification: `rate_limited_${retryEvidence.interpretation}`,
                rateLimitClassification:
                  errorResponse?.rateLimit?.classification ?? "unspecified_429",
              }
            : {}),
        });
        completed = true;
      }
      if (!response.ok) {
        throw new SpotifyHttpError(
          `Spotify token request failed with status ${response.status}`,
          response.status,
          retryEvidence,
          "oauth_token",
          responseClassification,
          providerReasonToken,
          providerErrorClassification,
        );
      }
      return spotifyTokenSchema.parse(await response.json());
    } catch (error) {
      if (permit && this.requestGate && !completed) {
        await this.requestGate.complete(permit, { errorClassification: "oauth_request_failed" });
      }
      throw error;
    }
  }
}

const spotifyRetryAfterFallbackMs = 60_000;
const spotifyRetryAfterMaximumSeconds = 31_536_000n;

export function parseSpotifyRetryAfter(
  value: string | null,
  observedAt = new Date(),
): SpotifyRetryAfterEvidence {
  if (value === null || value.length === 0) {
    return {
      cooldownIndefinite: false,
      cooldownUntil: new Date(observedAt.getTime() + spotifyRetryAfterFallbackMs),
      interpretation: "missing",
      rawValue: value,
      waitMs: spotifyRetryAfterFallbackMs,
    };
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    const interpretation = Number.isNaN(Date.parse(trimmed)) ? "malformed" : "http_date";
    return {
      cooldownIndefinite: false,
      cooldownUntil: new Date(observedAt.getTime() + spotifyRetryAfterFallbackMs),
      interpretation,
      rawValue: value,
      waitMs: spotifyRetryAfterFallbackMs,
    };
  }
  const seconds = BigInt(trimmed);
  if (seconds > spotifyRetryAfterMaximumSeconds) {
    return {
      cooldownIndefinite: true,
      interpretation: "overflow",
      parsedSeconds: seconds.toString(),
      rawValue: value,
    };
  }
  const waitMs = Number(seconds) * 1_000;
  const cooldownUntilMs = observedAt.getTime() + waitMs;
  if (!Number.isSafeInteger(cooldownUntilMs) || cooldownUntilMs > 8_640_000_000_000_000) {
    return {
      cooldownIndefinite: true,
      interpretation: "overflow",
      parsedSeconds: seconds.toString(),
      rawValue: value,
    };
  }
  return {
    cooldownIndefinite: false,
    cooldownUntil: new Date(cooldownUntilMs),
    interpretation: "integer_seconds",
    parsedSeconds: seconds.toString(),
    rawValue: value,
    waitMs,
  };
}

export function spotifyEndpointCategory(path: string, method = "GET"): string {
  if (/^\/artists\/[^/]+\/albums(?:\?|$)/.test(path)) return "artist_albums";
  if (/^\/albums\/[^/]+\/tracks(?:\?|$)/.test(path)) return "album_tracks";
  if (/^\/albums\/[^/]+$/.test(path)) return "album_detail";
  if (path.startsWith("/me/playlists")) return "playlist_read";
  if (/^\/playlists\/[^/]+\/items/.test(path)) {
    return method === "GET" ? "playlist_read" : "playlist_write";
  }
  if (/^\/playlists\/[^/]+$/.test(path))
    return method === "GET" ? "playlist_read" : "playlist_write";
  return "oauth_or_other";
}

const spotifyErrorBodyMaximumBytes = 4_096;
const spotifyReasonTokenPattern = /^[A-Z0-9_]{1,64}$/;

export async function inspectSpotifyErrorResponse(
  response: Response,
): Promise<SpotifyErrorResponseEvidence> {
  const body = await readBoundedSpotifyErrorBody(response);
  if (body.kind !== "text") {
    return {
      ...(response.status === 429
        ? { rateLimit: { classification: "unspecified_429" as const } }
        : {}),
      responseClassification: body.kind,
    };
  }
  const parsed = parseSpotifyErrorBody(body.value);
  const providerReasonToken = extractSpotifyProviderReasonToken(parsed.value);
  const providerErrorClassification = classifySpotifyProviderError(parsed.value);
  return {
    ...(providerErrorClassification ? { providerErrorClassification } : {}),
    ...(providerReasonToken ? { providerReasonToken } : {}),
    ...(response.status === 429 ? { rateLimit: classifySpotify429Reason(parsed.value) } : {}),
    responseClassification: parsed.classification,
  };
}

function classifySpotifyProviderError(
  body: unknown,
): SpotifyProviderErrorClassification | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  if (body.error.reason === "QUOTA_EXCEEDED") return "quota_exceeded";
  if (typeof body.error.message !== "string") return undefined;
  const message = body.error.message.trim().toLowerCase();
  if (message === "insufficient client scope" || message === "insufficient client scope.") {
    return "insufficient_scope";
  }
  if (message === "quota exceeded" || message === "quota exceeded.") return "quota_exceeded";
  if (message === "premium required" || message === "premium required.") {
    return "premium_required";
  }
  if (message === "restriction violated" || message === "restriction violated.") {
    return "restriction_violated";
  }
  if (message === "forbidden" || message === "forbidden.") return "forbidden";
  return undefined;
}

function extractSpotifyProviderReasonToken(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.reason !== "string") {
    return undefined;
  }
  return spotifyReasonTokenPattern.test(body.error.reason) ? body.error.reason : undefined;
}

function parseSpotifyErrorBody(body: string): {
  classification: string;
  value: unknown;
} {
  if (body.trim().length === 0) return { classification: "empty", value: null };
  try {
    const parsed: unknown = JSON.parse(body);
    return {
      classification:
        parsed && typeof parsed === "object" && "error" in parsed ? "json_error" : "json_other",
      value: parsed,
    };
  } catch {
    return { classification: "non_json", value: null };
  }
}

function classifySpotify429Reason(body: unknown): Spotify429ResponseEvidence {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.reason !== "string") {
    return { classification: "unspecified_429" };
  }
  const reason = body.error.reason;
  if (reason === "QUOTA_EXCEEDED") {
    return { classification: "quota_exceeded", providerReasonToken: reason };
  }
  if (spotifyReasonTokenPattern.test(reason)) {
    return { classification: "unknown_reason", providerReasonToken: reason };
  }
  return { classification: "unknown_reason" };
}

async function readBoundedSpotifyErrorBody(
  response: Response,
): Promise<{ kind: "oversized" | "unreadable" } | { kind: "text"; value: string }> {
  try {
    const clone = response.clone();
    const contentLength = clone.headers.get("content-length");
    if (
      contentLength &&
      /^\d+$/.test(contentLength) &&
      BigInt(contentLength) > BigInt(spotifyErrorBodyMaximumBytes)
    ) {
      return { kind: "oversized" };
    }
    if (!clone.body) return { kind: "text", value: "" };
    const reader = clone.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > spotifyErrorBodyMaximumBytes) {
        void reader.cancel().catch(() => undefined);
        return { kind: "oversized" };
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: "text", value: new TextDecoder().decode(bytes) };
  } catch {
    return { kind: "unreadable" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function abortableSleep(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return sleep(milliseconds);
  if (signal.aborted) throw signal.reason;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const onAbort = () => rejectAbort?.(signal.reason);
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function cancellableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal ? abortReason(signal) : new Error("Operation aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (!signal) return;
    signal.addEventListener("abort", onAbort, { once: true });
    void Promise.resolve().then(() => {
      if (signal.aborted) onAbort();
    });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}
