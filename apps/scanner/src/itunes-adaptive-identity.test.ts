import { describe, expect, it } from "vitest";
import {
  assertHistoricalEvidenceReadOnlyStatement,
  collectHistoricalIdentityEvidenceFromReader,
  historicalEvidenceCutoff,
  historicalEvidenceQueries,
  historicalEvidenceTransactionMode,
  serializeHistoricalArtistIdSet,
  serializeHistoricalIdentityEvidence,
  validateHistoricalIdentityEvidence,
  type HistoricalEvidenceReader,
} from "./itunes-historical-identity-evidence";
import type { FullWatchlistIdentitySnapshot } from "./itunes-full-watchlist-identity-snapshot";

describe("historical Spotify identity-evidence export", () => {
  it("uses one repeatable-read, read-only transaction and approved SELECT statements", async () => {
    const modes: string[] = [];
    const statements: string[] = [];
    const parameters: unknown[][] = [];
    const identity = fixtureIdentity();
    const reader = fixtureReader(identity, modes, statements, parameters);
    const snapshot = await collectHistoricalIdentityEvidenceFromReader(reader, {
      identity,
      sourceBranch: "codex/release-radar-hardening",
      sourceCommit: "a".repeat(40),
      sourceRepositoryPath: "C:\\source",
    });
    expect(modes).toEqual([historicalEvidenceTransactionMode]);
    expect(snapshot.source.transactionIsolation).toBe("repeatable read");
    expect(snapshot.source.transactionReadOnly).toBe(true);
    expect(statements).toEqual([
      historicalEvidenceQueries.transactionState,
      historicalEvidenceQueries.schemaVersion,
      historicalEvidenceQueries.artists,
      historicalEvidenceQueries.releases,
      historicalEvidenceQueries.tracks,
    ]);
    for (const statement of statements) {
      expect(() => assertHistoricalEvidenceReadOnlyStatement(statement)).not.toThrow();
    }
    const expectedArtistIdSet = identity.artists
      .map((artist) => artist.canonicalArtistId)
      .join(",");
    expect(parameters).toEqual([
      [expectedArtistIdSet, historicalEvidenceCutoff],
      [expectedArtistIdSet, historicalEvidenceCutoff],
      [expectedArtistIdSet, historicalEvidenceCutoff],
    ]);
    expect(historicalEvidenceQueries.artists).toContain("string_to_array($1, ',')::uuid[]");
    expect(historicalEvidenceQueries.releases).toContain("string_to_array($1, ',')::uuid[]");
    expect(historicalEvidenceQueries.tracks).toContain("string_to_array($1, ',')::uuid[]");
    expect(Object.values(historicalEvidenceQueries).join("\n")).not.toContain(
      "jsonb_array_elements_text",
    );
  });

  it("binds a validated UUID set instead of the legacy scalar JSON boundary", () => {
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    const corrected = serializeHistoricalArtistIdSet(ids);
    const legacyScalarJson = JSON.stringify(corrected);

    expect(legacyScalarJson).toBe(
      '"00000000-0000-4000-8000-000000000001,00000000-0000-4000-8000-000000000002"',
    );
    expect(corrected).toBe(ids.join(","));
    expect(corrected).not.toMatch(/^\s*"/);
    expect(() => serializeHistoricalArtistIdSet(["not-a-uuid"])).toThrow(/invalid artist ID/);
  });

  it.each([
    "insert into artists (name) values ('x')",
    "update artists set name = 'x'",
    "delete from artists",
    "merge into artists using source on true",
    "create temporary table x(id int)",
    "select pg_advisory_lock(1)",
    "select * from artists for update",
    "select * from spotify_request_events",
    "select * from feed_items",
  ])("rejects writes, locks, DDL, and prohibited tables: %s", (statement) => {
    expect(() => assertHistoricalEvidenceReadOnlyStatement(statement)).toThrow();
  });

  it("excludes evidence first observed after the fixed cutoff", async () => {
    const identity = fixtureIdentity();
    const reader = fixtureReader(identity, [], [], [], {
      releaseRows: [
        {
          canonical_artist_id: identity.artists[0]!.canonicalArtistId,
          created_at: new Date("2026-07-30T02:11:00Z"),
          details_fetched_at: null,
          discrepancy: null,
          expected_total_tracks: null,
          fetched_track_count: null,
          first_observed_at: new Date("2026-07-30T02:11:00Z"),
          last_observed_at: new Date("2026-07-30T02:11:00Z"),
          release_date: "2026-01-01",
          release_date_precision: "day",
          release_type: "single",
          retrieval_completed_at: null,
          retrieval_created_at: null,
          retrieval_id: null,
          retrieval_started_at: null,
          retrieval_status: null,
          retrieval_updated_at: null,
          spotify_release_id: "post-cutoff-release",
          title: "After Cutoff",
          total_tracks: 1,
          updated_at: new Date("2026-07-30T02:11:00Z"),
        },
      ],
    });
    const snapshot = await collectHistoricalIdentityEvidenceFromReader(reader, {
      identity,
      sourceBranch: "codex/release-radar-hardening",
      sourceCommit: "a".repeat(40),
      sourceRepositoryPath: "C:\\source",
    });
    expect(snapshot.evidenceCutoff).toBe(historicalEvidenceCutoff);
    expect(snapshot.summary.releaseCount).toBe(0);
  });

  it("serializes deterministically and rejects operational or credential-shaped data", async () => {
    const identity = fixtureIdentity();
    const snapshot = await collectHistoricalIdentityEvidenceFromReader(fixtureReader(identity), {
      identity,
      sourceBranch: "codex/release-radar-hardening",
      sourceCommit: "a".repeat(40),
      sourceRepositoryPath: "C:\\source",
    });
    expect(serializeHistoricalIdentityEvidence(snapshot)).toBe(
      serializeHistoricalIdentityEvidence(snapshot),
    );
    expect(() =>
      validateHistoricalIdentityEvidence({
        ...snapshot,
        campaignState: "running",
      }),
    ).toThrow(/prohibited field/i);
    expect(serializeHistoricalIdentityEvidence(snapshot)).not.toMatch(
      /credential|accessToken|refreshToken|artwork|previewUrl|rawPayload|campaignState/i,
    );
  });
});

function fixtureIdentity(): FullWatchlistIdentitySnapshot {
  return {
    artists: Array.from({ length: 593 }, (_, index) => {
      const sequence = String(index + 1).padStart(12, "0");
      const displayName = `Artist ${String(index + 1).padStart(3, "0")}`;
      return {
        active: true as const,
        aliases: [],
        canonicalArtistId: `00000000-0000-4000-8000-${sequence}`,
        displayName,
        normalizedName: displayName.toLocaleLowerCase("en-US"),
        spotifyArtistId: `spotify-${sequence}`,
      };
    }),
    canonicalContentSha256: "b".repeat(64),
    snapshotId: "fixture-identity",
    snapshotTimestamp: "2026-07-29T06:00:40.741Z",
    sourceSchemaVersion: 17,
    version: 1,
  };
}

function fixtureReader(
  identity: FullWatchlistIdentitySnapshot,
  modes: string[] = [],
  statements: string[] = [],
  parameters: unknown[][] = [],
  overrides: { releaseRows?: unknown[]; trackRows?: unknown[] } = {},
): HistoricalEvidenceReader {
  return {
    transaction: async (mode, work) => {
      modes.push(mode);
      return work({
        query: (statement, queryParameters = []) => {
          statements.push(statement);
          if (queryParameters.length > 0) parameters.push(queryParameters);
          if (statement === historicalEvidenceQueries.transactionState) {
            return Promise.resolve([
              {
                isolation_level: "repeatable read",
                read_only: "on",
                snapshot_timestamp: new Date("2026-07-30T03:00:00.000Z"),
              },
            ]);
          }
          if (statement === historicalEvidenceQueries.schemaVersion) {
            return Promise.resolve([{ source_schema_version: 17 }]);
          }
          if (statement === historicalEvidenceQueries.artists) {
            return Promise.resolve(
              identity.artists.map((artist) => ({
                aliases: artist.aliases,
                canonical_artist_id: artist.canonicalArtistId,
                display_name: artist.displayName,
                normalized_name: artist.normalizedName,
                spotify_artist_id: artist.spotifyArtistId,
              })),
            );
          }
          if (statement === historicalEvidenceQueries.releases) {
            return Promise.resolve(overrides.releaseRows ?? []);
          }
          if (statement === historicalEvidenceQueries.tracks) {
            return Promise.resolve(overrides.trackRows ?? []);
          }
          throw new Error("Unexpected fixture query.");
        },
      });
    },
  };
}
