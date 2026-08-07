import { randomUUID } from "node:crypto";
import type { AppleIdentityCandidateCatalog, AppleIdentityCandidateRanking } from "@radar/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  persistAppleIdentityCandidateCatalog,
  persistAppleIdentityCandidateRankings,
} from "./apple-identity-ranking";
import { createDatabase } from "./client";
import {
  decideArtistProviderIdentityStatus,
  listArtistMappingReviewArtistsPage,
} from "./provider-mappings";
import { artistMappingReviews, artistProviderIdentityStatuses, artists, users } from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("persisted Apple identity ranking evidence", () => {
  const connection = createDatabase(databaseUrl);
  const artistId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    await connection.db.execute(sql`truncate table users, artists restart identity cascade`);
    await connection.db.insert(users).values({
      displayName: "Ranking Test User",
      email: "ranking-test@example.test",
      id: userId,
    });
    await connection.db.insert(artists).values({
      id: artistId,
      name: "Ranked Candidate Artist",
      normalizedName: "ranked candidate artist",
    });
    await connection.db.insert(artistProviderIdentityStatuses).values({
      artistId,
      provider: "apple_music",
      reason: "Needs review",
      status: "requires_manual_decision",
    });
    await connection.db
      .insert(artistMappingReviews)
      .values([review("7001", "First Candidate"), review("7002", "Second Candidate")]);
  });

  afterAll(async () => {
    await connection.db.execute(sql`truncate table users, artists restart identity cascade`);
    await connection.client.end();
  });

  it("survives restart, enriches review cards, and persists a validated split decision", async () => {
    await persistAppleIdentityCandidateCatalog(connection.db, {
      catalog: catalog("7001", "First Candidate"),
      requestIdentity: "apple_identity:test:7001",
    });
    await persistAppleIdentityCandidateCatalog(connection.db, {
      catalog: catalog("7002", "Second Candidate"),
      requestIdentity: "apple_identity:test:7002",
    });
    await persistAppleIdentityCandidateRankings(connection.db, artistId, [
      ranking("7002", 1, 0.61),
      ranking("7001", 2, 0.44),
    ]);

    const restarted = createDatabase(databaseUrl);
    try {
      const page = await listArtistMappingReviewArtistsPage(restarted.db, {
        limit: 5,
        provider: "apple_music",
      });
      expect(page.reviews.map((row) => row.proposedExternalId)).toEqual(["7002", "7001"]);
      expect(page.reviews[0]?.candidateEvidence).toMatchObject({
        appleArtistName: "Second Candidate",
        genres: ["Electronic"],
        labels: ["Example Label"],
        rank: 1,
        resourceStatus: "valid",
        score: "0.610",
      });

      await expect(
        decideArtistProviderIdentityStatus(restarted.db, {
          artistId,
          externalIds: ["7001", "7999"],
          provider: "apple_music",
          status: "split_profile",
        }),
      ).rejects.toThrow("validated Apple candidates");

      await decideArtistProviderIdentityStatus(restarted.db, {
        artistId,
        externalIds: ["7001", "7002"],
        provider: "apple_music",
        status: "split_profile",
      });
      const [status] = await restarted.db
        .select()
        .from(artistProviderIdentityStatuses)
        .where(eq(artistProviderIdentityStatuses.artistId, artistId));
      expect(status?.status).toBe("split_profile");
      expect(status?.externalIds.sort()).toEqual(["7001", "7002"]);
      const pending = await restarted.db
        .select()
        .from(artistMappingReviews)
        .where(eq(artistMappingReviews.status, "pending"));
      expect(pending).toEqual([]);
    } finally {
      await restarted.client.end();
    }
  });

  function review(externalId: string, providerName: string) {
    return {
      artistId,
      matchReasons: ["Historical candidate inventory"],
      matchScore: "0.500",
      proposedExternalId: externalId,
      provider: "apple_music" as const,
      providerName,
    };
  }
});

function catalog(appleArtistId: string, artistName: string): AppleIdentityCandidateCatalog {
  return {
    appleArtistId,
    artistName,
    artistUrl: `https://music.apple.com/us/artist/${appleArtistId}`,
    artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/Music221/example/300x300bb.jpg",
    genres: ["Electronic"],
    labels: ["Example Label"],
    releases: [
      {
        appleReleaseId: `${appleArtistId}01`,
        artistIds: [appleArtistId],
        artistName,
        label: "Example Label",
        releaseDate: "2026-07-01",
        title: "Distinct Release",
      },
    ],
    resourceStatus: "valid",
    songs: [],
    source: "apple_music_api",
  };
}

function ranking(
  appleArtistId: string,
  rank: number,
  score: number,
): AppleIdentityCandidateRanking {
  return {
    appleArtistId,
    autoConfirmEligible: false,
    contradictions: [],
    eliminationSafe: false,
    rank,
    reasons: ["Apple-only advisory ranking."],
    score,
    signals: {
      activityScore: 0.1,
      catalogScore: 0.1,
      confirmedCollaboratorCount: 0,
      genreScore: 0.1,
      independentExactLink: false,
      titleOverlapScore: 0,
    },
    titleOverlaps: [],
  };
}
