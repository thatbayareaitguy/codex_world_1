import type { FullWatchlistIdentitySnapshot } from "./itunes-full-watchlist-identity-snapshot";

export const censusStorefront = "US";
export const censusLanguage = "en_us";
export const censusRequestStartPacingMs = 3200;
export const censusShardArtistLimit = 150;
export const censusShardNetworkRequestLimit = 150;

export type CensusCacheStatus =
  | "valid_cache_hit"
  | "new_network_search_required"
  | "invalid_or_unusable_cache_row"
  | "input_validation_failure";

export interface SearchCacheRow {
  requestIdentity: string;
  response: unknown;
  responseHash: string;
}

export interface SearchCensusManifestItem {
  assignedShard: number;
  cacheKeyIdentity: string;
  cacheStatus: CensusCacheStatus;
  canonicalArtistId: string;
  displayName: string;
  normalizedSearchTerm: string;
  projectedNetworkRequestRequired: boolean;
  requestKind: "artist_search";
}

export interface SearchCensusManifest {
  configuration: {
    artistLimitPerShard: 150;
    endpoint: "/search";
    entity: "musicArtist";
    language: "en_us";
    media: "music";
    networkRequestLimitPerShard: 150;
    requestStartPacingMs: 3200;
    storefront: "US";
  };
  items: SearchCensusManifestItem[];
  kind: "itunes_artist_search_census_plan";
  shards: Array<{
    artistCount: number;
    newNetworkRequestCount: number;
    projectedMinimumRuntimeMs: number;
    shard: number;
  }>;
  snapshot: {
    canonicalContentSha256: string;
    fileByteSha256: string;
    id: string;
    path: string;
  };
  summary: {
    inputValidationFailures: number;
    invalidCacheEntries: number;
    newNetworkSearches: number;
    projectedMinimumRuntimeMs: number;
    shardCount: number;
    totalArtists: number;
    validSearchCacheHits: number;
  };
  version: 1;
}

export function createSearchCensusManifest(input: {
  cacheRows: SearchCacheRow[];
  snapshot: FullWatchlistIdentitySnapshot;
  snapshotFileByteSha256: string;
  snapshotPath: string;
}): SearchCensusManifest {
  const cache = new Map<string, SearchCacheRow>();
  for (const row of input.cacheRows) cache.set(row.requestIdentity, row);
  const orderedArtists = [...input.snapshot.artists].sort(
    (left, right) =>
      compareText(left.normalizedName, right.normalizedName) ||
      compareText(left.canonicalArtistId, right.canonicalArtistId),
  );
  const items = orderedArtists.map((artist, index): SearchCensusManifestItem => {
    const assignedShard = Math.floor(index / censusShardArtistLimit) + 1;
    const normalizedSearchTerm = artist.displayName.trim().normalize("NFC");
    if (!normalizedSearchTerm) {
      return {
        assignedShard,
        cacheKeyIdentity: "",
        cacheStatus: "input_validation_failure",
        canonicalArtistId: artist.canonicalArtistId,
        displayName: artist.displayName,
        normalizedSearchTerm,
        projectedNetworkRequestRequired: false,
        requestKind: "artist_search",
      };
    }
    const cacheKeyIdentity = artistSearchRequestIdentity(normalizedSearchTerm);
    const row = cache.get(cacheKeyIdentity);
    const cacheStatus: CensusCacheStatus = !row
      ? "new_network_search_required"
      : validArtistSearchCacheRow(row)
        ? "valid_cache_hit"
        : "invalid_or_unusable_cache_row";
    return {
      assignedShard,
      cacheKeyIdentity,
      cacheStatus,
      canonicalArtistId: artist.canonicalArtistId,
      displayName: artist.displayName,
      normalizedSearchTerm,
      projectedNetworkRequestRequired: cacheStatus !== "valid_cache_hit",
      requestKind: "artist_search",
    };
  });
  const shardCount = Math.ceil(items.length / censusShardArtistLimit);
  const shards = Array.from({ length: shardCount }, (_, offset) => {
    const shard = offset + 1;
    const members = items.filter((item) => item.assignedShard === shard);
    const newNetworkRequestCount = members.filter(
      (item) => item.projectedNetworkRequestRequired,
    ).length;
    if (
      members.length > censusShardArtistLimit ||
      newNetworkRequestCount > censusShardNetworkRequestLimit
    ) {
      throw new Error(`Census shard ${shard} exceeds its declared bound.`);
    }
    return {
      artistCount: members.length,
      newNetworkRequestCount,
      projectedMinimumRuntimeMs: newNetworkRequestCount * censusRequestStartPacingMs,
      shard,
    };
  });
  const manifest: SearchCensusManifest = {
    configuration: {
      artistLimitPerShard: 150,
      endpoint: "/search",
      entity: "musicArtist",
      language: censusLanguage,
      media: "music",
      networkRequestLimitPerShard: 150,
      requestStartPacingMs: censusRequestStartPacingMs,
      storefront: censusStorefront,
    },
    items,
    kind: "itunes_artist_search_census_plan",
    shards,
    snapshot: {
      canonicalContentSha256: input.snapshot.canonicalContentSha256,
      fileByteSha256: input.snapshotFileByteSha256,
      id: input.snapshot.snapshotId,
      path: input.snapshotPath,
    },
    summary: {
      inputValidationFailures: items.filter(
        (item) => item.cacheStatus === "input_validation_failure",
      ).length,
      invalidCacheEntries: items.filter(
        (item) => item.cacheStatus === "invalid_or_unusable_cache_row",
      ).length,
      newNetworkSearches: items.filter((item) => item.projectedNetworkRequestRequired).length,
      projectedMinimumRuntimeMs: shards.reduce(
        (total, shard) => total + shard.projectedMinimumRuntimeMs,
        0,
      ),
      shardCount,
      totalArtists: items.length,
      validSearchCacheHits: items.filter((item) => item.cacheStatus === "valid_cache_hit").length,
    },
    version: 1,
  };
  validateSearchCensusManifest(manifest);
  return manifest;
}

export function serializeSearchCensusManifest(manifest: SearchCensusManifest): string {
  validateSearchCensusManifest(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function validateSearchCensusManifest(manifest: SearchCensusManifest): void {
  if (
    manifest.version !== 1 ||
    manifest.kind !== "itunes_artist_search_census_plan" ||
    manifest.configuration.endpoint !== "/search" ||
    manifest.configuration.entity !== "musicArtist" ||
    manifest.configuration.storefront !== censusStorefront
  ) {
    throw new Error("The search census manifest is not search-only.");
  }
  const artistIds = new Set<string>();
  for (const item of manifest.items) {
    if (item.requestKind !== "artist_search") {
      throw new Error("The census manifest contains a non-search request.");
    }
    if (artistIds.has(item.canonicalArtistId)) {
      throw new Error(`Artist appears more than once: ${item.canonicalArtistId}`);
    }
    artistIds.add(item.canonicalArtistId);
  }
  for (const shard of manifest.shards) {
    if (
      shard.artistCount > censusShardArtistLimit ||
      shard.newNetworkRequestCount > censusShardNetworkRequestLimit
    ) {
      throw new Error(`Census shard ${shard.shard} exceeds its limit.`);
    }
  }
}

export function artistSearchRequestIdentity(term: string): string {
  const normalizedTerm = term.trim().normalize("NFC");
  if (!normalizedTerm) throw new Error("Artist search term is empty.");
  const parameters = new URLSearchParams({
    country: censusStorefront,
    entity: "musicArtist",
    explicit: "Yes",
    lang: censusLanguage,
    limit: "10",
    media: "music",
    term: normalizedTerm,
  });
  parameters.sort();
  return `/search?${parameters.toString()}`;
}

export function validArtistSearchCacheRow(row: SearchCacheRow): boolean {
  if (
    row.requestIdentity !== artistSearchRequestIdentityFromIdentity(row.requestIdentity) ||
    !/^[0-9a-f]{64}$/.test(row.responseHash)
  ) {
    return false;
  }
  if (!row.response || typeof row.response !== "object" || Array.isArray(row.response)) {
    return false;
  }
  const response = row.response as Record<string, unknown>;
  if (
    !nonnegativeInteger(response.declaredResultCount) ||
    !nonnegativeInteger(response.unknownResultCount) ||
    !Array.isArray(response.artists) ||
    !Array.isArray(response.collections) ||
    !Array.isArray(response.tracks) ||
    response.collections.length !== 0 ||
    response.tracks.length !== 0
  ) {
    return false;
  }
  return response.artists.every(
    (artist) =>
      artist !== null &&
      typeof artist === "object" &&
      !Array.isArray(artist) &&
      (artist as Record<string, unknown>).wrapperType === "artist" &&
      nonemptyString((artist as Record<string, unknown>).artistId) &&
      nonemptyString((artist as Record<string, unknown>).artistName),
  );
}

function artistSearchRequestIdentityFromIdentity(identity: string): string {
  try {
    const url = new URL(identity, "https://itunes.apple.com");
    if (
      url.pathname !== "/search" ||
      url.searchParams.get("country") !== censusStorefront ||
      url.searchParams.get("entity") !== "musicArtist" ||
      url.searchParams.get("explicit") !== "Yes" ||
      url.searchParams.get("lang") !== censusLanguage ||
      url.searchParams.get("limit") !== "10" ||
      url.searchParams.get("media") !== "music" ||
      !url.searchParams.get("term") ||
      [...url.searchParams.keys()].length !== 7
    ) {
      return "";
    }
    return artistSearchRequestIdentity(url.searchParams.get("term")!);
  } catch {
    return "";
  }
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
