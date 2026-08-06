import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyVerifiedAppleIdentityDecisions,
  listAppleIdentityResolutionBatch,
  verifyAppleIdentityResolutionState,
} from "./apple-music-identities";
import { createDatabase } from "./client";
import {
  artistExternalIds,
  artistFollows,
  artistMappingReviews,
  artistProviderIdentityStatuses,
  artists,
  users,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("bulk Apple Music identity decisions", () => {
  const connection = createDatabase(databaseUrl);
  const userId = randomUUID();
  const artistIds = Array.from({ length: 6 }, () => randomUUID());

  beforeAll(async () => {
    await connection.db.execute(sql`truncate table users, artists restart identity cascade`);
    await connection.db.insert(users).values({
      displayName: "Identity Test User",
      email: "identity-test@example.test",
      id: userId,
    });
    await connection.db.insert(artists).values(
      artistIds.map((id, index) => ({
        id,
        name: `Identity Artist ${index + 1}`,
        normalizedName: `identity artist ${index + 1}`,
      })),
    );
    await connection.db
      .insert(artistFollows)
      .values(artistIds.map((artistId) => ({ artistId, source: "test", userId })));
    await connection.db.insert(artistProviderIdentityStatuses).values(
      artistIds.map((artistId) => ({
        artistId,
        provider: "apple_music" as const,
        reason: "Needs review",
        status: "requires_manual_decision" as const,
      })),
    );
    await connection.db.insert(artistMappingReviews).values(
      artistIds.map((artistId, index) => ({
        artistId,
        matchReasons: ["Candidate"],
        matchScore: "0.500",
        proposedExternalId: String(1000 + index),
        provider: "apple_music" as const,
        providerName: `Candidate ${index + 1}`,
      })),
    );
    await connection.db.insert(artistExternalIds).values({
      artistId: artistIds[0]!,
      confirmed: true,
      externalId: randomUUID(),
      mappingSource: "test_musicbrainz",
      provider: "musicbrainz",
    });
  });

  afterAll(async () => {
    await connection.db.execute(sql`truncate table users, artists restart identity cascade`);
    await connection.client.end();
  });

  it("prioritizes confirmed MusicBrainz evidence without exporting provider-crossed data", async () => {
    const rows = await listAppleIdentityResolutionBatch(connection.db, 3);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.artistId).toBe(artistIds[0]);
    expect(rows[0]?.musicBrainzId).toBeTruthy();
    expect(JSON.stringify(rows).toLowerCase()).not.toContain("spotify");
  });

  it("rolls back the complete batch when one Apple ID conflicts", async () => {
    const shared = "9000";
    await expect(
      applyVerifiedAppleIdentityDecisions(connection.db, [
        decision(artistIds[0]!, "confirm", [shared]),
        decision(artistIds[1]!, "confirm", [shared]),
      ]),
    ).rejects.toThrow("already mapped");
    const mappings = await connection.db
      .select()
      .from(artistExternalIds)
      .where(eq(artistExternalIds.provider, "apple_music"));
    expect(mappings).toHaveLength(0);
  });

  it("persists mapping, split, unavailable, and deferred decisions across a restart", async () => {
    const result = await applyVerifiedAppleIdentityDecisions(connection.db, [
      decision(artistIds[0]!, "confirm", ["9100"]),
      decision(artistIds[1]!, "split_profile", ["9200", "9201"]),
      decision(artistIds[2]!, "unavailable", []),
      decision(artistIds[3]!, "defer", []),
    ]);
    expect(result).toEqual({ applied: 4, unchanged: 0 });
    const restarted = createDatabase(databaseUrl);
    try {
      const verification = await verifyAppleIdentityResolutionState(restarted.db);
      expect(verification.issues).toEqual([]);
      expect(verification.confirmedMappings).toBe(1);
      expect(verification.unresolvedArtists).toBe(2);
      const statuses = await restarted.db
        .select()
        .from(artistProviderIdentityStatuses)
        .where(eq(artistProviderIdentityStatuses.provider, "apple_music"));
      expect(statuses.find((row) => row.artistId === artistIds[1])?.externalIds).toEqual([
        "9200",
        "9201",
      ]);
      expect(statuses.find((row) => row.artistId === artistIds[3])?.status).toBe(
        "intentionally_deferred",
      );
    } finally {
      await restarted.client.end();
    }
  });
});

function decision(
  artistId: string,
  decisionValue: "confirm" | "defer" | "split_profile" | "unavailable",
  ids: string[],
) {
  return {
    appleArtists: ids.map((id) => ({
      id,
      name: `Apple Artist ${id}`,
      url: `https://music.apple.com/us/artist/${id}`,
    })),
    artistId,
    decision: decisionValue,
    suppliedValue: ids.join(";"),
  };
}
