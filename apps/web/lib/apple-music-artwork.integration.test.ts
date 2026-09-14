import type { TrackCandidate } from "@radar/core";
import { createDatabase, feedItems, releaseExternalIds, sourceEvidence } from "@radar/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { persistCandidates } from "../../scanner/src/scan";
import { loadDatabaseFeedSnapshot } from "./feed-server";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("Apple Music release artwork persistence", () => {
  const connection = createDatabase(databaseUrl);

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
    );
  });

  afterAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
    );
    await connection.client.end();
  });

  it("persists namespaced Apple artwork and exposes it on every release track", async () => {
    await persistCandidates(
      connection.db,
      [appleCandidate("501", "First Track"), appleCandidate("502", "Second Track")],
      { dryRun: false, full: false, provider: "apple_music" },
    );
    const externalIds = (await connection.db.select().from(releaseExternalIds)).filter(
      (row) => row.externalId === "401" && row.provider === "apple_music",
    );
    expect(externalIds).toHaveLength(1);
    expect(externalIds[0]?.providerFields).toMatchObject({
      apple_music: {
        albumId: "401",
        image: { height: 600, width: 600 },
        sourceProvider: "apple_music",
      },
    });
    const items = (await loadDatabaseFeedSnapshot(databaseUrl)).items.filter(
      (item) => item.releaseTitle === "Apple Artwork Album",
    );
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.appleMusicArtwork?.albumId === "401")).toBe(true);
  });

  it("updates artwork on an idempotent observation without duplicate rows", async () => {
    const beforeFeed = (await connection.db.select().from(feedItems)).length;
    const beforeEvidence = (await connection.db.select().from(sourceEvidence)).length;
    const changed = appleCandidate("501", "First Track");
    changed.appleMusicRelease = {
      ...changed.appleMusicRelease!,
      image: {
        height: 1200,
        url: "https://is2-ssl.mzstatic.com/image/thumb/updated/1200x1200bb.jpg",
        width: 1200,
      },
      lastObservedAt: "2026-08-04T13:00:00.000Z",
    };
    expect(
      await persistCandidates(connection.db, [changed], {
        dryRun: false,
        full: false,
        provider: "apple_music",
      }),
    ).toMatchObject({ inserted: 0, skipped: 1 });
    expect((await connection.db.select().from(feedItems)).length).toBe(beforeFeed);
    expect((await connection.db.select().from(sourceEvidence)).length).toBe(beforeEvidence);
    expect(
      (await loadDatabaseFeedSnapshot(databaseUrl)).items
        .filter((item) => item.releaseTitle === "Apple Artwork Album")
        .every((item) => item.appleMusicArtwork?.image.width === 1200),
    ).toBe(true);
  });
});

function appleCandidate(externalTrackId: string, title: string): TrackCandidate {
  return {
    appleMusicRelease: {
      albumId: "401",
      albumUrl: "https://music.apple.com/us/album/401",
      image: {
        height: 600,
        url: "https://is1-ssl.mzstatic.com/image/thumb/original/600x600bb.jpg",
        width: 600,
      },
      lastObservedAt: "2026-08-04T12:00:00.000Z",
      sourceProvider: "apple_music",
    },
    artistExternalId: "101",
    artistName: "Apple Artwork Artist",
    availability: "unavailable",
    credits: [{ name: "Apple Artwork Artist", role: "primary" }],
    durationMs: 180_000,
    evidenceType: "apple_music_catalog_full-albums",
    evidenceUrl: "https://music.apple.com/us/album/401",
    externalReleaseId: "401",
    externalTrackId,
    firstSeenAt: "2026-08-04T12:00:00.000Z",
    payloadHash: `apple-artwork-${externalTrackId}`,
    provider: "apple_music",
    providerUrl: "https://music.apple.com/us/album/401",
    region: "US",
    releaseDate: "2026-08-02",
    releaseDatePrecision: "day",
    releaseTitle: "Apple Artwork Album",
    releaseType: "album",
    sourceLabel: "Apple Music Catalog",
    title,
  };
}
