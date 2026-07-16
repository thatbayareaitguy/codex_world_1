import { createHash } from "node:crypto";
import type { ArtistCreditInput, ReleaseType, TrackCandidate } from "@radar/core";
import { normalizeText } from "@radar/core";
import { z } from "zod";
import type { DiscoveryProvider, ScanContext } from "./contracts";

const mbid = z.string().uuid();
const artistCreditSchema = z
  .object({
    artist: z
      .object({ id: mbid, name: z.string(), "sort-name": z.string().optional() })
      .passthrough(),
    joinphrase: z.string().optional(),
    name: z.string(),
  })
  .passthrough();
const releaseGroupSchema = z
  .object({
    "artist-credit": z.array(artistCreditSchema).default([]),
    "first-release-date": z.string().optional(),
    "primary-type": z.string().nullable().optional(),
    "secondary-types": z.array(z.string()).default([]),
    id: mbid,
    title: z.string(),
  })
  .passthrough();
const recordingSchema = z
  .object({
    id: mbid,
    isrcs: z.array(z.string()).default([]),
    length: z.number().int().nonnegative().nullable().optional(),
    title: z.string(),
  })
  .passthrough();
const trackSchema = z
  .object({
    "artist-credit": z.array(artistCreditSchema).default([]),
    id: mbid,
    length: z.number().int().nonnegative().nullable().optional(),
    number: z.string(),
    position: z.number().int().positive(),
    recording: recordingSchema,
    title: z.string(),
  })
  .passthrough();
const releaseSchema = z
  .object({
    "artist-credit": z.array(artistCreditSchema).default([]),
    "release-group": releaseGroupSchema,
    barcode: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    date: z.string().optional(),
    id: mbid,
    media: z
      .array(
        z
          .object({
            position: z.number().int().positive(),
            "track-count": z.number().int().nonnegative(),
            tracks: z.array(trackSchema).default([]),
          })
          .passthrough(),
      )
      .default([]),
    status: z.string().nullable().optional(),
    title: z.string(),
  })
  .passthrough();

export const musicbrainzArtistSearchSchema = z.object({
  artists: z.array(
    z
      .object({
        aliases: z
          .array(z.object({ name: z.string(), primary: z.boolean().optional() }).passthrough())
          .default([]),
        country: z.string().optional(),
        disambiguation: z.string().optional(),
        id: mbid,
        "life-span": z
          .object({
            begin: z.string().nullable().optional(),
            end: z.string().nullable().optional(),
          })
          .passthrough()
          .optional(),
        name: z.string(),
        score: z.number().int().min(0).max(100),
        "sort-name": z.string(),
        type: z.string().nullable().optional(),
      })
      .passthrough(),
  ),
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
});
export const musicbrainzReleaseGroupsSchema = z.object({
  "release-group-count": z.number().int().nonnegative(),
  "release-group-offset": z.number().int().nonnegative(),
  "release-groups": z.array(releaseGroupSchema),
});
export const musicbrainzReleasesSchema = z.object({
  "release-count": z.number().int().nonnegative(),
  "release-offset": z.number().int().nonnegative(),
  releases: z.array(releaseSchema),
});

export type MusicBrainzArtistResult = z.infer<
  typeof musicbrainzArtistSearchSchema
>["artists"][number];
export type MusicBrainzRelease = z.infer<typeof releaseSchema>;
export type MusicBrainzReleaseGroup = z.infer<typeof releaseGroupSchema>;

export class MusicBrainzHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MusicBrainzHttpError";
  }
}

export class MusicBrainzRateGate {
  private queue = Promise.resolve();
  private nextRequestAt = 0;

  constructor(
    private readonly intervalMs = 1_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  schedule<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = this.queue.then(async () => {
      const wait = Math.max(0, this.nextRequestAt - this.now());
      if (wait) await this.sleep(wait);
      this.nextRequestAt = this.now() + this.intervalMs;
      return operation();
    });
    this.queue = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }
}

const sharedMusicBrainzGate = new MusicBrainzRateGate();

interface MusicBrainzClientOptions {
  baseUrl?: string;
  contactEmail: string;
  fetcher?: typeof fetch;
  gate?: MusicBrainzRateGate;
  packageVersion?: string;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class MusicBrainzClient {
  readonly metrics = { failures: 0, requests: 0, throttleWaits: 0 };
  private readonly baseUrl: string;
  private readonly cache = new Map<string, unknown>();
  private readonly fetcher: typeof fetch;
  private readonly gate: MusicBrainzRateGate;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(options: MusicBrainzClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://musicbrainz.org/ws/2";
    this.fetcher = options.fetcher ?? fetch;
    this.gate = options.gate ?? sharedMusicBrainzGate;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.userAgent = `ReleaseInbox/${options.packageVersion ?? "0.1.0"} (${options.contactEmail})`;
  }

  searchArtists(
    name: string,
    aliases: string[] = [],
    signal?: AbortSignal,
  ): Promise<MusicBrainzArtistResult[]> {
    const terms = [name, ...aliases].map((value) => `artist:${quoteLucene(value)}`).join(" OR ");
    return this.get(
      `/artist?query=${encodeURIComponent(terms)}&limit=10&offset=0&fmt=json`,
      musicbrainzArtistSearchSchema,
      signal,
    ).then((response) => response.artists);
  }

  browseReleaseGroups(
    artistMbid: string,
    signal?: AbortSignal,
  ): Promise<MusicBrainzReleaseGroup[]> {
    return this.browse(
      "/release-group",
      "artist",
      artistMbid,
      "artist-credits",
      musicbrainzReleaseGroupsSchema,
      "release-groups",
      "release-group-count",
      signal,
    );
  }

  browseReleases(
    artistMbid: string,
    mode: "artist" | "track_artist",
    signal?: AbortSignal,
  ): Promise<MusicBrainzRelease[]> {
    return this.browse(
      "/release",
      mode,
      artistMbid,
      "artist-credits+release-groups+media+recordings+isrcs",
      musicbrainzReleasesSchema,
      "releases",
      "release-count",
      signal,
    );
  }

  private async browse<T extends Record<string, unknown>, K extends keyof T, C extends keyof T>(
    path: string,
    browseType: string,
    mbidValue: string,
    includes: string,
    schema: z.ZodType<T>,
    itemsKey: K,
    countKey: C,
    signal?: AbortSignal,
  ): Promise<Array<T[K] extends Array<infer Item> ? Item : never>> {
    const results: Array<T[K] extends Array<infer Item> ? Item : never> = [];
    let offset = 0;
    let total = 0;
    do {
      const response = await this.get(
        `${path}?${browseType}=${encodeURIComponent(mbidValue)}&inc=${includes}&limit=100&offset=${offset}&fmt=json`,
        schema,
        signal,
      );
      const items = response[itemsKey] as Array<T[K] extends Array<infer Item> ? Item : never>;
      total = response[countKey] as number;
      results.push(...items);
      if (items.length === 0) break;
      offset += items.length;
    } while (offset < total);
    return results;
  }

  private async get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached as T;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await this.gate.schedule(async () => {
          this.metrics.requests += 1;
          const response = await this.fetcher(`${this.baseUrl}${path}`, {
            headers: { Accept: "application/json", "User-Agent": this.userAgent },
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
              : AbortSignal.timeout(20_000),
          });
          if (!response.ok) {
            throw new MusicBrainzHttpError(
              `MusicBrainz request failed with status ${response.status}`,
              response.status,
            );
          }
          return schema.parse(await response.json());
        });
        this.cache.set(path, result);
        return result;
      } catch (error) {
        const retryable =
          (error instanceof MusicBrainzHttpError && error.status === 503) ||
          (!(error instanceof MusicBrainzHttpError) && !(error instanceof z.ZodError));
        if (!retryable || attempt >= 3) {
          this.metrics.failures += 1;
          throw error;
        }
        this.metrics.throttleWaits += 1;
        await this.sleep(500 * 2 ** (attempt - 1));
      }
    }
    throw new Error("MusicBrainz retry loop exhausted");
  }
}

export interface CanonicalArtistMappingInput {
  aliases: string[];
  artistId: string;
  mbid: string;
  name: string;
}

export function scoreMusicBrainzArtist(
  canonicalName: string,
  aliases: string[],
  result: MusicBrainzArtistResult,
): { confidence: number; reasons: string[] } {
  let confidence = (result.score / 100) * 0.45;
  const reasons = [`MusicBrainz search score is ${result.score}`];
  const acceptedNames = [canonicalName, ...aliases].map(normalizeText);
  if (acceptedNames.includes(normalizeText(result.name))) {
    confidence += 0.4;
    reasons.push("Canonical name or user alias is exact");
  }
  if (result.aliases.some((alias) => acceptedNames.includes(normalizeText(alias.name)))) {
    confidence += 0.1;
    reasons.push("MusicBrainz alias matches a canonical name or user alias");
  }
  if (result.disambiguation) {
    confidence += 0.02;
    reasons.push(`Disambiguation is available: ${result.disambiguation}`);
  }
  return { confidence: Math.min(1, Math.round(confidence * 1000) / 1000), reasons };
}

export function classifyMusicBrainzRelease(
  primaryType: string | null | undefined,
  secondaryTypes: string[],
): ReleaseType {
  const secondary = secondaryTypes.map(normalizeText);
  if (secondary.includes("remix")) return "remix";
  if (secondary.includes("live")) return "live";
  if (secondary.includes("compilation")) return "compilation";
  if (secondary.includes("mixtape street")) return "mixtape";
  if (secondary.includes("dj mix")) return "dj_mix";
  if (secondary.includes("demo")) return "demo";
  if (secondary.includes("soundtrack")) return "soundtrack";
  if (normalizeText(primaryType ?? "") === "single") return "single";
  if (normalizeText(primaryType ?? "") === "ep") return "ep";
  if (normalizeText(primaryType ?? "") === "album") return "album";
  return "other";
}

export class MusicBrainzProvider implements DiscoveryProvider {
  readonly name = "musicbrainz" as const;

  constructor(
    private readonly client: MusicBrainzClient,
    private readonly mappedArtists: CanonicalArtistMappingInput[],
    private readonly now: () => Date = () => new Date(),
  ) {}

  async scan(context: ScanContext): Promise<{
    candidates: TrackCandidate[];
    providerMetrics: { failures: number; requests: number; waitMs: number };
  }> {
    const candidates: TrackCandidate[] = [];
    const mappings = context.filter.artistId
      ? this.mappedArtists.filter((mapping) => mapping.artistId === context.filter.artistId)
      : this.mappedArtists;
    for (const mapping of mappings) {
      const primary = await this.client.browseReleases(mapping.mbid, "artist", context.signal);
      const appearances = await this.client.browseReleases(
        mapping.mbid,
        "track_artist",
        context.signal,
      );
      for (const release of [...primary, ...appearances]) {
        const discovered = releaseCandidates(mapping, release, this.now());
        candidates.push(
          ...discovered.filter(
            (candidate) =>
              context.filter.full ||
              !context.filter.since ||
              candidate.releaseDate >= context.filter.since,
          ),
        );
      }
    }
    return {
      candidates,
      providerMetrics: {
        failures: this.client.metrics.failures,
        requests: this.client.metrics.requests,
        waitMs: this.client.metrics.throttleWaits * 1_000,
      },
    };
  }
}

function releaseCandidates(
  mapping: CanonicalArtistMappingInput,
  release: MusicBrainzRelease,
  now: Date,
): TrackCandidate[] {
  const releaseDate = normalizePartialDate(
    release.date ?? release["release-group"]["first-release-date"],
  );
  if (!releaseDate) return [];
  const classification = classifyMusicBrainzRelease(
    release["release-group"]["primary-type"],
    release["release-group"]["secondary-types"],
  );
  return release.media.flatMap((medium) =>
    medium.tracks
      .filter(
        (track) =>
          track["artist-credit"].some((credit) => credit.artist.id === mapping.mbid) ||
          release["artist-credit"].some((credit) => credit.artist.id === mapping.mbid),
      )
      .map((track) => {
        const credits = toCredits(track["artist-credit"], mapping.mbid);
        const providerUrl = `https://musicbrainz.org/recording/${track.recording.id}`;
        const durationMs = track.length ?? track.recording.length ?? undefined;
        const isrc = track.recording.isrcs[0];
        const candidate = {
          artistExternalId: mapping.mbid,
          artistName: mapping.name,
          availability: "unavailable" as const,
          credits,
          discNumber: medium.position,
          ...(durationMs !== undefined ? { durationMs } : {}),
          evidenceType: "musicbrainz_recording",
          evidenceUrl: providerUrl,
          externalReleaseId: release.id,
          externalTrackId: track.recording.id,
          firstSeenAt: now.toISOString(),
          isUpcoming: new Date(`${releaseDate.date}T00:00:00Z`).getTime() > now.getTime(),
          ...(isrc ? { isrc } : {}),
          musicbrainzRecordingId: track.recording.id,
          musicbrainzReleaseGroupId: release["release-group"].id,
          provider: "musicbrainz" as const,
          providerUrl,
          region: release.country?.slice(0, 2) ?? "ZZ",
          releaseDate: releaseDate.date,
          releaseDatePrecision: releaseDate.precision,
          releaseTitle: release.title,
          releaseType: credits.some((credit) => credit.role === "featured")
            ? ("feature" as const)
            : classification,
          sourceLabel: "MusicBrainz community metadata",
          title: track.title || track.recording.title,
          trackNumber: track.position,
          ...(release.barcode ? { upc: release.barcode } : {}),
        };
        return {
          ...candidate,
          payloadHash: createHash("sha256").update(JSON.stringify(candidate)).digest("hex"),
        } satisfies TrackCandidate;
      }),
  );
}

function toCredits(
  credits: MusicBrainzRelease["artist-credit"],
  watchedMbid: string,
): ArtistCreditInput[] {
  return credits.map((credit, index) => ({
    name: credit.name,
    role: credit.artist.id === watchedMbid && index > 0 ? "featured" : "primary",
  }));
}

function normalizePartialDate(
  value: string | undefined,
): { date: string; precision: "day" | "month" | "year" } | undefined {
  if (!value) return undefined;
  if (/^\d{4}$/.test(value)) return { date: `${value}-01-01`, precision: "year" };
  if (/^\d{4}-\d{2}$/.test(value)) return { date: `${value}-01`, precision: "month" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value, precision: "day" };
  return undefined;
}

function quoteLucene(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}
