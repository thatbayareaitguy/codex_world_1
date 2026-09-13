import { randomUUID } from "node:crypto";
import {
  artistExternalIds,
  artistFollows,
  artistMappingReviews,
  artistProviderIdentityStatuses,
  artists,
  createDatabase,
  users,
} from "@radar/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyAppleIdentityPreview,
  previewAppleIdentityCsv,
  type AppleIdentityCsvRow,
  type AppleIdentityVerifier,
} from "./apple-music-identity-workflow";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("Apple identity CSV preview and apply", () => {
  const connection = createDatabase(databaseUrl);
  const userId = randomUUID();
  const artistIds = Array.from({ length: 5 }, () => randomUUID());

  beforeAll(async () => {
    await connection.db.execute(sql`truncate table users, artists restart identity cascade`);
    await connection.db.insert(users).values({
      displayName: "CSV Test User",
      email: "csv-test@example.test",
      id: userId,
    });
    await connection.db.insert(artists).values(
      artistIds.map((id, index) => ({
        id,
        name: `CSV Artist ${index + 1}`,
        normalizedName: `csv artist ${index + 1}`,
      })),
    );
    await connection.db
      .insert(artistFollows)
      .values(artistIds.map((artistId) => ({ artistId, source: "test", userId })));
    await connection.db.insert(artistProviderIdentityStatuses).values([
      ...artistIds.slice(0, 4).map((artistId) => ({
        artistId,
        provider: "apple_music" as const,
        reason: "Needs review",
        status: "requires_manual_decision" as const,
      })),
      {
        artistId: artistIds[4]!,
        externalId: "9000",
        externalIds: ["9000"],
        provider: "apple_music" as const,
        reason: "Already confirmed",
        status: "manually_confirmed" as const,
      },
    ]);
    await connection.db.insert(artistMappingReviews).values(
      artistIds.slice(0, 4).map((artistId, index) => ({
        artistId,
        matchReasons: ["Candidate"],
        matchScore: "0.500",
        proposedExternalId: String(5000 + index),
        provider: "apple_music" as const,
        providerName: `Candidate ${index + 1}`,
      })),
    );
    await connection.db.insert(artistExternalIds).values({
      artistId: artistIds[4]!,
      confirmed: true,
      externalId: "9000",
      mappingSource: "test",
      provider: "apple_music",
    });
  });

  afterAll(async () => {
    await connection.db.execute(sql`truncate table users, artists restart identity cascade`);
    await connection.client.end();
  });

  it("reports every blocking category without partially applying the CSV", async () => {
    const preview = await previewAppleIdentityCsv(
      connection.db,
      [
        row(artistIds[0]!, "CSV Artist 1", "confirm", "100"),
        row(artistIds[1]!, "CSV Artist 2", "confirm", "100"),
        row(artistIds[2]!, "CSV Artist 3", "confirm", "9000"),
        row(artistIds[3]!, "CSV Artist 4", "confirm", "javascript:alert(1)"),
      ],
      verifier({ "100": "Different Apple Name", "9000": "CSV Artist 5" }),
    );
    expect(preview.duplicateAssignments).toHaveLength(1);
    expect(preview.existingConflicts).toHaveLength(1);
    expect(preview.invalidInputs).toHaveLength(1);
    expect(preview.nameDisagreements).toHaveLength(3);
    await expect(applyAppleIdentityPreview(connection.db, preview)).rejects.toThrow(
      "blocking validation errors",
    );
  });

  it("applies all valid outcomes together and becomes idempotent", async () => {
    const rows = [
      row(artistIds[0]!, "CSV Artist 1", "confirm", "101"),
      row(artistIds[1]!, "CSV Artist 2", "split_profile", "201;202"),
      row(artistIds[2]!, "CSV Artist 3", "unavailable", ""),
      row(artistIds[3]!, "CSV Artist 4", "defer", ""),
    ];
    const artistVerifier = verifier({
      "101": "CSV Artist 1",
      "201": "CSV Artist 2",
      "202": "CSV Artist 2",
    });
    const preview = await previewAppleIdentityCsv(connection.db, rows, artistVerifier);
    expect(preview.invalidInputs).toEqual([]);
    expect(await applyAppleIdentityPreview(connection.db, preview)).toEqual({
      applied: 4,
      unchanged: 0,
    });
    const repeated = await previewAppleIdentityCsv(connection.db, rows, artistVerifier);
    expect(repeated.unchanged).toBe(4);
    expect(await applyAppleIdentityPreview(connection.db, repeated)).toEqual({
      applied: 0,
      unchanged: 4,
    });
  });
});

function row(
  artistId: string,
  displayName: string,
  decision: string,
  appleValue: string,
): AppleIdentityCsvRow {
  return {
    apple_music_url_or_id: appleValue,
    canonical_artist_id: artistId,
    canonical_display_name: displayName,
    current_apple_candidate_count: "1",
    current_resolution_status: "requires_manual_decision",
    decision,
    existing_apple_candidate_urls: "",
    musicbrainz_id: "",
    user_note: "",
  };
}

function verifier(names: Record<string, string>): AppleIdentityVerifier {
  return {
    verify: (ids) =>
      Promise.resolve({
        artists: ids
          .filter((id) => names[id])
          .map((id) => ({
            artistId: id,
            evidenceUrl: `https://music.apple.com/us/artist/${id}`,
            genreNames: [],
            name: names[id]!,
            sourceStorefront: "us",
          })),
        missingIds: ids.filter((id) => !names[id]),
      }),
  };
}
