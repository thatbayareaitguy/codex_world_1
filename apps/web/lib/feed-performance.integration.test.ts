import { createDatabase, feedRevisions } from "@radar/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadDatabaseFeedPage, loadDatabaseFeedRevision } from "./feed-server";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const cursorSecret = "synthetic-feed-performance-secret";
const userId = "00000000-0000-4000-8000-000000000001";

describe.sequential("feed performance diagnostics", () => {
  const connection = createDatabase(databaseUrl);

  beforeAll(async () => resetDatabase(connection));

  afterAll(async () => {
    await resetDatabase(connection);
    await connection.client.end();
  });

  it.each([150, 1_000, 3_000])(
    "keeps the first page bounded with %d synthetic feed items",
    async (itemCount) => {
      await seedSyntheticFeed(connection, itemCount);
      const heapBefore = process.memoryUsage().heapUsed;
      const startedAt = performance.now();
      const page = await loadDatabaseFeedPage(databaseUrl, {
        limit: 100,
        secret: cursorSecret,
      });
      const elapsedMs = performance.now() - startedAt;
      const memoryDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
      const payloadBytes = Buffer.byteLength(JSON.stringify(page), "utf8");

      console.info(
        JSON.stringify({
          diagnostic: "feed_page_performance",
          elapsedMs: Number(elapsedMs.toFixed(2)),
          itemCount,
          memoryDeltaBytes,
          payloadBytes,
          returnedItems: page.items.length,
        }),
      );
      expect(page.items).toHaveLength(100);
      expect(page.totalCount).toBe(itemCount);
      expect(page.hasMore).toBe(itemCount > 100);
      expect(elapsedMs).toBeLessThan(1_000);
      expect(payloadBytes).toBeLessThan(1_000_000);
    },
    30_000,
  );

  it("uses indexed access for feed paging and the durable revision record", async () => {
    await seedSyntheticFeed(connection, 3_000);
    const feedPlan = await explain(
      connection,
      `SELECT id FROM feed_items
       WHERE user_id = '${userId}'
       ORDER BY first_seen_at DESC, id DESC
       LIMIT 100`,
    );
    const revisionPlan = await explain(
      connection,
      "SELECT revision, item_count, updated_at FROM feed_revisions WHERE id = 'global'",
    );
    expect(feedPlan).toContain("feed_user_seen_id_idx");
    expect(revisionPlan).toContain("feed_revisions_pkey");

    const revisionStartedAt = performance.now();
    const revision = await loadDatabaseFeedRevision(databaseUrl);
    const revisionElapsedMs = performance.now() - revisionStartedAt;
    console.info(
      JSON.stringify({
        diagnostic: "feed_revision_performance",
        elapsedMs: Number(revisionElapsedMs.toFixed(2)),
        itemCount: revision.count,
      }),
    );
    expect(revision.count).toBe(3_000);
    expect(revisionElapsedMs).toBeLessThan(100);
  });
});

async function resetDatabase(connection: ReturnType<typeof createDatabase>): Promise<void> {
  await connection.db.execute(
    sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
  );
  await connection.db
    .update(feedRevisions)
    .set({ itemCount: 0, revision: 0, updatedAt: new Date(0) })
    .where(eq(feedRevisions.id, "global"));
}

async function seedSyntheticFeed(
  connection: ReturnType<typeof createDatabase>,
  itemCount: number,
): Promise<void> {
  await resetDatabase(connection);
  await connection.client.unsafe(`
    INSERT INTO users (id, email, display_name)
    VALUES ('${userId}', 'feed-performance@example.test', 'Feed performance owner');

    DROP TABLE IF EXISTS synthetic_feed_seed;
    CREATE TEMP TABLE synthetic_feed_seed (
      item_number integer PRIMARY KEY,
      release_id uuid NOT NULL,
      track_id uuid NOT NULL,
      candidate_id uuid NOT NULL,
      feed_id uuid NOT NULL
    );

    INSERT INTO synthetic_feed_seed
    SELECT value, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
    FROM generate_series(1, ${itemCount}) AS value;

    INSERT INTO releases (
      id, title, normalized_title, release_type, release_date, release_date_precision
    )
    SELECT release_id, 'Release ' || item_number, 'release ' || item_number, 'single',
      date '2026-07-21' - (item_number % 365), 'day'
    FROM synthetic_feed_seed;

    INSERT INTO tracks (id, release_id, title, normalized_title, duration_ms, track_number)
    SELECT track_id, release_id, 'Track ' || item_number, 'track ' || item_number,
      180000 + item_number, 1
    FROM synthetic_feed_seed;

    INSERT INTO release_candidates (
      id, provider, provider_release_id, provider_track_id, artist_external_id,
      title, normalized_title, release_date, raw_payload, payload_hash, match_status,
      matched_track_id, match_rule, match_confidence, match_reasons,
      matching_algorithm_version, first_seen_at
    )
    SELECT candidate_id, 'mock', 'release-' || item_number, 'track-' || item_number,
      'synthetic-artist', 'Track ' || item_number, 'track ' || item_number,
      date '2026-07-21' - (item_number % 365),
      jsonb_build_object('releaseTitle', 'Release ' || item_number),
      'payload-' || item_number, 'matched', track_id, 'exact_provider_id', 1,
      ARRAY['Synthetic exact match'], 'synthetic-performance-v1',
      timestamptz '2026-07-21 20:00:00+00' - (item_number || ' seconds')::interval
    FROM synthetic_feed_seed;

    INSERT INTO source_evidence (
      candidate_id, provider, evidence_type, external_id, source_url, payload_hash
    )
    SELECT candidate_id, 'mock', 'mock_track', 'track-' || item_number,
      'https://example.test/evidence/' || item_number, 'payload-' || item_number
    FROM synthetic_feed_seed;

    INSERT INTO feed_items (
      id, user_id, candidate_id, release_id, track_id, state, dedupe_key, first_seen_at
    )
    SELECT feed_id, '${userId}', candidate_id, release_id, track_id, 'new',
      'synthetic:' || item_number,
      timestamptz '2026-07-21 20:00:00+00' - (item_number || ' seconds')::interval
    FROM synthetic_feed_seed;

    ANALYZE feed_items;
    ANALYZE feed_revisions;
  `);
}

async function explain(
  connection: ReturnType<typeof createDatabase>,
  query: string,
): Promise<string> {
  const rows = await connection.client.unsafe<Array<{ "QUERY PLAN": string }>>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`,
  );
  return rows.map((row) => row["QUERY PLAN"]).join("\n");
}
