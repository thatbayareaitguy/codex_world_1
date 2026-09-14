import type { TrackCandidate } from "@radar/core";
import { createDatabase, feedItems, matureReleasedFeedItems, releaseCandidates } from "@radar/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistCandidates } from "./scan";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("released feed-item maturity", () => {
  const connection = createDatabase(databaseUrl);

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, tracks, scan_runs restart identity cascade`,
    );
    await persistCandidates(
      connection.db,
      [
        candidate("past-date", "Past Date", "2026-08-27", "unavailable"),
        candidate("future-preview", "Future Preview", "2026-09-25", "playable"),
        candidate("future-unreleased", "Future Unreleased", "2026-09-25", "unavailable"),
        candidate("saved-past", "Saved Past", "2026-08-27", "unavailable"),
      ],
      { dryRun: false, full: false, provider: "spotify" },
    );
    const [savedCandidate] = await connection.db
      .select({ id: releaseCandidates.id })
      .from(releaseCandidates)
      .where(eq(releaseCandidates.title, "Saved Past"));
    expect(savedCandidate).toBeDefined();
    await connection.db
      .update(feedItems)
      .set({ savedAt: new Date("2026-08-27T12:00:00.000Z"), state: "saved" })
      .where(eq(feedItems.candidateId, savedCandidate!.id));
  });

  afterAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, tracks, scan_runs restart identity cascade`,
    );
    await connection.client.end();
  });

  it("matures past dates and playable previews without changing future or user states", async () => {
    const first = await matureReleasedFeedItems(
      connection.db,
      new Date("2026-08-28T12:00:00.000Z"),
    );
    expect(first.productionDate).toBe("2026-08-28");
    expect(first.maturedItemIds).toHaveLength(2);

    const states = await connection.db
      .select({ state: feedItems.state, title: releaseCandidates.title })
      .from(feedItems)
      .innerJoin(releaseCandidates, eq(releaseCandidates.id, feedItems.candidateId));
    expect(Object.fromEntries(states.map((row) => [row.title, row.state]))).toEqual({
      "Future Preview": "new",
      "Future Unreleased": "upcoming",
      "Past Date": "new",
      "Saved Past": "saved",
    });

    const second = await matureReleasedFeedItems(
      connection.db,
      new Date("2026-08-28T12:01:00.000Z"),
    );
    expect(second.maturedItemIds).toHaveLength(0);
  });
});

function candidate(
  key: string,
  title: string,
  releaseDate: string,
  availability: "playable" | "unavailable",
): TrackCandidate {
  return {
    artistExternalId: "spotify-feed-maturity-artist",
    artistName: "Feed Maturity Artist",
    availability,
    credits: [{ name: "Feed Maturity Artist", role: "primary" }],
    durationMs: 180_000,
    evidenceType: "spotify_track",
    evidenceUrl: `https://open.spotify.com/track/${key}`,
    externalReleaseId: `feed-maturity-release-${key}`,
    externalTrackId: `feed-maturity-track-${key}`,
    firstSeenAt: "2026-08-21T12:00:00.000Z",
    isUpcoming: true,
    payloadHash: `feed-maturity-${key}`,
    provider: "spotify",
    providerUrl: `https://open.spotify.com/track/${key}`,
    region: "US",
    releaseDate,
    releaseDatePrecision: "day",
    releaseTitle: `${title} Release`,
    releaseType: "single",
    sourceLabel: "Spotify test",
    title,
  };
}
