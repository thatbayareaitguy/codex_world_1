import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./client";
import { listScanHistoryPage } from "./scan-history";
import { appleMusicScanBatches, scanRuns } from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("scan history pagination", () => {
  const connection = createDatabase(databaseUrl);

  beforeAll(async () => {
    await connection.db.execute(sql`truncate table scan_runs restart identity cascade`);
    await connection.db.insert(scanRuns).values(
      Array.from({ length: 25 }, (_, index) => ({
        completedAt: new Date(Date.UTC(2026, 6, 21, 12, index)),
        provider: "mock" as const,
        providersCompleted: ["mock"],
        providersRequested: ["mock"],
        startedAt: new Date(Date.UTC(2026, 6, 21, 12, index)),
        status: "completed" as const,
        triggerType: "synthetic_history_test",
      })),
    );
  });

  afterAll(async () => {
    await connection.db.execute(sql`truncate table scan_runs restart identity cascade`);
    await connection.client.end();
  });

  it("loads older pages without gaps or duplicate scan IDs", async () => {
    const first = await listScanHistoryPage(connection.db, { limit: 10 });
    const second = await listScanHistoryPage(connection.db, {
      cursor: first.nextCursor!,
      limit: 10,
    });
    const third = await listScanHistoryPage(connection.db, {
      cursor: second.nextCursor!,
      limit: 10,
    });
    const entries = [...first.entries, ...second.entries, ...third.entries];
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    expect(third.hasMore).toBe(false);
    expect(entries).toHaveLength(25);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(25);
  });

  it("rejects malformed history cursors", async () => {
    await expect(
      listScanHistoryPage(connection.db, { cursor: "not-a-cursor", limit: 10 }),
    ).rejects.toThrow(/cursor/i);
  });

  it("reports persisted Apple Music batch counts and request telemetry", async () => {
    const [run] = await connection.db
      .insert(scanRuns)
      .values({
        completedAt: new Date("2026-08-04T19:00:10.000Z"),
        insertedCount: 4,
        provider: "apple_music",
        providersCompleted: ["apple_music"],
        providersRequested: ["apple_music"],
        startedAt: new Date("2026-08-04T19:00:00.000Z"),
        status: "completed",
        triggerType: "provider_manual",
      })
      .returning({ id: scanRuns.id });
    expect(run).toBeDefined();
    const [batch] = await connection.db
      .insert(appleMusicScanBatches)
      .values({
        completedArtists: 2,
        failedArtists: 0,
        requestCount: 7,
        scanRunId: run!.id,
        status: "completed",
        totalArtists: 2,
      })
      .returning({ id: appleMusicScanBatches.id });

    const history = await listScanHistoryPage(connection.db, { limit: 50 });
    expect(history.entries.find((entry) => entry.id === run!.id)).toMatchObject({
      artistCount: 2,
      batchId: batch!.id,
      batchMode: "apple_music",
      failureCount: 0,
      provider: "apple_music",
      requestCount: 7,
    });
  });
});
