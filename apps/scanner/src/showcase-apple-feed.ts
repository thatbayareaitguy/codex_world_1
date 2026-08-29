import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  asyncBufferFromUrl,
  cachedAsyncBuffer,
  parquetMetadataAsync,
  parquetReadObjects,
  parquetScan,
  type AsyncBuffer,
} from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { z } from "zod";
import type { ShowcaseSourceArtwork } from "./showcase-publication";

const APPLE_FEED_ORIGIN = "https://api.media.apple.com";
const APPLE_FEED_PART_HOST = "media-feed.cdn-apple.com";
const MAX_FEED_PARTS = 500;
const MAX_FEED_PAGES = 10;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_CDN_RANGE_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CDN_REQUEST_TIMEOUT_MS = 60_000;
const MIN_REQUEST_INTERVAL_MS = 1100;

const feedConfigSchema = z
  .object({
    SHOWCASE_APPLE_FEED_KEY_ID: z.string().regex(/^[A-Z0-9]{10}$/),
    SHOWCASE_APPLE_FEED_PRIVATE_KEY_PATH: z.string().trim().min(1),
    SHOWCASE_APPLE_FEED_TEAM_ID: z.string().regex(/^[A-Z0-9]{10}$/),
  })
  .strict();

const latestExportSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200),
          })
          .passthrough(),
      )
      .min(1)
      .max(10),
  })
  .passthrough();

const feedPartResourceSchema = z
  .object({
    attributes: z
      .object({
        exportLocation: z.url(),
      })
      .passthrough(),
    id: z.string().trim().min(1).max(300),
  })
  .passthrough();

const feedPartsPageSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(300),
          })
          .passthrough(),
      )
      .max(100),
    next: z.string().trim().min(1).optional(),
    resources: z
      .object({
        parts: z.record(z.string(), feedPartResourceSchema),
      })
      .passthrough(),
  })
  .passthrough();

const artworkItemSchema = z
  .object({
    height: z.number().int().positive().max(10_000),
    url: z.url(),
    width: z.number().int().positive().max(10_000),
  })
  .strict();

const artworksSchema = z
  .object({
    default: z.array(artworkItemSchema).max(20).optional(),
  })
  .passthrough();

interface AppleMusicFeedCredentials {
  readonly keyId: string;
  readonly privateKeyPath: string;
  readonly teamId: string;
}

export interface AppleMusicFeedPart {
  readonly id: string;
  readonly exportLocation: string;
}

export interface AppleMusicFeedArtworkProgress {
  readonly artworkMatchCount: number;
  readonly partCount: number;
  readonly partNumber: number;
  readonly remainingReleaseCount: number;
}

export interface AppleMusicFeedArtworkResult {
  readonly artworkByAppleReleaseId: ReadonlyMap<string, ShowcaseSourceArtwork>;
  readonly exportPartCount: number;
  readonly partsScanned: number;
  readonly requestedReleaseCount: number;
}

interface AppleMusicFeedClientOptions {
  readonly developerToken: string;
  readonly fetchImpl?: typeof fetch;
  readonly minimumRequestIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class AppleMusicFeedClient {
  readonly #developerToken: string;
  readonly #fetch: typeof fetch;
  readonly #minimumRequestIntervalMs: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #lastRequestStartedAt: number | undefined;

  constructor(options: AppleMusicFeedClientOptions) {
    this.#developerToken = options.developerToken;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#minimumRequestIntervalMs = options.minimumRequestIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? wait;
  }

  async listLatestAlbumParts(): Promise<readonly AppleMusicFeedPart[]> {
    const latest = latestExportSchema.parse(
      await this.#requestJson(new URL("/v1/feed/album/latest", APPLE_FEED_ORIGIN)),
    );
    const exportId = latest.data[0]!.id;
    let nextUrl: URL | undefined = new URL(
      `/v1/feed/exports/${encodeURIComponent(exportId)}/parts?limit=100&offset=0`,
      APPLE_FEED_ORIGIN,
    );
    const parts: AppleMusicFeedPart[] = [];
    let pageCount = 0;

    while (nextUrl !== undefined) {
      pageCount += 1;
      if (pageCount > MAX_FEED_PAGES) throw new Error("Apple Music Feed returned too many pages.");
      const page = feedPartsPageSchema.parse(await this.#requestJson(nextUrl));
      for (const item of page.data) {
        const resource = page.resources.parts[item.id];
        if (resource === undefined) throw new Error("Apple Music Feed omitted a part resource.");
        const exportLocation = validatedPartUrl(resource.attributes.exportLocation);
        parts.push({ id: resource.id, exportLocation });
        if (parts.length > MAX_FEED_PARTS)
          throw new Error("Apple Music Feed returned too many parts.");
      }
      nextUrl = page.next === undefined ? undefined : validatedNextPageUrl(page.next, exportId);
    }

    return parts;
  }

  async #requestJson(url: URL): Promise<unknown> {
    if (url.origin !== APPLE_FEED_ORIGIN || !url.pathname.startsWith("/v1/feed/"))
      throw new Error("Refusing an unexpected Apple Music Feed endpoint.");
    if (this.#lastRequestStartedAt !== undefined) {
      const remaining = this.#minimumRequestIntervalMs - (this.#now() - this.#lastRequestStartedAt);
      if (remaining > 0) await this.#sleep(remaining);
    }
    this.#lastRequestStartedAt = this.#now();
    const response = await this.#fetch(url, {
      headers: { Authorization: `Bearer ${this.#developerToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`Apple Music Feed request failed with status ${response.status}.`);
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error("Apple Music Feed response exceeded the size limit.");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_JSON_RESPONSE_BYTES)
      throw new Error("Apple Music Feed response exceeded the size limit.");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  }
}

export function resolveAppleMusicFeedConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.SHOWCASE_APPLE_FEED_CONFIG_PATH !== undefined)
    return resolve(environment.SHOWCASE_APPLE_FEED_CONFIG_PATH);
  const localDataRoot = environment.LOCALAPPDATA ?? resolve(homedir(), ".local", "share");
  return resolve(localDataRoot, "ShowcasePublicSite", "apple-music-feed.env");
}

export function loadAppleMusicFeedCredentials(
  path = resolveAppleMusicFeedConfigPath(),
): AppleMusicFeedCredentials {
  if (!existsSync(path)) throw new Error("Showcase Apple Music Feed configuration is missing.");
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    values[match[1]!] = unquote(match[2]!);
  }
  const parsed = feedConfigSchema.parse({
    SHOWCASE_APPLE_FEED_KEY_ID: values.SHOWCASE_APPLE_FEED_KEY_ID,
    SHOWCASE_APPLE_FEED_PRIVATE_KEY_PATH: values.SHOWCASE_APPLE_FEED_PRIVATE_KEY_PATH,
    SHOWCASE_APPLE_FEED_TEAM_ID: values.SHOWCASE_APPLE_FEED_TEAM_ID,
  });
  const privateKeyPath = resolve(parsed.SHOWCASE_APPLE_FEED_PRIVATE_KEY_PATH);
  if (!existsSync(privateKeyPath))
    throw new Error("The configured Showcase Apple Music Feed private key is missing.");
  return {
    keyId: parsed.SHOWCASE_APPLE_FEED_KEY_ID,
    privateKeyPath,
    teamId: parsed.SHOWCASE_APPLE_FEED_TEAM_ID,
  };
}

export function createAppleMusicFeedDeveloperToken(
  credentials: AppleMusicFeedCredentials,
  issuedAt = new Date(),
): string {
  const currentUnixSeconds = Math.floor(issuedAt.getTime() / 1000);
  const header = encodeJwtSegment({ alg: "ES256", kid: credentials.keyId });
  const payload = encodeJwtSegment({
    exp: currentUnixSeconds + 60 * 60,
    iss: credentials.teamId,
    iat: currentUnixSeconds,
  });
  const signingInput = `${header}.${payload}`;
  const privateKey = createPrivateKey(readFileSync(credentials.privateKeyPath, "utf8"));
  const signature = sign("sha256", Buffer.from(signingInput), {
    dsaEncoding: "ieee-p1363",
    key: privateKey,
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

export async function fetchAppleMusicFeedArtwork(options: {
  readonly appleReleaseIds: readonly string[];
  readonly client: AppleMusicFeedClient;
  readonly fetchImpl?: typeof fetch;
  readonly onProgress?: (progress: AppleMusicFeedArtworkProgress) => void;
}): Promise<AppleMusicFeedArtworkResult> {
  const requestedIds = [...new Set(options.appleReleaseIds.filter((id) => /^\d+$/.test(id)))];
  const remainingIds = new Set(requestedIds);
  const artworkByAppleReleaseId = new Map<string, ShowcaseSourceArtwork>();
  const parts = await options.client.listLatestAlbumParts();
  let partsScanned = 0;

  for (const [partIndex, part] of parts.entries()) {
    if (remainingIds.size === 0) break;
    const file = cachedAsyncBuffer(
      await asyncBufferFromUrl({
        fetch: createBoundedPartFetch(options.fetchImpl ?? fetch),
        url: part.exportLocation,
      }),
      { minSize: 64 * 1024 },
    );
    await collectArtworkFromPart(file, remainingIds, artworkByAppleReleaseId);
    partsScanned += 1;
    options.onProgress?.({
      artworkMatchCount: artworkByAppleReleaseId.size,
      partCount: parts.length,
      partNumber: partIndex + 1,
      remainingReleaseCount: remainingIds.size,
    });
  }

  return {
    artworkByAppleReleaseId,
    exportPartCount: parts.length,
    partsScanned,
    requestedReleaseCount: requestedIds.length,
  };
}

export function selectAppleMusicFeedArtwork(value: unknown): ShowcaseSourceArtwork | undefined {
  const parsed = artworksSchema.safeParse(value);
  if (!parsed.success || parsed.data.default === undefined) return undefined;
  const candidates = parsed.data.default
    .flatMap((artwork) => {
      const validatedUrl = validatedArtworkUrl(artwork.url);
      return validatedUrl === undefined ? [] : [{ ...artwork, url: validatedUrl }];
    })
    .sort((left, right) => right.width * right.height - left.width * left.height);
  const artwork = candidates[0];
  return artwork === undefined
    ? undefined
    : {
        source: "apple_music",
        url: artwork.url,
        width: artwork.width,
        height: artwork.height,
      };
}

async function collectArtworkFromPart(
  file: AsyncBuffer,
  remainingIds: Set<string>,
  output: Map<string, ShowcaseSourceArtwork>,
): Promise<void> {
  const metadata = await parquetMetadataAsync(file, { geoparquet: false });
  const scan = await parquetScan({
    columns: ["id"],
    compressors,
    file,
    geoparquet: false,
    metadata,
  });
  const matchingRows: { readonly id: string; readonly row: number }[] = [];
  for (const range of scan.ranges) {
    const ids = await scan.readColumn({ column: "id", ...range });
    for (let index = 0; index < ids.length; index += 1) {
      const id = String(ids[index]);
      if (remainingIds.has(id)) matchingRows.push({ id, row: range.rowStart + index });
    }
  }

  for (const match of matchingRows) {
    const rows: readonly Record<string, unknown>[] = await parquetReadObjects({
      columns: ["id", "artworks"],
      compressors,
      file,
      geoparquet: false,
      metadata,
      rowEnd: match.row + 1,
      rowStart: match.row,
      useOffsetIndex: true,
      usePageIndex: true,
    });
    const row = rows.find((candidate) => String(candidate.id) === match.id);
    const artwork = selectAppleMusicFeedArtwork(row?.artworks);
    if (artwork !== undefined) {
      output.set(match.id, artwork);
      remainingIds.delete(match.id);
    }
  }
}

function createBoundedPartFetch(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== APPLE_FEED_PART_HOST ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.hash !== ""
    )
      throw new Error("Refusing an untrusted Apple Music Feed part URL.");
    const method = request.method.toUpperCase();
    if (method !== "HEAD" && method !== "GET")
      throw new Error("Refusing an unexpected Apple Music Feed part method.");
    if (method === "GET") {
      const range = request.headers.get("range");
      const match = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
      if (match === null) throw new Error("Apple Music Feed part reads must use byte ranges.");
      const requestedBytes = Number(match[2]) - Number(match[1]) + 1;
      if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1)
        throw new Error("Apple Music Feed requested an invalid byte range.");
      if (requestedBytes > MAX_CDN_RANGE_BYTES)
        throw new Error("Apple Music Feed requested an oversized byte range.");
    }
    const response = await fetchImpl(request, {
      redirect: "error",
      signal: AbortSignal.timeout(CDN_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Apple Music Feed part request failed: ${response.status}.`);
    if (method === "GET" && response.status !== 206) {
      await response.body?.cancel();
      throw new Error("Apple Music Feed part server ignored the byte range.");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (
      method === "GET" &&
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_CDN_RANGE_BYTES
    ) {
      await response.body?.cancel();
      throw new Error("Apple Music Feed part response exceeded the size limit.");
    }
    return response;
  };
}

function validatedPartUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== APPLE_FEED_PART_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== ""
  )
    throw new Error("Apple Music Feed returned an untrusted part URL.");
  return url.toString();
}

function validatedNextPageUrl(value: string, exportId: string): URL {
  const url = new URL(value, APPLE_FEED_ORIGIN);
  const expectedPrefix = `/v1/feed/exports/${encodeURIComponent(exportId)}/parts`;
  if (url.origin !== APPLE_FEED_ORIGIN || url.pathname !== expectedPrefix)
    throw new Error("Apple Music Feed returned an untrusted pagination URL.");
  return url;
}

function validatedArtworkUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !/^is[1-5]-ssl\.mzstatic\.com$/.test(url.hostname) ||
      !url.pathname.startsWith("/image/thumb/") ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.hash !== ""
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function encodeJwtSegment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'"))
      return value.slice(1, -1);
  }
  return value;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
