import { normalizeAppleMusicArtworkUrl, type AppleIdentityCandidateCatalog } from "@radar/core";
import { z } from "zod";
import type { AppleMusicRequestPersistence } from "./apple-music";

const artistResultSchema = z
  .object({
    artistId: z.number().int().nonnegative(),
    artistLinkUrl: z.string().url().optional(),
    artistName: z.string().min(1),
    artistType: z.string().optional(),
    primaryGenreName: z.string().optional(),
    wrapperType: z.literal("artist"),
  })
  .passthrough();

const songResultSchema = z
  .object({
    artistId: z.number().int().nonnegative(),
    artistName: z.string().min(1),
    artistViewUrl: z.string().url().optional(),
    artworkUrl100: z.string().url().optional(),
    collectionArtistId: z.number().int().nonnegative().optional(),
    collectionArtistName: z.string().optional(),
    collectionId: z.number().int().nonnegative().optional(),
    collectionName: z.string().optional(),
    collectionViewUrl: z.string().url().optional(),
    copyright: z.string().optional(),
    primaryGenreName: z.string().optional(),
    releaseDate: z.string().optional(),
    trackCount: z.number().int().nonnegative().optional(),
    trackId: z.number().int().nonnegative(),
    trackName: z.string().min(1),
    trackViewUrl: z.string().url().optional(),
    wrapperType: z.literal("track"),
  })
  .passthrough();

const lookupResponseSchema = z.object({
  resultCount: z.number().int().nonnegative(),
  results: z.array(z.union([artistResultSchema, songResultSchema, z.object({}).passthrough()])),
});

export interface ITunesIdentityClientOptions {
  fetchImpl?: typeof fetch;
  maxRequestsPerRun: number;
  minRequestIntervalMs: number;
  persistence: AppleMusicRequestPersistence;
  requestTimeoutMs?: number;
  runId: string;
}

export interface AppleIdentityCatalogClient {
  readonly metrics: { cacheHits: number; failures: number; requests: number };
  getArtistCatalog(appleArtistId: string): Promise<AppleIdentityCandidateCatalog>;
}

export class ITunesIdentityClient implements AppleIdentityCatalogClient {
  readonly metrics = { cacheHits: 0, failures: 0, requests: 0 };
  private issuedRequests = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: ITunesIdentityClientOptions) {
    if (!Number.isInteger(options.maxRequestsPerRun) || options.maxRequestsPerRun < 1) {
      throw new Error("iTunes identity request budget must be positive.");
    }
    if (!Number.isInteger(options.minRequestIntervalMs) || options.minRequestIntervalMs < 3_000) {
      throw new Error("iTunes identity requests must be at least three seconds apart.");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  }

  async getArtistCatalog(appleArtistId: string): Promise<AppleIdentityCandidateCatalog> {
    if (!/^\d{1,32}$/.test(appleArtistId)) throw new Error("Apple artist ID is invalid.");
    const identity = `itunes_identity:us:artist:${appleArtistId}:songs:50:recent`;
    const cached = await this.options.persistence.loadCache(identity);
    if (cached) {
      const parsed = candidateCatalogSchema.parse(cached) as AppleIdentityCandidateCatalog;
      await this.options.persistence.recordCacheHit({
        endpointCategory: "artist",
        identity,
        runId: this.options.runId,
      });
      this.metrics.cacheHits += 1;
      return parsed;
    }
    if (this.issuedRequests >= this.options.maxRequestsPerRun) {
      throw new Error("iTunes identity request budget reached.");
    }
    this.issuedRequests += 1;
    const permit = await this.options.persistence.acquire({
      endpointCategory: "artist",
      identity,
      maxRequests: this.options.maxRequestsPerRun,
      minIntervalMs: this.options.minRequestIntervalMs,
      runId: this.options.runId,
    });
    const url = new URL("https://itunes.apple.com/lookup");
    url.searchParams.set("country", "US");
    url.searchParams.set("entity", "song");
    url.searchParams.set("id", appleArtistId);
    url.searchParams.set("limit", "50");
    url.searchParams.set("sort", "recent");
    try {
      this.metrics.requests += 1;
      const response = await this.fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const body = await response.text();
      const bodyBytes = Buffer.byteLength(body);
      if (bodyBytes > 2_000_000) throw new Error("iTunes identity response exceeded two MB.");
      if (!response.ok) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
        const completedAt = new Date();
        await this.options.persistence.complete({
          bodyBytes,
          completedAt,
          ...(response.status === 429 && retryAfterSeconds !== undefined
            ? {
                cooldownUntil: new Date(completedAt.getTime() + retryAfterSeconds * 1_000),
                retryAfterSeconds,
              }
            : {}),
          errorClassification: `itunes_http_${response.status}`,
          eventId: permit.eventId,
          leaseToken: permit.leaseToken,
          status: response.status,
        });
        this.metrics.failures += 1;
        throw new Error(`iTunes identity lookup failed with HTTP ${response.status}.`);
      }
      const parsed = lookupResponseSchema.parse(JSON.parse(body));
      const catalog = normalizeLookup(appleArtistId, parsed);
      await this.options.persistence.complete({
        bodyBytes,
        cacheValue: catalog,
        completedAt: new Date(),
        eventId: permit.eventId,
        leaseToken: permit.leaseToken,
        status: response.status,
      });
      return catalog;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("iTunes identity lookup failed"))) {
        await this.options.persistence.complete({
          bodyBytes: 0,
          completedAt: new Date(),
          errorClassification:
            error instanceof z.ZodError ? "itunes_invalid_response" : "itunes_network_error",
          eventId: permit.eventId,
          leaseToken: permit.leaseToken,
        });
        this.metrics.failures += 1;
      }
      throw error;
    }
  }
}

const candidateCatalogSchema = z.object({
  appleArtistId: z.string(),
  artistName: z.string(),
  artistUrl: z.string().url().optional(),
  artworkUrl: z.string().url().optional(),
  genres: z.array(z.string()),
  labels: z.array(z.string()),
  releases: z.array(
    z.object({
      appleReleaseId: z.string(),
      artistIds: z.array(z.string()),
      artistName: z.string(),
      artworkUrl: z.string().url().optional(),
      copyright: z.string().optional(),
      label: z.string().optional(),
      releaseDate: z.string().optional(),
      title: z.string(),
      trackCount: z.number().int().nonnegative().optional(),
    }),
  ),
  resourceStatus: z.enum(["invalid", "unknown", "valid"]),
  songs: z.array(
    z.object({
      albumTitle: z.string().optional(),
      appleSongId: z.string(),
      artistIds: z.array(z.string()),
      artistName: z.string(),
      artworkUrl: z.string().url().optional(),
      releaseDate: z.string().optional(),
      title: z.string(),
    }),
  ),
  source: z.enum(["apple_music_api", "itunes_lookup"]),
});

function normalizeLookup(
  appleArtistId: string,
  response: z.infer<typeof lookupResponseSchema>,
): AppleIdentityCandidateCatalog {
  const artistResults = response.results
    .map((result) => artistResultSchema.safeParse(result))
    .filter((result): result is { success: true; data: z.infer<typeof artistResultSchema> } =>
      Boolean(result.success && String(result.data.artistId) === appleArtistId),
    )
    .map((result) => result.data);
  const songResults = response.results
    .map((result) => songResultSchema.safeParse(result))
    .filter((result): result is { success: true; data: z.infer<typeof songResultSchema> } =>
      Boolean(
        result.success &&
        (String(result.data.artistId) === appleArtistId ||
          String(result.data.collectionArtistId ?? "") === appleArtistId),
      ),
    )
    .map((result) => result.data);
  const artist = artistResults[0];
  const releases = new Map<string, AppleIdentityCandidateCatalog["releases"][number]>();
  for (const song of songResults) {
    if (song.collectionId === undefined || !song.collectionName) continue;
    const id = String(song.collectionId);
    if (releases.has(id)) continue;
    releases.set(id, {
      appleReleaseId: id,
      artistIds: uniqueStrings([
        String(song.artistId),
        ...(song.collectionArtistId === undefined ? [] : [String(song.collectionArtistId)]),
      ]),
      artistName: song.collectionArtistName ?? song.artistName,
      ...(song.artworkUrl100 && normalizeAppleMusicArtworkUrl(song.artworkUrl100, 100, 100)
        ? { artworkUrl: normalizeAppleMusicArtworkUrl(song.artworkUrl100, 100, 100)! }
        : {}),
      ...(song.copyright ? { copyright: song.copyright } : {}),
      ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
      title: song.collectionName,
      ...(song.trackCount === undefined ? {} : { trackCount: song.trackCount }),
    });
  }
  const firstSong = songResults[0];
  const artistName = artist?.artistName ?? firstSong?.artistName ?? `Apple artist ${appleArtistId}`;
  const artistUrl = normalizeAppleArtistUrl(
    artist?.artistLinkUrl ?? firstSong?.artistViewUrl,
    appleArtistId,
  );
  const artworkUrl = firstSong?.artworkUrl100
    ? normalizeAppleMusicArtworkUrl(firstSong.artworkUrl100, 100, 100)
    : null;
  return {
    appleArtistId,
    artistName,
    ...(artistUrl ? { artistUrl } : {}),
    ...(artworkUrl ? { artworkUrl } : {}),
    genres: uniqueStrings(
      [artist?.primaryGenreName, ...songResults.map((song) => song.primaryGenreName)].filter(
        (value): value is string => Boolean(value),
      ),
    ),
    labels: [],
    releases: [...releases.values()],
    resourceStatus: artist || songResults.length ? "valid" : "unknown",
    songs: songResults.map((song) => ({
      ...(song.collectionName ? { albumTitle: song.collectionName } : {}),
      appleSongId: String(song.trackId),
      artistIds: uniqueStrings([
        String(song.artistId),
        ...(song.collectionArtistId === undefined ? [] : [String(song.collectionArtistId)]),
      ]),
      artistName: song.artistName,
      ...(song.artworkUrl100 && normalizeAppleMusicArtworkUrl(song.artworkUrl100, 100, 100)
        ? { artworkUrl: normalizeAppleMusicArtworkUrl(song.artworkUrl100, 100, 100)! }
        : {}),
      ...(song.releaseDate ? { releaseDate: song.releaseDate } : {}),
      title: song.trackName,
    })),
    source: "itunes_lookup",
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeAppleArtistUrl(value: string | undefined, artistId: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["itunes.apple.com", "music.apple.com"].includes(url.hostname.toLowerCase()) ||
      url.username ||
      url.password ||
      url.port ||
      !url.pathname.split("/").includes(artistId)
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}
