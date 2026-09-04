import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type RadarDatabase } from "./client";
import { markDiscoveryPlaylistInboxStatus } from "./discovery-schedule";
import {
  claimSpotifySchedulerWork,
  defaultSchedulerLimits,
  finishSpotifySchedulerWork,
  getSpotifySchedulerStatus,
  planSpotifySchedulerTick,
  queueSpotifyTrackResolutionWork,
  reconcileDeferredPriorityTrackResolutionWork,
  reconcileSpotifySchedulerWork,
  setSpotifySchedulerMode,
  spotifySchedulerWindowMs,
} from "./spotify-scheduler";
import {
  artistExternalIds,
  artistFollows,
  artists,
  discoveryReconciliationCampaigns,
  discoveryScheduleState,
  feedItems,
  releaseTrackAppearances,
  releases,
  spotifyProviderState,
  spotifyArtistCoverage,
  spotifyCatalogReleases,
  spotifyReleaseTrackRetrievals,
  spotifyRequestEvents,
  spotifySchedulerDailyArtists,
  spotifySchedulerState,
  spotifySchedulerWork,
  releaseCandidates,
  trackCredits,
  trackExternalIds,
  tracks,
  users,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

let connection: ReturnType<typeof createDatabase>;
let db: RadarDatabase;
let userId: string;

beforeAll(async () => {
  connection = createDatabase(databaseUrl);
  db = connection.db;
  const [user] = await db
    .insert(users)
    .values({
      displayName: "Scheduler integration owner",
      email: `scheduler-${randomUUID()}@example.test`,
    })
    .returning({ id: users.id });
  if (!user) throw new Error("Scheduler integration user was not created.");
  userId = user.id;
});

beforeEach(async () => {
  await db.delete(discoveryScheduleState);
  await db.delete(spotifySchedulerDailyArtists);
  await db.delete(spotifySchedulerWork);
  await db.execute(sql`truncate table tracks restart identity cascade`);
  await db.delete(discoveryReconciliationCampaigns);
  await db.delete(spotifyRequestEvents);
  await db.delete(spotifyProviderState);
  await db.delete(artistFollows);
  await db
    .update(spotifySchedulerState)
    .set({
      cycleTargetArtists: 0,
      effectiveConfiguration: defaultSchedulerLimits(),
      mode: "disabled",
      nextBaseSlotAt: null,
    })
    .where(eq(spotifySchedulerState.id, "global"));
});

afterEach(async () => {
  await db.delete(spotifySchedulerWork);
  await db.delete(spotifyReleaseTrackRetrievals);
  await db.execute(sql`truncate table artists restart identity cascade`);
});

afterAll(async () => {
  await connection.client.end();
});

describe("Spotify rolling scheduler persistence", () => {
  it("queues Apple tracks missing Spotify evidence and retires the work after an exact match", async () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const artistId = await createArtist("Targeted resolution", true, true);
    await db.insert(artistExternalIds).values({
      artistId,
      confirmed: true,
      externalId: `apple-${artistId}`,
      mappingSource: "test",
      provider: "apple_music",
    });
    const [track] = await db
      .insert(tracks)
      .values({
        isrc: "CA5KR2665824",
        normalizedTitle: "wonky",
        title: "Wonky",
      })
      .returning({ id: tracks.id });
    if (!track) throw new Error("Target track was not created.");
    await db.insert(releaseCandidates).values({
      artistExternalId: `apple-${artistId}`,
      firstSeenAt: now,
      matchConfidence: "1.000",
      matchReasons: ["Synthetic exact Apple candidate"],
      matchingAlgorithmVersion: "test",
      matchRule: "exact_isrc",
      matchStatus: "matched",
      matchedTrackId: track.id,
      normalizedTitle: "wonky",
      payloadHash: "synthetic",
      provider: "apple_music",
      providerReleaseId: "apple-release",
      providerTrackId: "apple-track",
      rawPayload: {},
      releaseDate: "2026-07-26",
      title: "Wonky",
    });

    await reconcileSpotifySchedulerWork(db, now);
    await reconcileSpotifySchedulerWork(db, now);
    const resolution = await db.query.spotifySchedulerWork.findMany({
      where: eq(spotifySchedulerWork.workType, "track_resolution"),
    });
    expect(resolution).toHaveLength(1);
    expect(resolution[0]).toMatchObject({
      artistId,
      source: "repair",
      status: "queued",
      targetIsrc: "CA5KR2665824",
      targetTrackId: track.id,
      trackResolutionMode: "isrc",
    });

    await setSpotifySchedulerMode(db, "automatic", now);
    await markDiscoveryPlaylistInboxStatus(db, { status: "completed" }, now);
    const claim = await claimSpotifySchedulerWork(db, new Date(now.getTime() + 1));
    expect(claim).toMatchObject({ targetTrackId: track.id, workType: "track_resolution" });
    await finishSpotifySchedulerWork(db, claim!, { status: "completed" }, now);
    expect(
      await db.query.spotifySchedulerWork.findFirst({
        where: eq(spotifySchedulerWork.id, claim!.id),
      }),
    ).toMatchObject({
      dueAt: new Date(now.getTime() + spotifySchedulerWindowMs),
      status: "queued",
    });

    await db.insert(trackExternalIds).values({
      externalId: "spotify-track",
      provider: "spotify",
      providerUrl: "https://open.spotify.com/track/0123456789ABCDEFGHIJKL",
      trackId: track.id,
    });
    await reconcileSpotifySchedulerWork(db, new Date(now.getTime() + 2));
    expect(
      await db.query.spotifySchedulerWork.findFirst({
        where: eq(spotifySchedulerWork.id, claim!.id),
      }),
    ).toMatchObject({ status: "completed" });
  });

  it("prioritizes a user-supplied exact track link without consuming broad scan capacity", async () => {
    const now = new Date("2026-08-13T19:00:00.000Z");
    const artistId = await createArtist("Manual resolution", true, true);
    const [track] = await db
      .insert(tracks)
      .values({ isrc: "USABC2600002", normalizedTitle: "manual-track", title: "Manual Track" })
      .returning({ id: tracks.id });
    if (!track) throw new Error("Target track was not created.");
    await queueSpotifyTrackResolutionWork(db, {
      artistId,
      dueAt: now,
      expectedSpotifyArtistId: `spotify-${artistId}`,
      mode: "isrc",
      targetIsrc: "USABC2600002",
      targetTrackId: track.id,
    });
    await queueSpotifyTrackResolutionWork(db, {
      artistId,
      dueAt: now,
      expectedSpotifyArtistId: `spotify-${artistId}`,
      mode: "manual",
      spotifyTrackId: "0M6v8qTwT7wfiEsAmLQKdd",
      targetIsrc: "USABC2600002",
      targetTrackId: track.id,
    });
    await db
      .update(spotifySchedulerState)
      .set({
        effectiveConfiguration: { ...defaultSchedulerLimits(), maxBroadRequestsPerLocalDay: 0 },
        mode: "automatic",
      })
      .where(eq(spotifySchedulerState.id, "global"));

    expect(await claimSpotifySchedulerWork(db, now)).toMatchObject({
      targetSpotifyTrackId: "0M6v8qTwT7wfiEsAmLQKdd",
      trackResolutionMode: "manual",
    });
  });

  it("queues canonical followed tracks even when their source was not Apple Music", async () => {
    const now = new Date("2026-08-29T12:30:00.000Z");
    const artistId = await createArtist("Historical canonical resolver", true, true);
    const [release] = await db
      .insert(releases)
      .values({
        normalizedTitle: "historical canonical release",
        releaseDate: "2026-08-28",
        releaseDatePrecision: "day",
        releaseType: "single",
        title: "Historical Canonical Release",
      })
      .returning({ id: releases.id });
    const [track] = await db
      .insert(tracks)
      .values({
        isrc: "USABC2600015",
        normalizedTitle: "historical canonical track",
        releaseId: release!.id,
        title: "Historical Canonical Track",
      })
      .returning({ id: tracks.id });
    await db.insert(trackCredits).values({
      artistId,
      creditedName: "Historical canonical resolver",
      creditOrder: 0,
      role: "primary",
      trackId: track!.id,
    });
    const [appearance] = await db
      .insert(releaseTrackAppearances)
      .values({ releaseId: release!.id, trackId: track!.id })
      .returning({ id: releaseTrackAppearances.id });
    await db.insert(feedItems).values({
      appearanceId: appearance!.id,
      dedupeKey: `historical:${track!.id}`,
      firstSeenAt: now,
      releaseId: release!.id,
      state: "new",
      trackId: track!.id,
      userId,
    });

    await reconcileSpotifySchedulerWork(db, now);

    expect(
      await db.query.spotifySchedulerWork.findFirst({
        where: eq(spotifySchedulerWork.workKey, `track_resolution:isrc:${track!.id}`),
      }),
    ).toMatchObject({
      artistId,
      expectedSpotifyArtistId: `spotify-${artistId}`,
      source: "repair",
      status: "queued",
      targetIsrc: "USABC2600015",
      targetTrackId: track!.id,
      trackResolutionMode: "isrc",
    });
  });

  it("does not reopen completed automatic fallback work unless a user explicitly retries it", async () => {
    const now = new Date("2026-08-29T12:00:00.000Z");
    const artistId = await createArtist("Fallback retry guard", true, true);
    const [track] = await db
      .insert(tracks)
      .values({ isrc: "USABC2600014", normalizedTitle: "fallback-guard", title: "Fallback Guard" })
      .returning({ id: tracks.id });
    if (!track) throw new Error("Fallback guard target was not created.");
    const work = {
      artistId,
      dueAt: now,
      expectedSpotifyArtistId: `spotify-${artistId}`,
      mode: "single" as const,
      source: "repair" as const,
      targetIsrc: "USABC2600014",
      targetTrackId: track.id,
    };

    await queueSpotifyTrackResolutionWork(db, work);
    await db
      .update(spotifySchedulerWork)
      .set({ status: "completed" })
      .where(eq(spotifySchedulerWork.targetTrackId, track.id));

    await queueSpotifyTrackResolutionWork(db, { ...work, requeueCompleted: false });
    expect(
      await db.query.spotifySchedulerWork.findFirst({
        where: eq(spotifySchedulerWork.targetTrackId, track.id),
      }),
    ).toMatchObject({ status: "completed" });

    await queueSpotifyTrackResolutionWork(db, work);
    expect(
      await db.query.spotifySchedulerWork.findFirst({
        where: eq(spotifySchedulerWork.targetTrackId, track.id),
      }),
    ).toMatchObject({ status: "queued" });
  });

  it("moves completed Apple-priority ISRC retries into normal repair work", async () => {
    const now = new Date("2026-08-22T06:30:00.000Z");
    const artistId = await createArtist("Priority retry", true, true);
    const [track] = await db
      .insert(tracks)
      .values({ isrc: "USABC2600011", normalizedTitle: "priority-retry", title: "Priority Retry" })
      .returning({ id: tracks.id });
    if (!track) throw new Error("Priority retry target was not created.");
    await queueSpotifyTrackResolutionWork(db, {
      artistId,
      dueAt: now,
      expectedSpotifyArtistId: `spotify-${artistId}`,
      mode: "isrc",
      source: "apple_priority",
      targetIsrc: "USABC2600011",
      targetTrackId: track.id,
    });
    await db.insert(discoveryScheduleState).values({
      id: "global",
      phase: "apple_priority",
      playlistInboxStatus: "pending",
    });
    await setSpotifySchedulerMode(db, "automatic", now);

    const claim = await claimSpotifySchedulerWork(db, now);
    expect(claim).toMatchObject({ source: "apple_priority", workType: "track_resolution" });
    await finishSpotifySchedulerWork(db, claim!, { status: "completed" }, now);

    expect(
      await db.query.spotifySchedulerWork.findFirst({
        where: eq(spotifySchedulerWork.id, claim!.id),
      }),
    ).toMatchObject({
      dueAt: new Date(now.getTime() + spotifySchedulerWindowMs),
      source: "repair",
      status: "queued",
    });
  });

  it("repairs future-dated priority ISRC rows without moving immediate first attempts", async () => {
    const now = new Date("2026-08-22T06:40:00.000Z");
    const artistId = await createArtist("Legacy priority retry", true, true);
    const [futureTrack, immediateTrack] = await db
      .insert(tracks)
      .values([
        { isrc: "USABC2600012", normalizedTitle: "future-retry", title: "Future Retry" },
        { isrc: "USABC2600013", normalizedTitle: "immediate-check", title: "Immediate Check" },
      ])
      .returning({ id: tracks.id });
    if (!futureTrack || !immediateTrack) throw new Error("Legacy retry targets were not created.");
    await queueSpotifyTrackResolutionWork(db, {
      artistId,
      dueAt: new Date(now.getTime() + spotifySchedulerWindowMs),
      expectedSpotifyArtistId: `spotify-${artistId}`,
      mode: "isrc",
      source: "apple_priority",
      targetIsrc: "USABC2600012",
      targetTrackId: futureTrack.id,
    });
    await queueSpotifyTrackResolutionWork(db, {
      artistId,
      dueAt: now,
      expectedSpotifyArtistId: `spotify-${artistId}`,
      mode: "isrc",
      source: "apple_priority",
      targetIsrc: "USABC2600013",
      targetTrackId: immediateTrack.id,
    });
    await db
      .update(spotifySchedulerWork)
      .set({ attemptCount: 1 })
      .where(eq(spotifySchedulerWork.targetTrackId, futureTrack.id));

    await expect(reconcileDeferredPriorityTrackResolutionWork(db, now)).resolves.toBe(1);
    const rows = await db
      .select({
        source: spotifySchedulerWork.source,
        targetTrackId: spotifySchedulerWork.targetTrackId,
      })
      .from(spotifySchedulerWork)
      .where(inArray(spotifySchedulerWork.targetTrackId, [futureTrack.id, immediateTrack.id]));
    expect(rows.find((row) => row.targetTrackId === futureTrack.id)?.source).toBe("repair");
    expect(rows.find((row) => row.targetTrackId === immediateTrack.id)?.source).toBe(
      "apple_priority",
    );
  });

  it("blocks broad Artist Albums work at 60 calls while preserving priority capacity", async () => {
    const now = new Date("2026-07-25T12:00:00.000Z");
    const broadArtist = await createArtist("Budget broad", true, true);
    const priorityArtist = await createArtist("Budget priority", true, true);
    const limits = defaultSchedulerLimits();
    await reconcileSpotifySchedulerWork(db, now, limits);
    await setSpotifySchedulerMode(db, "automatic", now);
    await db.insert(spotifyRequestEvents).values(
      Array.from({ length: 60 }, (_, index) => ({
        endpointCategory: "artist_albums",
        id: randomUUID(),
        method: "GET",
        quotaLane: "broad" as const,
        queueWaitMs: 0,
        startedAt: new Date(now.getTime() - 2 * 60 * 60_000 - index * 1_000),
        status: 200,
      })),
    );

    expect(await claimSpotifySchedulerWork(db, now)).toBeNull();

    await db.insert(discoveryScheduleState).values({
      id: "global",
      phase: "apple_priority",
      playlistInboxStatus: "completed",
    });
    await db.insert(spotifySchedulerWork).values({
      artistId: priorityArtist,
      dueAt: now,
      expectedSpotifyArtistId: `spotify-${priorityArtist}`,
      priority: -100,
      source: "apple_priority",
      workKey: `budget-priority:${priorityArtist}`,
      workType: "artist_reconciliation",
    });
    const priority = await claimSpotifySchedulerWork(db, now);
    expect(priority).toMatchObject({ artistId: priorityArtist, source: "apple_priority" });
    expect(priority?.artistId).not.toBe(broadArtist);
  });

  it("initializes idempotently, prioritizes never-scanned artists, and excludes ineligible artists", async () => {
    const now = new Date("2026-07-22T12:00:00.000Z");
    const eligible = await createArtist("Eligible", true, true);
    const inactive = await createArtist("Inactive", false, true);
    const unconfirmed = await createArtist("Unconfirmed", true, false);
    await createArtist("Unmapped", true, null);

    await reconcileSpotifySchedulerWork(db, now);
    await reconcileSpotifySchedulerWork(db, now);

    const work = await db.query.spotifySchedulerWork.findMany({
      where: eq(spotifySchedulerWork.workType, "base_artist"),
    });
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ artistId: eligible, source: "initial", status: "queued" });
    expect(work[0]!.dueAt).toEqual(now);
    expect(work.some((item) => item.artistId === inactive)).toBe(false);
    expect(work.some((item) => item.artistId === unconfirmed)).toBe(false);

    const added = await createArtist("Newly followed", true, true);
    await reconcileSpotifySchedulerWork(db, new Date(now.getTime() + 1_000));
    const refreshed = await db.query.spotifySchedulerWork.findMany({
      where: eq(spotifySchedulerWork.workType, "base_artist"),
      orderBy: (table, { asc }) => [asc(table.dueAt)],
    });
    expect(new Set(refreshed.map((item) => item.artistId))).toEqual(new Set([eligible, added]));
    expect(refreshed.every((item) => item.source === "initial" && item.priority === 0)).toBe(true);
  });

  it("claims the most overdue work deterministically and recovers only expired leases", async () => {
    const now = new Date("2026-07-22T13:00:00.000Z");
    const first = await createArtist("First due", true, true);
    const second = await createArtist("Second due", true, true);
    await reconcileSpotifySchedulerWork(db, now);
    await db
      .update(spotifySchedulerWork)
      .set({ dueAt: new Date(now.getTime() - 60_000) })
      .where(inArray(spotifySchedulerWork.artistId, [first, second]));
    await setSpotifySchedulerMode(db, "automatic", now);

    const expected = [first, second].sort()[0];
    const claimed = await claimSpotifySchedulerWork(db, now);
    expect(claimed?.artistId).toBe(expected);
    const other = await claimSpotifySchedulerWork(db, now);
    expect(other?.artistId).not.toBe(expected);

    await db
      .update(spotifySchedulerState)
      .set({ nextBaseSlotAt: null })
      .where(eq(spotifySchedulerState.id, "global"));
    await db
      .update(spotifySchedulerWork)
      .set({ leaseExpiresAt: new Date(now.getTime() - 1), leaseOwner: "expired", status: "leased" })
      .where(eq(spotifySchedulerWork.id, claimed!.id));
    const recovered = await claimSpotifySchedulerWork(db, now);
    expect(recovered?.id).toBe(claimed?.id);
    expect(recovered?.leaseOwner).not.toBe("expired");
  });

  it("blocks claims during cooldown and resumes with the most overdue artist afterward", async () => {
    const now = new Date("2026-07-22T14:00:00.000Z");
    const artistId = await createArtist("Cooldown", true, true);
    await reconcileSpotifySchedulerWork(db, now);
    await setSpotifySchedulerMode(db, "automatic", now);
    await db.insert(spotifyProviderState).values({
      cooldownObservedAt: now,
      cooldownUntil: new Date(now.getTime() + 60_000),
      id: "global",
    });

    expect(await claimSpotifySchedulerWork(db, now)).toBeNull();
    const resumed = await claimSpotifySchedulerWork(db, new Date(now.getTime() + 60_001));
    expect(resumed?.artistId).toBe(artistId);
  });

  it("plans without claiming or mutating scheduler work", async () => {
    const now = new Date("2026-07-22T15:00:00.000Z");
    await createArtist("Plan only", true, true);
    await reconcileSpotifySchedulerWork(db, now);
    const before = await db.select().from(spotifySchedulerWork);

    const plan = await planSpotifySchedulerTick(db, now);
    const after = await db.select().from(spotifySchedulerWork);

    expect(plan.selected?.workType).toBe("base_artist");
    expect(after).toEqual(before);
    expect(after.every((item) => item.status === "queued" && item.leaseOwner === null)).toBe(true);
  });

  it("reports bounded backlog, cooldown, lease, and request status fields", async () => {
    const now = new Date("2026-07-22T16:00:00.000Z");
    await createArtist("Status", true, true);
    await reconcileSpotifySchedulerWork(db, now);
    const status = await getSpotifySchedulerStatus(db, now);

    expect(status).toMatchObject({
      activeLease: null,
      backlog: { base_artist: 1 },
      cooldownActive: false,
      eligibleArtistCount: 1,
      mode: "disabled",
      targetArtistCount: 1,
    });
    expect(status.estimatedCompletion.earliest).toBeInstanceOf(Date);
    expect(status.requestCounts).toEqual({
      byEndpointCategory: {
        album_detail: 0,
        album_tracks: 0,
        artist_albums: 0,
        oauth_or_other: 0,
        playlist_read: 0,
        playlist_write: 0,
      },
      byWorkType: {},
      last24Hours: 0,
      last30Minutes: 0,
    });
  });

  it("queues recent catalog releases without details and protects due base work", async () => {
    const now = new Date("2026-07-22T16:30:00.000Z");
    const artistId = await createArtist("Detail queue", true, true);
    await db.insert(spotifyCatalogReleases).values({
      artistId,
      externalReleaseId: "spotify-detail-album",
      lastObservedAt: now,
      releaseDate: "2026-07-20",
      releaseDatePrecision: "day",
      releaseType: "album",
      summaryHash: "summary",
      title: "Queued detail",
      totalTracks: 12,
    });

    await reconcileSpotifySchedulerWork(db, now);
    await setSpotifySchedulerMode(db, "automatic", now);
    const work = await db.select().from(spotifySchedulerWork);
    expect(work.filter((item) => item.workType === "release_detail")).toHaveLength(1);

    const base = await claimSpotifySchedulerWork(db, now);
    expect(base?.workType).toBe("base_artist");
    await finishSpotifySchedulerWork(db, base!, { status: "completed" }, now);
    const detail = await claimSpotifySchedulerWork(db, new Date(now.getTime() + 1));
    expect(detail).toMatchObject({
      artistId,
      spotifyAlbumId: "spotify-detail-album",
      workType: "release_detail",
    });
  });

  it("requeues successful base work for the next rolling day without duplicating it", async () => {
    const now = new Date("2026-07-22T17:00:00.000Z");
    await createArtist("Recurring", true, true);
    await reconcileSpotifySchedulerWork(db, now);
    await setSpotifySchedulerMode(db, "automatic", now);
    const claim = await claimSpotifySchedulerWork(db, now);
    expect(claim).not.toBeNull();
    expect(await finishSpotifySchedulerWork(db, claim!, { status: "completed" }, now)).toBe(true);

    const work = await db.select().from(spotifySchedulerWork);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ attemptCount: 1, status: "queued" });
    expect(work[0]!.dueAt).toEqual(new Date(now.getTime() + spotifySchedulerWindowMs));
  });

  it("blocks broad Spotify work on Thursday and Friday while allowing Apple priority", async () => {
    const thursday = new Date("2026-08-13T19:00:00.000Z");
    const broadArtist = await createArtist("Thursday broad", true, true);
    const priorityArtist = await createArtist("Thursday priority", true, true);
    await reconcileSpotifySchedulerWork(db, thursday);
    await setSpotifySchedulerMode(db, "automatic", thursday);

    expect(await claimSpotifySchedulerWork(db, thursday)).toBeNull();
    await db.insert(spotifySchedulerWork).values({
      artistId: priorityArtist,
      dueAt: thursday,
      expectedSpotifyArtistId: `spotify-${priorityArtist}`,
      priority: -100,
      source: "apple_priority",
      workKey: `thursday-priority:${priorityArtist}`,
      workType: "artist_reconciliation",
    });
    const claim = await claimSpotifySchedulerWork(db, thursday);
    expect(claim).toMatchObject({ artistId: priorityArtist, source: "apple_priority" });
    expect(claim?.artistId).not.toBe(broadArtist);
  });

  it("enforces separate local-day broad artist and request ceilings", async () => {
    const saturday = new Date("2026-08-15T19:00:00.000Z");
    await createArtist("Saturday first", true, true);
    await createArtist("Saturday second", true, true);
    await reconcileSpotifySchedulerWork(db, saturday);
    await db
      .update(spotifySchedulerState)
      .set({
        effectiveConfiguration: {
          ...defaultSchedulerLimits(),
          maxBroadArtistsPerLocalDay: 1,
          maxBroadRequestsPerLocalDay: 6,
        },
        mode: "automatic",
        nextBaseSlotAt: null,
      })
      .where(eq(spotifySchedulerState.id, "global"));
    const first = await claimSpotifySchedulerWork(db, saturday);
    expect(first?.workType).toBe("base_artist");
    await finishSpotifySchedulerWork(db, first!, { status: "completed" }, saturday);
    await db
      .update(spotifySchedulerState)
      .set({ nextBaseSlotAt: null })
      .where(eq(spotifySchedulerState.id, "global"));
    expect(await claimSpotifySchedulerWork(db, new Date(saturday.getTime() + 1))).toBeNull();

    const status = await getSpotifySchedulerStatus(db, saturday);
    expect(status.dailyBudget).toMatchObject({
      broadArtistsLimit: 1,
      broadArtistsUsed: 1,
      broadRequestsLimit: 6,
      broadRequestsUsed: 0,
      localDate: "2026-08-15",
    });

    await db.insert(spotifyRequestEvents).values(
      Array.from({ length: 6 }, (_, index) => ({
        endpointCategory: "artist_albums",
        method: "GET",
        schedulerWorkId: first!.id,
        schedulerWorkType: "base_artist" as const,
        startedAt: new Date(saturday.getTime() + index * 10_000),
        status: 200,
      })),
    );
    const requestLimited = await getSpotifySchedulerStatus(
      db,
      new Date(saturday.getTime() + 60_000),
    );
    expect(requestLimited.dailyBudget.broadRequestsUsed).toBe(6);
  });

  it("checkpoints playlist export between full, catch-up, and broad Spotify work", async () => {
    const now = new Date("2026-07-22T18:00:00.000Z");
    const broadArtist = await createArtist("Broad", true, true);
    const priorityArtist = await createArtist("Apple priority", true, true);
    const catchupArtist = await createArtist("Apple catch-up", true, true);
    const campaignId = randomUUID();
    await reconcileSpotifySchedulerWork(db, now);
    await db.insert(discoveryReconciliationCampaigns).values({
      appleArtistsScanned: 2,
      campaignKey: `scheduler-priority-${campaignId}`,
      effectiveConfiguration: {},
      id: campaignId,
      spotifyCohortSize: 1,
      spotifyPageLimit: 1,
      spotifyRotationSize: 1,
      totalArtists: 2,
      windowEnd: "2026-07-22",
      windowStart: "2026-06-22",
    });
    await db.insert(discoveryScheduleState).values({
      activeCampaignId: campaignId,
      applePriorityQueuedCount: 2,
      broadSpotifyQueuedCount: 1,
      id: "global",
      phase: "playlist_inbox",
      playlistInboxStatus: "ready",
    });
    await db.insert(spotifySchedulerWork).values({
      artistId: priorityArtist,
      dueAt: now,
      expectedSpotifyArtistId: `spotify-${priorityArtist}`,
      priority: -100,
      source: "apple_priority",
      workKey: `priority:${priorityArtist}`,
      workType: "artist_reconciliation",
    });
    await db.insert(spotifySchedulerWork).values({
      artistId: catchupArtist,
      dueAt: now,
      expectedSpotifyArtistId: `spotify-${catchupArtist}`,
      priority: -80,
      source: "apple_catchup",
      workKey: `catchup:${catchupArtist}`,
      workType: "artist_reconciliation",
    });
    await db
      .update(spotifySchedulerWork)
      .set({ discoveryReconciliationCampaignId: campaignId, dueAt: now })
      .where(eq(spotifySchedulerWork.artistId, broadArtist));
    await setSpotifySchedulerMode(db, "automatic", now);

    expect(await claimSpotifySchedulerWork(db, now)).toBeNull();
    await db
      .update(discoveryScheduleState)
      .set({ phase: "apple_priority", playlistInboxStatus: "completed" })
      .where(eq(discoveryScheduleState.id, "global"));
    const priority = await claimSpotifySchedulerWork(db, now);
    expect(priority).toMatchObject({ artistId: priorityArtist, source: "apple_priority" });
    await finishSpotifySchedulerWork(db, priority!, { status: "completed" }, now);

    expect(await claimSpotifySchedulerWork(db, new Date(now.getTime() + 1))).toBeNull();
    expect(
      await db.query.discoveryScheduleState.findFirst({
        where: eq(discoveryScheduleState.id, "global"),
      }),
    ).toMatchObject({ phase: "playlist_inbox", playlistInboxStatus: "ready" });
    await markDiscoveryPlaylistInboxStatus(
      db,
      { status: "completed" },
      new Date(now.getTime() + 2),
    );
    expect(
      await db.query.discoveryScheduleState.findFirst({
        where: eq(discoveryScheduleState.id, "global"),
      }),
    ).toMatchObject({ phase: "apple_catchup_priority" });
    const catchup = await claimSpotifySchedulerWork(db, new Date(now.getTime() + 3));
    expect(catchup).toMatchObject({ artistId: catchupArtist, source: "apple_catchup" });
    await finishSpotifySchedulerWork(
      db,
      catchup!,
      { status: "completed" },
      new Date(now.getTime() + 3),
    );
    expect(await claimSpotifySchedulerWork(db, new Date(now.getTime() + 4))).toBeNull();
    expect(
      await db.query.discoveryScheduleState.findFirst({
        where: eq(discoveryScheduleState.id, "global"),
      }),
    ).toMatchObject({ phase: "playlist_inbox", playlistInboxStatus: "ready" });
    await markDiscoveryPlaylistInboxStatus(
      db,
      { status: "completed" },
      new Date(now.getTime() + 5),
    );
    const broad = await claimSpotifySchedulerWork(db, new Date(now.getTime() + 6));
    expect(broad).toMatchObject({ workType: "base_artist" });
    await finishSpotifySchedulerWork(
      db,
      broad!,
      { status: "completed" },
      new Date(now.getTime() + 6),
    );
    expect(
      await db.query.spotifySchedulerWork.findFirst({
        where: eq(spotifySchedulerWork.id, broad!.id),
      }),
    ).toMatchObject({ discoveryReconciliationCampaignId: null });
    expect(
      await db.query.discoveryScheduleState.findFirst({
        where: eq(discoveryScheduleState.id, "global"),
      }),
    ).toMatchObject({ phase: "broad_spotify" });
  });

  it("restores the playlist checkpoint after a persisted cooldown expires", async () => {
    const now = new Date("2026-08-08T19:00:00.000Z");
    const priorityArtist = await createArtist("Cooldown priority", true, true);
    await reconcileSpotifySchedulerWork(db, now);
    await db.insert(discoveryScheduleState).values({
      applePriorityQueuedCount: 1,
      id: "global",
      phase: "cooldown_wait",
      playlistInboxStatus: "ready",
    });
    await db.insert(spotifySchedulerWork).values({
      artistId: priorityArtist,
      dueAt: now,
      expectedSpotifyArtistId: `spotify-${priorityArtist}`,
      priority: -100,
      source: "apple_priority",
      workKey: `cooldown-priority:${priorityArtist}`,
      workType: "artist_reconciliation",
    });
    await setSpotifySchedulerMode(db, "automatic", now);

    expect(await claimSpotifySchedulerWork(db, now)).toBeNull();
    expect(
      await db.query.discoveryScheduleState.findFirst({
        where: eq(discoveryScheduleState.id, "global"),
      }),
    ).toMatchObject({ phase: "playlist_inbox", playlistInboxStatus: "ready" });
  });

  it("caps a large backlog at 75 broad artists per local day without starving detail work", async () => {
    const now = new Date("2026-07-25T07:00:00.000Z");
    const artistRows = Array.from({ length: 80 }, (_, index) => ({
      id: randomUUID(),
      name: `Scale artist ${index}`,
      normalizedName: `scale-artist-${index}-${randomUUID()}`,
    }));
    await db.insert(artists).values(artistRows);
    await db.insert(artistFollows).values(
      artistRows.map((artist, index) => ({
        artistId: artist.id,
        followedAt: new Date(now.getTime() + (index % 7) * 1_000),
        source: "scale-test",
        userId,
      })),
    );
    await db.insert(artistExternalIds).values(
      artistRows.map((artist) => ({
        artistId: artist.id,
        confirmed: true,
        externalId: `spotify-scale-${artist.id}`,
        mappingSource: "scale-test",
        provider: "spotify" as const,
      })),
    );
    await db.insert(spotifyArtistCoverage).values(
      artistRows.slice(0, 101).map((artist) => ({
        artistId: artist.id,
        dailyScanCompletedAt: new Date(now.getTime() - spotifySchedulerWindowMs),
        partial: false,
        status: "daily_scan_current",
      })),
    );
    await reconcileSpotifySchedulerWork(db, now);
    const retrievals = await db
      .insert(spotifyReleaseTrackRetrievals)
      .values(
        Array.from({ length: 10 }, (_, index) => ({
          expectedTotalTracks: 100,
          spotifyAlbumId: `scale-album-${index}`,
        })),
      )
      .returning();
    await db.insert(spotifySchedulerWork).values([
      ...Array.from({ length: 10 }, (_, index) => ({
        dueAt: now,
        priority: 30,
        source: "repair" as const,
        spotifyAlbumId: `scale-detail-${index}`,
        workKey: `scale-release-detail:${index}`,
        workType: "release_detail" as const,
      })),
      ...retrievals.map((retrieval) => ({
        dueAt: now,
        priority: 20,
        releaseTrackRetrievalId: retrieval.id,
        source: "repair" as const,
        spotifyAlbumId: retrieval.spotifyAlbumId,
        workKey: `scale-release-tracks:${retrieval.id}`,
        workType: "release_tracks" as const,
      })),
      ...artistRows.slice(0, 10).map((artist, index) => ({
        artistId: artist.id,
        dueAt: now,
        expectedSpotifyArtistId: `spotify-scale-${artist.id}`,
        priority: 400,
        source: "recurring" as const,
        workKey: `scale-reconciliation:${index}`,
        workType: "artist_reconciliation" as const,
      })),
    ]);
    await setSpotifySchedulerMode(db, "automatic", now);

    const baseClaims = new Set<string>();
    const allClaims = new Set<string>();
    const requestStarts: number[] = [];
    const workCounts = new Map<string, number>();
    for (let slot = 0; slot < 144; slot += 1) {
      const tickAt = new Date(now.getTime() + slot * 10 * 60_000);
      const claim = await claimSpotifySchedulerWork(db, tickAt);
      if (!claim) continue;
      expect(allClaims.has(claim.id)).toBe(false);
      allClaims.add(claim.id);
      requestStarts.push(tickAt.getTime());
      workCounts.set(claim.workType, (workCounts.get(claim.workType) ?? 0) + 1);
      if (claim.workType === "base_artist" && claim.artistId) baseClaims.add(claim.artistId);
      await finishSpotifySchedulerWork(db, claim, { status: "completed" }, tickAt);
    }

    expect(baseClaims.size).toBe(75);
    expect(workCounts.get("release_detail")).toBe(10);
    expect(workCounts.get("release_tracks")).toBe(10);
    expect(workCounts.get("artist_reconciliation")).toBe(10);
    expect(
      requestStarts.slice(1).every((value, index) => value - requestStarts[index]! >= 10_000),
    ).toBe(true);
    expect(await db.select().from(spotifySchedulerWork)).toHaveLength(110);
  }, 120_000);
});

async function createArtist(
  label: string,
  active: boolean,
  confirmed: boolean | null,
): Promise<string> {
  const id = randomUUID();
  await db
    .insert(artists)
    .values({ id, name: label, normalizedName: `${label}-${id}`.toLowerCase() });
  await db.insert(artistFollows).values({ active, artistId: id, source: "test", userId });
  if (confirmed !== null) {
    await db.insert(artistExternalIds).values({
      artistId: id,
      confirmed,
      externalId: `spotify-${id}`,
      mappingSource: "test",
      provider: "spotify",
    });
  }
  return id;
}
