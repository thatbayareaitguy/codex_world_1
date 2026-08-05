import { describe, expect, it } from "vitest";
import {
  groupSpotifyPlaylistAdditions,
  planSpotifyPlaylistExport,
  planSpotifyPlaylistSync,
  type SpotifyPlaylistExportCandidate,
} from "./spotify-playlist";

describe("Spotify playlist planning", () => {
  it("deduplicates exact matches and rejects ambiguous tracks", () => {
    const plan = planSpotifyPlaylistSync(
      [
        item("0000000000000000000001", "exact_isrc", 1),
        item("0000000000000000000001", "exact_isrc", 1),
        item("0000000000000000000002", "metadata", 0.8),
        { ...item("0000000000000000000003", "manual_review", 0.8), manuallyConfirmed: true },
        item("0000000000000000000004", "new_canonical", 1),
      ],
      new Set(["0000000000000000000001"]),
    );

    expect(plan).toEqual({
      alreadyPresent: ["0000000000000000000001"],
      rejected: [
        {
          providerTrackId: "0000000000000000000002",
          reason: "Only exact or manually confirmed matches may be exported",
        },
      ],
      toAdd: ["0000000000000000000003", "0000000000000000000004"],
    });
  });

  it("keeps only followed exact or confirmed canonical feed items and reports every skip reason", () => {
    const candidates = [
      candidate("1", "0000000000000000000001"),
      candidate("2", "0000000000000000000002", { matchRule: "metadata", confidence: 0.7 }),
      candidate("3", "0000000000000000000003", {
        matchRule: "manual_confirmation",
        confidence: 0.7,
        manuallyConfirmed: true,
      }),
      candidate("4", undefined),
      candidate("5", "bad", {}),
      candidate("6", "0000000000000000000006", { followedArtist: false }),
      candidate("7", "0000000000000000000007", { feedState: "dismissed" }),
      candidate("8", "0000000000000000000008", { feedState: "needs_review" }),
    ];
    const plan = planSpotifyPlaylistExport(candidates, [], new Set());

    expect(plan.desired.map((item) => item.feedItemId)).toEqual(["1", "3"]);
    expect(plan.skips.map((item) => item.reason).sort()).toEqual([
      "feed_dismissed",
      "malformed_spotify_track_id",
      "missing_spotify_match",
      "needs_review",
      "not_followed_artist",
      "uncertain_spotify_match",
    ]);
  });

  it("orders newest releases first, keeps album tracks contiguous, and preserves user tracks", () => {
    const userA = "9999999999999999999998";
    const userB = "9999999999999999999999";
    const candidates = [
      candidate("old-2", "0000000000000000000002", {
        releaseDate: "2026-07-01",
        releaseId: "old",
        trackNumber: 2,
      }),
      candidate("new-2", "0000000000000000000004", {
        releaseDate: "2026-08-01",
        releaseId: "new",
        trackNumber: 2,
      }),
      candidate("new-1", "0000000000000000000003", {
        releaseDate: "2026-08-01",
        releaseId: "new",
        trackNumber: 1,
      }),
      candidate("old-1", "0000000000000000000001", {
        releaseDate: "2026-07-01",
        releaseId: "old",
        trackNumber: 1,
      }),
    ];
    const plan = planSpotifyPlaylistExport(
      candidates,
      [
        { position: 0, trackId: userA },
        { position: 1, trackId: "0000000000000000000002" },
        { position: 2, trackId: userB },
      ],
      new Set(["0000000000000000000002"]),
    );

    expect(plan.desired.map((item) => item.providerTrackId)).toEqual([
      "0000000000000000000003",
      "0000000000000000000004",
      "0000000000000000000001",
      "0000000000000000000002",
    ]);
    expect(plan.finalTrackIds).toEqual([
      userA,
      "0000000000000000000003",
      "0000000000000000000004",
      "0000000000000000000001",
      "0000000000000000000002",
      userB,
    ]);
    expect(plan.finalTrackIds.filter((id) => id === userA || id === userB)).toEqual([userA, userB]);
    expect(plan.alreadyPresent).toEqual([
      expect.objectContaining({ appManaged: true, providerTrackId: "0000000000000000000002" }),
    ]);
    expect(groupSpotifyPlaylistAdditions(plan.additions)).toHaveLength(1);
  });

  it("deduplicates recording appearances and reports existing duplicates and order conflicts", () => {
    const first = candidate("first", "0000000000000000000001", {
      releaseDate: "2026-08-01",
    });
    const duplicateAppearance = candidate("duplicate", "0000000000000000000001", {
      releaseDate: "2026-07-15",
    });
    const second = candidate("second", "0000000000000000000002", {
      releaseDate: "2026-07-01",
    });
    const plan = planSpotifyPlaylistExport(
      [first, duplicateAppearance, second],
      [
        { position: 0, trackId: "0000000000000000000002" },
        { position: 1, trackId: "0000000000000000000001" },
        { position: 2, trackId: "0000000000000000000001" },
      ],
      new Set(),
    );

    expect(plan.desired).toHaveLength(2);
    expect(plan.skips).toContainEqual(
      expect.objectContaining({
        feedItemId: "duplicate",
        reason: "duplicate_recording_appearance",
      }),
    );
    expect(plan.existingDuplicateTrackIds).toEqual(["0000000000000000000001"]);
    expect(plan.orderingConflicts).toEqual([
      {
        earlierPosition: 1,
        earlierTrackId: "0000000000000000000001",
        laterPosition: 0,
        laterTrackId: "0000000000000000000002",
      },
    ]);
    expect(plan.additions).toHaveLength(0);
  });

  it("reports unrelated playlist items and release groups split by them", () => {
    const first = candidate("first", "0000000000000000000001", {
      providerReleaseId: "spotify-album-together",
      releaseId: "release-together",
      releaseTitle: "Together",
      trackNumber: 1,
    });
    const second = candidate("second", "0000000000000000000002", {
      providerReleaseId: "spotify-album-together",
      releaseId: "release-together",
      releaseTitle: "Together",
      trackNumber: 2,
    });
    const unrelated = "9999999999999999999999";
    const plan = planSpotifyPlaylistExport(
      [first, second],
      [
        { position: 0, trackId: first.providerTrackId! },
        {
          albumId: "different-spotify-album",
          artistNames: ["User Artist"],
          position: 1,
          releaseDate: "2020-01-01",
          title: "User Track",
          trackId: unrelated,
        },
        { position: 2, trackId: second.providerTrackId! },
      ],
      new Set(),
    );

    expect(plan.releaseGroupingConflicts).toEqual([
      {
        positions: [0, 2],
        releaseId: "release-together",
        releaseTitle: "Together",
      },
    ]);
    expect(plan.unrelatedItems).toEqual([
      expect.objectContaining({
        artistNames: ["User Artist"],
        position: 1,
        reason: "not_in_export_set",
        releaseDate: "2020-01-01",
        title: "User Track",
        trackId: unrelated,
      }),
    ]);

    const sameAlbumPlan = planSpotifyPlaylistExport(
      [first, second],
      [
        { position: 0, trackId: first.providerTrackId! },
        {
          albumId: "spotify-album-together",
          position: 1,
          trackId: unrelated,
        },
        { position: 2, trackId: second.providerTrackId! },
      ],
      new Set(),
    );
    expect(sameAlbumPlan.releaseGroupingConflicts).toEqual([]);
  });

  it("splits positional additions at Spotify's 100-item limit", () => {
    const plan = planSpotifyPlaylistExport(
      Array.from({ length: 205 }, (_, index) =>
        candidate(String(index), index.toString(36).padStart(22, "0"), {
          title: `Track ${index}`,
          trackNumber: index + 1,
        }),
      ),
      [],
      new Set(),
    );
    expect(groupSpotifyPlaylistAdditions(plan.additions).map((group) => group.length)).toEqual([
      100, 100, 5,
    ]);
  });
});

function item(providerTrackId: string, matchRule: string, confidence: number) {
  return {
    confidence,
    manuallyConfirmed: false,
    matchRule,
    providerTrackId,
    providerUrl: `https://open.spotify.com/track/${providerTrackId}`,
  };
}

function candidate(
  id: string,
  providerTrackId: string | undefined,
  overrides: Partial<SpotifyPlaylistExportCandidate> = {},
): SpotifyPlaylistExportCandidate {
  return {
    confidence: 1,
    discNumber: 1,
    feedItemId: id,
    feedState: "new",
    followedArtist: true,
    manuallyConfirmed: false,
    matchRule: "new_canonical",
    ...(providerTrackId ? { providerTrackId } : {}),
    releaseDate: "2026-08-01",
    releaseId: `release-${id}`,
    releaseTitle: `Release ${id}`,
    releaseType: "single",
    title: `Track ${id}`,
    trackId: `track-${id}`,
    trackNumber: 1,
    ...overrides,
  };
}
