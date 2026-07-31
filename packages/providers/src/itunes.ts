import { z } from "zod";

const identifier = z.union([z.string(), z.number()]).transform(String);
const optionalIdentifier = identifier.optional();
const optionalHttpsUrl = z
  .url()
  .optional()
  .transform((value) => safeAppleViewUrl(value));
const isoDate = z.iso.datetime({ offset: true });

const artistSchema = z.object({
  artistId: identifier,
  artistLinkUrl: optionalHttpsUrl,
  artistName: z.string().min(1).max(500),
  artistViewUrl: optionalHttpsUrl,
  primaryGenreName: z.string().max(200).optional(),
  wrapperType: z.literal("artist"),
});

const collectionSchema = z.object({
  artistId: optionalIdentifier,
  artistName: z.string().max(500).optional(),
  collectionArtistId: optionalIdentifier,
  collectionArtistName: z.string().max(500).optional(),
  collectionExplicitness: z.string().max(100).optional(),
  collectionId: identifier,
  collectionName: z.string().min(1).max(1000),
  collectionType: z.string().max(100).optional(),
  collectionViewUrl: optionalHttpsUrl,
  primaryGenreName: z.string().max(200).optional(),
  releaseDate: isoDate,
  trackCount: z.number().int().nonnegative().optional(),
  wrapperType: z.literal("collection"),
});

const trackSchema = z.object({
  artistId: optionalIdentifier,
  artistName: z.string().min(1).max(500),
  collectionArtistId: optionalIdentifier,
  collectionArtistName: z.string().max(500).optional(),
  collectionId: optionalIdentifier,
  collectionName: z.string().max(1000).optional(),
  discCount: z.number().int().positive().optional(),
  discNumber: z.number().int().positive().optional(),
  kind: z.literal("song"),
  releaseDate: isoDate,
  trackCount: z.number().int().positive().optional(),
  trackExplicitness: z.string().max(100).optional(),
  trackId: identifier,
  trackName: z.string().min(1).max(1000),
  trackNumber: z.number().int().positive().optional(),
  trackTimeMillis: z.number().int().nonnegative().optional(),
  trackViewUrl: optionalHttpsUrl,
  wrapperType: z.literal("track"),
});

const responseSchema = z.object({
  resultCount: z.number().int().nonnegative(),
  results: z.array(z.unknown()).max(2000),
});

export type ItunesArtist = z.infer<typeof artistSchema>;
export type ItunesCollection = z.infer<typeof collectionSchema>;
export type ItunesTrack = z.infer<typeof trackSchema>;

export interface ItunesNormalizedResponse {
  artists: ItunesArtist[];
  collections: ItunesCollection[];
  declaredResultCount: number;
  tracks: ItunesTrack[];
  unknownResultCount: number;
}

export type ItunesEndpointCategory =
  | "artist_search"
  | "targeted_collection_search"
  | "artist_albums"
  | "artist_songs"
  | "batch_albums"
  | "batch_songs"
  | "collection_songs";

export interface ItunesRequestPermit {
  eventId: string;
  leaseToken: string;
  startedAt: Date;
}

export interface ItunesRequestPersistence {
  acquire(input: {
    endpointCategory: ItunesEndpointCategory;
    identity: string;
    maxRequests: number;
    minIntervalMs: number;
    runId: string;
  }): Promise<ItunesRequestPermit>;
  complete(input: {
    bodyBytes: number;
    cacheValue?: ItunesNormalizedResponse;
    completedAt: Date;
    errorClassification?: string;
    eventId: string;
    leaseToken: string;
    retryAfterSeconds?: number;
    status?: number;
  }): Promise<void>;
  loadCache(identity: string): Promise<unknown>;
  recordCacheHit(input: {
    endpointCategory: ItunesEndpointCategory;
    identity: string;
    runId: string;
  }): Promise<void>;
}

export interface ItunesClientOptions {
  enabled: boolean;
  fetchImpl?: typeof fetch;
  language?: "en_us" | "ja_jp";
  maxRequestsPerRun?: number;
  maxResponseBytes?: number;
  minRequestIntervalMs?: number;
  persistence: ItunesRequestPersistence;
  requestTimeoutMs?: number;
  storefront?: string;
}

export class ItunesClientError extends Error {
  constructor(
    message: string,
    readonly classification: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ItunesClientError";
  }
}

export class ItunesClient {
  private readonly fetchImpl: typeof fetch;
  private readonly language: "en_us" | "ja_jp";
  private readonly maxRequestsPerRun: number;
  private readonly maxResponseBytes: number;
  private readonly minRequestIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly storefront: string;

  constructor(private readonly options: ItunesClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.language = options.language ?? "en_us";
    this.maxRequestsPerRun = options.maxRequestsPerRun ?? 200;
    this.maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 3200;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.storefront = options.storefront ?? "US";
    if (!/^[A-Z]{2}$/.test(this.storefront)) {
      throw new ItunesClientError("Invalid iTunes storefront.", "invalid_configuration");
    }
    if (!Number.isInteger(this.minRequestIntervalMs) || this.minRequestIntervalMs < 3200) {
      throw new ItunesClientError(
        "iTunes request spacing must be at least 3200 milliseconds.",
        "invalid_configuration",
      );
    }
  }

  searchArtists(runId: string, term: string): Promise<ItunesNormalizedResponse> {
    if (!term.trim())
      throw new ItunesClientError("Artist search term is empty.", "invalid_request");
    return this.request(runId, "artist_search", "/search", {
      country: this.storefront,
      entity: "musicArtist",
      explicit: "Yes",
      lang: this.language,
      limit: "10",
      media: "music",
      term: term.trim(),
    });
  }

  searchCollectionsExact(
    runId: string,
    input: {
      cacheIdentity: string;
      parameters: Record<string, string>;
    },
  ): Promise<ItunesNormalizedResponse> {
    const expected = new Set(["country", "entity", "explicit", "lang", "limit", "media", "term"]);
    if (
      !input.cacheIdentity.startsWith("itunes-cache:v2:") ||
      Object.keys(input.parameters).some((key) => !expected.has(key)) ||
      Object.keys(input.parameters).length !== expected.size ||
      input.parameters.country !== this.storefront ||
      input.parameters.entity !== "album" ||
      input.parameters.explicit !== "Yes" ||
      input.parameters.lang !== this.language ||
      input.parameters.limit !== "25" ||
      input.parameters.media !== "music" ||
      !input.parameters.term?.trim()
    ) {
      throw new ItunesClientError(
        "Targeted collection search differs from the frozen request shape.",
        "invalid_request",
      );
    }
    return this.request(runId, "targeted_collection_search", "/search", input.parameters, {
      identityOverride: input.cacheIdentity,
      maximumAttempts: 1,
    });
  }

  lookupAlbums(runId: string, artistIds: string[]): Promise<ItunesNormalizedResponse> {
    return this.lookupArtists(runId, artistIds, "album");
  }

  lookupSongs(runId: string, artistIds: string[]): Promise<ItunesNormalizedResponse> {
    return this.lookupArtists(runId, artistIds, "song");
  }

  lookupCollectionSongs(runId: string, collectionId: string): Promise<ItunesNormalizedResponse> {
    return this.request(runId, "collection_songs", "/lookup", {
      country: this.storefront,
      entity: "song",
      explicit: "Yes",
      id: requiredNumericIdentifiers([collectionId])[0]!,
      limit: "200",
    });
  }

  private lookupArtists(
    runId: string,
    artistIds: string[],
    entity: "album" | "song",
  ): Promise<ItunesNormalizedResponse> {
    const ids = requiredNumericIdentifiers(artistIds);
    const batch = ids.length > 1;
    return this.request(
      runId,
      entity === "album"
        ? batch
          ? "batch_albums"
          : "artist_albums"
        : batch
          ? "batch_songs"
          : "artist_songs",
      "/lookup",
      {
        country: this.storefront,
        entity,
        explicit: "Yes",
        id: ids.join(","),
        limit: "200",
        ...(entity === "song" ? { sort: "recent" } : {}),
      },
    );
  }

  private async request(
    runId: string,
    endpointCategory: ItunesEndpointCategory,
    path: "/search" | "/lookup",
    parameters: Record<string, string>,
    behavior: { identityOverride?: string; maximumAttempts?: number } = {},
  ): Promise<ItunesNormalizedResponse> {
    if (!this.options.enabled) {
      throw new ItunesClientError(
        "iTunes discovery requires explicit pilot enablement.",
        "provider_disabled",
      );
    }
    const url = buildItunesUrl(path, parameters);
    const identity = behavior.identityOverride ?? normalizedRequestIdentity(url);
    if (
      behavior.identityOverride !== undefined &&
      !behavior.identityOverride.startsWith("itunes-cache:v2:")
    ) {
      throw new ItunesClientError("Invalid v2 cache identity override.", "invalid_request");
    }
    const cached = await this.options.persistence.loadCache(identity);
    if (cached !== null) {
      const parsed = normalizedResponseSchema.parse(cached);
      await this.options.persistence.recordCacheHit({ endpointCategory, identity, runId });
      return parsed;
    }

    const maximumAttempts = behavior.maximumAttempts ?? 3;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const permit = await this.options.persistence.acquire({
        endpointCategory,
        identity,
        maxRequests: this.maxRequestsPerRun,
        minIntervalMs: this.minRequestIntervalMs,
        runId,
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let completionRecorded = false;
      try {
        const response = await this.fetchImpl(url, {
          headers: { Accept: "application/json" },
          method: "GET",
          redirect: "error",
          signal: controller.signal,
        });
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
        const body = await readBoundedBody(response, this.maxResponseBytes);
        if (!response.ok) {
          const classification = classifyHttpStatus(response.status);
          await this.options.persistence.complete({
            bodyBytes: body.byteLength,
            completedAt: new Date(),
            errorClassification: classification,
            eventId: permit.eventId,
            leaseToken: permit.leaseToken,
            ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
            status: response.status,
          });
          completionRecorded = true;
          if (response.status >= 500 && attempt < maximumAttempts) continue;
          throw new ItunesClientError(
            `iTunes request failed with HTTP ${response.status}.`,
            classification,
            response.status,
            retryAfterSeconds,
          );
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder().decode(body));
        } catch {
          await this.options.persistence.complete({
            bodyBytes: body.byteLength,
            completedAt: new Date(),
            errorClassification: "malformed_json",
            eventId: permit.eventId,
            leaseToken: permit.leaseToken,
            status: response.status,
          });
          completionRecorded = true;
          throw new ItunesClientError("iTunes returned malformed JSON.", "malformed_json");
        }
        const normalized = parseItunesResponse(decoded);
        await this.options.persistence.complete({
          bodyBytes: body.byteLength,
          cacheValue: normalized,
          completedAt: new Date(),
          eventId: permit.eventId,
          leaseToken: permit.leaseToken,
          status: response.status,
        });
        completionRecorded = true;
        return normalized;
      } catch (error) {
        if (error instanceof ItunesClientError) {
          if (!completionRecorded) {
            await this.options.persistence.complete({
              bodyBytes: 0,
              completedAt: new Date(),
              errorClassification: error.classification,
              eventId: permit.eventId,
              leaseToken: permit.leaseToken,
              ...(error.retryAfterSeconds === undefined
                ? {}
                : { retryAfterSeconds: error.retryAfterSeconds }),
              ...(error.status === undefined ? {} : { status: error.status }),
            });
          }
          throw error;
        }
        const classification =
          error instanceof DOMException && error.name === "AbortError"
            ? "timeout"
            : "network_error";
        await this.options.persistence.complete({
          bodyBytes: 0,
          completedAt: new Date(),
          errorClassification: classification,
          eventId: permit.eventId,
          leaseToken: permit.leaseToken,
        });
        if (attempt < maximumAttempts) continue;
        throw new ItunesClientError("iTunes request could not be completed.", classification);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new ItunesClientError("iTunes retry bound was exhausted.", "retry_exhausted");
  }
}

export function parseItunesResponse(value: unknown): ItunesNormalizedResponse {
  const envelope = responseSchema.parse(value);
  const artists: ItunesArtist[] = [];
  const collections: ItunesCollection[] = [];
  const tracks: ItunesTrack[] = [];
  let unknownResultCount = 0;
  for (const result of envelope.results) {
    const artist = artistSchema.safeParse(result);
    if (artist.success) {
      artists.push(artist.data);
      continue;
    }
    const collection = collectionSchema.safeParse(result);
    if (collection.success) {
      collections.push(collection.data);
      continue;
    }
    const track = trackSchema.safeParse(result);
    if (track.success) {
      tracks.push(track.data);
      continue;
    }
    unknownResultCount += 1;
  }
  return {
    artists,
    collections,
    declaredResultCount: envelope.resultCount,
    tracks,
    unknownResultCount,
  };
}

const normalizedResponseSchema = z.object({
  artists: z.array(artistSchema),
  collections: z.array(collectionSchema),
  declaredResultCount: z.number().int().nonnegative(),
  tracks: z.array(trackSchema),
  unknownResultCount: z.number().int().nonnegative(),
});

export function buildItunesUrl(
  path: "/search" | "/lookup",
  parameters: Record<string, string>,
): URL {
  const url = new URL(path, "https://itunes.apple.com");
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  url.searchParams.sort();
  assertAllowedItunesRequestUrl(url);
  return url;
}

export function assertAllowedItunesRequestUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.hostname !== "itunes.apple.com" ||
    !["/search", "/lookup"].includes(url.pathname) ||
    url.username ||
    url.password
  ) {
    throw new ItunesClientError("iTunes request URL is not allowed.", "url_not_allowed");
  }
}

export function normalizedRequestIdentity(url: URL): string {
  assertAllowedItunesRequestUrl(url);
  const normalized = new URL(url);
  normalized.searchParams.sort();
  return `${normalized.pathname}?${normalized.searchParams.toString()}`;
}

function requiredNumericIdentifiers(values: string[]): string[] {
  const unique = [...new Set(values.map((value) => value.trim()))];
  if (unique.length === 0 || unique.some((value) => !/^\d{1,30}$/.test(value))) {
    throw new ItunesClientError("iTunes IDs must be numeric.", "invalid_request");
  }
  return unique;
}

function safeAppleViewUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "itunes.apple.com" ||
        url.hostname === "music.apple.com" ||
        url.hostname.endsWith(".itunes.apple.com"))
    ) {
      return url.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

function classifyHttpStatus(status: number): string {
  if (status === 429) return "rate_limited";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "server_error";
  return "http_error";
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maximumBytes) {
    throw new ItunesClientError("iTunes response exceeded the body limit.", "response_too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ItunesClientError("iTunes response exceeded the body limit.", "response_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
