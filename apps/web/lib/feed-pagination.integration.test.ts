import type { TrackCandidate } from "@radar/core";
import { createDatabase, feedRevisions, sourceEvidence, tracks } from "@radar/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { persistCandidates } from "../../scanner/src/scan";
import { loadDatabaseFeed, loadDatabaseFeedPage, loadDatabaseFeedRevision } from "./feed-server";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const cursorSecret = "synthetic-feed-pagination-secret";

describe.sequential("database feed pagination", () => {
  const connection = createDatabase(databaseUrl);

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
    );
    await connection.db
      .update(feedRevisions)
      .set({ itemCount: 0, revision: 0, updatedAt: new Date(0) })
      .where(eq(feedRevisions.id, "global"));

    const albumTracks = Array.from({ length: 30 }, (_, index) =>
      spotifyCandidate(index, {
        releaseDate: "2026-07-20",
        releaseId: spotifyId(900),
        releaseTitle: "Large Synthetic Album",
        releaseType: "album",
        trackNumber: index + 1,
      }),
    );
    const singles = Array.from({ length: 10 }, (_, index) =>
      spotifyCandidate(index + 100, {
        releaseDate: `2026-07-${String(19 - index).padStart(2, "0")}`,
        releaseId: spotifyId(800 + index),
        releaseTitle: `Synthetic Single ${index + 1}`,
        releaseType: "single",
        trackNumber: 1,
      }),
    );
    await persistCandidates(connection.db, [...albumTracks, ...singles], {
      dryRun: false,
      full: false,
      provider: "spotify",
    });
  });

  afterAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
    );
    await connection.client.end();
  });

  it("keeps a release group intact and advances without duplicates", async () => {
    const first = await loadDatabaseFeedPage(databaseUrl, {
      limit: 25,
      secret: cursorSecret,
    });
    expect(first.items).toHaveLength(30);
    expect(new Set(first.items.map((item) => item.releaseId)).size).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.totalCount).toBe(40);
    expect(first.items.map((item) => item.trackNumber)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );

    const repeated = await loadDatabaseFeedPage(databaseUrl, {
      limit: 25,
      secret: cursorSecret,
    });
    expect(repeated.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));

    const second = await loadDatabaseFeedPage(databaseUrl, {
      cursor: first.nextCursor!,
      limit: 25,
      secret: cursorSecret,
    });
    expect(second.items).toHaveLength(10);
    expect(second.hasMore).toBe(false);
    expect(second.totalCount).toBe(40);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(40);

    const compatibilityProjection = await loadDatabaseFeed(databaseUrl);
    expect(compatibilityProjection).toEqual([...first.items, ...second.items]);
  });

  it("rejects tampered and query-mismatched cursors", async () => {
    const first = await loadDatabaseFeedPage(databaseUrl, { limit: 25, secret: cursorSecret });
    await expect(
      loadDatabaseFeedPage(databaseUrl, {
        cursor: `${first.nextCursor!}x`,
        limit: 25,
        secret: cursorSecret,
      }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      loadDatabaseFeedPage(databaseUrl, {
        cursor: first.nextCursor!,
        filters: { search: "different query" },
        limit: 25,
        secret: cursorSecret,
      }),
    ).rejects.toThrow(/current query/i);
  });

  it("applies search and provider filters before pagination", async () => {
    const page = await loadDatabaseFeedPage(databaseUrl, {
      filters: {
        provider: "spotify",
        releaseType: "single",
        search: "synthetic single",
        sort: "first-seen",
        spotify: "available",
      },
      limit: 25,
      secret: cursorSecret,
    });
    expect(page.items).toHaveLength(10);
    expect(page.totalCount).toBe(10);
    expect(page.hasMore).toBe(false);
    expect(page.items.every((item) => item.releaseType === "single")).toBe(true);
  });

  it("increments the durable revision when projected track data changes", async () => {
    const before = await loadDatabaseFeedRevision(databaseUrl);
    const [track] = await connection.db.select({ id: tracks.id }).from(tracks).limit(1);
    await connection.db
      .update(tracks)
      .set({ title: "Updated Synthetic Title", updatedAt: new Date() })
      .where(eq(tracks.id, track!.id));
    const after = await loadDatabaseFeedRevision(databaseUrl);
    expect(after.count).toBe(40);
    expect(after.revision).not.toBe(before.revision);
  });

  it("keeps an in-progress cursor stable when a newer item is inserted", async () => {
    const baseline = await loadDatabaseFeedPage(databaseUrl, {
      limit: 200,
      secret: cursorSecret,
    });
    const first = await loadDatabaseFeedPage(databaseUrl, {
      limit: 25,
      secret: cursorSecret,
    });
    await persistCandidates(
      connection.db,
      [
        spotifyCandidate(500, {
          releaseDate: "2026-07-21",
          releaseId: spotifyId(950),
          releaseTitle: "Inserted After First Page",
          releaseType: "single",
          trackNumber: 1,
        }),
      ],
      { dryRun: false, full: false, provider: "spotify" },
    );
    const second = await loadDatabaseFeedPage(databaseUrl, {
      cursor: first.nextCursor!,
      limit: 25,
      secret: cursorSecret,
    });
    const traversedIds = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(traversedIds).size).toBe(baseline.items.length);
    expect(new Set(traversedIds)).toEqual(new Set(baseline.items.map((item) => item.id)));
    expect(
      [...first.items, ...second.items].some(
        (item) => item.releaseTitle === "Inserted After First Page",
      ),
    ).toBe(false);

    const refreshed = await loadDatabaseFeedPage(databaseUrl, {
      limit: 25,
      secret: cursorSecret,
    });
    expect(refreshed.items.some((item) => item.releaseTitle === "Inserted After First Page")).toBe(
      true,
    );
  });

  it("omits an unsafe stored provider evidence URL from rendered links", async () => {
    const [evidence] = await connection.db
      .select({ id: sourceEvidence.id })
      .from(sourceEvidence)
      .limit(1);
    await connection.db
      .update(sourceEvidence)
      .set({ sourceUrl: "https://open.spotify.com.evil.example/track/0123456789ABCDEFGHIJKL" })
      .where(eq(sourceEvidence.id, evidence!.id));
    const page = await loadDatabaseFeedPage(databaseUrl, { limit: 200, secret: cursorSecret });
    expect(page.items.some((item) => item.links.length === 0)).toBe(true);
    expect(JSON.stringify(page.items)).not.toContain("evil.example");
  });
});

function spotifyCandidate(
  index: number,
  release: {
    releaseDate: string;
    releaseId: string;
    releaseTitle: string;
    releaseType: "album" | "single";
    trackNumber: number;
  },
): TrackCandidate {
  const trackId = spotifyId(index + 1);
  return {
    artistExternalId: spotifyId(999),
    artistName: "Pagination Artist",
    availability: "playable",
    credits: [{ name: "Pagination Artist", role: "primary" }],
    durationMs: 180_000 + index,
    evidenceType: "spotify_track",
    evidenceUrl: `https://open.spotify.com/track/${trackId}`,
    externalReleaseId: release.releaseId,
    externalTrackId: trackId,
    firstSeenAt: `2026-07-21T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
    payloadHash: `pagination-${index}`,
    provider: "spotify",
    providerUrl: `https://open.spotify.com/track/${trackId}`,
    region: "US",
    releaseDate: release.releaseDate,
    releaseDatePrecision: "day",
    releaseTitle: release.releaseTitle,
    releaseType: release.releaseType,
    sourceLabel: "Spotify synthetic pagination fixture",
    title: `Synthetic Track ${index + 1}`,
    trackNumber: release.trackNumber,
  };
}

function spotifyId(value: number): string {
  return String(value).padStart(22, "0");
}
