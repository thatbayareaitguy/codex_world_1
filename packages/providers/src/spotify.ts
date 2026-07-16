import { z } from "zod";

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
    height: z.number().int().nullable(),
    url: spotifyUrl,
    width: z.number().int().nullable(),
  })
  .passthrough();
const artistSchema = simplifiedArtistSchema
  .extend({ images: z.array(imageSchema).default([]) })
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
    external_urls: externalUrlsSchema,
    id: z.string().min(1),
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
export const spotifyAlbumTracksSchema = pagingBaseSchema.extend({
  items: z.array(trackSummarySchema),
});
export const spotifySearchArtistsSchema = z.object({
  artists: pagingBaseSchema.extend({ items: z.array(artistSchema) }),
});
export const spotifyPlaylistsSchema = pagingBaseSchema.extend({ items: z.array(playlistSchema) });
export const spotifyPlaylistItemsSchema = pagingBaseSchema.extend({
  items: z.array(
    z
      .object({
        added_at: z.string().nullable().optional(),
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

export const SPOTIFY_SCOPES = [
  "user-follow-read",
  "playlist-read-private",
  "playlist-modify-private",
] as const;

export class SpotifyHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "SpotifyHttpError";
  }
}

export interface SpotifyRequestMetrics {
  failures: number;
  rateLimitWaitMs: number;
  requests: number;
}

interface SpotifyClientOptions {
  accessToken: () => Promise<string>;
  apiBaseUrl?: string;
  fetcher?: typeof fetch;
  onUnauthorized?: () => Promise<void>;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}

interface RequestOptions {
  body?: unknown;
  method?: "GET" | "POST";
  signal?: AbortSignal | undefined;
}

export class SpotifyClient {
  readonly metrics: SpotifyRequestMetrics = { failures: 0, rateLimitWaitMs: 0, requests: 0 };
  private readonly accessToken: () => Promise<string>;
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly onUnauthorized: (() => Promise<void>) | undefined;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: SpotifyClientOptions) {
    this.accessToken = options.accessToken;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.spotify.com/v1";
    this.fetcher = options.fetcher ?? fetch;
    this.onUnauthorized = options.onUnauthorized;
    this.random = options.random ?? Math.random;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
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

  async getArtistAlbums(id: string, signal?: AbortSignal): Promise<SpotifyAlbumSummary[]> {
    const results: SpotifyAlbumSummary[] = [];
    let offset = 0;
    while (true) {
      const query = new URLSearchParams({
        include_groups: "album,single,appears_on,compilation",
        limit: "10",
        offset: String(offset),
      });
      const page = await this.request(
        `/artists/${encodeURIComponent(id)}/albums?${query}`,
        spotifyArtistAlbumsSchema,
        { signal },
      );
      results.push(...page.items);
      if (!page.next || page.items.length === 0) break;
      offset += page.items.length;
    }
    return results;
  }

  getAlbum(id: string, signal?: AbortSignal): Promise<SpotifyAlbum> {
    return this.request(`/albums/${encodeURIComponent(id)}`, albumSchema, { signal });
  }

  async getAlbumTracks(id: string, signal?: AbortSignal): Promise<SpotifyTrackSummary[]> {
    const results: SpotifyTrackSummary[] = [];
    let offset = 0;
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

  getTrack(id: string, signal?: AbortSignal): Promise<SpotifyTrack> {
    return this.request(`/tracks/${encodeURIComponent(id)}`, trackSchema, { signal });
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

  createPrivatePlaylist(name: string, signal?: AbortSignal): Promise<SpotifyPlaylist> {
    return this.request("/me/playlists", playlistSchema, {
      body: { name, public: false, collaborative: false, description: "Personal release inbox" },
      method: "POST",
      signal,
    });
  }

  getPlaylist(id: string, signal?: AbortSignal): Promise<SpotifyPlaylist> {
    return this.request(`/playlists/${encodeURIComponent(id)}`, playlistSchema, { signal });
  }

  async getPlaylistTrackIds(id: string, signal?: AbortSignal): Promise<Set<string>> {
    const ids = new Set<string>();
    let offset = 0;
    while (true) {
      const page = await this.request(
        `/playlists/${encodeURIComponent(id)}/items?limit=50&offset=${offset}`,
        spotifyPlaylistItemsSchema,
        { signal },
      );
      for (const entry of page.items) if (entry.item?.id) ids.add(entry.item.id);
      if (!page.next || page.items.length === 0) break;
      offset += page.items.length;
    }
    return ids;
  }

  async addPlaylistItems(id: string, trackIds: string[], signal?: AbortSignal): Promise<string[]> {
    const snapshots: string[] = [];
    for (let offset = 0; offset < trackIds.length; offset += 100) {
      const batch = trackIds.slice(offset, offset + 100);
      const response = await this.request(
        `/playlists/${encodeURIComponent(id)}/items`,
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

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    let refreshed = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        this.metrics.requests += 1;
        const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
        const response = await this.fetcher(`${this.apiBaseUrl}${path}`, {
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${await this.accessToken()}`,
            ...(options.body ? { "Content-Type": "application/json" } : {}),
          },
          method: options.method ?? "GET",
          signal,
        });

        if (response.status === 401 && this.onUnauthorized && !refreshed) {
          refreshed = true;
          await this.onUnauthorized();
          attempt -= 1;
          continue;
        }
        if (!response.ok) {
          const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
          throw new SpotifyHttpError(
            `Spotify request failed with status ${response.status}`,
            response.status,
            retryAfterMs,
          );
        }
        return schema.parse(await response.json());
      } catch (error) {
        const retryable =
          (error instanceof SpotifyHttpError && (error.status === 429 || error.status >= 500)) ||
          (!(error instanceof SpotifyHttpError) && !(error instanceof z.ZodError));
        if (!retryable || attempt >= 3) {
          this.metrics.failures += 1;
          throw error;
        }
        const delay =
          error instanceof SpotifyHttpError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : Math.floor(250 * 2 ** (attempt - 1) * (0.5 + this.random() * 0.5));
        if (error instanceof SpotifyHttpError && error.status === 429) {
          this.metrics.rateLimitWaitMs += delay;
        }
        await this.sleep(delay);
      }
    }
    throw new Error("Spotify retry loop exhausted");
  }
}

interface SpotifyOAuthClientOptions {
  accountsBaseUrl?: string;
  clientId: string;
  clientSecret: string;
  fetcher?: typeof fetch;
  redirectUri: string;
}

export class SpotifyOAuthClient {
  private readonly accountsBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetcher: typeof fetch;
  private readonly redirectUri: string;

  constructor(options: SpotifyOAuthClientOptions) {
    this.accountsBaseUrl = options.accountsBaseUrl ?? "https://accounts.spotify.com";
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetcher = options.fetcher ?? fetch;
    this.redirectUri = options.redirectUri;
  }

  authorizationUrl(state: string, codeChallenge: string): string {
    const url = new URL("/authorize", this.accountsBaseUrl);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: SPOTIFY_SCOPES.join(" "),
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
    const response = await this.fetcher(`${this.accountsBaseUrl}/api/token`, {
      body,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new SpotifyHttpError(
        `Spotify token request failed with status ${response.status}`,
        response.status,
      );
    }
    return spotifyTokenSchema.parse(await response.json());
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1_000) : undefined;
}
