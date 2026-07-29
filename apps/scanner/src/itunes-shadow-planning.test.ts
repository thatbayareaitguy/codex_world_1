import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertIdentitySnapshotReadOnlyStatement,
  collectFullWatchlistIdentitySnapshot,
  fullWatchlistIdentityQueries,
  fullWatchlistIdentityTransactionMode,
  serializeFullWatchlistIdentitySnapshot,
  validateFullWatchlistIdentitySnapshot,
  writeFullWatchlistIdentitySnapshot,
  type FullWatchlistIdentitySnapshot,
  type IdentitySnapshotReader,
} from "./itunes-full-watchlist-identity-snapshot";
import {
  artistSearchRequestIdentity,
  createSearchCensusManifest,
  serializeSearchCensusManifest,
  type SearchCacheRow,
} from "./itunes-search-census-planner";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  while (temporaryDirectories.length > 0) {
    await rm(temporaryDirectories.pop()!, { force: true, recursive: true });
  }
});

describe("full-watchlist identity snapshot", () => {
  it("uses only a repeatable-read, read-only transaction and approved SELECT statements", async () => {
    const calls: string[] = [];
    const modes: string[] = [];
    const reader = fixtureReader(2, calls, modes);
    await collectFullWatchlistIdentitySnapshot(reader);

    expect(modes).toEqual([fullWatchlistIdentityTransactionMode]);
    expect(fullWatchlistIdentityTransactionMode).toBe("isolation level repeatable read read only");
    expect(calls).toEqual([
      fullWatchlistIdentityQueries.timestamp,
      fullWatchlistIdentityQueries.schemaVersion,
      fullWatchlistIdentityQueries.artists,
    ]);
    for (const statement of calls) {
      expect(() => assertIdentitySnapshotReadOnlyStatement(statement)).not.toThrow();
    }
  });

  it.each([
    "update artists set name = 'x'",
    "delete from artists",
    "insert into artists (name) values ('x')",
    "select pg_advisory_lock(1)",
    "select * from spotify_request_events",
    "select * from artists for update",
  ])("rejects write, lock, or prohibited-table SQL: %s", (statement) => {
    expect(() => assertIdentitySnapshotReadOnlyStatement(statement)).toThrow();
  });

  it("contains identity fields only and rejects releases, tracks, credentials, and operations", async () => {
    const snapshot = await fixtureSnapshot(2);
    const serialized = serializeFullWatchlistIdentitySnapshot(snapshot);
    expect(serialized).not.toMatch(
      /release|track|credential|token|account|telemetry|campaign|scheduler|cooldown|lease|lock|playlist|feed|payload/i,
    );

    for (const prohibited of [
      { releases: [] },
      { tracks: [] },
      { accessToken: "secret" },
      { campaignState: "running" },
      { schedulerLease: "held" },
    ]) {
      expect(() => validateFullWatchlistIdentitySnapshot({ ...snapshot, ...prohibited })).toThrow(
        /prohibited field/,
      );
    }
  });

  it("rejects duplicate canonical artists and duplicate confirmed Spotify mappings", async () => {
    const snapshot = await fixtureSnapshot(2);
    const duplicateCanonical = {
      ...snapshot,
      artists: [snapshot.artists[0]!, snapshot.artists[0]!],
    };
    expect(() => validateFullWatchlistIdentitySnapshot(duplicateCanonical)).toThrow(
      /Duplicate canonical artist ID/,
    );

    const duplicateSpotify = {
      ...snapshot,
      artists: [
        snapshot.artists[0]!,
        {
          ...snapshot.artists[1]!,
          spotifyArtistId: snapshot.artists[0]!.spotifyArtistId,
        },
      ],
    };
    expect(() => validateFullWatchlistIdentitySnapshot(duplicateSpotify)).toThrow(
      /Duplicate confirmed Spotify artist ID/,
    );
  });

  it("serializes deterministically and reports explicit, distinct hash fields", async () => {
    const snapshot = await fixtureSnapshot(3);
    expect(serializeFullWatchlistIdentitySnapshot(snapshot)).toBe(
      serializeFullWatchlistIdentitySnapshot(snapshot),
    );
    const directory = await mkdtemp(join(tmpdir(), "itunes-identity-test-"));
    temporaryDirectories.push(directory);
    const result = await writeFullWatchlistIdentitySnapshot(snapshot, directory);
    const bytes = await readFile(result.outputPath, "utf8");

    expect(result).toHaveProperty("fileByteSha256");
    expect(result).toHaveProperty("canonicalContentSha256");
    expect(result.fileByteSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.canonicalContentSha256).toBe(snapshot.canonicalContentSha256);
    expect(result.fileByteSha256).not.toBe(result.canonicalContentSha256);
    expect(sha256(bytes)).toBe(result.fileByteSha256);
  });
});

describe("offline artist-search census planner", () => {
  it("uses valid search cache rows and treats invalid rows as new network work", async () => {
    const snapshot = await fixtureSnapshot(3);
    const valid = validCacheRow(snapshot.artists[0]!.displayName);
    const invalid = {
      ...validCacheRow(snapshot.artists[1]!.displayName),
      response: { malformed: true },
    };
    const manifest = createSearchCensusManifest({
      cacheRows: [valid, invalid],
      snapshot,
      snapshotFileByteSha256: "a".repeat(64),
      snapshotPath: "C:\\snapshots\\identity.json",
    });

    expect(manifest.summary.validSearchCacheHits).toBe(1);
    expect(manifest.summary.invalidCacheEntries).toBe(1);
    expect(manifest.summary.newNetworkSearches).toBe(2);
    expect(manifest.items.map((item) => item.cacheStatus)).toEqual([
      "valid_cache_hit",
      "invalid_or_unusable_cache_row",
      "new_network_search_required",
    ]);
  });

  it("never initializes HTTP and emits only artist-search work", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("HTTP must be impossible in the planner.");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const snapshot = await fixtureSnapshot(3);
    const manifest = createSearchCensusManifest({
      cacheRows: [],
      snapshot,
      snapshotFileByteSha256: "a".repeat(64),
      snapshotPath: "C:\\snapshots\\identity.json",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(manifest.configuration.endpoint).toBe("/search");
    expect(manifest.configuration.entity).toBe("musicArtist");
    expect(manifest.items.every((item) => item.requestKind === "artist_search")).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(
      /artist_albums|artist_songs|batch_albums|batch_songs|collection_songs|\/lookup/,
    );
  });

  it("assigns every artist once to deterministic shards within both 150 limits", async () => {
    const snapshot = await fixtureSnapshot(301);
    const first = createSearchCensusManifest({
      cacheRows: [],
      snapshot,
      snapshotFileByteSha256: "a".repeat(64),
      snapshotPath: "C:\\snapshots\\identity.json",
    });
    const second = createSearchCensusManifest({
      cacheRows: [],
      snapshot,
      snapshotFileByteSha256: "a".repeat(64),
      snapshotPath: "C:\\snapshots\\identity.json",
    });

    expect(serializeSearchCensusManifest(first)).toBe(serializeSearchCensusManifest(second));
    expect(first.shards.map((shard) => shard.artistCount)).toEqual([150, 150, 1]);
    expect(first.shards.map((shard) => shard.newNetworkRequestCount)).toEqual([150, 150, 1]);
    expect(first.shards.every((shard) => shard.artistCount <= 150)).toBe(true);
    expect(first.shards.every((shard) => shard.newNetworkRequestCount <= 150)).toBe(true);
    expect(new Set(first.items.map((item) => item.canonicalArtistId)).size).toBe(301);
  });

  it("preserves the completed pilot and offline-evaluation audit artifacts", async () => {
    const expected = new Map([
      [
        "docs/itunes-pilot-identity-provenance.csv",
        "21a9cda2a60b9b27639dcf9183b82b9afda9ec987dd2bad3a6deb96d8fc31525",
      ],
      [
        "docs/itunes-pilot-match-review.csv",
        "e3229c7f33de3b8b89554a8b1eef842f489f0b54926d4a827b4681404ad1c20d",
      ],
      [
        "docs/itunes-pilot-offline-evaluation.json",
        "43a2af3e19f86888546c523721eca1ac61f5031e03c0ae569b23f675e4f0d5c5",
      ],
    ]);
    for (const [path, digest] of expected) {
      expect(sha256(await readFile(resolve(path), "utf8"))).toBe(digest);
    }
  });
});

async function fixtureSnapshot(count: number): Promise<FullWatchlistIdentitySnapshot> {
  return collectFullWatchlistIdentitySnapshot(fixtureReader(count));
}

function fixtureReader(
  count: number,
  calls: string[] = [],
  modes: string[] = [],
): IdentitySnapshotReader {
  return {
    transaction: async (mode, work) => {
      modes.push(mode);
      return work({
        query: (statement) => {
          calls.push(statement);
          if (statement === fullWatchlistIdentityQueries.timestamp) {
            return Promise.resolve([{ snapshot_timestamp: new Date("2026-07-29T12:00:00.000Z") }]);
          }
          if (statement === fullWatchlistIdentityQueries.schemaVersion) {
            return Promise.resolve([{ source_schema_version: 17 }]);
          }
          if (statement === fullWatchlistIdentityQueries.artists) {
            return Promise.resolve(
              Array.from({ length: count }, (_, index) => ({
                active: true,
                aliases: index === 0 ? ["Alias One"] : [],
                canonical_artist_id: fixtureUuid(index),
                display_name: `Artist ${String(index).padStart(4, "0")}`,
                normalized_name: `artist ${String(index).padStart(4, "0")}`,
                spotify_artist_id: `spotify-${String(index).padStart(4, "0")}`,
              })),
            );
          }
          throw new Error("Unexpected fixture query.");
        },
      });
    },
  };
}

function fixtureUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function validCacheRow(term: string): SearchCacheRow {
  const response = {
    artists: [
      {
        artistId: "123",
        artistName: term,
        wrapperType: "artist",
      },
    ],
    collections: [],
    declaredResultCount: 1,
    tracks: [],
    unknownResultCount: 0,
  };
  return {
    requestIdentity: artistSearchRequestIdentity(term),
    response,
    responseHash: sha256(JSON.stringify(response)),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
