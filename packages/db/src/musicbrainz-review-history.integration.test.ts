import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./client";
import { listMusicBrainzMappingReviewsPage } from "./musicbrainz-review-history";
import { artistFollows, artistMappingReviews, artists, users } from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("MusicBrainz mapping review pagination", () => {
  const connection = createDatabase(databaseUrl);
  let artistId = "";
  const userId = randomUUID();

  beforeAll(async () => {
    await connection.db.execute(sql`truncate table users, artists restart identity cascade`);
    await connection.db.insert(users).values({
      displayName: "Review Test User",
      email: "review-test@example.test",
      id: userId,
    });
    const [artist] = await connection.db
      .insert(artists)
      .values({ name: "Synthetic Review Artist", normalizedName: "synthetic review artist" })
      .returning({ id: artists.id });
    artistId = artist!.id;
    await connection.db.insert(artistFollows).values({ artistId, source: "test", userId });
    await connection.db.insert(artistMappingReviews).values(
      Array.from({ length: 23 }, (_, index) => ({
        artistId,
        matchReasons: [`Synthetic candidate ${index}`],
        matchScore: "0.500",
        proposedExternalId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        provider: "musicbrainz" as const,
        providerName: `Candidate ${index}`,
        status: index === 0 ? "confirmed" : "pending",
        updatedAt: new Date(Date.UTC(2026, 6, 21, 12, index)),
      })),
    );
  });

  afterAll(async () => {
    await connection.db.execute(sql`truncate table users, artists restart identity cascade`);
    await connection.client.end();
  });

  it("pages pending reviews without duplicates and excludes resolved rows", async () => {
    const first = await listMusicBrainzMappingReviewsPage(connection.db, { limit: 10 });
    const second = await listMusicBrainzMappingReviewsPage(connection.db, {
      cursor: first.nextCursor!,
      limit: 10,
    });
    const third = await listMusicBrainzMappingReviewsPage(connection.db, {
      cursor: second.nextCursor!,
      limit: 10,
    });
    const reviews = [...first.reviews, ...second.reviews, ...third.reviews];
    expect(reviews).toHaveLength(22);
    expect(new Set(reviews.map((review) => review.id)).size).toBe(22);
    expect(reviews.every((review) => review.status === "pending")).toBe(true);
    expect(third.hasMore).toBe(false);
  });

  it("returns resolved rows only for an explicit artist and rejects malformed cursors", async () => {
    const artistPage = await listMusicBrainzMappingReviewsPage(connection.db, {
      artistId,
      limit: 50,
    });
    expect(artistPage.reviews).toHaveLength(23);
    expect(artistPage.reviews.some((review) => review.status === "confirmed")).toBe(true);
    await expect(
      listMusicBrainzMappingReviewsPage(connection.db, { cursor: "not-a-cursor", limit: 10 }),
    ).rejects.toThrow(/cursor/i);
  });
});
