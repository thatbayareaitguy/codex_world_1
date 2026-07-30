import type { ProviderScanResult, ReleaseType, TrackCandidate } from "@radar/core";
import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { DiscoveryProvider, ScanContext } from "./contracts";

const APPLE_MUSIC_ORIGIN = "https://api.music.apple.com";
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3_600;
const MAX_TOKEN_LIFETIME_SECONDS = 15_777_000;
const DEFAULT_REQUEST_INTERVAL_MS = 1_100;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REQUESTS = 200;
const DEFAULT_MAX_RUNTIME_MS = 30 * 60_000;
const MAX_BATCH_ARTISTS = 25;
const MAX_BATCH_SONGS = 25;

export const appleMusicArtistViews = [
  "latest-release",
  "singles",
  "full-albums",
  "live-albums",
  "compilation-albums",
  "appears-on-albums",
] as const;

export type AppleMusicArtistView = (typeof appleMusicArtistViews)[number];

const resourceReferenceSchema = z.object({
  href: z.string().optional(),
  id: z.string().min(1),
  type: z.string().min(1),
});

const relationshipReferenceSchema = z.object({
  data: z.array(resourceReferenceSchema).default([]),
  href: z.string().optional(),
  next: z.string().optional(),
});

const embeddedViewSchema = z.object({
  data: z.array(z.unknown()).default([]),
  href: z.string().optional(),
  next: z.string().optional(),
});

const artistResourceSchema = z.object({
  attributes: z
    .object({
      genreNames: z.array(z.string()).default([]),
      name: z.string().min(1),
      url: z.string().optional(),
    })
    .optional(),
  href: z.string().optional(),
  id: z.string().min(1),
  relationships: z
    .object({
      albums: relationshipReferenceSchema.optional(),
    })
    .optional(),
  type: z.literal("artists"),
  views: z.record(z.string(), embeddedViewSchema).optional(),
});

const albumResourceSchema = z.object({
  attributes: z
    .object({
      artistName: z.string().min(1),
      contentRating: z.enum(["clean", "explicit"]).optional(),
      genreNames: z.array(z.string()).default([]),
      isCompilation: z.boolean().optional(),
      isSingle: z.boolean().optional(),
      name: z.string().min(1),
      releaseDate: z.string().optional(),
      trackCount: z.number().int().nonnegative().optional(),
      upc: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  href: z.string().optional(),
  id: z.string().min(1),
  relationships: z
    .object({
      artists: relationshipReferenceSchema.optional(),
      tracks: relationshipReferenceSchema.optional(),
    })
    .optional(),
  type: z.literal("albums"),
});

const songResourceSchema = z.object({
  attributes: z
    .object({
      albumName: z.string().optional(),
      artistName: z.string().min(1),
      contentRating: z.enum(["clean", "explicit"]).optional(),
      discNumber: z.number().int().positive().optional(),
      durationInMillis: z.number().int().nonnegative().optional(),
      genreNames: z.array(z.string()).default([]),
      isrc: z.string().optional(),
      name: z.string().min(1),
      releaseDate: z.string().optional(),
      trackNumber: z.number().int().positive().optional(),
      url: z.string().optional(),
    })
    .optional(),
  href: z.string().optional(),
  id: z.string().min(1),
  relationships: z
    .object({
      albums: relationshipReferenceSchema.optional(),
      artists: relationshipReferenceSchema.optional(),
    })
    .optional(),
  type: z.literal("songs"),
});

const artistsResponseSchema = z.object({
  data: z.array(artistResourceSchema),
  next: z.string().optional(),
});

const albumsResponseSchema = z.object({
  data: z.array(albumResourceSchema),
  next: z.string().optional(),
});

const songsResponseSchema = z.object({
  data: z.array(songResourceSchema),
  next: z.string().optional(),
});

const searchResponseSchema = z.object({
  results: z.object({
    artists: z
      .object({
        data: z.array(artistResourceSchema),
        href: z.string().optional(),
        next: z.string().optional(),
      })
      .optional(),
  }),
});

export interface AppleMusicArtist {
  artistId: string;
  evidenceUrl?: string;
  genreNames: string[];
  name: string;
  sourceStorefront: string;
}

export interface AppleMusicAlbum {
  albumId: string;
  artistIds: string[];
  artistName: string;
  contentRating?: "clean" | "explicit";
  evidenceUrl?: string;
  genreNames: string[];
  isCompilation?: boolean;
  isSingle?: boolean;
  paginationPath: string;
  pageNumber: number;
  releaseDate?: string;
  sourceStorefront: string;
  sourceView: AppleMusicArtistView | "album";
  title: string;
  trackCount?: number;
  upc?: string;
}

export interface AppleMusicSong {
  albumId?: string;
  artistIds: string[];
  artistName: string;
  contentRating?: "clean" | "explicit";
  discNumber?: number;
  durationMs?: number;
  evidenceUrl?: string;
  isrc?: string;
  paginationPath: string;
  pageNumber: number;
  releaseDate?: string;
  songId: string;
  sourceStorefront: string;
  title: string;
  trackNumber?: number;
}

export interface AppleMusicBatchResult<T> {
  items: T[];
  missingIds: string[];
}

export type AppleMusicEndpointCategory =
  | "artist_search"
  | "artist"
  | "artists_batch"
  | "artist_view"
  | "album"
  | "album_tracks"
  | "songs_batch";

export interface AppleMusicRequestPermit {
  eventId: string;
  leaseToken: string;
  startedAt: Date;
}

export interface AppleMusicRequestPersistence {
  acquire(input: {
    endpointCategory: AppleMusicEndpointCategory;
    identity: string;
    maxRequests: number;
    minIntervalMs: number;
    runId: string;
  }): Promise<AppleMusicRequestPermit>;
  complete(input: {
    bodyBytes: number;
    cacheValue?: unknown;
    completedAt: Date;
    cooldownUntil?: Date;
    errorClassification?: string;
    eventId: string;
    leaseToken: string;
    retryAfterSeconds?: number;
    status?: number;
  }): Promise<void>;
  loadCache(identity: string): Promise<unknown>;
  recordCacheHit(input: {
    endpointCategory: AppleMusicEndpointCategory;
    identity: string;
    runId: string;
  }): Promise<void>;
}

export interface AppleDeveloperTokenOptions {
  keyId: string;
  now?: () => Date;
  privateKeyPath: string;
  readPrivateKey?: (path: string) => string | Buffer;
  teamId: string;
  tokenLifetimeSeconds?: number;
}

export class AppleMusicAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleMusicAuthenticationError";
  }
}

export class AppleDeveloperTokenManager {
  private cached?: { expiresAtSeconds: number; token: string };
  private key?: KeyObject;
  private readonly now: () => Date;
  private readonly readPrivateKey: (path: string) => string | Buffer;
  private readonly tokenLifetimeSeconds: number;

  constructor(private readonly options: AppleDeveloperTokenOptions) {
    if (!/^[A-Z0-9]{10}$/.test(options.teamId)) {
      throw new AppleMusicAuthenticationError("Apple Music Team ID is invalid.");
    }
    if (!/^[A-Z0-9]{10}$/.test(options.keyId)) {
      throw new AppleMusicAuthenticationError("Apple Music Key ID is invalid.");
    }
    if (!isAbsolute(options.privateKeyPath)) {
      throw new AppleMusicAuthenticationError("Apple Music private-key path must be absolute.");
    }
    this.tokenLifetimeSeconds = options.tokenLifetimeSeconds ?? DEFAULT_TOKEN_LIFETIME_SECONDS;
    if (
      !Number.isInteger(this.tokenLifetimeSeconds) ||
      this.tokenLifetimeSeconds < 300 ||
      this.tokenLifetimeSeconds > MAX_TOKEN_LIFETIME_SECONDS
    ) {
      throw new AppleMusicAuthenticationError("Apple Music token lifetime is invalid.");
    }
    this.now = options.now ?? (() => new Date());
    this.readPrivateKey = options.readPrivateKey ?? ((path) => readFileSync(path));
  }

  getToken(): string {
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    const refreshSkew = Math.min(300, Math.floor(this.tokenLifetimeSeconds / 10));
    if (this.cached && nowSeconds < this.cached.expiresAtSeconds - refreshSkew) {
      return this.cached.token;
    }
    const expiresAtSeconds = nowSeconds + this.tokenLifetimeSeconds;
    const header = encodeJson({
      alg: "ES256",
      kid: this.options.keyId,
      typ: "JWT",
    });
    const payload = encodeJson({
      exp: expiresAtSeconds,
      iat: nowSeconds,
      iss: this.options.teamId,
    });
    const signingInput = `${header}.${payload}`;
    const signature = sign("sha256", Buffer.from(signingInput), {
      dsaEncoding: "ieee-p1363",
      key: this.privateKey(),
    }).toString("base64url");
    const token = `${signingInput}.${signature}`;
    this.cached = { expiresAtSeconds, token };
    return token;
  }

  private privateKey(): KeyObject {
    if (this.key) return this.key;
    try {
      const key = createPrivateKey(this.readPrivateKey(this.options.privateKeyPath));
      if (key.type !== "private" || key.asymmetricKeyType !== "ec") {
        throw new AppleMusicAuthenticationError(
          "Apple Music private key must be an EC private key.",
        );
      }
      if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        throw new AppleMusicAuthenticationError(
          "Apple Music private key must use the P-256 curve.",
        );
      }
      this.key = key;
      return key;
    } catch (error) {
      if (error instanceof AppleMusicAuthenticationError) throw error;
      throw new AppleMusicAuthenticationError("Apple Music private key is unavailable.");
    }
  }
}

export interface AppleMusicClientOptions {
  enabled: boolean;
  fetchImpl?: typeof fetch;
  maxRequestsPerRun?: number;
  maxResponseBytes?: number;
  maximumRuntimeMs?: number;
  maxRetries?: number;
  minRequestIntervalMs?: number;
  now?: () => Date;
  persistence: AppleMusicRequestPersistence;
  requestTimeoutMs?: number;
  runId: string;
  sleep?: (milliseconds: number) => Promise<void>;
  storefront?: string;
  tokenProvider: Pick<AppleDeveloperTokenManager, "getToken">;
}

export class AppleMusicClientError extends Error {
  constructor(
    message: string,
    readonly classification: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AppleMusicClientError";
  }
}

export class AppleMusicClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxRequestsPerRun: number;
  private readonly maxResponseBytes: number;
  private readonly maximumRuntimeMs: number;
  private readonly maxRetries: number;
  private readonly minRequestIntervalMs: number;
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly startedAt: number;
  private readonly storefront: string;
  private issuedRequests = 0;

  constructor(private readonly options: AppleMusicClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRequestsPerRun = options.maxRequestsPerRun ?? DEFAULT_MAX_REQUESTS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.maximumRuntimeMs = options.maximumRuntimeMs ?? DEFAULT_MAX_RUNTIME_MS;
    this.maxRetries = options.maxRetries ?? 2;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.storefront = options.storefront ?? "us";
    this.startedAt = this.now().getTime();
    if (!/^[a-z]{2}$/.test(this.storefront)) {
      throw new AppleMusicClientError("Apple Music storefront is invalid.", "invalid_storefront");
    }
    if (!Number.isInteger(this.minRequestIntervalMs) || this.minRequestIntervalMs < 1_100) {
      throw new AppleMusicClientError(
        "Apple Music request interval must be at least 1100 milliseconds.",
        "unsafe_request_interval",
      );
    }
    if (!Number.isInteger(this.maxRequestsPerRun) || this.maxRequestsPerRun < 1) {
      throw new AppleMusicClientError(
        "Apple Music request budget must be positive.",
        "invalid_request_budget",
      );
    }
    if (!Number.isInteger(this.maximumRuntimeMs) || this.maximumRuntimeMs < 1_000) {
      throw new AppleMusicClientError(
        "Apple Music runtime budget is invalid.",
        "invalid_runtime_budget",
      );
    }
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 3) {
      throw new AppleMusicClientError("Apple Music retry limit is invalid.", "invalid_retry_limit");
    }
  }

  async searchArtists(term: string, signal?: AbortSignal): Promise<AppleMusicArtist[]> {
    if (!term.trim()) return [];
    const url = this.catalogUrl("search");
    url.searchParams.set("limit", "25");
    url.searchParams.set("term", term.trim());
    url.searchParams.set("types", "artists");
    const response = await this.request(url, "artist_search", searchResponseSchema, signal);
    return (response.results.artists?.data ?? []).map((artist) =>
      normalizeArtist(artist, this.storefront),
    );
  }

  async getArtist(id: string, signal?: AbortSignal): Promise<AppleMusicArtist | undefined> {
    const response = await this.request(
      this.catalogUrl(`artists/${encodeIdentifier(id)}`),
      "artist",
      artistsResponseSchema,
      signal,
    );
    const artist = response.data[0];
    return artist ? normalizeArtist(artist, this.storefront) : undefined;
  }

  async getArtists(
    ids: string[],
    signal?: AbortSignal,
  ): Promise<AppleMusicBatchResult<AppleMusicArtist>> {
    const uniqueIds = uniqueIdentifiers(ids, MAX_BATCH_ARTISTS, "artist");
    const url = this.catalogUrl("artists");
    url.searchParams.set("ids", uniqueIds.join(","));
    const response = await this.request(url, "artists_batch", artistsResponseSchema, signal);
    const items = response.data.map((artist) => normalizeArtist(artist, this.storefront));
    const returned = new Set(items.map((artist) => artist.artistId));
    return { items, missingIds: uniqueIds.filter((id) => !returned.has(id)) };
  }

  async getArtistView(
    artistId: string,
    view: AppleMusicArtistView,
    signal?: AbortSignal,
  ): Promise<AppleMusicAlbum[]> {
    const initialPath = `/v1/catalog/${this.storefront}/artists/${encodeIdentifier(artistId)}/view/${view}?limit=100&with=attributes`;
    return this.paginateAlbums(initialPath, view, signal);
  }

  async getAllArtistViews(
    artistId: string,
    signal?: AbortSignal,
  ): Promise<Record<AppleMusicArtistView, AppleMusicAlbum[]>> {
    const entries: Array<readonly [AppleMusicArtistView, AppleMusicAlbum[]]> = [];
    for (const view of appleMusicArtistViews) {
      entries.push([view, await this.getArtistView(artistId, view, signal)]);
    }
    return Object.fromEntries(entries) as Record<AppleMusicArtistView, AppleMusicAlbum[]>;
  }

  embeddedArtistView(value: unknown, view: AppleMusicArtistView): AppleMusicAlbum[] {
    const artist = artistResourceSchema.parse(value);
    const relationship = artist.views?.[view];
    if (!relationship) return [];
    validateOptionalPath(relationship.href, this.storefront);
    validateOptionalPath(relationship.next, this.storefront);
    const albums: AppleMusicAlbum[] = [];
    for (const resource of relationship.data) {
      const parsed = albumResourceSchema.safeParse(resource);
      if (parsed.success && parsed.data.type === "albums") {
        albums.push(
          normalizeAlbum(
            parsed.data,
            this.storefront,
            view,
            1,
            relationship.href ??
              artist.href ??
              `/v1/catalog/${this.storefront}/artists/${artist.id}`,
          ),
        );
      }
    }
    return albums;
  }

  async getAlbum(id: string, signal?: AbortSignal): Promise<AppleMusicAlbum | undefined> {
    const url = this.catalogUrl(`albums/${encodeIdentifier(id)}`);
    url.searchParams.set("include", "artists");
    const response = await this.request(url, "album", albumsResponseSchema, signal);
    const album = response.data[0];
    return album
      ? normalizeAlbum(album, this.storefront, "album", 1, url.pathname + url.search)
      : undefined;
  }

  async getAlbumTracks(id: string, signal?: AbortSignal): Promise<AppleMusicSong[]> {
    const initialPath = `/v1/catalog/${this.storefront}/albums/${encodeIdentifier(id)}/tracks?limit=100`;
    const songs: AppleMusicSong[] = [];
    const seenSongs = new Set<string>();
    await this.paginate(
      initialPath,
      "album_tracks",
      songsResponseSchema,
      signal,
      (page, path, pageNumber) => {
        for (const resource of page.data) {
          if (seenSongs.has(resource.id)) continue;
          seenSongs.add(resource.id);
          songs.push(normalizeSong(resource, this.storefront, pageNumber, path, id));
        }
      },
    );
    return songs.sort(compareSongPosition);
  }

  async getSongs(
    ids: string[],
    signal?: AbortSignal,
  ): Promise<AppleMusicBatchResult<AppleMusicSong>> {
    const uniqueIds = uniqueIdentifiers(ids, MAX_BATCH_SONGS, "song");
    const url = this.catalogUrl("songs");
    url.searchParams.set("ids", uniqueIds.join(","));
    url.searchParams.set("include", "albums,artists");
    const response = await this.request(url, "songs_batch", songsResponseSchema, signal);
    const items = response.data.map((song) =>
      normalizeSong(song, this.storefront, 1, url.pathname + url.search),
    );
    const returned = new Set(items.map((song) => song.songId));
    return { items, missingIds: uniqueIds.filter((id) => !returned.has(id)) };
  }

  private async paginateAlbums(
    initialPath: string,
    view: AppleMusicArtistView,
    signal?: AbortSignal,
  ): Promise<AppleMusicAlbum[]> {
    const albums: AppleMusicAlbum[] = [];
    const seenAlbums = new Set<string>();
    await this.paginate(
      initialPath,
      "artist_view",
      albumsResponseSchema,
      signal,
      (page, path, pageNumber) => {
        for (const resource of page.data) {
          if (seenAlbums.has(resource.id)) continue;
          seenAlbums.add(resource.id);
          albums.push(normalizeAlbum(resource, this.storefront, view, pageNumber, path));
        }
      },
    );
    return albums.sort(compareAlbumDate);
  }

  private async paginate<T>(
    initialPath: string,
    endpointCategory: AppleMusicEndpointCategory,
    schema: z.ZodType<T>,
    signal: AbortSignal | undefined,
    consume: (page: T, path: string, pageNumber: number) => void,
  ): Promise<void> {
    let path = assertAllowedAppleMusicPath(initialPath, this.storefront);
    const seenPages = new Set<string>();
    let pageNumber = 0;
    while (true) {
      if (seenPages.has(path)) {
        throw new AppleMusicClientError(
          "Apple Music pagination repeated a page.",
          "duplicate_next_page",
        );
      }
      seenPages.add(path);
      pageNumber += 1;
      const page = await this.request(
        new URL(path, APPLE_MUSIC_ORIGIN),
        endpointCategory,
        schema,
        signal,
      );
      consume(page, path, pageNumber);
      const next = (page as { next?: string }).next;
      if (!next) return;
      path = assertAllowedAppleMusicPath(next, this.storefront);
    }
  }

  private async request<T>(
    url: URL,
    endpointCategory: AppleMusicEndpointCategory,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.assertEnabled();
    assertAllowedAppleMusicUrl(url, this.storefront);
    const identity = normalizedAppleMusicRequestIdentity(url);
    const cached = await this.options.persistence.loadCache(identity);
    if (cached !== null && cached !== undefined) {
      const parsed = schema.parse(cached);
      await this.options.persistence.recordCacheHit({
        endpointCategory,
        identity,
        runId: this.options.runId,
      });
      return parsed;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      this.assertBudgets();
      const permit = await this.options.persistence.acquire({
        endpointCategory,
        identity,
        maxRequests: this.maxRequestsPerRun,
        minIntervalMs: this.minRequestIntervalMs,
        runId: this.options.runId,
      });
      this.issuedRequests += 1;
      let completed = false;
      let responseBytes = 0;
      let responseStatus: number | undefined;
      try {
        const { cleanup, response } = await this.fetchWithTimeout(url, signal);
        responseStatus = response.status;
        let body: Awaited<ReturnType<typeof readBoundedBody>>;
        try {
          body = await readBoundedBody(response, this.maxResponseBytes);
          responseBytes = body.bytes;
        } finally {
          cleanup();
        }
        const retryAfterSeconds = parseAppleRetryAfter(
          response.headers.get("retry-after"),
          this.now(),
        );
        if (!response.ok) {
          const classification = classifyHttpStatus(response.status);
          const cooldownUntil =
            response.status === 429 && retryAfterSeconds !== undefined
              ? new Date(this.now().getTime() + retryAfterSeconds * 1_000)
              : undefined;
          await this.options.persistence.complete({
            bodyBytes: body.bytes,
            completedAt: this.now(),
            ...(cooldownUntil ? { cooldownUntil } : {}),
            errorClassification: classification,
            eventId: permit.eventId,
            leaseToken: permit.leaseToken,
            ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
            status: response.status,
          });
          completed = true;
          const error = new AppleMusicClientError(
            `Apple Music request failed with HTTP ${response.status}.`,
            classification,
            response.status,
            retryAfterSeconds,
          );
          if (response.status >= 500 && attempt < this.maxRetries) {
            lastError = error;
            await this.sleep(
              retryAfterSeconds === undefined ? 250 * 2 ** attempt : retryAfterSeconds * 1_000,
            );
            continue;
          }
          throw error;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(body.text);
        } catch {
          throw new AppleMusicClientError(
            "Apple Music returned malformed JSON.",
            "malformed_json",
            response.status,
          );
        }
        const parsed = schema.parse(decoded);
        await this.options.persistence.complete({
          bodyBytes: body.bytes,
          cacheValue: parsed,
          completedAt: this.now(),
          eventId: permit.eventId,
          leaseToken: permit.leaseToken,
          status: response.status,
        });
        completed = true;
        return parsed;
      } catch (error) {
        if (completed) throw error;
        const classified = classifyTransportError(error);
        await this.options.persistence.complete({
          bodyBytes: responseBytes,
          completedAt: this.now(),
          errorClassification: classified.classification,
          eventId: permit.eventId,
          leaseToken: permit.leaseToken,
          ...(responseStatus === undefined ? {} : { status: responseStatus }),
        });
        throw classified;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new AppleMusicClientError("Apple Music retries were exhausted.", "retry_exhausted");
  }

  private async fetchWithTimeout(
    url: URL,
    signal?: AbortSignal,
  ): Promise<{ cleanup: () => void; response: Response }> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Apple Music request timed out.")),
      this.requestTimeoutMs,
    );
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.tokenProvider.getToken()}`,
        },
        method: "GET",
        signal: controller.signal,
      });
      return { cleanup, response };
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private assertEnabled(): void {
    if (!this.options.enabled) {
      throw new AppleMusicClientError(
        "Apple Music catalog access is disabled.",
        "provider_disabled",
      );
    }
  }

  private assertBudgets(): void {
    if (this.issuedRequests >= this.maxRequestsPerRun) {
      throw new AppleMusicClientError(
        "Apple Music request budget is exhausted.",
        "request_budget_exhausted",
      );
    }
    if (this.now().getTime() - this.startedAt >= this.maximumRuntimeMs) {
      throw new AppleMusicClientError(
        "Apple Music runtime budget is exhausted.",
        "runtime_budget_exhausted",
      );
    }
  }

  private catalogUrl(path: string): URL {
    return new URL(`/v1/catalog/${this.storefront}/${path}`, APPLE_MUSIC_ORIGIN);
  }
}

export interface AppleMusicProviderMapping {
  appleArtistId: string;
  canonicalArtistId: string;
  canonicalName: string;
}

export class AppleMusicProvider implements DiscoveryProvider {
  readonly name = "apple_music" as const;

  constructor(
    private readonly client: AppleMusicClient,
    private readonly mappings: AppleMusicProviderMapping[],
    private readonly now = () => new Date(),
  ) {}

  async scan(context: ScanContext): Promise<ProviderScanResult> {
    const selected = this.mappings.filter(
      (mapping) =>
        (!context.filter.artistId || mapping.canonicalArtistId === context.filter.artistId) &&
        (!context.filter.artistExternalId ||
          mapping.appleArtistId === context.filter.artistExternalId),
    );
    const candidates: TrackCandidate[] = [];
    for (const mapping of selected) {
      const views = await this.client.getAllArtistViews(mapping.appleArtistId, context.signal);
      const albums = dedupeBy(
        appleMusicArtistViews.flatMap((view) => views[view]),
        (album) => album.albumId,
      );
      for (const album of albums) {
        const songs = await this.client.getAlbumTracks(album.albumId, context.signal);
        for (const song of songs) {
          candidates.push(toTrackCandidate(mapping, album, song, this.now()));
        }
      }
    }
    return { candidates };
  }
}

export function assertAllowedAppleMusicUrl(url: URL, storefront: string): void {
  const escapedStorefront = storefront.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const allowedPath = new RegExp(
    `^/v1/catalog/${escapedStorefront}/(?:search|artists(?:/[^/]+(?:/view/(?:${appleMusicArtistViews.join("|")}))?)?|albums/[^/]+(?:/tracks)?|songs(?:/[^/]+)?)$`,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.music.apple.com" ||
    (url.port && url.port !== "443") ||
    url.username ||
    url.password ||
    url.hash ||
    !allowedPath.test(url.pathname)
  ) {
    throw new AppleMusicClientError(
      "Apple Music URL is outside the catalog allowlist.",
      "unsafe_url",
    );
  }
}

export function assertAllowedAppleMusicPath(path: string, storefront: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) {
    throw new AppleMusicClientError(
      "Apple Music pagination path is unsafe.",
      "unsafe_pagination_path",
    );
  }
  const url = new URL(path, APPLE_MUSIC_ORIGIN);
  assertAllowedAppleMusicUrl(url, storefront);
  return `${url.pathname}${url.search}`;
}

export function normalizedAppleMusicRequestIdentity(url: URL): string {
  const normalized = new URL(url);
  normalized.searchParams.sort();
  return `${normalized.pathname}${normalized.search}`;
}

export function parseAppleRetryAfter(value: string | null, now = new Date()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.ceil((parsed - now.getTime()) / 1_000));
}

function normalizeArtist(
  resource: z.infer<typeof artistResourceSchema>,
  storefront: string,
): AppleMusicArtist {
  if (!resource.attributes) {
    throw new AppleMusicClientError(
      "Apple Music artist attributes are missing.",
      "invalid_payload",
    );
  }
  validateOptionalPath(resource.href, storefront);
  validateRelationship(resource.relationships?.albums, storefront);
  const evidenceUrl = safeEvidenceUrl(resource.attributes.url);
  return {
    artistId: resource.id,
    ...(evidenceUrl ? { evidenceUrl } : {}),
    genreNames: resource.attributes.genreNames,
    name: resource.attributes.name,
    sourceStorefront: storefront,
  };
}

function normalizeAlbum(
  resource: z.infer<typeof albumResourceSchema>,
  storefront: string,
  sourceView: AppleMusicAlbum["sourceView"],
  pageNumber: number,
  paginationPath: string,
): AppleMusicAlbum {
  if (!resource.attributes) {
    throw new AppleMusicClientError("Apple Music album attributes are missing.", "invalid_payload");
  }
  validateOptionalPath(resource.href, storefront);
  validateOptionalPath(resource.relationships?.artists?.href, storefront);
  validateOptionalPath(resource.relationships?.tracks?.href, storefront);
  validateRelationship(resource.relationships?.artists, storefront);
  validateRelationship(resource.relationships?.tracks, storefront);
  const evidenceUrl = safeEvidenceUrl(resource.attributes.url);
  return {
    albumId: resource.id,
    artistIds: resource.relationships?.artists?.data.map((artist) => artist.id) ?? [],
    artistName: resource.attributes.artistName,
    ...(resource.attributes.contentRating
      ? { contentRating: resource.attributes.contentRating }
      : {}),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    genreNames: resource.attributes.genreNames,
    ...(resource.attributes.isCompilation === undefined
      ? {}
      : { isCompilation: resource.attributes.isCompilation }),
    ...(resource.attributes.isSingle === undefined
      ? {}
      : { isSingle: resource.attributes.isSingle }),
    paginationPath,
    pageNumber,
    ...(resource.attributes.releaseDate ? { releaseDate: resource.attributes.releaseDate } : {}),
    sourceStorefront: storefront,
    sourceView,
    title: resource.attributes.name,
    ...(resource.attributes.trackCount === undefined
      ? {}
      : { trackCount: resource.attributes.trackCount }),
    ...(resource.attributes.upc ? { upc: resource.attributes.upc } : {}),
  };
}

function normalizeSong(
  resource: z.infer<typeof songResourceSchema>,
  storefront: string,
  pageNumber: number,
  paginationPath: string,
  fallbackAlbumId?: string,
): AppleMusicSong & { songId: string } {
  if (!resource.attributes) {
    throw new AppleMusicClientError("Apple Music song attributes are missing.", "invalid_payload");
  }
  validateOptionalPath(resource.href, storefront);
  validateOptionalPath(resource.relationships?.albums?.href, storefront);
  validateOptionalPath(resource.relationships?.artists?.href, storefront);
  validateRelationship(resource.relationships?.albums, storefront);
  validateRelationship(resource.relationships?.artists, storefront);
  const albumId = resource.relationships?.albums?.data[0]?.id ?? fallbackAlbumId;
  const evidenceUrl = safeEvidenceUrl(resource.attributes.url);
  return {
    ...(albumId ? { albumId } : {}),
    artistIds: resource.relationships?.artists?.data.map((artist) => artist.id) ?? [],
    artistName: resource.attributes.artistName,
    ...(resource.attributes.contentRating
      ? { contentRating: resource.attributes.contentRating }
      : {}),
    ...(resource.attributes.discNumber === undefined
      ? {}
      : { discNumber: resource.attributes.discNumber }),
    ...(resource.attributes.durationInMillis === undefined
      ? {}
      : { durationMs: resource.attributes.durationInMillis }),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    ...(resource.attributes.isrc ? { isrc: resource.attributes.isrc } : {}),
    paginationPath,
    pageNumber,
    ...(resource.attributes.releaseDate ? { releaseDate: resource.attributes.releaseDate } : {}),
    songId: resource.id,
    sourceStorefront: storefront,
    title: resource.attributes.name,
    ...(resource.attributes.trackNumber === undefined
      ? {}
      : { trackNumber: resource.attributes.trackNumber }),
  };
}

function toTrackCandidate(
  mapping: AppleMusicProviderMapping,
  album: AppleMusicAlbum,
  song: AppleMusicSong,
  observedAt: Date,
): TrackCandidate {
  const releaseDate = normalizeReleaseDate(song.releaseDate ?? album.releaseDate);
  const externalTrackId = song.songId;
  if (!externalTrackId) {
    throw new AppleMusicClientError("Apple Music song ID is missing.", "invalid_payload");
  }
  const evidenceUrl = song.evidenceUrl ?? album.evidenceUrl;
  if (!evidenceUrl) {
    throw new AppleMusicClientError("Apple Music evidence URL is missing.", "invalid_payload");
  }
  const releaseType = classifyAlbum(album);
  const payloadHash = createHash("sha256")
    .update(
      JSON.stringify({
        albumId: album.albumId,
        artistId: mapping.appleArtistId,
        discNumber: song.discNumber,
        releaseDate: releaseDate.date,
        songId: externalTrackId,
        title: song.title,
        trackNumber: song.trackNumber,
      }),
    )
    .digest("hex");
  return {
    artistExternalId: mapping.appleArtistId,
    artistName: song.artistName || mapping.canonicalName,
    availability: "unavailable",
    credits: [{ name: song.artistName || mapping.canonicalName, role: "primary" }],
    ...(song.discNumber === undefined ? {} : { discNumber: song.discNumber }),
    ...(song.durationMs === undefined ? {} : { durationMs: song.durationMs }),
    evidenceType: `apple_music_catalog_${album.sourceView}`,
    evidenceUrl,
    externalReleaseId: album.albumId,
    externalTrackId,
    firstSeenAt: observedAt.toISOString(),
    ...(song.isrc ? { isrc: song.isrc } : {}),
    payloadHash,
    provider: "apple_music",
    providerUrl: evidenceUrl,
    region: album.sourceStorefront.toUpperCase(),
    releaseDate: releaseDate.date,
    releaseDatePrecision: releaseDate.precision,
    releaseTitle: album.title,
    releaseType,
    sourceLabel: "Apple Music Catalog",
    title: song.title,
    ...(song.trackNumber === undefined ? {} : { trackNumber: song.trackNumber }),
    ...(album.upc ? { upc: album.upc } : {}),
  };
}

function classifyAlbum(album: AppleMusicAlbum): ReleaseType {
  const title = album.title.toLowerCase();
  if (album.sourceView === "appears-on-albums") return "feature";
  if (album.sourceView === "live-albums" || /\blive\b/.test(title)) return "live";
  if (album.sourceView === "compilation-albums" || album.isCompilation) return "compilation";
  if (/\bremix(?:es)?\b/.test(title)) return "remix";
  if (album.sourceView === "singles" || album.isSingle || (album.trackCount ?? 0) <= 3)
    return "single";
  if ((album.trackCount ?? 0) <= 6 || /\bep\b/.test(title)) return "ep";
  return "album";
}

function normalizeReleaseDate(value: string | undefined): {
  date: string;
  precision: "day" | "month" | "year";
} {
  if (!value || !/^\d{4}(?:-\d{2})?(?:-\d{2})?$/.test(value)) {
    throw new AppleMusicClientError("Apple Music release date is invalid.", "invalid_payload");
  }
  if (value.length === 4) return { date: `${value}-01-01`, precision: "year" };
  if (value.length === 7) return { date: `${value}-01`, precision: "month" };
  return { date: value, precision: "day" };
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<{ bytes: number; text: string }> {
  if (!response.body) return { bytes: 0, text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new AppleMusicClientError(
        "Apple Music response exceeded the configured size limit.",
        "response_too_large",
      );
    }
    chunks.push(result.value);
  }
  return { bytes, text: Buffer.concat(chunks).toString("utf8") };
}

function classifyHttpStatus(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "temporary_server_error";
  return "http_error";
}

function classifyTransportError(error: unknown): AppleMusicClientError {
  if (error instanceof AppleMusicClientError) return error;
  if (error instanceof z.ZodError) {
    return new AppleMusicClientError(
      "Apple Music returned an invalid catalog payload.",
      "invalid_payload",
    );
  }
  const message = error instanceof Error ? error.message : "";
  return new AppleMusicClientError(
    message.toLowerCase().includes("timed out") || message.toLowerCase().includes("abort")
      ? "Apple Music request timed out."
      : "Apple Music transport failed.",
    message.toLowerCase().includes("timed out") || message.toLowerCase().includes("abort")
      ? "timeout"
      : "transport_error",
  );
}

function encodeJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function encodeIdentifier(value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new AppleMusicClientError("Apple Music identifier is invalid.", "invalid_identifier");
  }
  return encodeURIComponent(value);
}

function uniqueIdentifiers(ids: string[], maximum: number, label: string): string[] {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) {
    throw new AppleMusicClientError(
      `Apple Music ${label} identifiers are required.`,
      "missing_ids",
    );
  }
  if (unique.length > maximum) {
    throw new AppleMusicClientError(
      `Apple Music ${label} batch exceeds ${maximum} identifiers.`,
      "batch_limit_exceeded",
    );
  }
  for (const id of unique) encodeIdentifier(id);
  return unique;
}

function validateOptionalPath(path: string | undefined, storefront: string): void {
  if (path) assertAllowedAppleMusicPath(path, storefront);
}

function validateRelationship(
  relationship: z.infer<typeof relationshipReferenceSchema> | undefined,
  storefront: string,
): void {
  if (!relationship) return;
  validateOptionalPath(relationship.href, storefront);
  validateOptionalPath(relationship.next, storefront);
  for (const resource of relationship.data) {
    validateOptionalPath(resource.href, storefront);
  }
}

function safeEvidenceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "music.apple.com" ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function compareAlbumDate(left: AppleMusicAlbum, right: AppleMusicAlbum): number {
  const date = (right.releaseDate ?? "").localeCompare(left.releaseDate ?? "");
  return date || left.albumId.localeCompare(right.albumId);
}

function compareSongPosition(left: AppleMusicSong, right: AppleMusicSong): number {
  return (
    (left.discNumber ?? Number.MAX_SAFE_INTEGER) - (right.discNumber ?? Number.MAX_SAFE_INTEGER) ||
    (left.trackNumber ?? Number.MAX_SAFE_INTEGER) -
      (right.trackNumber ?? Number.MAX_SAFE_INTEGER) ||
    left.title.localeCompare(right.title)
  );
}

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
