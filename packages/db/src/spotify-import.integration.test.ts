import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type RadarDatabase } from "./client";
import {
  confirmSpotifyImport,
  createSpotifyImportRun,
  deactivateFollowedArtist,
  listFollowedArtists,
} from "./repositories";
import {
  artistExternalIds,
  artistFollows,
  artistImportCandidates,
  artistImportRuns,
  artists,
  spotifySchedulerWork,
  users,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

let connection: ReturnType<typeof createDatabase>;
let db: RadarDatabase;

async function createTestUser(label: string): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ displayName: label, email: `${label}-${randomUUID()}@example.test` })
    .returning({ id: users.id });
  if (!user) throw new Error("Failed to create test user");
  return user.id;
}

async function decisionsForRun(importRunId: string) {
  const candidates = await db.query.artistImportCandidates.findMany({
    where: eq(artistImportCandidates.importRunId, importRunId),
  });
  return candidates.map((candidate) => ({
    candidateId: candidate.id,
    decision: candidate.proposedAction === "merge" ? ("merge" as const) : ("create" as const),
    ...(candidate.existingArtistId ? { existingArtistId: candidate.existingArtistId } : {}),
    selected: true,
  }));
}

beforeAll(() => {
  connection = createDatabase(databaseUrl);
  db = connection.db;
});

afterAll(async () => {
  await connection.client.end();
});

describe("Spotify followed-artist persistence", () => {
  it("durably removes a followed artist and blocks its queued Spotify work", async () => {
    const userId = await createTestUser("remove-follow-owner");
    const [artist] = await db
      .insert(artists)
      .values({ name: "Removed Artist", normalizedName: "removed artist", sortName: null })
      .returning({ id: artists.id });
    if (!artist) throw new Error("Failed to create removable artist fixture");
    await db
      .insert(artistFollows)
      .values({ artistId: artist.id, source: "spotify_import", userId });
    await db.insert(spotifySchedulerWork).values({
      artistId: artist.id,
      dueAt: new Date(),
      expectedSpotifyArtistId: "spotify-removed-artist",
      source: "recurring",
      workKey: `base_artist:${artist.id}`,
      workType: "base_artist",
    });

    const first = await deactivateFollowedArtist(db, userId, artist.id);
    expect(first).toEqual({
      alreadyInactive: false,
      artistId: artist.id,
      blockedSpotifyWork: 1,
    });
    expect(await listFollowedArtists(db, userId)).toEqual([]);
    expect(
      await db.query.artistFollows.findFirst({
        where: and(eq(artistFollows.userId, userId), eq(artistFollows.artistId, artist.id)),
      }),
    ).toMatchObject({ active: false });
    expect(await db.query.artists.findFirst({ where: eq(artists.id, artist.id) })).toMatchObject({
      name: "Removed Artist",
    });
    expect(
      await db.query.spotifySchedulerWork.findFirst({
        where: eq(spotifySchedulerWork.artistId, artist.id),
      }),
    ).toMatchObject({ blockedReason: "artist_not_followed", status: "blocked" });

    await expect(deactivateFollowedArtist(db, userId, artist.id)).resolves.toEqual({
      alreadyInactive: true,
      artistId: artist.id,
      blockedSpotifyWork: 0,
    });
  });

  it("persists, lists, reloads, and idempotently reimports canonical watchlist artists", async () => {
    const userId = await createTestUser("spotify-import-owner");
    const [manualArtist] = await db
      .insert(artists)
      .values({ name: "Manual Artist", normalizedName: "manual artist", sortName: null })
      .returning({ id: artists.id });
    if (!manualArtist) throw new Error("Failed to create manual artist fixture");
    await db.insert(artistFollows).values({ artistId: manualArtist.id, source: "manual", userId });

    const preview = [
      {
        existingArtistId: manualArtist.id,
        proposedAction: "merge" as const,
        providerArtistId: "spotify-manual-artist",
        providerName: "Manual Artist from Spotify",
        providerUrl: "https://open.spotify.com/artist/spotify-manual-artist",
        selected: true,
      },
      {
        proposedAction: "create" as const,
        providerArtistId: "spotify-imported-artist",
        providerName: "Imported Artist",
        providerUrl: "https://open.spotify.com/artist/spotify-imported-artist",
        selected: true,
      },
    ];
    const importRunId = await createSpotifyImportRun(db, userId, preview);
    const summary = await confirmSpotifyImport(
      db,
      userId,
      importRunId,
      await decisionsForRun(importRunId),
    );

    expect(summary).toEqual({
      alreadyPresent: 0,
      created: 1,
      failed: 0,
      merged: 1,
      needsReview: 0,
      persisted: 2,
      retrieved: 2,
      selected: 2,
      skipped: 0,
    });

    const followed = await listFollowedArtists(db, userId);
    expect(followed).toHaveLength(2);
    expect(followed.map((artist) => artist.name).sort()).toEqual([
      "Imported Artist",
      "Manual Artist",
    ]);
    expect(followed.every((artist) => artist.active)).toBe(true);
    expect(followed.every((artist) => artist.providers.includes("spotify"))).toBe(true);

    const [manualFollow] = await db
      .select({ source: artistFollows.source })
      .from(artistFollows)
      .where(and(eq(artistFollows.userId, userId), eq(artistFollows.artistId, manualArtist.id)));
    expect(manualFollow?.source).toBe("manual");

    const mappings = await db
      .select()
      .from(artistExternalIds)
      .where(eq(artistExternalIds.provider, "spotify"));
    const userArtistIds = new Set(followed.map((artist) => artist.artistId));
    expect(mappings.filter((mapping) => userArtistIds.has(mapping.artistId))).toHaveLength(2);
    expect(
      mappings
        .filter((mapping) => userArtistIds.has(mapping.artistId))
        .every(
          (mapping) =>
            mapping.mappingSource === "spotify_follow_import" && mapping.importedAt !== null,
        ),
    ).toBe(true);

    const recordedDecisions = await db
      .select({ decision: artistImportCandidates.decision })
      .from(artistImportCandidates)
      .where(eq(artistImportCandidates.importRunId, importRunId));
    expect(recordedDecisions.map((row) => row.decision).sort()).toEqual(["create", "merge"]);

    const importedArtist = followed.find((artist) => artist.name === "Imported Artist");
    if (!importedArtist) throw new Error("Imported artist was not listed");
    const reimportRunId = await createSpotifyImportRun(db, userId, [
      { ...preview[0]!, existingArtistId: manualArtist.id, proposedAction: "merge" },
      {
        ...preview[1]!,
        existingArtistId: importedArtist.artistId,
        proposedAction: "merge",
      },
    ]);
    const reimportSummary = await confirmSpotifyImport(
      db,
      userId,
      reimportRunId,
      await decisionsForRun(reimportRunId),
    );
    expect(reimportSummary).toMatchObject({
      alreadyPresent: 2,
      created: 0,
      merged: 0,
      persisted: 2,
      selected: 2,
    });
    expect(await listFollowedArtists(db, userId)).toHaveLength(2);

    const restartedConnection = createDatabase(databaseUrl);
    try {
      const afterRestart = await listFollowedArtists(restartedConnection.db, userId);
      expect(afterRestart).toHaveLength(2);
      expect(afterRestart.some((artist) => artist.name === "Imported Artist")).toBe(true);
    } finally {
      await restartedConnection.client.end();
    }
  });

  it("rejects a zero-selection confirmation without reporting success", async () => {
    const userId = await createTestUser("zero-selection-owner");
    const importRunId = await createSpotifyImportRun(db, userId, [
      {
        proposedAction: "create",
        providerArtistId: "spotify-zero-selection",
        providerName: "Not Selected",
        providerUrl: "https://open.spotify.com/artist/spotify-zero-selection",
        selected: true,
      },
    ]);
    const [candidate] = await db
      .select({ id: artistImportCandidates.id })
      .from(artistImportCandidates)
      .where(eq(artistImportCandidates.importRunId, importRunId));
    if (!candidate) throw new Error("Import candidate missing");

    await expect(
      confirmSpotifyImport(db, userId, importRunId, [
        { candidateId: candidate.id, decision: "skip", selected: false },
      ]),
    ).rejects.toThrow("Select at least one artist");
    const run = await db.query.artistImportRuns.findFirst({
      where: eq(artistImportRuns.id, importRunId),
    });
    expect(run?.status).toBe("preview");
  });

  it("rejects confirmation by a different local user", async () => {
    const ownerId = await createTestUser("batch-owner");
    const otherUserId = await createTestUser("other-owner");
    const importRunId = await createSpotifyImportRun(db, ownerId, [
      {
        proposedAction: "create",
        providerArtistId: "spotify-owned-batch",
        providerName: "Owned Batch Artist",
        providerUrl: "https://open.spotify.com/artist/spotify-owned-batch",
        selected: true,
      },
    ]);

    await expect(
      confirmSpotifyImport(db, otherUserId, importRunId, await decisionsForRun(importRunId)),
    ).rejects.toThrow("does not belong to the local user");
    expect(await listFollowedArtists(db, otherUserId)).toEqual([]);
  });
});
