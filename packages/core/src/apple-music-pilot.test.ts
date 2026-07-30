import { describe, expect, it } from "vitest";
import {
  appleMusicCandidateInWindow,
  classifyAppleMusicAlbum,
  compareAppleMusicToGroundTruth,
  compareAppleViewCompleteness,
  decideAppleMusicArtistMapping,
  resolveAppleMusicArtistFromCatalogEvidence,
  type AppleMusicAlbumCandidate,
  type AppleMusicArtistCandidate,
  type AppleMusicSongCandidate,
} from "./apple-music-pilot";
import type { SpotifyGroundTruthRelease } from "./itunes-pilot";

const artist = (artistId: string, name: string): AppleMusicArtistCandidate => ({
  artistId,
  name,
});

const album = (
  albumId: string,
  title = "Signal Fire",
  overrides: Partial<AppleMusicAlbumCandidate> = {},
): AppleMusicAlbumCandidate => ({
  albumId,
  artistIds: ["artist-1"],
  artistName: "Artist",
  paginationPath: "/v1/catalog/us/artists/artist-1/view/full-albums",
  pageNumber: 1,
  releaseDate: "2026-07-01",
  sourceView: "full-albums",
  title,
  trackCount: 1,
  ...overrides,
});

const song = (songId: string, title = "Signal Fire"): AppleMusicSongCandidate => ({
  albumId: "album-1",
  artistIds: ["artist-1"],
  artistName: "Artist",
  paginationPath: "/v1/catalog/us/albums/album-1/tracks",
  pageNumber: 1,
  songId,
  title,
});

const groundTruth: SpotifyGroundTruthRelease[] = [
  {
    canonicalReleaseId: "canonical-1",
    normalizedTitle: "signal fire",
    releaseDate: "2026-07-01",
    releaseType: "single",
    spotifyReleaseId: "spotify-1",
    title: "Signal Fire",
    trackCount: 1,
    tracks: [{ normalizedTitle: "signal fire", title: "Signal Fire" }],
  },
];

describe("Apple Music artist mapping", () => {
  it("confirms a compatible inherited iTunes ID only after resolution", () => {
    expect(
      decideAppleMusicArtistMapping({
        aliases: [],
        canonicalName: "A.M.C",
        existingArtist: artist("42", "A.M.C"),
        existingArtistId: "42",
        searchCandidates: [],
      }),
    ).toMatchObject({
      selected: { artistId: "42" },
      status: "existing_id_confirmed",
    });
  });

  it("rejects inherited IDs that do not resolve to the expected identity", () => {
    expect(
      decideAppleMusicArtistMapping({
        aliases: [],
        canonicalName: "Expected",
        existingArtistId: "missing",
        searchCandidates: [],
      }),
    ).toMatchObject({ status: "no_match" });
    expect(
      decideAppleMusicArtistMapping({
        aliases: [],
        canonicalName: "Expected",
        existingArtist: artist("different", "Expected"),
        existingArtistId: "inherited",
        searchCandidates: [],
      }),
    ).toMatchObject({ status: "rejected" });
    expect(
      decideAppleMusicArtistMapping({
        aliases: [],
        canonicalName: "Expected",
        existingArtist: artist("inherited", "Wrong Artist"),
        existingArtistId: "inherited",
        searchCandidates: [],
      }),
    ).toMatchObject({ status: "rejected" });
  });

  it("handles unique exact, multiple exact, alias, ambiguous, and no-match searches", () => {
    expect(
      decideAppleMusicArtistMapping({
        aliases: [],
        canonicalName: "Artist",
        searchCandidates: [artist("1", "Artist")],
      }),
    ).toMatchObject({ status: "search_confirmed" });
    expect(
      decideAppleMusicArtistMapping({
        aliases: [],
        canonicalName: "Artist",
        searchCandidates: [artist("1", "Artist"), artist("2", "Artist")],
      }),
    ).toMatchObject({ status: "ambiguous" });
    expect(
      decideAppleMusicArtistMapping({
        aliases: ["Known Alias"],
        canonicalName: "Artist",
        searchCandidates: [artist("1", "Known Alias")],
      }),
    ).toMatchObject({ status: "evidence_confirmed" });
    expect(
      decideAppleMusicArtistMapping({
        aliases: [],
        canonicalName: "Artist",
        searchCandidates: [artist("1", "Partial Artist Name")],
      }),
    ).toMatchObject({ status: "ambiguous" });
    expect(
      decideAppleMusicArtistMapping({
        aliases: [],
        canonicalName: "Artist",
        searchCandidates: [],
      }),
    ).toMatchObject({ status: "no_match" });
  });

  it("confirms uniquely strong catalog evidence and rejects same-name conflicts", () => {
    const confirmed = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: [
        {
          albums: [album("correct")],
          artist: artist("correct", "Artist"),
          songs: [song("song-1")],
        },
        {
          albums: [album("other", "Unrelated")],
          artist: artist("other", "Artist"),
          songs: [],
        },
      ],
      canonicalName: "Artist",
      groundTruth,
    });
    expect(confirmed).toMatchObject({
      selected: { artistId: "correct" },
      status: "evidence_confirmed",
    });

    const conflicted = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: [
        {
          albums: [album("conflict", "Signal Fire", { releaseDate: "2020-01-01" })],
          artist: artist("conflict", "Artist"),
          songs: [song("song-1")],
        },
      ],
      canonicalName: "Artist",
      groundTruth,
    });
    expect(conflicted).toMatchObject({ status: "ambiguous" });
  });
});

describe("Apple Music comparison framework", () => {
  it("reuses deterministic release evaluation and records misses", () => {
    const matches = compareAppleMusicToGroundTruth(groundTruth, [album("apple-1")]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.apple?.collectionId).toBe("apple-1");
    expect(matches[0]).toMatchObject({
      classification: "exact_match",
      spotifyReleaseId: "spotify-1",
    });
    expect(compareAppleMusicToGroundTruth(groundTruth, [])).toEqual([
      expect.objectContaining({
        classification: "spotify_ground_truth_missed_by_apple_music",
      }),
    ]);
  });

  it("supports bounded recall windows and batch/direct completeness", () => {
    expect(appleMusicCandidateInWindow("2026-07-23", "2026-07-29T12:00:00Z", 7)).toBe(true);
    expect(appleMusicCandidateInWindow("2026-07-22", "2026-07-29T12:00:00Z", 7)).toBe(false);
    expect(
      compareAppleViewCompleteness({
        batchAlbums: [album("1")],
        directAlbums: [album("1"), album("2")],
      }),
    ).toEqual({
      missingFromBatch: ["2"],
      missingFromDirect: [],
      safe: false,
    });
  });

  it("classifies singles, EPs, albums, remixes, live, compilations, and appearances", () => {
    expect(classifyAppleMusicAlbum(album("single", "Single", { sourceView: "singles" }))).toBe(
      "single",
    );
    expect(classifyAppleMusicAlbum(album("ep", "Small", { trackCount: 5 }))).toBe("ep");
    expect(classifyAppleMusicAlbum(album("album", "Long", { trackCount: 10 }))).toBe("album");
    expect(classifyAppleMusicAlbum(album("remix", "Signal Fire Remixes"))).toBe("remix");
    expect(classifyAppleMusicAlbum(album("live", "Concert", { sourceView: "live-albums" }))).toBe(
      "live",
    );
    expect(
      classifyAppleMusicAlbum(album("comp", "Collection", { sourceView: "compilation-albums" })),
    ).toBe("compilation");
    expect(
      classifyAppleMusicAlbum(
        album("appearance", "Guest Track", { sourceView: "appears-on-albums" }),
      ),
    ).toBe("feature");
  });
});
