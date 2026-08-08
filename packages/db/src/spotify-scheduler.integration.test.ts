import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type RadarDatabase } from "./client";
import {
  claimSpotifySchedulerWork,
  finishSpotifySchedulerWork,
  getSpotifySchedulerStatus,
  planSpotifySchedulerTick,
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
  spotifyProviderState,
  spotifyArtistCoverage,
  spotifyCatalogReleases,
  spotifyReleaseTrackRetrievals,
  spotifyRequestEvents,
  spotifySchedulerState,
  spotifySchedulerWork,
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
  await db.delete(spotifySchedulerWork);
  await db.delete(discoveryReconciliationCampaigns);
  await db.delete(spotifyRequestEvents);
  await db.delete(spotifyProviderState);
  await db.delete(artistFollows);
  await db
    .update(spotifySchedulerState)
    .set({
      cycleTargetArtists: 0,
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
  it("initializes idempotently, staggers never-scanned artists, and excludes ineligible artists", async () => {
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
    expect(refreshed.map((item) => item.artistId)).toEqual([eligible, added]);
    expect(refreshed[1]!.dueAt.getTime() - refreshed[0]!.dueAt.getTime()).toBeGreaterThanOrEqual(
      spotifySchedulerWindowMs / 2 - 1_000,
    );
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
    expect(status.requestCounts).toEqual({ byWorkType: {}, last24Hours: 0, last30Minutes: 0 });
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

  it("blocks broad work until the playlist inbox and Apple-priority queue are drained", async () => {
    const now = new Date("2026-07-22T18:00:00.000Z");
    const broadArtist = await createArtist("Broad", true, true);
    const priorityArtist = await createArtist("Apple priority", true, true);
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
      applePriorityQueuedCount: 1,
      broadSpotifyQueuedCount: 1,
      id: "global",
      phase: "playlist_inbox",
      playlistInboxStatus: "ready",
    });
    await db.insert(spotifySchedulerWork).values({
      artistId: priorityArtist,
      discoveryReconciliationCampaignId: campaignId,
      dueAt: now,
      expectedSpotifyArtistId: `spotify-${priorityArtist}`,
      priority: -100,
      source: "apple_priority",
      workKey: `priority:${priorityArtist}`,
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

    const broad = await claimSpotifySchedulerWork(db, new Date(now.getTime() + 1));
    expect(broad).toMatchObject({ workType: "base_artist" });
    await finishSpotifySchedulerWork(
      db,
      broad!,
      { status: "completed" },
      new Date(now.getTime() + 1),
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

  it("simulates 593 artists across a rolling day without starving base work", async () => {
    const now = new Date("2026-07-23T00:00:00.000Z");
    const artistRows = Array.from({ length: 593 }, (_, index) => ({
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
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const tickAt = new Date(now.getTime() + minute * 60_000);
      const claim = await claimSpotifySchedulerWork(db, tickAt);
      if (!claim) continue;
      expect(allClaims.has(claim.id)).toBe(false);
      allClaims.add(claim.id);
      requestStarts.push(tickAt.getTime());
      workCounts.set(claim.workType, (workCounts.get(claim.workType) ?? 0) + 1);
      if (claim.workType === "base_artist" && claim.artistId) baseClaims.add(claim.artistId);
      await finishSpotifySchedulerWork(db, claim, { status: "completed" }, tickAt);
    }

    expect(baseClaims.size).toBe(593);
    expect(workCounts.get("release_detail")).toBe(10);
    expect(workCounts.get("release_tracks")).toBe(10);
    expect(workCounts.get("artist_reconciliation")).toBeGreaterThan(0);
    expect(workCounts.get("artist_reconciliation")).toBeLessThan(10);
    expect(
      requestStarts.slice(1).every((value, index) => value - requestStarts[index]! >= 10_000),
    ).toBe(true);
    expect(await db.select().from(spotifySchedulerWork)).toHaveLength(623);
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
