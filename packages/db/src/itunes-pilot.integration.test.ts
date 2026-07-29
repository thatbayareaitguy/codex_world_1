import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import { createItunesRequestPersistence } from "./itunes-pilot";
import {
  feedItems,
  itunesPilotProviderState,
  itunesPilotRequestEvents,
  itunesPilotResponseCache,
  itunesPilotRuns,
  itunesPilotSnapshots,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:55434/radar_itunes_test";

describe.sequential("iTunes pilot persistence and global request gate", () => {
  const connection = createDatabase(databaseUrl);
  let snapshotId = "";

  beforeAll(async () => {
    const [snapshot] = await connection.db
      .insert(itunesPilotSnapshots)
      .values({
        artistCount: 50,
        mainRepositoryCommit: "a".repeat(40),
        mainSchemaVersion: 17,
        releaseCount: 1,
        snapshotHash: "b".repeat(64),
        snapshotTimestamp: new Date("2026-07-28T12:00:00Z"),
        windowEnd: "2026-07-28",
        windowStart: "2026-05-29",
      })
      .returning({ id: itunesPilotSnapshots.id });
    snapshotId = snapshot!.id;
  });

  beforeEach(async () => {
    await connection.db.delete(itunesPilotRequestEvents);
    await connection.db.delete(itunesPilotResponseCache);
    await connection.db.delete(itunesPilotProviderState);
    await connection.db.delete(itunesPilotRuns);
  });

  afterAll(async () => {
    await connection.db.execute(sql`truncate table itunes_pilot_snapshots cascade`);
    await connection.client.end();
  });

  it("enforces concurrency one and at least 3.2 seconds between request starts", async () => {
    const runId = await createRunningRun(2);
    const persistence = createItunesRequestPersistence(connection.db);
    const first = await persistence.acquire({
      endpointCategory: "artist_search",
      identity: "/search?term=one",
      maxRequests: 2,
      minIntervalMs: 3200,
      runId,
    });
    let secondResolved = false;
    const secondPromise = persistence
      .acquire({
        endpointCategory: "artist_search",
        identity: "/search?term=two",
        maxRequests: 2,
        minIntervalMs: 3200,
        runId,
      })
      .then((permit) => {
        secondResolved = true;
        return permit;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondResolved).toBe(false);
    await persistence.complete({
      bodyBytes: 10,
      completedAt: new Date(),
      eventId: first.eventId,
      leaseToken: first.leaseToken,
      status: 200,
    });
    const second = await secondPromise;
    expect(second.startedAt.getTime() - first.startedAt.getTime()).toBeGreaterThanOrEqual(3150);
    await persistence.complete({
      bodyBytes: 10,
      completedAt: new Date(),
      eventId: second.eventId,
      leaseToken: second.leaseToken,
      status: 200,
    });
  }, 10_000);

  it("enforces the per-run request budget", async () => {
    const runId = await createRunningRun(1);
    const persistence = createItunesRequestPersistence(connection.db);
    const permit = await persistence.acquire({
      endpointCategory: "artist_search",
      identity: "/search?term=one",
      maxRequests: 1,
      minIntervalMs: 3200,
      runId,
    });
    await persistence.complete({
      bodyBytes: 10,
      completedAt: new Date(),
      eventId: permit.eventId,
      leaseToken: permit.leaseToken,
      status: 200,
    });
    await expect(
      persistence.acquire({
        endpointCategory: "artist_search",
        identity: "/search?term=two",
        maxRequests: 1,
        minIntervalMs: 3200,
        runId,
      }),
    ).rejects.toMatchObject({
      classification: "request_budget_exhausted",
    });
  });

  it("persists normalized cache values and cache-hit telemetry idempotently", async () => {
    const runId = await createRunningRun(1);
    const persistence = createItunesRequestPersistence(connection.db);
    const permit = await persistence.acquire({
      endpointCategory: "artist_search",
      identity: "/search?term=cache",
      maxRequests: 1,
      minIntervalMs: 3200,
      runId,
    });
    const normalized = {
      artists: [],
      collections: [],
      declaredResultCount: 0,
      tracks: [],
      unknownResultCount: 0,
    };
    await persistence.complete({
      bodyBytes: 30,
      cacheValue: normalized,
      completedAt: new Date(),
      eventId: permit.eventId,
      leaseToken: permit.leaseToken,
      status: 200,
    });
    expect(await persistence.loadCache("/search?term=cache")).toEqual(normalized);
    await persistence.recordCacheHit({
      endpointCategory: "artist_search",
      identity: "/search?term=cache",
      runId,
    });
    const events = await connection.db.select().from(itunesPilotRequestEvents);
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.cacheHit)).toHaveLength(1);
    const [run] = await connection.db
      .select()
      .from(itunesPilotRuns)
      .where(sql`${itunesPilotRuns.id} = ${runId}`);
    expect(run?.requestCount).toBe(1);
  });

  it("never mutates production feed tables", async () => {
    const before = await connection.db
      .select({ count: sql<number>`count(*)::int` })
      .from(feedItems);
    const runId = await createRunningRun(1);
    const persistence = createItunesRequestPersistence(connection.db);
    const permit = await persistence.acquire({
      endpointCategory: "artist_search",
      identity: "/search?term=isolation",
      maxRequests: 1,
      minIntervalMs: 3200,
      runId,
    });
    await persistence.complete({
      bodyBytes: 0,
      completedAt: new Date(),
      eventId: permit.eventId,
      leaseToken: permit.leaseToken,
      status: 200,
    });
    const after = await connection.db.select({ count: sql<number>`count(*)::int` }).from(feedItems);
    expect(after).toEqual(before);
  });

  async function createRunningRun(requestBudget: number): Promise<string> {
    const [run] = await connection.db
      .insert(itunesPilotRuns)
      .values({
        deadlineAt: new Date(Date.now() + 60_000),
        implementationCommit: randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40),
        maximumRuntimeMs: 60_000,
        requestBudget,
        snapshotId,
        startedAt: new Date(),
        status: "running",
      })
      .returning({ id: itunesPilotRuns.id });
    return run!.id;
  }
});
