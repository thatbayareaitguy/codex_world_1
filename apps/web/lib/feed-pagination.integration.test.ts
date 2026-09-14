import { normalizeText, type TrackCandidate } from "@radar/core";
import {
  createDatabase,
  feedItems,
  feedRevisions,
  releaseCandidates,
  releases,
  sourceEvidence,
  trackAvailabilities,
  tracks,
} from "@radar/db";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { persistCandidates } from "../../scanner/src/scan";
import { loadDatabaseFeed, loadDatabaseFeedPage, loadDatabaseFeedRevision } from "./feed-server";
import { loadDatabaseProviderActivity } from "./provider-status-server";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const cursorSecret = "synthetic-feed-pagination-secret";

describe.sequential("database feed pagination", () => {
  const connection = createDatabase(databaseUrl);

  beforeAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
    );
    await connection.db
      .update(feedRevisions)
      .set({ itemCount: 0, revision: 0, updatedAt: new Date(0) })
      .where(eq(feedRevisions.id, "global"));

    const albumTracks = Array.from({ length: 30 }, (_, index) =>
      spotifyCandidate(index, {
        releaseDate: "2026-07-20",
        releaseId: spotifyId(900),
        releaseTitle: "Large Synthetic Album",
        releaseType: "album",
        trackNumber: index + 1,
      }),
    );
    const singles = Array.from({ length: 10 }, (_, index) =>
      spotifyCandidate(index + 100, {
        releaseDate: `2026-07-${String(19 - index).padStart(2, "0")}`,
        releaseId: spotifyId(800 + index),
        releaseTitle: `Synthetic Single ${index + 1}`,
        releaseType: "single",
        trackNumber: 1,
      }),
    );
    await persistCandidates(connection.db, [...albumTracks, ...singles], {
      dryRun: false,
      full: false,
      provider: "spotify",
    });
  });

  afterAll(async () => {
    await connection.db.execute(
      sql`truncate table users, artists, releases, scan_runs restart identity cascade`,
    );
    await connection.client.end();
  });

  it("keeps a release group intact and advances without duplicates", async () => {
    const first = await loadDatabaseFeedPage(databaseUrl, {
      limit: 25,
      secret: cursorSecret,
    });
    expect(first.items).toHaveLength(30);
    expect(new Set(first.items.map((item) => item.releaseId)).size).toBe(1);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(first.totalCount).toBe(40);
    expect(first.items.map((item) => item.trackNumber)).toEqual(
      Array.from({ length: 30 }, (_, index) => index + 1),
    );

    const repeated = await loadDatabaseFeedPage(databaseUrl, {
      limit: 25,
      secret: cursorSecret,
    });
    expect(repeated.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));

    const second = await loadDatabaseFeedPage(databaseUrl, {
      cursor: first.nextCursor!,
      limit: 25,
      secret: cursorSecret,
    });
    expect(second.items).toHaveLength(10);
    expect(second.hasMore).toBe(false);
    expect(second.totalCount).toBe(40);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(40);

    const compatibilityProjection = await loadDatabaseFeed(databaseUrl);
    expect(compatibilityProjection).toEqual([...first.items, ...second.items]);
  });

  it("rejects tampered and query-mismatched cursors", async () => {
    const first = await loadDatabaseFeedPage(databaseUrl, { limit: 25, secret: cursorSecret });
    await expect(
      loadDatabaseFeedPage(databaseUrl, {
        cursor: `${first.nextCursor!}x`,
        limit: 25,
        secret: cursorSecret,
      }),
    ).rejects.toThrow(/cursor/i);
    await expect(
      loadDatabaseFeedPage(databaseUrl, {
        cursor: first.nextCursor!,
        filters: { search: "different query" },
        limit: 25,
        secret: cursorSecret,
      }),
    ).rejects.toThrow(/current query/i);
  });

  it("applies search and provider filters before pagination", async () => {
    const page = await loadDatabaseFeedPage(databaseUrl, {
      filters: {
        provider: "spotify",
        releaseType: "single",
        search: "synthetic single",
        sort: "first-seen",
        spotify: "available",
      },
      limit: 25,
      secret: cursorSecret,
    });
    expect(page.items).toHaveLength(10);
    expect(page.totalCount).toBe(10);
    expect(page.hasMore).toBe(false);
    expect(page.items.every((item) => item.releaseType === "single")).toBe(true);
  });

  it("reports providers observed in persisted source evidence", async () => {
    await expect(loadDatabaseProviderActivity(databaseUrl)).resolves.toEqual({
      appleMusic: false,
      spotify: true,
    });
  });

  it("projects a canonical Spotify track link when appearance evidence is absent", async () => {
    const [track] = await connection.db
      .select({ id: tracks.id, title: tracks.title })
      .from(tracks)
      .where(eq(tracks.title, "Synthetic Track 1"))
      .limit(1);
    await connection.db
      .delete(trackAvailabilities)
      .where(eq(trackAvailabilities.trackId, track!.id));
    const feed = await connection.db.query.feedItems.findFirst({
      where: eq(feedItems.trackId, track!.id),
    });
    await connection.db
      .delete(sourceEvidence)
      .where(eq(sourceEvidence.candidateId, feed!.candidateId!));

    const page = await loadDatabaseFeedPage(databaseUrl, {
      filters: { search: track!.title, spotify: "available" },
      limit: 25,
      secret: cursorSecret,
    });

    const projected = page.items.find((item) => item.title === "Synthetic Track 1");
    expect(projected).toMatchObject({ spotify: "playable", title: "Synthetic Track 1" });
    expect(projected!.sources.some((source) => source.provider === "Spotify")).toBe(true);

    const unavailable = await loadDatabaseFeedPage(databaseUrl, {
      filters: { search: track!.title, spotify: "unavailable" },
      limit: 25,
      secret: cursorSecret,
    });
    expect(unavailable.items.some((item) => item.title === "Synthetic Track 1")).toBe(false);
  });

  it("increments the durable revision when projected track data changes", async () => {
    const before = await loadDatabaseFeedRevision(databaseUrl);
    const [track] = await connection.db.select({ id: tracks.id }).from(tracks).limit(1);
    await connection.db
      .update(tracks)
      .set({ title: "Updated Synthetic Title", updatedAt: new Date() })
      .where(eq(tracks.id, track!.id));
    const after = await loadDatabaseFeedRevision(databaseUrl);
    expect(after.count).toBe(40);
    expect(after.revision).not.toBe(before.revision);
  });

  it("keeps an in-progress cursor stable when a newer item is inserted", async () => {
    const baseline = await loadDatabaseFeedPage(databaseUrl, {
      limit: 200,
      secret: cursorSecret,
    });
    const first = await loadDatabaseFeedPage(databaseUrl, {
      limit: 25,
      secret: cursorSecret,
    });
    await persistCandidates(
      connection.db,
      [
        spotifyCandidate(500, {
          releaseDate: "2026-07-21",
          releaseId: spotifyId(950),
          releaseTitle: "Inserted After First Page",
          releaseType: "single",
          trackNumber: 1,
        }),
      ],
      { dryRun: false, full: false, provider: "spotify" },
    );
    const second = await loadDatabaseFeedPage(databaseUrl, {
      cursor: first.nextCursor!,
      limit: 25,
      secret: cursorSecret,
    });
    const traversedIds = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(traversedIds).size).toBe(baseline.items.length);
    expect(new Set(traversedIds)).toEqual(new Set(baseline.items.map((item) => item.id)));
    expect(
      [...first.items, ...second.items].some(
        (item) => item.releaseTitle === "Inserted After First Page",
      ),
    ).toBe(false);

    const refreshed = await loadDatabaseFeedPage(databaseUrl, {
      limit: 25,
      secret: cursorSecret,
    });
    expect(refreshed.items.some((item) => item.releaseTitle === "Inserted After First Page")).toBe(
      true,
    );
  });

  it("omits an unsafe stored provider evidence URL from rendered links", async () => {
    const [evidence] = await connection.db
      .select({ id: sourceEvidence.id })
      .from(sourceEvidence)
      .limit(1);
    await connection.db
      .update(sourceEvidence)
      .set({ sourceUrl: "https://open.spotify.com.evil.example/track/0123456789ABCDEFGHIJKL" })
      .where(eq(sourceEvidence.id, evidence!.id));
    const page = await loadDatabaseFeedPage(databaseUrl, { limit: 200, secret: cursorSecret });
    expect(page.items.some((item) => item.links.length === 0)).toBe(true);
    expect(JSON.stringify(page.items)).not.toContain("evil.example");
  });

  it("does not leak upcoming siblings or an unreleased album group into New", async () => {
    const releaseId = spotifyId(970);
    const releasedTrackId = spotifyId(971);
    const upcomingTrackIds = [spotifyId(972), spotifyId(973)];
    await persistCandidates(
      connection.db,
      [releasedTrackId, ...upcomingTrackIds].map((trackId, index) => ({
        ...spotifyCandidate(700 + index, {
          releaseDate: "2026-09-25",
          releaseId,
          releaseTitle: "Future Grouped Album",
          releaseType: "album",
          trackNumber: index + 1,
        }),
        externalTrackId: trackId,
        title: index === 0 ? "Released Preview Single" : `Unreleased Album Track ${index}`,
      })),
      { dryRun: false, full: false, provider: "spotify" },
    );
    const rows = await connection.db
      .select({ feedId: feedItems.id, providerTrackId: releaseCandidates.providerTrackId })
      .from(feedItems)
      .innerJoin(releaseCandidates, eq(releaseCandidates.id, feedItems.candidateId))
      .where(inArray(releaseCandidates.providerTrackId, [releasedTrackId, ...upcomingTrackIds]));
    await connection.db
      .update(feedItems)
      .set({ state: "upcoming" })
      .where(
        inArray(
          feedItems.id,
          rows.map((row) => row.feedId),
        ),
      );
    await connection.db
      .update(feedItems)
      .set({ state: "new" })
      .where(
        inArray(
          feedItems.id,
          rows.filter((row) => row.providerTrackId === releasedTrackId).map((row) => row.feedId),
        ),
      );

    const newPage = await loadDatabaseFeedPage(databaseUrl, {
      filters: { search: "Future Grouped Album", state: "new" },
      limit: 25,
      secret: cursorSecret,
    });
    expect(newPage.items.map((item) => item.title)).toEqual(["Released Preview Single"]);

    const upcomingPage = await loadDatabaseFeedPage(databaseUrl, {
      filters: { search: "Future Grouped Album", state: "upcoming" },
      limit: 25,
      secret: cursorSecret,
    });
    expect(upcomingPage.items.map((item) => item.title).sort()).toEqual([
      "Unreleased Album Track 1",
      "Unreleased Album Track 2",
    ]);
    await connection.db
      .update(feedItems)
      .set({ state: "needs_review" })
      .where(
        inArray(
          feedItems.id,
          rows
            .filter((row) => row.providerTrackId === upcomingTrackIds[0])
            .map((row) => row.feedId),
        ),
      );
    const bothUpcoming = await loadDatabaseFeedPage(databaseUrl, {
      filters: { search: "Future Grouped Album", state: "upcoming" },
      secret: cursorSecret,
    });
    const bothReview = await loadDatabaseFeedPage(databaseUrl, {
      filters: { search: "Future Grouped Album", state: "needs_review" },
      secret: cursorSecret,
    });
    expect(bothUpcoming.items.map((item) => item.title).sort()).toEqual([
      "Unreleased Album Track 1",
      "Unreleased Album Track 2",
    ]);
    expect(bothReview.items.map((item) => item.title)).toEqual(["Unreleased Album Track 1"]);
  });

  it("projects incoming and proposed identities with cross-artist review warnings", async () => {
    const title = "Need You Projection Review";
    const canonicalIsrc = "USPRJ2600001";
    const canonicalCandidate: TrackCandidate = {
      ...spotifyCandidate(980, {
        releaseDate: "2026-09-11",
        releaseId: spotifyId(981),
        releaseTitle: "Need You Spotify Release",
        releaseType: "single",
        trackNumber: 1,
      }),
      artistExternalId: spotifyId(982),
      artistName: "Maurizzle",
      credits: [{ name: "Maurizzle", role: "primary" }],
      durationMs: 180_000,
      externalTrackId: spotifyId(983),
      isrc: canonicalIsrc,
      title,
    };
    await persistCandidates(connection.db, [canonicalCandidate], {
      dryRun: false,
      full: false,
      provider: "spotify",
    });
    const canonicalFeed = await connection.db.query.feedItems.findFirst({
      where: eq(feedItems.dedupeKey, `spotify:${spotifyId(981)}:${spotifyId(983)}`),
    });
    expect(canonicalFeed?.releaseId).toBeTruthy();
    expect(canonicalFeed?.trackId).toBeTruthy();
    const [incomingRelease] = await connection.db
      .insert(releases)
      .values({
        normalizedTitle: normalizeText("Need You Apple Release"),
        releaseDate: "2026-09-11",
        releaseDatePrecision: "day",
        releaseType: "single",
        title: "Need You Apple Release",
      })
      .returning({ id: releases.id });

    const appleCandidate: TrackCandidate = {
      artistExternalId: "1982000001",
      artistName: "Oliverse",
      availability: "unavailable",
      credits: [{ name: "Oliverse", role: "primary" }],
      durationMs: 231_000,
      evidenceType: "apple_music_catalog_singles",
      evidenceUrl: "https://music.apple.com/us/album/need-you/1981000001",
      externalReleaseId: "1981000001",
      externalTrackId: "1983000001",
      firstSeenAt: "2026-09-12T04:00:00.000Z",
      payloadHash: "projection-review-payload",
      provider: "apple_music",
      providerUrl: "https://music.apple.com/us/album/need-you/1981000001",
      region: "US",
      releaseDate: "2026-09-11",
      releaseDatePrecision: "day",
      releaseTitle: "Need You Apple Release",
      releaseType: "single",
      sourceLabel: "Apple Music Catalog",
      title,
      trackNumber: 1,
    };
    const [candidateRow] = await connection.db
      .insert(releaseCandidates)
      .values({
        artistExternalId: appleCandidate.artistExternalId,
        firstSeenAt: new Date(appleCandidate.firstSeenAt),
        matchConfidence: "0.600",
        matchReasons: ["Normalized titles are identical", "Score is below 0.93"],
        matchRule: "manual_review",
        matchStatus: "needs_review",
        matchedTrackId: canonicalFeed!.trackId,
        matchingAlgorithmVersion: "synthetic-legacy-review",
        normalizedTitle: normalizeText(title),
        payloadHash: appleCandidate.payloadHash,
        provider: "apple_music",
        providerReleaseId: appleCandidate.externalReleaseId,
        providerTrackId: appleCandidate.externalTrackId,
        rawPayload: appleCandidate,
        releaseDate: appleCandidate.releaseDate,
        title,
      })
      .returning({ id: releaseCandidates.id });
    await connection.db.insert(sourceEvidence).values({
      candidateId: candidateRow!.id,
      evidenceType: appleCandidate.evidenceType,
      externalId: appleCandidate.externalTrackId,
      payloadHash: appleCandidate.payloadHash,
      provider: "apple_music",
      sourceUrl: appleCandidate.evidenceUrl,
    });
    await connection.db.insert(feedItems).values({
      candidateId: candidateRow!.id,
      dedupeKey: `apple_music:${appleCandidate.externalReleaseId}:${appleCandidate.externalTrackId}`,
      firstSeenAt: new Date(appleCandidate.firstSeenAt),
      releaseId: incomingRelease!.id,
      state: "needs_review",
      trackId: null,
      userId: canonicalFeed!.userId,
    });

    const page = await loadDatabaseFeedPage(databaseUrl, {
      filters: { search: title, state: "needs_review" },
      limit: 25,
      secret: cursorSecret,
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.review).toMatchObject({
      exactIdentityMatch: false,
      groupKey: `${incomingRelease!.id}:${canonicalFeed!.trackId}`,
      incomingCandidate: {
        artist: "Oliverse",
        durationMs: 231_000,
        releaseDate: "2026-09-11",
        releaseTitle: "Need You Apple Release",
        releaseType: "single",
        title,
      },
      proposedCanonical: {
        artist: "Maurizzle",
        durationMs: 180_000,
        releaseDate: "2026-09-11",
        releaseTitle: "Need You Spotify Release",
        releaseType: "single",
        title,
      },
      warnings: ["artist_credit_mismatch", "duration_mismatch"],
    });

    await connection.db
      .update(releaseCandidates)
      .set({ rawPayload: { ...appleCandidate, isrc: canonicalIsrc } })
      .where(eq(releaseCandidates.id, candidateRow!.id));
    const exactPage = await loadDatabaseFeedPage(databaseUrl, {
      filters: { search: title, state: "needs_review" },
      limit: 25,
      secret: cursorSecret,
    });
    expect(exactPage.items[0]?.review).toMatchObject({
      exactIdentityMatch: true,
      groupKey: `${incomingRelease!.id}:${canonicalFeed!.trackId}`,
      warnings: ["artist_credit_mismatch", "duration_mismatch"],
    });
  });
});

function spotifyCandidate(
  index: number,
  release: {
    releaseDate: string;
    releaseId: string;
    releaseTitle: string;
    releaseType: "album" | "single";
    trackNumber: number;
  },
): TrackCandidate {
  const trackId = spotifyId(index + 1);
  return {
    artistExternalId: spotifyId(999),
    artistName: "Pagination Artist",
    availability: "playable",
    credits: [{ name: "Pagination Artist", role: "primary" }],
    durationMs: 180_000 + index,
    evidenceType: "spotify_track",
    evidenceUrl: `https://open.spotify.com/track/${trackId}`,
    externalReleaseId: release.releaseId,
    externalTrackId: trackId,
    firstSeenAt: `2026-07-21T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
    payloadHash: `pagination-${index}`,
    provider: "spotify",
    providerUrl: `https://open.spotify.com/track/${trackId}`,
    region: "US",
    releaseDate: release.releaseDate,
    releaseDatePrecision: "day",
    releaseTitle: release.releaseTitle,
    releaseType: release.releaseType,
    sourceLabel: "Spotify synthetic pagination fixture",
    title: `Synthetic Track ${index + 1}`,
    trackNumber: release.trackNumber,
  };
}

function spotifyId(value: number): string {
  return String(value).padStart(22, "0");
}
