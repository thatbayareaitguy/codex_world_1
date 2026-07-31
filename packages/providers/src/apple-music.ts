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

const artistViewFirstPageResponseSchema = z.object({
  data: z.array(albumResourceSchema),
  next: z.union([z.string(), z.boolean()]).optional(),
});

const searchResponseSchema = z.object({
  results: z.object({
    albums: z
      .object({
        data: z.array(albumResourceSchema),
        href: z.string().optional(),
        next: z.string().optional(),
      })
      .optional(),
    artists: z
      .object({
        data: z.array(artistResourceSchema),
        href: z.string().optional(),
        next: z.string().optional(),
      })
      .optional(),
    songs: z
      .object({
        data: z.array(songResourceSchema),
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
  albumName?: string;
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

export interface AppleMusicArtistViewPage {
  items: AppleMusicAlbum[];
  nextPresent: boolean;
}

export interface AppleMusicRecentSearchPage {
  albums: AppleMusicAlbum[];
  albumsNextPresent: boolean;
  songs: AppleMusicSong[];
  songsNextPresent: boolean;
}

export type AppleMusicEndpointCategory =
  | "artist_search"
  | "artist"
  | "artists_batch"
  | "artist_albums"
  | "artist_view"
  | "album"
  | "album_tracks"
  | "songs_batch";

type AppleMusicRouteClassification = AppleMusicEndpointCategory | "unsupported";

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

export interface AppleMusicUrlDiagnostic {
  fieldPath: string;
  form: "absolute" | "malformed" | "relative";
  host: "allowed_api" | "apple_sharing" | "cross_host" | "none";
  operation: AppleMusicEndpointCategory | "none";
  reason:
    | "cross_host"
    | "embedded_credentials"
    | "fragment"
    | "invalid_form"
    | "invalid_scheme"
    | "missing_owner"
    | "non_catalog_path"
    | "nonstandard_port"
    | "operation_mismatch"
    | "outside_allowlist"
    | "personal_scope"
    | "resource_mismatch"
    | "unsupported_query"
    | "wrong_storefront";
  role: "pagination" | "request" | "resource_href";
  route: AppleMusicRouteClassification;
  scheme: "http" | "https" | "none" | "other";
}

export interface AppleMusicErrorDiagnostic {
  bodyFormat: "apple_errors" | "malformed_json" | "unrecognized_json";
  code: string;
  detailPresent: boolean;
  endpointCategory: AppleMusicEndpointCategory;
  queryKeys: string[];
  sourceParameter?: string;
  sourcePointer: "absent" | "json_pointer" | "present";
  status: number;
  titleCategory:
    | "bad_request"
    | "forbidden"
    | "invalid_request"
    | "not_found"
    | "other"
    | "rate_limited"
    | "server_error"
    | "unauthorized";
  view?: AppleMusicArtistView;
}

export class AppleMusicClientError extends Error {
  constructor(
    message: string,
    readonly classification: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    readonly urlDiagnostic?: AppleMusicUrlDiagnostic,
    readonly appleError?: AppleMusicErrorDiagnostic,
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
    const response = await this.request(
      url,
      "artist_search",
      searchResponseSchema,
      (value) => sanitizeSearchResponse(value, this.storefront),
      signal,
    );
    return (response.results.artists?.data ?? []).map((artist) =>
      normalizeArtist(artist, this.storefront),
    );
  }

  async searchRecentRemixes(
    term: string,
    identityScope: string,
    signal?: AbortSignal,
  ): Promise<AppleMusicRecentSearchPage> {
    if (!term.trim()) {
      return {
        albums: [],
        albumsNextPresent: false,
        songs: [],
        songsNextPresent: false,
      };
    }
    const url = this.catalogUrl("search");
    url.searchParams.set("term", term.trim());
    url.searchParams.set("types", "albums,songs");
    const requestPath = url.pathname + url.search;
    const response = await this.request(
      url,
      "artist_search",
      searchResponseSchema,
      (value) => sanitizeSearchResponse(value, this.storefront, requestPath),
      signal,
      identityScope,
    );
    return {
      albums:
        response.results.albums?.data.map((album) =>
          normalizeAlbum(album, this.storefront, "album", 1, requestPath),
        ) ?? [],
      albumsNextPresent: response.results.albums?.next === "present",
      songs:
        response.results.songs?.data.map((song) =>
          normalizeSong(song, this.storefront, 1, requestPath),
        ) ?? [],
      songsNextPresent: response.results.songs?.next === "present",
    };
  }

  async getArtist(id: string, signal?: AbortSignal): Promise<AppleMusicArtist | undefined> {
    const response = await this.request(
      this.catalogUrl(`artists/${encodeIdentifier(id)}`),
      "artist",
      artistsResponseSchema,
      (value) => sanitizeArtistsResponse(value, this.storefront),
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
    const response = await this.request(
      url,
      "artists_batch",
      artistsResponseSchema,
      (value) => sanitizeArtistsResponse(value, this.storefront),
      signal,
    );
    const items = response.data.map((artist) => normalizeArtist(artist, this.storefront));
    const returned = new Set(items.map((artist) => artist.artistId));
    return { items, missingIds: uniqueIds.filter((id) => !returned.has(id)) };
  }

  async getArtistView(
    artistId: string,
    view: AppleMusicArtistView,
    signal?: AbortSignal,
  ): Promise<AppleMusicAlbum[]> {
    const initialPath = artistViewPath(this.storefront, artistId, view);
    return this.paginateAlbums(initialPath, view, signal);
  }

  async getArtistViewFirstPage(
    artistId: string,
    view: AppleMusicArtistView,
    signal?: AbortSignal,
    identityScope = "view_probe",
  ): Promise<AppleMusicArtistViewPage> {
    const initialPath = artistViewPath(this.storefront, artistId, view);
    const response = await this.request(
      new URL(initialPath, APPLE_MUSIC_ORIGIN),
      "artist_view",
      artistViewFirstPageResponseSchema,
      (value) => sanitizeArtistViewFirstPage(value, this.storefront, view, initialPath),
      signal,
      identityScope,
    );
    return {
      items: response.data.map((resource) =>
        normalizeAlbum(resource, this.storefront, view, 1, initialPath),
      ),
      nextPresent: response.next === true,
    };
  }

  async getArtistAlbumsFirstPage(
    artistId: string,
    identityScope: string,
    signal?: AbortSignal,
  ): Promise<AppleMusicArtistViewPage> {
    const initialPath = `/v1/catalog/${this.storefront}/artists/${encodeIdentifier(artistId)}/albums`;
    const response = await this.request(
      new URL(initialPath, APPLE_MUSIC_ORIGIN),
      "artist_albums",
      artistViewFirstPageResponseSchema,
      (value) => sanitizeAlbumRelationshipFirstPage(value, this.storefront, initialPath),
      signal,
      identityScope,
    );
    return {
      items: response.data.map((resource) =>
        normalizeAlbum(resource, this.storefront, "album", 1, initialPath),
      ),
      nextPresent: response.next === true,
    };
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
    discardDescriptiveUrl(artist.attributes?.url);
    const relationship = artist.views?.[view];
    if (!relationship) return [];
    const ownedViewPath = `/v1/catalog/${this.storefront}/artists/${encodeIdentifier(artist.id)}/view/${view}`;
    const albums: AppleMusicAlbum[] = [];
    for (const resource of relationship.data) {
      const parsed = albumResourceSchema.safeParse(resource);
      if (parsed.success && parsed.data.type === "albums") {
        albums.push(normalizeAlbum(parsed.data, this.storefront, view, 1, ownedViewPath));
      }
    }
    return albums;
  }

  async getAlbum(id: string, signal?: AbortSignal): Promise<AppleMusicAlbum | undefined> {
    const url = this.catalogUrl(`albums/${encodeIdentifier(id)}`);
    url.searchParams.set("include", "artists");
    const requestPath = url.pathname + url.search;
    const response = await this.request(
      url,
      "album",
      albumsResponseSchema,
      (value) => sanitizeAlbumsResponse(value, this.storefront, "album", 1, requestPath),
      signal,
    );
    const album = response.data[0];
    return album ? normalizeAlbum(album, this.storefront, "album", 1, requestPath) : undefined;
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
      (page, path, pageNumber) =>
        sanitizeSongsResponse(page, this.storefront, pageNumber, path, id, {
          operation: "album_tracks",
          originPath: path,
        }),
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
    const requestPath = url.pathname + url.search;
    const response = await this.request(
      url,
      "songs_batch",
      songsResponseSchema,
      (value) => sanitizeSongsResponse(value, this.storefront, 1, requestPath),
      signal,
    );
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
      (page, path, pageNumber) =>
        sanitizeAlbumsResponse(page, this.storefront, view, pageNumber, path, {
          operation: "artist_view",
          originPath: path,
        }),
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
    sanitizePage: (page: T, path: string, pageNumber: number) => T,
    consume: (page: T, path: string, pageNumber: number) => void,
  ): Promise<void> {
    let path = assertAllowedAppleMusicPath(initialPath, this.storefront, {
      fieldPath: "request.target",
      operation: endpointCategory,
      role: "request",
    });
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
        (value) => sanitizePage(value, path, pageNumber),
        signal,
      );
      consume(page, path, pageNumber);
      const next = (page as { next?: string }).next;
      if (!next) return;
      path = assertAllowedAppleMusicPath(next, this.storefront, {
        fieldPath: "response.next",
        operation: endpointCategory,
        originPath: path,
        role: "pagination",
      });
    }
  }

  private async request<T>(
    url: URL,
    endpointCategory: AppleMusicEndpointCategory,
    schema: z.ZodType<T>,
    sanitize: (value: T) => T,
    signal?: AbortSignal,
    identityScope = "catalog",
  ): Promise<T> {
    this.assertEnabled();
    assertAllowedAppleMusicUrl(url, this.storefront, {
      fieldPath: "request.target",
      operation: endpointCategory,
      role: "request",
    });
    const identity = normalizedAppleMusicRequestIdentity(url, identityScope);
    const cached = await this.options.persistence.loadCache(identity);
    if (cached !== null && cached !== undefined) {
      const parsed = sanitize(schema.parse(cached));
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
          const appleError = parseAppleMusicErrorResponse(
            body.text,
            response.status,
            endpointCategory,
            url,
            this.storefront,
          );
          const cooldownUntil =
            response.status === 429 && retryAfterSeconds !== undefined
              ? new Date(this.now().getTime() + retryAfterSeconds * 1_000)
              : undefined;
          await this.options.persistence.complete({
            bodyBytes: body.bytes,
            completedAt: this.now(),
            ...(cooldownUntil ? { cooldownUntil } : {}),
            errorClassification: appleMusicErrorTelemetry(classification, appleError),
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
            undefined,
            appleError,
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
        const parsed = sanitize(schema.parse(decoded));
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
          errorClassification: telemetryClassification(classified),
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
        redirect: "error",
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

interface AppleMusicUrlContext {
  fieldPath: string;
  form?: AppleMusicUrlDiagnostic["form"];
  operation?: AppleMusicEndpointCategory;
  originPath?: string;
  role: AppleMusicUrlDiagnostic["role"];
}

export function assertAllowedAppleMusicUrl(
  url: URL,
  storefront: string,
  context: AppleMusicUrlContext = {
    fieldPath: "request.target",
    role: "request",
  },
): void {
  const route = classifyAppleMusicRoute(url.pathname, storefront);
  let reason: AppleMusicUrlDiagnostic["reason"] | undefined;
  if (url.protocol !== "https:") reason = "invalid_scheme";
  else if (url.hostname !== "api.music.apple.com") reason = "cross_host";
  else if (url.port && url.port !== "443") reason = "nonstandard_port";
  else if (url.username || url.password) reason = "embedded_credentials";
  else if (url.hash) reason = "fragment";
  else if (url.pathname.startsWith("/v1/me")) reason = "personal_scope";
  else if (
    url.pathname.startsWith("/v1/catalog/") &&
    !url.pathname.startsWith(`/v1/catalog/${storefront}/`)
  ) {
    reason = "wrong_storefront";
  } else if (!url.pathname.startsWith("/v1/catalog/")) reason = "non_catalog_path";
  else if (route.classification === "unsupported") reason = "outside_allowlist";
  else if (context.operation && route.classification !== context.operation) {
    reason = "operation_mismatch";
  } else if (hasUnsupportedQuery(url, context.operation ?? route.classification)) {
    reason = "unsupported_query";
  } else if (context.role === "pagination") {
    if (!context.operation || !context.originPath) {
      reason = "missing_owner";
    } else if (!paginationOwnerMatches(url, context.originPath, storefront, context.operation)) {
      reason = "resource_mismatch";
    }
  }
  if (reason) throw unsafeAppleMusicUrl(url, context, route.classification, reason);
}

export function assertAllowedAppleMusicPath(
  path: string,
  storefront: string,
  context: AppleMusicUrlContext = {
    fieldPath: "request.target",
    role: "request",
  },
): string {
  let url: URL;
  let form: AppleMusicUrlDiagnostic["form"];
  if (path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
    form = "relative";
    url = new URL(path, APPLE_MUSIC_ORIGIN);
  } else {
    form = "absolute";
    try {
      url = new URL(path);
    } catch {
      throw new AppleMusicClientError(
        "Apple Music URL metadata is unsafe.",
        "unsafe_url",
        undefined,
        undefined,
        {
          fieldPath: sanitizeDiagnosticFieldPath(context.fieldPath),
          form: "malformed",
          host: "none",
          operation: context.operation ?? "none",
          reason: "invalid_form",
          role: context.role,
          route: "unsupported",
          scheme: "none",
        },
      );
    }
  }
  assertAllowedAppleMusicUrl(url, storefront, { ...context, form });
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}

interface AppleMusicRouteMatch {
  classification: AppleMusicRouteClassification;
  resourceIdentity?: string;
  view?: AppleMusicArtistView;
}

function classifyAppleMusicRoute(pathname: string, storefront: string): AppleMusicRouteMatch {
  const escapedStorefront = storefront.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = `/v1/catalog/${storefront}`;
  if (pathname === `${prefix}/search`) return { classification: "artist_search" };
  if (pathname === `${prefix}/artists`) return { classification: "artists_batch" };
  if (pathname === `${prefix}/songs`) return { classification: "songs_batch" };
  const artist = new RegExp(`^/v1/catalog/${escapedStorefront}/artists/([^/]+)$`).exec(pathname);
  if (artist) return { classification: "artist", resourceIdentity: artist[1]! };
  const artistAlbums = new RegExp(`^/v1/catalog/${escapedStorefront}/artists/([^/]+)/albums$`).exec(
    pathname,
  );
  if (artistAlbums) {
    return { classification: "artist_albums", resourceIdentity: artistAlbums[1]! };
  }
  const artistView = new RegExp(
    `^/v1/catalog/${escapedStorefront}/artists/([^/]+)/view/(${appleMusicArtistViews.join("|")})$`,
  ).exec(pathname);
  if (artistView) {
    return {
      classification: "artist_view",
      resourceIdentity: artistView[1]!,
      view: artistView[2] as AppleMusicArtistView,
    };
  }
  const album = new RegExp(`^/v1/catalog/${escapedStorefront}/albums/([^/]+)$`).exec(pathname);
  if (album) return { classification: "album", resourceIdentity: album[1]! };
  const albumTracks = new RegExp(`^/v1/catalog/${escapedStorefront}/albums/([^/]+)/tracks$`).exec(
    pathname,
  );
  if (albumTracks) {
    return { classification: "album_tracks", resourceIdentity: albumTracks[1]! };
  }
  return { classification: "unsupported" };
}

function hasUnsupportedQuery(url: URL, operation: AppleMusicRouteClassification): boolean {
  const allowed = new Set(
    operation === "artist_search"
      ? ["limit", "term", "types"]
      : operation === "artists_batch"
        ? ["ids"]
        : operation === "artist_view"
          ? ["extend", "include", "l", "limit", "offset", "with"]
          : operation === "artist_albums"
            ? ["extend", "include", "l", "limit", "offset"]
            : operation === "album"
              ? ["include"]
              : operation === "album_tracks"
                ? ["cursor", "limit", "offset"]
                : operation === "songs_batch"
                  ? ["ids", "include"]
                  : [],
  );
  const keys = [...url.searchParams.keys()];
  return (
    keys.some((key) => !allowed.has(key)) ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => url.searchParams.getAll(key).some((value) => value.length === 0))
  );
}

function paginationOwnerMatches(
  candidate: URL,
  originPath: string,
  storefront: string,
  operation: AppleMusicEndpointCategory,
): boolean {
  if (operation !== "artist_view" && operation !== "album_tracks") return false;
  let origin: URL;
  try {
    origin = new URL(originPath, APPLE_MUSIC_ORIGIN);
  } catch {
    return false;
  }
  const expected = classifyAppleMusicRoute(origin.pathname, storefront);
  const actual = classifyAppleMusicRoute(candidate.pathname, storefront);
  if (expected.classification !== operation || actual.classification !== operation) return false;
  if (expected.resourceIdentity !== actual.resourceIdentity) return false;
  return operation !== "artist_view" || expected.view === actual.view;
}

export function normalizedAppleMusicRequestIdentity(url: URL, scope = "catalog"): string {
  const normalized = new URL(url);
  normalized.searchParams.sort();
  const storefront = normalized.pathname.split("/")[3] ?? "";
  const route = /^[a-z]{2}$/.test(storefront)
    ? classifyAppleMusicRoute(normalized.pathname, storefront).classification
    : "unsupported";
  const page = normalized.searchParams.has("offset") ? "pagination" : "initial";
  const digest = createHash("sha256")
    .update(`${scope}:${normalized.pathname}${normalized.search}`)
    .digest("hex");
  return `v2:${route}:${page}:${digest}`;
}

export function parseAppleRetryAfter(value: string | null, now = new Date()): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.ceil((parsed - now.getTime()) / 1_000));
}

function unsafeAppleMusicUrl(
  url: URL,
  context: AppleMusicUrlContext,
  route: AppleMusicRouteClassification,
  reason: AppleMusicUrlDiagnostic["reason"],
): AppleMusicClientError {
  const scheme: AppleMusicUrlDiagnostic["scheme"] =
    url.protocol === "https:"
      ? "https"
      : url.protocol === "http:"
        ? "http"
        : url.protocol
          ? "other"
          : "none";
  const host: AppleMusicUrlDiagnostic["host"] =
    url.hostname === "api.music.apple.com"
      ? "allowed_api"
      : url.hostname === "music.apple.com"
        ? "apple_sharing"
        : url.hostname
          ? "cross_host"
          : "none";
  return new AppleMusicClientError(
    "Apple Music URL metadata is unsafe.",
    "unsafe_url",
    undefined,
    undefined,
    {
      fieldPath: sanitizeDiagnosticFieldPath(context.fieldPath),
      form: context.form ?? "absolute",
      host,
      operation: context.operation ?? "none",
      reason,
      role: context.role,
      route,
      scheme,
    },
  );
}

function sanitizeDiagnosticFieldPath(value: string): string {
  return /^[A-Za-z.[\]]+$/.test(value) ? value : "unknown";
}

function sanitizeSearchResponse(
  response: z.infer<typeof searchResponseSchema>,
  storefront: string,
  paginationPath = `/v1/catalog/${storefront}/search`,
): z.infer<typeof searchResponseSchema> {
  const albums = response.results.albums;
  const artists = response.results.artists;
  const songs = response.results.songs;
  return {
    results: {
      ...(albums
        ? {
            albums: {
              data: albums.data.map((resource) =>
                sanitizeAlbumResource(resource, storefront, "album", 1, paginationPath),
              ),
              ...(albums.next ? { next: "present" } : {}),
            },
          }
        : {}),
      ...(artists
        ? {
            artists: {
              data: artists.data.map((resource) => sanitizeArtistResource(resource, storefront)),
            },
          }
        : {}),
      ...(songs
        ? {
            songs: {
              data: songs.data.map((resource) =>
                sanitizeSongResource(resource, storefront, 1, paginationPath),
              ),
              ...(songs.next ? { next: "present" } : {}),
            },
          }
        : {}),
    },
  };
}

function sanitizeArtistsResponse(
  response: z.infer<typeof artistsResponseSchema>,
  storefront: string,
): z.infer<typeof artistsResponseSchema> {
  return {
    data: response.data.map((resource) => sanitizeArtistResource(resource, storefront)),
  };
}

interface AppleMusicPaginationContext {
  operation: "album_tracks" | "artist_view";
  originPath: string;
}

function sanitizeAlbumsResponse(
  response: z.infer<typeof albumsResponseSchema>,
  storefront: string,
  sourceView: AppleMusicAlbum["sourceView"],
  pageNumber: number,
  paginationPath: string,
  pagination?: AppleMusicPaginationContext,
): z.infer<typeof albumsResponseSchema> {
  const next = pagination
    ? sanitizeResponseNext(response.next, storefront, "response.next", pagination)
    : undefined;
  return {
    data: response.data.map((resource) =>
      sanitizeAlbumResource(resource, storefront, sourceView, pageNumber, paginationPath),
    ),
    ...(next ? { next } : {}),
  };
}

function sanitizeArtistViewFirstPage(
  response: z.infer<typeof artistViewFirstPageResponseSchema>,
  storefront: string,
  view: AppleMusicArtistView,
  paginationPath: string,
): z.infer<typeof artistViewFirstPageResponseSchema> {
  return {
    data: response.data.map((resource) =>
      sanitizeAlbumResource(resource, storefront, view, 1, paginationPath),
    ),
    ...(response.next === undefined ? {} : { next: true }),
  };
}

function sanitizeAlbumRelationshipFirstPage(
  response: z.infer<typeof artistViewFirstPageResponseSchema>,
  storefront: string,
  paginationPath: string,
): z.infer<typeof artistViewFirstPageResponseSchema> {
  return {
    data: response.data.map((resource) =>
      sanitizeAlbumResource(resource, storefront, "album", 1, paginationPath),
    ),
    ...(response.next === undefined ? {} : { next: true }),
  };
}

function sanitizeSongsResponse(
  response: z.infer<typeof songsResponseSchema>,
  storefront: string,
  pageNumber: number,
  paginationPath: string,
  fallbackAlbumId?: string,
  pagination?: AppleMusicPaginationContext,
): z.infer<typeof songsResponseSchema> {
  const next = pagination
    ? sanitizeResponseNext(response.next, storefront, "response.next", pagination)
    : undefined;
  return {
    data: response.data.map((resource) =>
      sanitizeSongResource(resource, storefront, pageNumber, paginationPath, fallbackAlbumId),
    ),
    ...(next ? { next } : {}),
  };
}

function sanitizeArtistResource(
  resource: z.infer<typeof artistResourceSchema>,
  storefront: string,
): z.infer<typeof artistResourceSchema> {
  const artist = normalizeArtist(resource, storefront);
  return {
    attributes: {
      genreNames: artist.genreNames,
      name: artist.name,
    },
    id: artist.artistId,
    type: "artists",
  };
}

function sanitizeAlbumResource(
  resource: z.infer<typeof albumResourceSchema>,
  storefront: string,
  sourceView: AppleMusicAlbum["sourceView"],
  pageNumber: number,
  paginationPath: string,
): z.infer<typeof albumResourceSchema> {
  const album = normalizeAlbum(resource, storefront, sourceView, pageNumber, paginationPath);
  return {
    attributes: {
      artistName: album.artistName,
      ...(album.contentRating ? { contentRating: album.contentRating } : {}),
      genreNames: album.genreNames,
      ...(album.isCompilation === undefined ? {} : { isCompilation: album.isCompilation }),
      ...(album.isSingle === undefined ? {} : { isSingle: album.isSingle }),
      name: album.title,
      ...(album.releaseDate ? { releaseDate: album.releaseDate } : {}),
      ...(album.trackCount === undefined ? {} : { trackCount: album.trackCount }),
      ...(album.upc ? { upc: album.upc } : {}),
    },
    id: album.albumId,
    relationships: {
      artists: {
        data: album.artistIds.map((id) => ({ id, type: "artists" })),
      },
    },
    type: "albums",
  };
}

function sanitizeSongResource(
  resource: z.infer<typeof songResourceSchema>,
  storefront: string,
  pageNumber: number,
  paginationPath: string,
  fallbackAlbumId?: string,
): z.infer<typeof songResourceSchema> {
  const song = normalizeSong(resource, storefront, pageNumber, paginationPath, fallbackAlbumId);
  return {
    attributes: {
      ...(song.albumName ? { albumName: song.albumName } : {}),
      artistName: song.artistName,
      ...(song.contentRating ? { contentRating: song.contentRating } : {}),
      ...(song.discNumber === undefined ? {} : { discNumber: song.discNumber }),
      ...(song.durationMs === undefined ? {} : { durationInMillis: song.durationMs }),
      genreNames: [],
      ...(song.isrc ? { isrc: song.isrc } : {}),
      name: song.title,
      ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
      ...(song.trackNumber === undefined ? {} : { trackNumber: song.trackNumber }),
    },
    id: song.songId,
    relationships: {
      ...(song.albumId ? { albums: { data: [{ id: song.albumId, type: "albums" }] } } : {}),
      artists: {
        data: song.artistIds.map((id) => ({ id, type: "artists" })),
      },
    },
    type: "songs",
  };
}

function sanitizeResponseNext(
  value: string | undefined,
  storefront: string,
  fieldPath: string,
  pagination: AppleMusicPaginationContext,
): string | undefined {
  return value
    ? assertAllowedAppleMusicPath(value, storefront, {
        fieldPath,
        operation: pagination.operation,
        originPath: pagination.originPath,
        role: "pagination",
      })
    : undefined;
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
  discardDescriptiveUrl(resource.attributes.url);
  return {
    artistId: resource.id,
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
  discardDescriptiveUrl(resource.attributes.url);
  return {
    albumId: resource.id,
    artistIds: resource.relationships?.artists?.data.map((artist) => artist.id) ?? [],
    artistName: resource.attributes.artistName,
    ...(resource.attributes.contentRating
      ? { contentRating: resource.attributes.contentRating }
      : {}),
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
  const albumId = resource.relationships?.albums?.data[0]?.id ?? fallbackAlbumId;
  discardDescriptiveUrl(resource.attributes.url);
  return {
    ...(albumId ? { albumId } : {}),
    ...(resource.attributes.albumName ? { albumName: resource.attributes.albumName } : {}),
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
  if (status === 400) return "bad_request";
  return "http_error";
}

const appleErrorResponseSchema = z.object({
  errors: z
    .array(
      z.object({
        code: z.string().optional(),
        detail: z.string().optional(),
        id: z.string().optional(),
        source: z
          .object({
            parameter: z.string().optional(),
            pointer: z.string().optional(),
          })
          .optional(),
        status: z.string().optional(),
        title: z.string().optional(),
      }),
    )
    .min(1),
});

function parseAppleMusicErrorResponse(
  body: string,
  status: number,
  endpointCategory: AppleMusicEndpointCategory,
  url: URL,
  storefront: string,
): AppleMusicErrorDiagnostic {
  const route = classifyAppleMusicRoute(url.pathname, storefront);
  const base = {
    endpointCategory,
    queryKeys: sanitizeAppleQueryKeys(url),
    sourcePointer: "absent" as const,
    status,
    ...(route.classification === "artist_view" && route.view ? { view: route.view } : {}),
  };
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return {
      ...base,
      bodyFormat: "malformed_json",
      code: "unavailable",
      detailPresent: false,
      titleCategory: titleCategory(undefined, status),
    };
  }
  const parsed = appleErrorResponseSchema.safeParse(decoded);
  if (!parsed.success) {
    return {
      ...base,
      bodyFormat: "unrecognized_json",
      code: "unavailable",
      detailPresent: false,
      titleCategory: titleCategory(undefined, status),
    };
  }
  const error = parsed.data.errors[0]!;
  const sourceParameter = sanitizeSourceParameter(error.source?.parameter);
  return {
    ...base,
    bodyFormat: "apple_errors",
    code: sanitizeAppleErrorCode(error.code),
    detailPresent: typeof error.detail === "string" && error.detail.length > 0,
    ...(sourceParameter ? { sourceParameter } : {}),
    sourcePointer: classifySourcePointer(error.source?.pointer),
    titleCategory: titleCategory(error.title, status),
  };
}

function sanitizeAppleErrorCode(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9._-]{1,32}$/.test(value)) return "unavailable";
  return value;
}

function sanitizeSourceParameter(value: string | undefined): string | undefined {
  const allowed = new Set([
    "extend",
    "ids",
    "include",
    "l",
    "limit",
    "offset",
    "term",
    "types",
    "with",
  ]);
  return value && allowed.has(value) ? value : undefined;
}

function classifySourcePointer(
  value: string | undefined,
): AppleMusicErrorDiagnostic["sourcePointer"] {
  if (!value) return "absent";
  return value.startsWith("/") ? "json_pointer" : "present";
}

function titleCategory(
  value: string | undefined,
  status: number,
): AppleMusicErrorDiagnostic["titleCategory"] {
  const normalized = value?.toLowerCase() ?? "";
  if (normalized.includes("invalid")) return "invalid_request";
  if (normalized.includes("bad request")) return "bad_request";
  if (normalized.includes("unauthorized") || status === 401) return "unauthorized";
  if (normalized.includes("forbidden") || status === 403) return "forbidden";
  if (normalized.includes("not found") || status === 404) return "not_found";
  if (normalized.includes("rate") || status === 429) return "rate_limited";
  if (normalized.includes("server") || status >= 500) return "server_error";
  return "other";
}

function sanitizeAppleQueryKeys(url: URL): string[] {
  const allowed = new Set([
    "extend",
    "ids",
    "include",
    "l",
    "limit",
    "offset",
    "term",
    "types",
    "with",
  ]);
  return [...new Set([...url.searchParams.keys()].map((key) => (allowed.has(key) ? key : "other")))]
    .sort()
    .slice(0, 8);
}

function appleMusicErrorTelemetry(
  classification: string,
  diagnostic: AppleMusicErrorDiagnostic,
): string {
  const fields = [
    classification,
    `s=${diagnostic.status}`,
    `c=${diagnostic.code}`,
    `t=${diagnostic.titleCategory}`,
    `p=${diagnostic.sourceParameter ?? "none"}`,
    `x=${diagnostic.sourcePointer}`,
    `d=${diagnostic.detailPresent ? "1" : "0"}`,
    `v=${diagnostic.view ?? "none"}`,
    `q=${diagnostic.queryKeys.join(",") || "none"}`,
  ];
  return fields.join("|").slice(0, 100);
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

function telemetryClassification(error: AppleMusicClientError): string {
  const diagnostic = error.urlDiagnostic;
  if (!diagnostic) return error.classification;
  return [
    error.classification,
    diagnostic.fieldPath,
    diagnostic.operation,
    diagnostic.route,
    diagnostic.reason,
  ]
    .join(":")
    .slice(0, 100);
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

function artistViewPath(storefront: string, artistId: string, view: AppleMusicArtistView): string {
  return `/v1/catalog/${storefront}/artists/${encodeIdentifier(artistId)}/view/${view}`;
}

export function appleMusicArtistViewRequestShape(view: AppleMusicArtistView): {
  headerNames: ["accept", "authorization"];
  host: "allowed_api";
  method: "GET";
  pathTemplate: string;
  queryKeys: [];
  storefront: "us";
  view: AppleMusicArtistView;
} {
  return {
    headerNames: ["accept", "authorization"],
    host: "allowed_api",
    method: "GET",
    pathTemplate: `/v1/catalog/us/artists/<artist_id>/view/${view}`,
    queryKeys: [],
    storefront: "us",
    view,
  };
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

function discardDescriptiveUrl(value: string | undefined): void {
  if (!value) return;
  try {
    void new URL(value);
  } catch {
    return;
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
