import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase } from "./client";
import { listScanHistoryPage } from "./scan-history";
import { scanRuns } from "./schema";

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
});
