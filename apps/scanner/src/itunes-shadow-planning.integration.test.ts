import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertIdentitySnapshotReadOnlyStatement,
  collectFullWatchlistIdentitySnapshot,
  fullWatchlistIdentityTransactionMode,
  type IdentitySnapshotReader,
} from "./itunes-full-watchlist-identity-snapshot";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:55434/radar_itunes_test";

describe.sequential("full-watchlist identity exporter against isolated PostgreSQL", () => {
  const sql = postgres(databaseUrl, { max: 1 });
  const userId = randomUUID();
  const artistId = randomUUID();
  const spotifyArtistId = `integration-${randomUUID()}`;

  beforeAll(async () => {
    await sql`
      insert into users (id, email, display_name)
      values (${userId}::uuid, ${`${userId}@example.test`}, 'Identity Export Test')
    `;
    await sql`
      insert into artists (id, name, normalized_name)
      values (${artistId}::uuid, 'Identity Export Artist', 'identity export artist')
    `;
    await sql`
      insert into artist_aliases (artist_id, name, normalized_name, source)
      values (${artistId}::uuid, 'Exporter Alias', 'exporter alias', 'test')
    `;
    await sql`
      insert into artist_external_ids
        (artist_id, provider, external_id, confirmed, mapping_source)
      values (${artistId}::uuid, 'spotify', ${spotifyArtistId}, true, 'test')
    `;
    await sql`
      insert into artist_follows (user_id, artist_id, active, source)
      values (${userId}::uuid, ${artistId}::uuid, true, 'test')
    `;
  });

  afterAll(async () => {
    await sql`delete from users where id = ${userId}::uuid`;
    await sql.end();
  });

  it("runs the real identity query in REPEATABLE READ READ ONLY mode", async () => {
    const transactionSettings: Array<{ isolation: string; readOnly: string }> = [];
    const reader: IdentitySnapshotReader = {
      transaction: async (mode, work) => {
        const result = await sql.begin(mode, async (tx) => {
          const [settings] = await tx<
            Array<{ isolation: string; read_only: string }>
          >`select current_setting('transaction_isolation') as isolation,
                   current_setting('transaction_read_only') as read_only`;
          transactionSettings.push({
            isolation: settings!.isolation,
            readOnly: settings!.read_only,
          });
          return work({
            query: (statement) => {
              assertIdentitySnapshotReadOnlyStatement(statement);
              return tx.unsafe(statement);
            },
          });
        });
        return result as Awaited<ReturnType<typeof work>>;
      },
    };

    const snapshot = await collectFullWatchlistIdentitySnapshot(reader);

    expect(fullWatchlistIdentityTransactionMode).toBe("isolation level repeatable read read only");
    expect(transactionSettings).toEqual([{ isolation: "repeatable read", readOnly: "on" }]);
    expect(snapshot.artists).toContainEqual({
      active: true,
      aliases: ["Exporter Alias"],
      canonicalArtistId: artistId,
      displayName: "Identity Export Artist",
      normalizedName: "identity export artist",
      spotifyArtistId,
    });
  });
});
