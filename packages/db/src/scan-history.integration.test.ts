import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type RadarDatabase } from "./client";
import { listScanHistory, selectDefaultScanHistoryEntry } from "./scan-history";
import { artists, scanRuns, spotifyArtistScans, spotifyScanBatches } from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

let connection: ReturnType<typeof createDatabase>;
let db: RadarDatabase;

beforeAll(() => {
  connection = createDatabase(databaseUrl);
  db = connection.db;
});

beforeEach(async () => {
  await db.delete(spotifyArtistScans);
  await db.delete(spotifyScanBatches);
  await db.delete(scanRuns);
});

afterAll(async () => {
  await connection.client.end();
});

describe("scan history", () => {
  it("keeps a meaningful batch as the idle default after a newer single-artist check", async () => {
    const [firstArtist, secondArtist] = await db
      .insert(artists)
      .values([
        { name: `History Artist ${randomUUID()}`, normalizedName: randomUUID() },
        { name: `History Artist ${randomUUID()}`, normalizedName: randomUUID() },
      ])
      .returning({ id: artists.id });
    const [batchRun, singleRun, dryRun] = await db
      .insert(scanRuns)
      .values([
        {
          completedAt: new Date("2026-07-21T04:13:51.904Z"),
          insertedCount: 90,
          provider: "spotify",
          providersCompleted: ["spotify"],
          providersRequested: ["spotify"],
          reviewCount: 1,
          startedAt: new Date("2026-07-21T04:04:55.085Z"),
          status: "completed",
          triggerType: "provider_manual",
          updatedCount: 3,
        },
        {
          artistFilter: firstArtist!.id,
          completedAt: new Date("2026-07-21T04:15:17.792Z"),
          provider: "spotify",
          providersCompleted: ["spotify"],
          providersRequested: ["spotify"],
          startedAt: new Date("2026-07-21T04:15:17.400Z"),
          status: "completed",
          triggerType: "provider_manual",
        },
        {
          artistFilter: secondArtist!.id,
          completedAt: new Date("2026-07-21T04:16:00.000Z"),
          dryRun: true,
          provider: "spotify",
          providersFailed: ["spotify"],
          providersRequested: ["spotify"],
          startedAt: new Date("2026-07-21T04:15:59.000Z"),
          status: "failed",
          triggerType: "manual",
        },
      ])
      .returning({ id: scanRuns.id });
    const [batch, singleBatch] = await db
      .insert(spotifyScanBatches)
      .values([
        {
          estimatedRequests: 550,
          mode: "daily",
          pageLimit: 1,
          partialArtists: 2,
          scanRunId: batchRun!.id,
          status: "completed",
          totalArtists: 2,
        },
        {
          estimatedRequests: 11,
          mode: "daily",
          pageLimit: 1,
          partialArtists: 1,
          scanRunId: singleRun!.id,
          status: "completed",
          totalArtists: 1,
        },
      ])
      .returning({ id: spotifyScanBatches.id });
    await db.insert(spotifyArtistScans).values([
      {
        artistId: firstArtist!.id,
        batchId: batch!.id,
        position: 0,
        requestCount: 51,
        status: "partial",
      },
      {
        artistId: secondArtist!.id,
        batchId: batch!.id,
        position: 1,
        requestCount: 51,
        status: "partial",
      },
      {
        artistId: firstArtist!.id,
        batchId: singleBatch!.id,
        position: 0,
        requestCount: 1,
        status: "partial",
      },
    ]);

    const history = await listScanHistory(db);
    expect(history.map((run) => run.id)).toEqual([dryRun!.id, singleRun!.id, batchRun!.id]);
    expect(history.find((run) => run.id === batchRun!.id)).toMatchObject({
      artistCount: 2,
      createdCount: 90,
      failureCount: 0,
      partialArtistCount: 2,
      requestCount: 102,
      reviewCount: 1,
      updatedCount: 3,
    });
    expect(history.find((run) => run.id === dryRun!.id)).toMatchObject({
      artistCount: 1,
      dryRun: true,
      failureCount: 1,
      requestCount: null,
      status: "failed",
    });
    expect(selectDefaultScanHistoryEntry(history)?.id).toBe(batchRun!.id);
  });
});
