import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "./client";
import {
  artistExternalIds,
  artistFollows,
  artists,
  spotifyArtistCoverage,
  spotifyProviderState,
  spotifyReleaseTrackRetrievals,
  spotifySchedulerState,
  spotifySchedulerWork,
  spotifySyncCampaignMembers,
  spotifySyncCampaigns,
  users,
} from "./schema";
import {
  advanceSpotifySyncCampaignCanary,
  claimSpotifySyncCampaignWork,
  createSpotifySyncCampaign,
  finishSpotifySyncCampaignWork,
  getSpotifySyncCampaignStatus,
  pauseSpotifySyncCampaign,
  planSpotifySyncCampaignTick,
  queueSpotifyCampaignReleaseTrackWork,
  resumeSpotifySyncCampaign,
  startSpotifySyncCampaign,
} from "./spotify-sync-campaign";
import { queueSpotifyReleaseDetailWork, reconcileSpotifySchedulerWork } from "./spotify-scheduler";

const url = process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const connection = createDatabase(url);
const db = connection.db;
let userId = "";

beforeAll(async () => {
  userId = randomUUID();
  await db.insert(users).values({
    displayName: "Campaign test owner",
    email: `campaign-${userId}@example.test`,
    id: userId,
  });
});

beforeEach(async () => {
  await db.delete(spotifySyncCampaignMembers);
  await db.delete(spotifySyncCampaigns);
  await db.delete(spotifySchedulerWork);
  await db.delete(spotifyReleaseTrackRetrievals);
  await db.delete(spotifySchedulerState);
  await db.delete(spotifyArtistCoverage);
  await db.delete(spotifyProviderState);
  await db.delete(artistExternalIds);
  await db.delete(artistFollows);
  await db.delete(artists);
});

afterAll(async () => {
  await connection.client.end();
});

describe("bounded Spotify sync campaign", () => {
  it("snapshots only active mapped never-scanned artists in stable order and is idempotent", async () => {
    const now = new Date("2026-07-23T02:00:00.000Z");
    const eligible = await createArtist("Eligible", { followedAt: now });
    await createArtist("Inactive", { active: false, followedAt: now });
    await createArtist("Unmapped", { followedAt: now, mapped: false });
    const scanned = await createArtist("Scanned", { followedAt: now });
    await db.insert(spotifyArtistCoverage).values({
      artistId: scanned,
      dailyScanCompletedAt: now,
      partial: true,
      status: "daily_current",
    });
    await reconcileSpotifySchedulerWork(db, now);

    const first = await createSpotifySyncCampaign(db, {
      canaryTarget: 1,
      expiresAt: new Date(now.getTime() + 30 * 60 * 60_000),
      now,
      targetSuccesses: 1,
    });
    const second = await createSpotifySyncCampaign(db, {
      canaryTarget: 1,
      expiresAt: new Date(now.getTime() + 8 * 60 * 60_000),
      now,
      targetSuccesses: 1,
    });
    const members = await db.select().from(spotifySyncCampaignMembers);

    expect(second.id).toBe(first.id);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ artistId: eligible, ordinal: 1, status: "pending" });
  });

  it("releases failed and expired reservations without consuming success", async () => {
    const now = new Date("2026-07-23T03:00:00.000Z");
    await createArtist("First");
    await createArtist("Second");
    await reconcileSpotifySchedulerWork(db, now);
    const campaign = await createSpotifySyncCampaign(db, {
      canaryTarget: 1,
      expiresAt: new Date(now.getTime() + 30 * 60 * 60_000),
      now,
      targetSuccesses: 2,
    });
    await startSpotifySyncCampaign(db, campaign.id, now);

    const failed = await claimSpotifySyncCampaignWork(db, campaign.id, now);
    expect(failed).not.toBeNull();
    await finishSpotifySyncCampaignWork(
      db,
      failed!,
      { errorClassification: "synthetic_failure", status: "retry" },
      now,
    );
    expect((await getSpotifySyncCampaignStatus(db, campaign.id))?.activeReservations).toBe(0);

    await db
      .update(spotifySchedulerWork)
      .set({ notBefore: null })
      .where(eq(spotifySchedulerWork.id, failed!.id));
    const later = new Date(now.getTime() + campaign.baseIntervalMs);
    const expired = await claimSpotifySyncCampaignWork(db, campaign.id, later);
    expect(expired).not.toBeNull();
    const duringSpacing = await claimSpotifySyncCampaignWork(
      db,
      campaign.id,
      new Date(later.getTime() + 120_001),
    );
    expect(duringSpacing).toBeNull();
    expect((await getSpotifySyncCampaignStatus(db, campaign.id))?.activeReservations).toBe(0);
    const recovered = await claimSpotifySyncCampaignWork(
      db,
      campaign.id,
      new Date(later.getTime() + campaign.baseIntervalMs),
    );
    expect(recovered?.campaignMemberId).toBe(expired?.campaignMemberId);
    expect((await getSpotifySyncCampaignStatus(db, campaign.id))?.activeReservations).toBe(1);
  });

  it("does not resume a paused campaign past an unapproved canary boundary", async () => {
    const now = new Date("2026-07-23T00:00:00.000Z");
    await createArtist("Canary boundary");
    await createArtist("After canary");
    await reconcileSpotifySchedulerWork(db, now);
    const campaign = await createSpotifySyncCampaign(db, {
      canaryTarget: 1,
      expiresAt: new Date(now.getTime() + 8 * 60 * 60_000),
      now,
      targetSuccesses: 2,
    });
    await startSpotifySyncCampaign(db, campaign.id, now);
    const claim = await claimSpotifySyncCampaignWork(db, campaign.id, now);
    expect(claim).not.toBeNull();
    await recordSuccess(claim!.artistId!, now);
    await finishSpotifySyncCampaignWork(db, claim!, { status: "completed" }, now);
    expect((await getSpotifySyncCampaignStatus(db, campaign.id))?.status).toBe("canary_review");
    expect(await pauseSpotifySyncCampaign(db, campaign.id, "manual review", now)).toBe(true);
    expect(await startSpotifySyncCampaign(db, campaign.id, now)).toBe(false);
  });

  it("resumes the same expired campaign with a bounded deadline and preserves progress", async () => {
    const now = new Date("2026-07-23T01:00:00.000Z");
    await createArtist("Completed before continuation");
    await createArtist("Pending continuation");
    await createArtist("Second pending continuation");
    await reconcileSpotifySchedulerWork(db, now);
    const campaign = await createSpotifySyncCampaign(db, {
      canaryTarget: 3,
      expiresAt: new Date(now.getTime() + 60_000),
      now,
      targetSuccesses: 3,
    });
    await startSpotifySyncCampaign(db, campaign.id, now);
    const completed = await claimSpotifySyncCampaignWork(db, campaign.id, now);
    await recordSuccess(completed!.artistId!, now);
    await finishSpotifySyncCampaignWork(db, completed!, { status: "completed" }, now);
    const detailWorkId = randomUUID();
    await db.insert(spotifySchedulerWork).values({
      campaignId: campaign.id,
      campaignMemberId: completed!.campaignMemberId,
      dueAt: now,
      id: detailWorkId,
      source: "initial",
      spotifyAlbumId: "continuation-detail",
      status: "queued",
      workKey: "campaign-release-detail:continuation-detail",
      workType: "release_detail",
    });

    const expiredAt = new Date(now.getTime() + 60_001);
    expect(await claimSpotifySyncCampaignWork(db, campaign.id, expiredAt)).toBeNull();
    expect(await getSpotifySyncCampaignStatus(db, campaign.id)).toMatchObject({
      pendingMembers: 2,
      qualifyingSuccesses: 1,
      status: "paused",
      stopReason: "hard_deadline_reached",
    });

    const continuationDeadline = new Date(expiredAt.getTime() + 24 * 60 * 60_000);
    expect(
      await resumeSpotifySyncCampaign(db, campaign.id, {
        expiresAt: continuationDeadline,
        now: expiredAt,
      }),
    ).toBe(true);
    expect(await getSpotifySyncCampaignStatus(db, campaign.id)).toMatchObject({
      campaignId: campaign.id,
      detailBacklog: 1,
      expiresAt: continuationDeadline,
      pendingMembers: 2,
      qualifyingSuccesses: 1,
      status: "running",
      target: 3,
    });
    expect(
      await resumeSpotifySyncCampaign(db, campaign.id, {
        expiresAt: continuationDeadline,
        now: expiredAt,
      }),
    ).toBe(false);

    const members = await db
      .select()
      .from(spotifySyncCampaignMembers)
      .where(eq(spotifySyncCampaignMembers.campaignId, campaign.id));
    expect(members).toHaveLength(3);
    expect(members.filter((member) => member.status === "succeeded")).toHaveLength(1);
    expect(members.filter((member) => member.status === "pending")).toHaveLength(2);
    const detail = await db.query.spotifySchedulerWork.findFirst({
      where: eq(spotifySchedulerWork.id, detailWorkId),
    });
    expect(detail).toMatchObject({ campaignId: campaign.id, status: "queued" });
    const next = await planSpotifySyncCampaignTick(db, campaign.id, expiredAt);
    expect(next).toMatchObject({
      campaignId: campaign.id,
      workType: "base_artist",
    });
    expect(next?.campaignMemberId).not.toBe(completed?.campaignMemberId);
    expect((await getSpotifySyncCampaignStatus(db, campaign.id))?.activeReservations).toBe(0);
  });

  it("recovers a stale expired running campaign without replacing its baseline", async () => {
    const now = new Date("2026-07-23T02:00:00.000Z");
    await createArtist("Stale first");
    await createArtist("Stale second");
    await reconcileSpotifySchedulerWork(db, now);
    const campaign = await createSpotifySyncCampaign(db, {
      canaryTarget: 2,
      expiresAt: new Date(now.getTime() + 60_000),
      now,
      targetSuccesses: 2,
    });
    await startSpotifySyncCampaign(db, campaign.id, now);
    const continuedAt = new Date(now.getTime() + 60_001);
    const continuationDeadline = new Date(continuedAt.getTime() + 24 * 60 * 60_000);

    expect(
      await resumeSpotifySyncCampaign(db, campaign.id, {
        expiresAt: continuationDeadline,
        now: continuedAt,
      }),
    ).toBe(true);
    expect(await getSpotifySyncCampaignStatus(db, campaign.id)).toMatchObject({
      baselineSize: 2,
      campaignId: campaign.id,
      expiresAt: continuationDeadline,
      pendingMembers: 2,
      qualifyingSuccesses: 0,
      status: "running",
      target: 2,
    });
  });

  it("rejects unsafe continuation deadlines and active campaign reservations", async () => {
    const now = new Date("2026-07-23T03:00:00.000Z");
    await createArtist("Reserved continuation");
    await createArtist("Later continuation");
    await reconcileSpotifySchedulerWork(db, now);
    const campaign = await createSpotifySyncCampaign(db, {
      canaryTarget: 2,
      expiresAt: new Date(now.getTime() + 60_000),
      now,
      targetSuccesses: 2,
    });
    await startSpotifySyncCampaign(db, campaign.id, now);
    expect(await claimSpotifySyncCampaignWork(db, campaign.id, now)).not.toBeNull();
    const expiredAt = new Date(now.getTime() + 60_001);

    await expect(
      resumeSpotifySyncCampaign(db, campaign.id, {
        expiresAt: new Date(expiredAt.getTime() + 24 * 60 * 60_000 + 1),
        now: expiredAt,
      }),
    ).rejects.toThrow("at most 24 hours");
    expect(
      await resumeSpotifySyncCampaign(db, campaign.id, {
        expiresAt: new Date(expiredAt.getTime() + 24 * 60 * 60_000),
        now: expiredAt,
      }),
    ).toBe(false);
    expect(await getSpotifySyncCampaignStatus(db, campaign.id)).toMatchObject({
      activeReservations: 1,
      qualifyingSuccesses: 0,
      status: "running",
    });
  });

  it("attributes only campaign-created release work and leaves unrelated work untouched", async () => {
    const now = new Date("2026-07-23T04:00:00.000Z");
    const artistId = await createArtist("Detail artist");
    await reconcileSpotifySchedulerWork(db, now);
    const campaign = await createSpotifySyncCampaign(db, {
      canaryTarget: 1,
      expiresAt: new Date(now.getTime() + 8 * 60 * 60_000),
      now,
      targetSuccesses: 1,
    });
    const member = await db.query.spotifySyncCampaignMembers.findFirst({
      where: eq(spotifySyncCampaignMembers.campaignId, campaign.id),
    });
    await queueSpotifyReleaseDetailWork(db, {
      artistId,
      campaignId: campaign.id,
      campaignMemberId: member!.id,
      dueAt: now,
      spotifyAlbumId: "campaign-album",
    });
    await queueSpotifyReleaseDetailWork(db, {
      artistId,
      dueAt: now,
      spotifyAlbumId: "unrelated-album",
    });
    const retrievalId = randomUUID();
    await db.execute(sql`
      insert into spotify_release_track_retrievals (id, spotify_album_id, expected_total_tracks)
      values (${retrievalId}, 'campaign-tracks', 1)
    `);
    await queueSpotifyCampaignReleaseTrackWork(db, {
      campaignId: campaign.id,
      campaignMemberId: member!.id,
      dueAt: now,
      releaseTrackRetrievalId: retrievalId,
      spotifyAlbumId: "campaign-tracks",
    });
    await startSpotifySyncCampaign(db, campaign.id, now);

    const first = await claimSpotifySyncCampaignWork(db, campaign.id, now);
    expect(first?.workType).toBe("base_artist");
    await recordSuccess(first!.artistId!, now);
    await finishSpotifySyncCampaignWork(db, first!, { status: "completed" }, now);
    const detail = await claimSpotifySyncCampaignWork(db, campaign.id, new Date(now.getTime() + 1));
    expect(detail).toMatchObject({ spotifyAlbumId: "campaign-album", workType: "release_detail" });
    const unrelated = await db.query.spotifySchedulerWork.findFirst({
      where: eq(spotifySchedulerWork.spotifyAlbumId, "unrelated-album"),
    });
    expect(unrelated).toMatchObject({ campaignId: null, status: "queued" });
  });

  it("blocks on cooldown and skips members that become ineligible before claim", async () => {
    const now = new Date("2026-07-23T04:30:00.000Z");
    await createArtist("Inactive before claim", { followedAt: now });
    await createArtist("Successful outside", { followedAt: new Date(now.getTime() + 1) });
    await createArtist("Still eligible", { followedAt: new Date(now.getTime() + 2) });
    await reconcileSpotifySchedulerWork(db, now);
    const campaign = await createSpotifySyncCampaign(db, {
      canaryTarget: 1,
      expiresAt: new Date(now.getTime() + 12 * 60 * 60_000),
      now,
      targetSuccesses: 1,
    });
    const members = await db
      .select()
      .from(spotifySyncCampaignMembers)
      .where(eq(spotifySyncCampaignMembers.campaignId, campaign.id))
      .orderBy(spotifySyncCampaignMembers.ordinal);
    await db
      .update(artistFollows)
      .set({ active: false })
      .where(eq(artistFollows.artistId, members[0]!.artistId));
    await recordSuccess(members[1]!.artistId, now);
    await db.insert(spotifyProviderState).values({
      cooldownObservedAt: now,
      cooldownUntil: new Date(now.getTime() + 60_000),
      id: "global",
    });
    await startSpotifySyncCampaign(db, campaign.id, now);

    expect(await claimSpotifySyncCampaignWork(db, campaign.id, now)).toBeNull();
    expect((await getSpotifySyncCampaignStatus(db, campaign.id))?.activeReservations).toBe(0);
    const claim = await claimSpotifySyncCampaignWork(
      db,
      campaign.id,
      new Date(now.getTime() + 60_001),
    );
    expect(claim?.artistId).toBe(members[2]!.artistId);
    expect((await getSpotifySyncCampaignStatus(db, campaign.id))?.skippedMembers).toBe(2);
  });

  it("enforces canary 10 and the exact 100 boundary in the 593/101/492 shape", async () => {
    const now = new Date("2026-07-23T05:00:00.000Z");
    const rows = Array.from({ length: 593 }, (_, index) => ({
      id: randomUUID(),
      name: `Scale ${index}`,
      normalizedName: `scale-${index}-${randomUUID()}`,
    }));
    await db.insert(artists).values(rows);
    await db.insert(artistFollows).values(
      rows.map((artist, index) => ({
        artistId: artist.id,
        followedAt: new Date(now.getTime() + (index % 7) * 1_000),
        source: "campaign-scale",
        userId,
      })),
    );
    await db.insert(artistExternalIds).values(
      rows.map((artist) => ({
        artistId: artist.id,
        confirmed: true,
        externalId: `spotify-${artist.id}`,
        mappingSource: "campaign-scale",
        provider: "spotify" as const,
      })),
    );
    await db.insert(spotifyArtistCoverage).values(
      rows.slice(0, 101).map((artist) => ({
        artistId: artist.id,
        dailyScanCompletedAt: now,
        partial: true,
        status: "daily_current",
      })),
    );
    await reconcileSpotifySchedulerWork(db, now);
    const campaign = await createSpotifySyncCampaign(db, {
      canaryTarget: 10,
      expiresAt: new Date(now.getTime() + 8 * 60 * 60_000),
      now,
      targetSuccesses: 100,
    });
    expect(campaign.baselineArtistCount).toBe(492);
    expect(await planSpotifySyncCampaignTick(db, campaign.id, now)).not.toBeNull();
    expect((await getSpotifySyncCampaignStatus(db, campaign.id))?.activeReservations).toBe(0);
    await startSpotifySyncCampaign(db, campaign.id, now);

    let tickAt = now;
    for (let index = 0; index < 10; index += 1) {
      const claim = await claimSpotifySyncCampaignWork(db, campaign.id, tickAt);
      expect(claim?.workType).toBe("base_artist");
      await recordSuccess(claim!.artistId!, tickAt);
      await finishSpotifySyncCampaignWork(db, claim!, { status: "completed" }, tickAt);
      tickAt = new Date(tickAt.getTime() + campaign.baseIntervalMs);
    }
    expect((await getSpotifySyncCampaignStatus(db, campaign.id))?.status).toBe("canary_review");
    expect(await claimSpotifySyncCampaignWork(db, campaign.id, tickAt)).toBeNull();
    expect(await advanceSpotifySyncCampaignCanary(db, campaign.id, true, tickAt)).toBe(true);

    for (let index = 10; index < 99; index += 1) {
      const claim = await claimSpotifySyncCampaignWork(db, campaign.id, tickAt);
      expect(claim?.workType).toBe("base_artist");
      await recordSuccess(claim!.artistId!, tickAt);
      await finishSpotifySyncCampaignWork(db, claim!, { status: "completed" }, tickAt);
      tickAt = new Date(tickAt.getTime() + campaign.baseIntervalMs);
    }
    const attempts = await Promise.all([
      claimSpotifySyncCampaignWork(db, campaign.id, tickAt),
      claimSpotifySyncCampaignWork(db, campaign.id, tickAt),
    ]);
    const claims = attempts.filter((value) => value !== null);
    expect(claims).toHaveLength(1);
    await recordSuccess(claims[0]!.artistId!, tickAt);
    await finishSpotifySyncCampaignWork(db, claims[0]!, { status: "completed" }, tickAt);

    const status = await getSpotifySyncCampaignStatus(db, campaign.id);
    expect(status).toMatchObject({
      activeReservations: 0,
      baselineSize: 492,
      qualifyingSuccesses: 100,
      status: "completed",
      target: 100,
    });
    expect(await claimSpotifySyncCampaignWork(db, campaign.id, tickAt)).toBeNull();
    expect(
      await db
        .select()
        .from(spotifySyncCampaignMembers)
        .where(andCampaignMemberStatus(campaign.id, ["succeeded"])),
    ).toHaveLength(100);
    expect(
      await db
        .select()
        .from(spotifySyncCampaignMembers)
        .where(andCampaignMemberStatus(campaign.id, ["reserved"])),
    ).toHaveLength(0);
  }, 180_000);
});

async function createArtist(
  label: string,
  options: { active?: boolean; followedAt?: Date; mapped?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await db
    .insert(artists)
    .values({ id, name: label, normalizedName: `${label}-${id}`.toLowerCase() });
  await db.insert(artistFollows).values({
    active: options.active ?? true,
    artistId: id,
    followedAt: options.followedAt ?? new Date(),
    source: "campaign-test",
    userId,
  });
  if (options.mapped ?? true) {
    await db.insert(artistExternalIds).values({
      artistId: id,
      confirmed: true,
      externalId: `spotify-${id}`,
      mappingSource: "campaign-test",
      provider: "spotify",
    });
  }
  return id;
}

async function recordSuccess(artistId: string, at: Date): Promise<void> {
  await db
    .insert(spotifyArtistCoverage)
    .values({ artistId, dailyScanCompletedAt: at, partial: true, status: "daily_current" })
    .onConflictDoUpdate({
      target: spotifyArtistCoverage.artistId,
      set: { dailyScanCompletedAt: at, updatedAt: at },
    });
}

function andCampaignMemberStatus(campaignId: string, statuses: Array<"succeeded" | "reserved">) {
  return and(
    eq(spotifySyncCampaignMembers.campaignId, campaignId),
    inArray(spotifySyncCampaignMembers.status, statuses),
  );
}
