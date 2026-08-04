import { describe, expect, it } from "vitest";
import {
  appleMusicCandidateInWindow,
  classifyAppleMusicAlbum,
  compareAppleMusicToGroundTruth,
  compareAppleViewCompleteness,
  decideAppleMusicArtistMapping,
  resolveAppleMusicArtistFromCatalogEvidence,
  selectAppleMusicCatalogEvidenceCandidates,
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

const song = (
  songId: string,
  title = "Signal Fire",
  overrides: Partial<AppleMusicSongCandidate> = {},
): AppleMusicSongCandidate => ({
  albumId: "album-1",
  artistIds: ["artist-1"],
  artistName: "Artist",
  paginationPath: "/v1/catalog/us/albums/album-1/tracks",
  pageNumber: 1,
  songId,
  title,
  ...overrides,
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

  it("selects only exact canonical or alias candidates within the requested bound", () => {
    expect(
      selectAppleMusicCatalogEvidenceCandidates({
        aliases: ["Known Alias"],
        candidates: [
          artist("1", "Artist"),
          artist("2", "Known Alias"),
          artist("3", "Partial Artist"),
        ],
        canonicalName: "Artist",
        maximumCandidates: 2,
      }),
    ).toEqual([artist("1", "Artist"), artist("2", "Known Alias")]);
  });

  it("keeps weak and tied catalog evidence ambiguous", () => {
    const weak = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: [
        {
          albums: [],
          artist: artist("weak", "Artist"),
          songs: [song("weak-song")],
        },
      ],
      canonicalName: "Artist",
      groundTruth,
    });
    expect(weak).toMatchObject({ status: "ambiguous" });

    const tied = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: [
        {
          albums: [album("one")],
          artist: artist("one", "Artist"),
          songs: [],
        },
        {
          albums: [album("two")],
          artist: artist("two", "Artist"),
          songs: [],
        },
      ],
      canonicalName: "Artist",
      groundTruth,
    });
    expect(tied).toMatchObject({ status: "ambiguous" });
  });

  it("uses a unique exact ISRC only for one compatible candidate", () => {
    const codedGroundTruth: SpotifyGroundTruthRelease[] = [
      {
        ...groundTruth[0]!,
        tracks: [
          {
            isrc: " us-aaa-26-00001 ",
            normalizedTitle: "signal fire",
            title: "Signal Fire",
          },
        ],
      },
    ];
    const decision = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: [
        {
          albums: [],
          artist: artist("winner", "Artist"),
          songs: [song("winner-song", "Unrelated", { isrc: "USAAA2600001" })],
        },
        {
          albums: [],
          artist: artist("other", "Artist"),
          songs: [song("other-song", "Unrelated", { isrc: "USBBB2600002" })],
        },
      ],
      canonicalName: "Artist",
      groundTruth: codedGroundTruth,
    });
    expect(decision).toMatchObject({
      selected: { artistId: "winner" },
      status: "evidence_confirmed",
    });
    expect(decision.evidence[0]).toMatchObject({
      evidenceTier: "isrc_exact",
      exactIsrcMatchCount: 1,
    });
    expect(
      resolveAppleMusicArtistFromCatalogEvidence({
        aliases: [],
        candidateCatalogs: [
          {
            albums: [],
            artist: { ...artist("wrong-name", "Different Artist"), genreNames: ["Popular"] },
            songs: [song("wrong-song", "Unrelated", { isrc: "USAAA2600001" })],
          },
          {
            albums: [],
            artist: { ...artist("compatible", "Artist"), genreNames: ["Unknown"] },
            songs: [],
          },
        ],
        canonicalName: "Artist",
        groundTruth: codedGroundTruth,
      }),
    ).toMatchObject({ status: "ambiguous" });
  });

  it("keeps duplicated, missing, and unrelated ISRC evidence neutral or ambiguous", () => {
    const codedGroundTruth: SpotifyGroundTruthRelease[] = [
      {
        ...groundTruth[0]!,
        tracks: [
          {
            isrc: "USAAA2600001",
            normalizedTitle: "signal fire",
            title: "Signal Fire",
          },
        ],
      },
    ];
    const duplicated = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: ["one", "two"].map((id) => ({
        albums: [],
        artist: artist(id, "Artist"),
        songs: [song(`${id}-song`, "Unrelated", { isrc: "USAAA2600001" })],
      })),
      canonicalName: "Artist",
      groundTruth: codedGroundTruth,
    });
    expect(duplicated).toMatchObject({ status: "ambiguous" });
    expect(duplicated.evidence.every((evidence) => evidence.isrcMatchState === "duplicated")).toBe(
      true,
    );

    const neutral = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: [
        { albums: [], artist: artist("missing", "Artist"), songs: [song("missing")] },
        {
          albums: [],
          artist: artist("unrelated", "Artist"),
          songs: [song("unrelated", "Other", { isrc: "USBBB2600002" })],
        },
      ],
      canonicalName: "Artist",
      groundTruth: codedGroundTruth,
    });
    expect(neutral).toMatchObject({ status: "ambiguous" });
    expect(neutral.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contradictoryIsrcCount: 0, exactIsrcMatchCount: 0 }),
      ]),
    );
  });

  it("blocks a same-title compatible-date contradictory ISRC", () => {
    const decision = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: [
        {
          albums: [album("candidate")],
          artist: artist("candidate", "Artist"),
          songs: [
            song("candidate-song", "Signal Fire", {
              isrc: "USBBB2600002",
              releaseDate: "2026-07-01",
            }),
          ],
        },
      ],
      canonicalName: "Artist",
      groundTruth: [
        {
          ...groundTruth[0]!,
          tracks: [
            {
              isrc: "USAAA2600001",
              normalizedTitle: "signal fire",
              title: "Signal Fire",
            },
          ],
        },
      ],
    });
    expect(decision).toMatchObject({ status: "ambiguous" });
    expect(decision.evidence[0]).toMatchObject({
      contradictoryIsrcCount: 1,
      evidenceTier: "code_conflict",
    });
  });

  it("uses unique UPC evidence and keeps duplicated or missing UPC evidence nondecisive", () => {
    const codedGroundTruth: SpotifyGroundTruthRelease[] = [
      { ...groundTruth[0]!, upc: " 012345678905 " },
    ];
    const unique = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: [
        {
          albums: [album("winner", "Other", { upc: "012345678905" })],
          artist: artist("winner", "Artist"),
          songs: [],
        },
        {
          albums: [album("other", "Other")],
          artist: artist("other", "Artist"),
          songs: [],
        },
      ],
      canonicalName: "Artist",
      groundTruth: codedGroundTruth,
    });
    expect(unique).toMatchObject({ selected: { artistId: "winner" } });

    const duplicated = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: ["one", "two"].map((id) => ({
        albums: [album(id, "Other", { upc: "012345678905" })],
        artist: artist(id, "Artist"),
        songs: [],
      })),
      canonicalName: "Artist",
      groundTruth: codedGroundTruth,
    });
    expect(duplicated).toMatchObject({ status: "ambiguous" });
    expect(duplicated.evidence.every((evidence) => evidence.upcMatchState === "duplicated")).toBe(
      true,
    );
    expect(
      resolveAppleMusicArtistFromCatalogEvidence({
        aliases: [],
        candidateCatalogs: [
          { albums: [album("missing", "Other")], artist: artist("missing", "Artist"), songs: [] },
        ],
        canonicalName: "Artist",
        groundTruth: codedGroundTruth,
      }),
    ).toMatchObject({ status: "ambiguous" });
  });

  it("keeps conflicting unique ISRC and UPC winners ambiguous", () => {
    const decision = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: [
        {
          albums: [],
          artist: artist("isrc", "Artist"),
          songs: [song("isrc-song", "Other", { isrc: "USAAA2600001" })],
        },
        {
          albums: [album("upc-album", "Other", { upc: "012345678905" })],
          artist: artist("upc", "Artist"),
          songs: [],
        },
      ],
      canonicalName: "Artist",
      groundTruth: [
        {
          ...groundTruth[0]!,
          tracks: [
            {
              isrc: "USAAA2600001",
              normalizedTitle: "signal fire",
              title: "Signal Fire",
            },
          ],
          upc: "012345678905",
        },
      ],
    });
    expect(decision).toMatchObject({
      reason: "Exact ISRC and UPC identity evidence point to different candidates.",
      status: "ambiguous",
    });
  });

  it("ranks three and ten candidates deterministically using the actual runner-up", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => {
      const id = String(10 - index);
      return {
        albums:
          id === "7"
            ? [album("seven")]
            : id === "8"
              ? [album("eight", "Signal Fire"), album("eight-two", "Signal Fire")]
              : [],
        artist: artist(id, "Artist"),
        songs: [],
      };
    });
    const first = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: candidates,
      canonicalName: "Artist",
      groundTruth,
    });
    const reversed = resolveAppleMusicArtistFromCatalogEvidence({
      aliases: [],
      candidateCatalogs: [...candidates].reverse(),
      canonicalName: "Artist",
      groundTruth,
    });
    expect(first).toMatchObject({ status: "ambiguous" });
    expect(reversed).toMatchObject({ status: "ambiguous" });
    expect(first.evidence).toHaveLength(10);
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
