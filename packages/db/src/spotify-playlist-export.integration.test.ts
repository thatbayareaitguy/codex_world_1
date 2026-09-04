import type { FeedState } from "@radar/core";
import type { SpotifyPlaylistExportClient } from "./spotify-playlist-export";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import {
  executeSpotifyPlaylistExport,
  inspectSpotifyPlaylistCheckpoint,
  previewSpotifyPlaylistExport,
  surfaceUncertainSpotifyMatchesForReview,
} from "./spotify-playlist-export";
import {
  artistFollows,
  artists,
  discoveryReconciliationCampaigns,
  feedItems,
  manualMatchDecisions,
  oauthAccounts,
  playlistExports,
  playlistTargets,
  releaseCandidates,
  releaseProviderReconciliations,
  releases,
  releaseTrackAppearances,
  spotifyPlaylistExportOperations,
  spotifyPlaylistExportRuns,
  trackCredits,
  tracks,
  users,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const connection = createDatabase(databaseUrl);
const db = connection.db;
const playlistId = "1234567890123456789012";

describe.sequential("Spotify canonical playlist export", () => {
  beforeEach(async () => {
    await db.execute(
      sql`truncate table users, artists, releases, release_candidates, playlist_targets restart identity cascade`,
    );
  });

  afterAll(async () => {
    await connection.client.end();
  });

  it("previews canonical exact and manual matches while caching the verified snapshot", async () => {
    const fixture = await createFixture({ includeIneligible: true, writeScope: false });
    const client = new FakePlaylistClient(["9999999999999999999999"]);

    const preview = await previewSpotifyPlaylistExport(db, fixture.userId, client, playlistId);

    expect(preview.target).toMatchObject({ id: playlistId, public: true });
    expect(preview.plan.desired.map((item) => item.title)).toEqual([
      "Exact track",
      "Confirmed track",
    ]);
    expect(preview.plan.additions.map((item) => item.position)).toEqual([0, 1]);
    expect(preview.plan.skips.map((item) => item.reason).sort()).toEqual([
      "duplicate_recording_appearance",
      "feed_dismissed",
      "needs_review",
      "not_followed_artist",
      "uncertain_spotify_match",
    ]);
    expect(client.items).toEqual(["9999999999999999999999"]);
    await expect(tableCount(playlistTargets)).resolves.toBe(1);
    await expect(tableCount(playlistExports)).resolves.toBe(0);
    await expect(tableCount(spotifyPlaylistExportRuns)).resolves.toBe(0);
    await expect(tableCount(spotifyPlaylistExportOperations)).resolves.toBe(0);
  });

  it("avoids playlist-item pagination while the remote snapshot is unchanged", async () => {
    const fixture = await createFixture({ writeScope: false });
    const client = new FakePlaylistClient(["9999999999999999999999"]);

    const first = await previewSpotifyPlaylistExport(db, fixture.userId, client, playlistId);
    const second = await previewSpotifyPlaylistExport(db, fixture.userId, client, playlistId);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(client.itemReadCalls).toBe(1);
    client.externalInsert("8888888888888888888888", 0);
    const afterExternalChange = await previewSpotifyPlaylistExport(
      db,
      fixture.userId,
      client,
      playlistId,
    );
    expect(afterExternalChange.cacheHit).toBe(false);
    expect(client.itemReadCalls).toBe(2);
  });

  it("uses cached database state to skip no-change checkpoints and surface uncertain matches", async () => {
    const fixture = await createFixture({ includeIneligible: true, writeScope: false });
    const verifiedAt = new Date("2026-08-19T04:00:00.000Z");
    const client = new FakePlaylistClient([
      fixture.exactProviderTrackId,
      fixture.confirmedProviderTrackId,
    ]);
    await previewSpotifyPlaylistExport(db, fixture.userId, client, playlistId);
    await db
      .update(playlistTargets)
      .set({ snapshotVerifiedAt: verifiedAt })
      .where(eq(playlistTargets.userId, fixture.userId));

    await expect(
      inspectSpotifyPlaylistCheckpoint(db, fixture.userId, playlistId, {
        now: new Date(verifiedAt.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({
      exportedCount: 2,
      pendingAdditionCount: 0,
      reason: "none",
      reorderMoveCount: 0,
      shouldRun: false,
    });
    await expect(
      inspectSpotifyPlaylistCheckpoint(db, fixture.userId, playlistId, {
        now: new Date(verifiedAt.getTime() + 25 * 60 * 60_000),
      }),
    ).resolves.toMatchObject({ reason: "periodic_reconciliation", shouldRun: true });

    await expect(
      surfaceUncertainSpotifyMatchesForReview(db, fixture.userId, verifiedAt),
    ).resolves.toMatchObject({ candidatesUpdated: 1, feedItemsUpdated: 1 });
    const uncertain = await db.query.releaseCandidates.findFirst({
      where: eq(releaseCandidates.title, "Uncertain track"),
    });
    const uncertainFeed = uncertain
      ? await db.query.feedItems.findFirst({ where: eq(feedItems.candidateId, uncertain.id) })
      : undefined;
    expect(uncertain).toMatchObject({ matchStatus: "needs_review" });
    expect(uncertainFeed).toMatchObject({ state: "needs_review" });
  });

  it("restores release-date Custom Order from cache without a second full playlist read", async () => {
    const fixture = await createFixture({ writeScope: true });
    const client = new FakePlaylistClient([
      fixture.confirmedProviderTrackId,
      fixture.exactProviderTrackId,
    ]);
    await db.insert(playlistTargets).values({
      name: "Release Radar Inbox",
      provider: "spotify",
      providerPlaylistId: playlistId,
      snapshotId: "snapshot-1",
      snapshotItems: [
        {
          addedAt: "2026-08-01T00:00:00.000Z",
          position: 0,
          releaseDate: "2026-07-31",
          trackId: fixture.confirmedProviderTrackId,
        },
        {
          addedAt: "2026-08-02T00:00:00.000Z",
          position: 1,
          releaseDate: "2026-08-01",
          trackId: fixture.exactProviderTrackId,
        },
      ],
      snapshotVerifiedAt: new Date(),
      userId: fixture.userId,
    });

    const result = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });

    expect(result.cacheHit).toBe(true);
    expect(client.items).toEqual([fixture.exactProviderTrackId, fixture.confirmedProviderTrackId]);
    expect(client.reorderCalls).toBe(1);
    expect(client.itemReadCalls).toBe(0);
    const target = await db.query.playlistTargets.findFirst();
    expect(target?.snapshotItems?.map((item) => item.addedAt)).toEqual([
      "2026-08-02T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
  });

  it("blocks an allowlist mismatch and missing write scope before any Spotify call", async () => {
    const fixture = await createFixture({ writeScope: false });
    const mismatchClient = new FakePlaylistClient([]);
    await expect(
      executeSpotifyPlaylistExport(db, fixture.userId, mismatchClient, {
        playlistId: "abcdefghijklmnopqrstuv",
        policy: { allowedPlaylistId: playlistId, enabled: true },
      }),
    ).rejects.toMatchObject({ code: "playlist_id_mismatch" });
    expect(mismatchClient.readCalls).toBe(0);
    expect(mismatchClient.addCalls).toHaveLength(0);

    const scopeClient = new FakePlaylistClient([]);
    await expect(
      executeSpotifyPlaylistExport(db, fixture.userId, scopeClient, {
        playlistId,
        policy: { allowedPlaylistId: playlistId, enabled: true },
      }),
    ).rejects.toMatchObject({ code: "missing_write_scope" });
    expect(scopeClient.readCalls).toBe(0);
    expect(scopeClient.addCalls).toHaveLength(0);
  });

  it("blocks live export when only the private playlist modification scope is stored", async () => {
    const fixture = await createFixture({ writeScope: true });
    await db
      .update(oauthAccounts)
      .set({ scopes: ["user-follow-read", "playlist-read-private", "playlist-modify-private"] })
      .where(eq(oauthAccounts.userId, fixture.userId));
    const client = new FakePlaylistClient([]);

    await expect(
      executeSpotifyPlaylistExport(db, fixture.userId, client, {
        playlistId,
        policy: { allowedPlaylistId: playlistId, enabled: true },
      }),
    ).rejects.toMatchObject({ code: "missing_write_scope" });
    expect(client.readCalls).toBe(0);
    expect(client.addCalls).toHaveLength(0);
  });

  it("resumes a canary, reconciles a post-write crash, preserves user tracks, and remains idempotent", async () => {
    const fixture = await createFixture({ writeScope: true });
    const userTrack = "9999999999999999999999";
    const client = new FakePlaylistClient([userTrack]);

    const canary = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      maxAdditions: 1,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });
    expect(canary.run).toMatchObject({ additionsAttempted: 1, pending: 1, status: "partial" });
    expect(client.items).toEqual([fixture.exactProviderTrackId, userTrack]);
    expect(client.addCalls).toHaveLength(1);

    client.externalInsert(fixture.confirmedProviderTrackId, 1);
    const resumed = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });
    expect(resumed.run).toMatchObject({
      additionsAttempted: 0,
      pending: 0,
      resumed: true,
      status: "completed",
    });
    expect(client.addCalls).toHaveLength(1);
    expect(client.items).toEqual([
      fixture.exactProviderTrackId,
      fixture.confirmedProviderTrackId,
      userTrack,
    ]);

    const repeat = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });
    expect(repeat.run).toMatchObject({ additionsAttempted: 0, status: "completed" });
    expect(client.addCalls).toHaveLength(1);
    expect(client.itemReadCalls).toBe(2);
    expect(new Set(client.items).size).toBe(client.items.length);
    expect(client.items.filter((item) => item === userTrack)).toHaveLength(1);

    const ledger = await db
      .select({
        appOwned: playlistExports.appOwned,
        providerTrackId: playlistExports.providerTrackId,
      })
      .from(playlistExports)
      .orderBy(playlistExports.providerTrackId);
    expect(ledger).toEqual([
      { appOwned: true, providerTrackId: fixture.exactProviderTrackId },
      { appOwned: false, providerTrackId: fixture.confirmedProviderTrackId },
    ]);
  });

  it("falls back to individual additions, records one failure, and continues", async () => {
    const fixture = await createFixture({ includeThirdExact: true, writeScope: true });
    const client = new FakePlaylistClient([], (trackIds) => {
      if (trackIds.length > 1) return new Error("synthetic batch failure");
      if (trackIds[0] === fixture.confirmedProviderTrackId) {
        return new Error("synthetic item failure");
      }
      return undefined;
    });

    const result = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });

    expect(result.run).toMatchObject({ exported: 2, failed: 1, pending: 0, status: "partial" });
    expect(client.items).toEqual([fixture.exactProviderTrackId, fixture.thirdProviderTrackId]);
    const failed = await db.query.spotifyPlaylistExportOperations.findFirst({
      where: and(
        eq(spotifyPlaylistExportOperations.providerTrackId, fixture.confirmedProviderTrackId),
        eq(spotifyPlaylistExportOperations.status, "failed"),
      ),
    });
    expect(failed).toMatchObject({ attemptCount: 1, errorCode: "playlist_item_add_failed" });
  });

  it("exports only campaign-eligible tracks in release-date Custom Order", async () => {
    const fixture = await createFixture({ writeScope: true });
    const campaignId = crypto.randomUUID();
    await db.insert(discoveryReconciliationCampaigns).values({
      campaignKey: `playlist-inbox-${campaignId}`,
      effectiveConfiguration: {},
      id: campaignId,
      spotifyCohortSize: 1,
      spotifyPageLimit: 1,
      spotifyRotationSize: 0,
      totalArtists: 1,
      windowEnd: "2026-08-07",
      windowStart: "2026-07-08",
    });
    await db.insert(releaseProviderReconciliations).values({
      artistId: fixture.exactArtistId,
      campaignId,
      confidence: "1.000",
      playlistEligible: true,
      playlistEligibleTrackCount: 1,
      reconciliationKey: `eligible-${campaignId}`,
      releaseDate: "2026-08-01",
      releaseType: "single",
      reasons: ["Exact campaign-scoped playlist fixture"],
      spotifyCanonicalReleaseId: fixture.exactReleaseId,
      spotifyProviderReleaseId: `release-${fixture.exactProviderTrackId}`,
      status: "spotify_only",
      title: "Exact track Release",
    });
    const userTrack = "9999999999999999999999";
    const client = new FakePlaylistClient([userTrack]);

    const result = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      discoveryReconciliationCampaignId: campaignId,
      orderingPolicy: "release_date_custom_order",
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });

    expect(result.plan.desired.map((item) => item.providerTrackId)).toEqual([
      fixture.exactProviderTrackId,
    ]);
    expect(client.addCalls).toEqual([{ position: 0, trackIds: [fixture.exactProviderTrackId] }]);
    expect(client.items).toEqual([fixture.exactProviderTrackId, userTrack]);
    expect(client.itemReadCalls).toBe(1);
    expect(
      await db.query.spotifyPlaylistExportRuns.findFirst({
        where: eq(spotifyPlaylistExportRuns.id, result.run.id),
      }),
    ).toMatchObject({
      discoveryReconciliationCampaignId: campaignId,
      orderingPolicy: "release_date_custom_order",
      status: "completed",
    });
  });
});

class FakePlaylistClient implements SpotifyPlaylistExportClient {
  readonly addCalls: Array<{ position: number; trackIds: string[] }> = [];
  itemReadCalls = 0;
  readCalls = 0;
  reorderCalls = 0;
  private snapshot = 1;

  constructor(
    readonly items: string[],
    private readonly fail?: (trackIds: string[]) => Error | undefined,
  ) {}

  getCurrentUser = () => {
    this.readCalls += 1;
    return Promise.resolve({
      account_id: "owner-account",
      display_name: "Owner",
      external_urls: { spotify: "https://open.spotify.com/user/owner" },
      id: "owner",
      type: "user" as const,
      uri: "spotify:user:owner",
    });
  };

  getPlaylist = (id: string) => {
    this.readCalls += 1;
    return Promise.resolve({
      collaborative: false,
      external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
      id,
      name: "Release Radar Inbox",
      owner: { account_id: "owner-account", id: "owner" },
      public: true,
      snapshot_id: `snapshot-${this.snapshot}`,
      uri: `spotify:playlist:${id}`,
    });
  };

  getPlaylistItems = () => {
    this.readCalls += 1;
    this.itemReadCalls += 1;
    return Promise.resolve(this.items.map((trackId, position) => ({ position, trackId })));
  };

  externalInsert(trackId: string, position: number): void {
    this.items.splice(position, 0, trackId);
    this.snapshot += 1;
  }

  addPlaylistItemsAtPosition = (_id: string, trackIds: string[], position: number) => {
    this.addCalls.push({ position, trackIds: [...trackIds] });
    const failure = this.fail?.(trackIds);
    if (failure) return Promise.reject(failure);
    this.items.splice(position, 0, ...trackIds);
    this.snapshot += 1;
    return Promise.resolve(`snapshot-${this.snapshot}`);
  };

  reorderPlaylistItems = (
    _id: string,
    input: { insertBefore: number; rangeLength?: number; rangeStart: number },
  ) => {
    this.reorderCalls += 1;
    const rangeLength = input.rangeLength ?? 1;
    const moved = this.items.splice(input.rangeStart, rangeLength);
    const adjustedInsert =
      input.insertBefore > input.rangeStart ? input.insertBefore - rangeLength : input.insertBefore;
    this.items.splice(adjustedInsert, 0, ...moved);
    this.snapshot += 1;
    return Promise.resolve(`snapshot-${this.snapshot}`);
  };
}

async function createFixture(input: {
  includeIneligible?: boolean;
  includeThirdExact?: boolean;
  writeScope: boolean;
}) {
  const [user] = await db
    .insert(users)
    .values({ displayName: "Owner", email: "owner@example.test" })
    .returning();
  if (!user) throw new Error("Test user was not created.");
  await db.insert(oauthAccounts).values({
    provider: "spotify",
    providerAccountId: "spotify-owner",
    scopes: input.writeScope
      ? [
          "user-follow-read",
          "playlist-read-private",
          "playlist-modify-private",
          "playlist-modify-public",
        ]
      : ["user-follow-read", "playlist-read-private"],
    userId: user.id,
  });
  const exact = await createFeedTrack(user.id, {
    confidence: "1.000",
    feedState: "new",
    followed: true,
    matchRule: "new_canonical",
    providerTrackId: "0000000000000000000001",
    releaseDate: "2026-08-01",
    title: "Exact track",
  });
  const confirmed = await createFeedTrack(user.id, {
    confidence: "0.700",
    feedState: "new",
    followed: true,
    matchRule: "metadata",
    providerTrackId: "0000000000000000000002",
    releaseDate: "2026-07-31",
    title: "Confirmed track",
  });
  await db.insert(manualMatchDecisions).values({
    candidateId: confirmed.candidateId,
    decision: "confirm",
    reason: "Test confirmation",
    selectedTrackId: confirmed.trackId,
    userId: user.id,
  });
  let thirdProviderTrackId = "";
  if (input.includeThirdExact) {
    thirdProviderTrackId = "0000000000000000000003";
    await createFeedTrack(user.id, {
      confidence: "1.000",
      feedState: "new",
      followed: true,
      matchRule: "exact_isrc",
      providerTrackId: thirdProviderTrackId,
      releaseDate: "2026-07-30",
      title: "Third exact track",
    });
  }
  if (input.includeIneligible) {
    await createFeedTrack(user.id, {
      confidence: "0.700",
      feedState: "new",
      followed: true,
      matchRule: "metadata",
      providerTrackId: "0000000000000000000010",
      releaseDate: "2026-07-29",
      title: "Uncertain track",
    });
    await createFeedTrack(user.id, {
      confidence: "1.000",
      feedState: "dismissed",
      followed: true,
      matchRule: "exact_isrc",
      providerTrackId: "0000000000000000000011",
      releaseDate: "2026-07-28",
      title: "Dismissed track",
    });
    await createFeedTrack(user.id, {
      confidence: "1.000",
      feedState: "new",
      followed: false,
      matchRule: "exact_isrc",
      providerTrackId: "0000000000000000000012",
      releaseDate: "2026-07-27",
      title: "Unfollowed track",
    });
    await createFeedTrack(user.id, {
      confidence: "1.000",
      feedState: "needs_review",
      followed: true,
      matchRule: "exact_isrc",
      providerTrackId: "0000000000000000000013",
      releaseDate: "2026-07-26",
      title: "Review track",
    });
    await createDuplicateAppearance(user.id, exact);
  }
  return {
    confirmedProviderTrackId: confirmed.providerTrackId,
    exactArtistId: exact.artistId,
    exactProviderTrackId: exact.providerTrackId,
    exactReleaseId: exact.releaseId,
    thirdProviderTrackId,
    userId: user.id,
  };
}

async function createFeedTrack(
  userId: string,
  input: {
    confidence: string;
    feedState: FeedState;
    followed: boolean;
    matchRule: string;
    providerTrackId: string;
    releaseDate: string;
    title: string;
  },
) {
  const [artist] = await db
    .insert(artists)
    .values({ name: `${input.title} Artist`, normalizedName: input.title.toLowerCase() })
    .returning();
  const [release] = await db
    .insert(releases)
    .values({
      normalizedTitle: input.title.toLowerCase(),
      releaseDate: input.releaseDate,
      releaseDatePrecision: "day",
      releaseType: "single",
      title: `${input.title} Release`,
    })
    .returning();
  if (!artist || !release) throw new Error("Fixture identity was not created.");
  const [track] = await db
    .insert(tracks)
    .values({ normalizedTitle: input.title.toLowerCase(), title: input.title })
    .returning();
  if (!track) throw new Error("Fixture track was not created.");
  await db.insert(trackCredits).values({
    artistId: artist.id,
    creditOrder: 0,
    creditedName: artist.name,
    role: "primary",
    trackId: track.id,
  });
  if (input.followed) {
    await db.insert(artistFollows).values({ artistId: artist.id, userId });
  }
  const [appearance] = await db
    .insert(releaseTrackAppearances)
    .values({ discNumber: 1, releaseId: release.id, trackId: track.id, trackNumber: 1 })
    .returning();
  const [candidate] = await db
    .insert(releaseCandidates)
    .values({
      artistExternalId: `artist-${input.providerTrackId}`,
      firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
      matchConfidence: input.confidence,
      matchedTrackId: track.id,
      matchReasons: ["fixture"],
      matchRule: input.matchRule,
      matchStatus: input.feedState === "needs_review" ? "needs_review" : "matched",
      normalizedTitle: input.title.toLowerCase(),
      payloadHash: `hash-${input.providerTrackId}`,
      provider: "spotify",
      providerReleaseId: `release-${input.providerTrackId}`,
      providerTrackId: input.providerTrackId,
      rawPayload: {},
      releaseDate: input.releaseDate,
      title: input.title,
    })
    .returning();
  if (!appearance || !candidate) throw new Error("Fixture candidate was not created.");
  await db.insert(feedItems).values({
    appearanceId: appearance.id,
    candidateId: candidate.id,
    dedupeKey: `feed-${input.providerTrackId}`,
    dismissedAt: input.feedState === "dismissed" ? new Date() : null,
    firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
    releaseId: release.id,
    state: input.feedState,
    trackId: track.id,
    userId,
  });
  return {
    artistId: artist.id,
    appearanceId: appearance.id,
    candidateId: candidate.id,
    providerTrackId: input.providerTrackId,
    releaseId: release.id,
    trackId: track.id,
  };
}

async function createDuplicateAppearance(
  userId: string,
  input: { candidateId: string; trackId: string },
) {
  const [release] = await db
    .insert(releases)
    .values({
      normalizedTitle: "duplicate appearance",
      releaseDate: "2026-07-01",
      releaseDatePrecision: "day",
      releaseType: "compilation",
      title: "Duplicate appearance",
    })
    .returning();
  if (!release) throw new Error("Duplicate release was not created.");
  const [appearance] = await db
    .insert(releaseTrackAppearances)
    .values({ discNumber: 1, releaseId: release.id, trackId: input.trackId, trackNumber: 1 })
    .returning();
  if (!appearance) throw new Error("Duplicate appearance was not created.");
  await db.insert(feedItems).values({
    appearanceId: appearance.id,
    candidateId: input.candidateId,
    dedupeKey: `duplicate-${input.trackId}`,
    firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
    releaseId: release.id,
    state: "new",
    trackId: input.trackId,
    userId,
  });
}

async function tableCount(
  table:
    | typeof playlistTargets
    | typeof playlistExports
    | typeof spotifyPlaylistExportRuns
    | typeof spotifyPlaylistExportOperations,
) {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(table);
  return row?.count ?? 0;
}
