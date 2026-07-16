import {
  artists,
  confirmSpotifyImport,
  consumeOAuthState,
  createDatabase,
  createSpotifyImportRun,
  disconnectSpotifyAccount,
  ensureLocalOwner,
  feedItems,
  persistOAuthState,
  playlistExports,
  playlistTargets,
  releaseCandidates,
  scanLocks,
  sourceEvidence,
  tracks,
  upsertSpotifyAccount,
} from "@radar/db";
import { encryptSecret } from "@radar/providers";
import { mockProviderFixture } from "@radar/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistCandidates } from "./scan";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

describe.sequential("PostgreSQL integration", () => {
  const connection = createDatabase(databaseUrl);

  beforeAll(async () => {
    await connection.db.execute(sql`truncate table scan_runs restart identity cascade`);
  });

  afterAll(async () => {
    await connection.client.end();
  });

  it("is idempotent, merges ISRC duplicates, and creates review feed items", async () => {
    const first = await persistCandidates(
      connection.db,
      mockProviderFixture.candidates,
      { dryRun: false, full: false, provider: "mock" },
      mockProviderFixture.nextCursor,
    );
    const second = await persistCandidates(
      connection.db,
      mockProviderFixture.candidates,
      { dryRun: false, full: false, provider: "mock" },
      mockProviderFixture.nextCursor,
    );

    expect(first).toMatchObject({ inserted: 5, needsReview: 1 });
    expect(second).toMatchObject({ inserted: 0, skipped: 5 });
    expect(await connection.db.select().from(releaseCandidates)).toHaveLength(5);
    expect(await connection.db.select().from(tracks)).toHaveLength(3);
    expect(await connection.db.select().from(sourceEvidence)).toHaveLength(5);
    expect(
      (await connection.db.select().from(feedItems)).some((item) => item.state === "needs_review"),
    ).toBe(true);
  });

  it("consumes OAuth state exactly once and rejects expired state", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const validId = await persistOAuthState(connection.db, {
      encryptedVerifier: { ciphertext: "cipher", nonce: "nonce" },
      expiresAt: new Date(Date.now() + 60_000),
      stateHash: "valid-hash",
      userId,
    });
    expect(await consumeOAuthState(connection.db, validId, "valid-hash")).toEqual({
      ciphertext: "cipher",
      nonce: "nonce",
    });
    expect(await consumeOAuthState(connection.db, validId, "valid-hash")).toBeUndefined();

    const expiredId = await persistOAuthState(connection.db, {
      encryptedVerifier: { ciphertext: "expired", nonce: "nonce" },
      expiresAt: new Date(Date.now() - 1),
      stateHash: "expired-hash",
      userId,
    });
    expect(await consumeOAuthState(connection.db, expiredId, "expired-hash")).toBeUndefined();
  });

  it("deduplicates repeated Spotify imports by provider artist ID", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const preview = [
      {
        providerArtistId: "spotify-artist-integration",
        providerName: "Integration Artist",
        providerUrl: "https://open.spotify.com/artist/spotify-artist-integration",
        proposedAction: "create" as const,
        selected: true,
      },
    ];
    const firstRun = await createSpotifyImportRun(connection.db, userId, preview);
    const firstCandidate = await connection.db.query.artistImportCandidates.findFirst({
      where: (table, { eq }) => eq(table.importRunId, firstRun),
    });
    expect(firstCandidate).toBeDefined();
    await confirmSpotifyImport(connection.db, userId, firstRun, [
      {
        candidateId: firstCandidate!.id,
        decision: "create",
        selected: true,
      },
    ]);

    const secondRun = await createSpotifyImportRun(connection.db, userId, preview);
    const secondCandidate = await connection.db.query.artistImportCandidates.findFirst({
      where: (table, { eq }) => eq(table.importRunId, secondRun),
    });
    await confirmSpotifyImport(connection.db, userId, secondRun, [
      {
        candidateId: secondCandidate!.id,
        decision: "create",
        selected: true,
      },
    ]);
    const mappings = await connection.db.query.artistExternalIds.findMany({
      where: (table, { and, eq }) =>
        and(eq(table.provider, "spotify"), eq(table.externalId, "spotify-artist-integration")),
    });
    expect(mappings).toHaveLength(1);
    expect(
      (await connection.db.select().from(artists)).filter(
        (artist) => artist.normalizedName === "integration artist",
      ),
    ).toHaveLength(1);
  });

  it("encrypts tokens, deletes them on disconnect, and preserves canonical data", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const key = Buffer.alloc(32, 7).toString("base64");
    await upsertSpotifyAccount(connection.db, {
      accessToken: encryptSecret("access", key),
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      providerAccountId: "spotify-account-integration",
      refreshToken: encryptSecret("refresh", key),
      scopes: ["user-follow-read"],
      userId,
    });
    const stored = await connection.db.query.oauthAccounts.findFirst({
      where: (table, { eq }) => eq(table.providerAccountId, "spotify-account-integration"),
    });
    expect(stored?.encryptedRefreshToken).not.toContain("refresh");
    const artistCount = (await connection.db.select().from(artists)).length;
    await disconnectSpotifyAccount(connection.db, userId);
    const disconnected = await connection.db.query.oauthAccounts.findFirst({
      where: (table, { eq }) => eq(table.providerAccountId, "spotify-account-integration"),
    });
    expect(disconnected).toMatchObject({
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
    });
    expect(disconnected?.disconnectedAt).toBeInstanceOf(Date);
    expect(await connection.db.select().from(artists)).toHaveLength(artistCount);
  });

  it("enforces one playlist addition and recovers an expired scan lock", async () => {
    const userId = await ensureLocalOwner(connection.db);
    const [track] = await connection.db.select().from(tracks);
    expect(track).toBeDefined();
    const [target] = await connection.db
      .insert(playlistTargets)
      .values({ name: "Integration inbox", provider: "spotify", userId })
      .returning({ id: playlistTargets.id });
    expect(target).toBeDefined();
    const exportValue = {
      playlistTargetId: target!.id,
      providerTrackId: "spotify-track-integration",
      status: "exported" as const,
      trackId: track!.id,
    };
    await connection.db.insert(playlistExports).values(exportValue);
    await connection.db.insert(playlistExports).values(exportValue).onConflictDoNothing();
    expect(await connection.db.select().from(playlistExports)).toHaveLength(1);

    await connection.db.insert(scanLocks).values({
      acquiredAt: new Date(Date.now() - 120_000),
      expiresAt: new Date(Date.now() - 60_000),
      ownerToken: "interrupted-run",
      provider: "mock",
    });
    const recovered = await persistCandidates(
      connection.db,
      mockProviderFixture.candidates,
      { dryRun: false, full: false, provider: "mock" },
      mockProviderFixture.nextCursor,
    );
    expect(recovered.skipped).toBe(5);
    expect(await connection.db.select().from(scanLocks)).toHaveLength(0);
  });
});
