import { describe, expect, it } from "vitest";
import {
  batchEquivalentToIndividuals,
  candidateInWindow,
  classifyItunesCollectionType,
  compareItunesToSpotify,
  decideItunesArtistMapping,
  dedupeItunesTracks,
  evaluateItunesReleasePair,
  isItunesAppearance,
  mergeItunesCollections,
  normalizeArtistIdentity,
  resolveItunesArtistFromCatalogEvidence,
  type ItunesCollectionCandidate,
  type SpotifyGroundTruthRelease,
  type ItunesTrackCandidate,
} from "./itunes-pilot";

const candidate = (artistId: string, artistName: string) => ({ artistId, artistName });
const collection = (
  collectionId: string,
  collectionName = "Release",
  source: ItunesCollectionCandidate["source"] = "album_lookup",
): ItunesCollectionCandidate => ({
  artistId: "1",
  artistName: "Artist",
  collectionId,
  collectionName,
  releaseDate: "2026-07-01T00:00:00Z",
  source,
  trackCount: 2,
});
const track = (trackId: string, artistId = "1"): ItunesTrackCandidate => ({
  artistId,
  artistName: "Artist",
  collectionArtistId: "2",
  collectionName: "Compilation",
  releaseDate: "2026-07-01T00:00:00Z",
  trackId,
  trackName: "Track",
});

describe("iTunes artist mapping", () => {
  it("confirms one exact normalized match across punctuation and joining characters", () => {
    expect(normalizeArtistIdentity("A.M.C & Friends")).toBe("a m c and friends");
    expect(
      decideItunesArtistMapping({
        aliases: [],
        candidates: [candidate("1", "A.M.C")],
        canonicalName: "A.M.C",
      }),
    ).toMatchObject({ selected: { artistId: "1" }, status: "exact_confirmed" });
  });

  it("rejects multiple exact candidates as ambiguous regardless of rank", () => {
    expect(
      decideItunesArtistMapping({
        aliases: [],
        candidates: [candidate("popular", "1991"), candidate("other", "1991")],
        canonicalName: "1991",
      }),
    ).toMatchObject({ status: "ambiguous" });
  });

  it("uses one exact stored alias as evidence confirmation", () => {
    expect(
      decideItunesArtistMapping({
        aliases: ["DJ Alias"],
        candidates: [candidate("1", "DJ Alias")],
        canonicalName: "Different Name",
      }),
    ).toMatchObject({ status: "evidence_confirmed" });
  });

  it("does not confirm partial spelling or a same-name conflict", () => {
    expect(
      decideItunesArtistMapping({
        aliases: [],
        candidates: [candidate("1", "Dimension Music")],
        canonicalName: "Dimension",
      }),
    ).toMatchObject({ status: "ambiguous" });
    expect(
      decideItunesArtistMapping({
        aliases: [],
        candidates: [],
        canonicalName: "Missing",
      }),
    ).toMatchObject({ status: "no_match" });
  });

  it("evidence-confirms only the same-name candidate with unique strong catalog overlap", () => {
    const groundTruth: SpotifyGroundTruthRelease[] = [
      {
        canonicalReleaseId: "canonical",
        normalizedTitle: "signal fire",
        releaseDate: "2026-07-01",
        releaseType: "single",
        spotifyReleaseId: "spotify",
        title: "Signal Fire",
        trackCount: 1,
        tracks: [{ normalizedTitle: "signal fire", title: "Signal Fire" }],
      },
    ];
    const decision = resolveItunesArtistFromCatalogEvidence({
      aliases: [],
      candidates: [
        {
          candidate: candidate("correct", "Same Name"),
          collections: [
            {
              ...collection("correct-release", "Signal Fire"),
              releaseDate: "2026-07-01T00:00:00Z",
              trackCount: 1,
            },
          ],
          tracks: [{ ...track("correct-track", "correct"), trackName: "Signal Fire" }],
        },
        {
          candidate: candidate("unrelated", "Same Name"),
          collections: [collection("unrelated-release", "Unrelated")],
          tracks: [track("unrelated-track", "unrelated")],
        },
      ],
      canonicalName: "Same Name",
      groundTruth,
    });
    expect(decision).toMatchObject({
      selected: { artistId: "correct" },
      status: "evidence_confirmed",
    });
    expect(decision.candidateEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artistId: "correct",
          decision: "confirm",
          matchedReleases: ["spotify"],
        }),
      ]),
    );
  });

  it("keeps conflicting or duplicate strong catalog evidence ambiguous", () => {
    const groundTruth: SpotifyGroundTruthRelease[] = [
      {
        canonicalReleaseId: "canonical",
        normalizedTitle: "shared title",
        releaseDate: "2026-07-01",
        releaseType: "single",
        spotifyReleaseId: "spotify",
        title: "Shared Title",
        trackCount: 1,
      },
    ];
    const matchingCatalog = (artistId: string) => ({
      candidate: candidate(artistId, "Same Name"),
      collections: [
        {
          ...collection(`${artistId}-release`, "Shared Title"),
          releaseDate: "2026-07-01T00:00:00Z",
          trackCount: 1,
        },
      ],
      tracks: [{ ...track(`${artistId}-track`, artistId), trackName: "Shared Title" }],
    });
    expect(
      resolveItunesArtistFromCatalogEvidence({
        aliases: [],
        candidates: [matchingCatalog("one"), matchingCatalog("two")],
        canonicalName: "Same Name",
        groundTruth,
      }),
    ).toMatchObject({ status: "ambiguous" });
    expect(
      resolveItunesArtistFromCatalogEvidence({
        aliases: [],
        candidates: [
          {
            candidate: candidate("one", "Same Name"),
            collections: [
              {
                ...collection("old", "Shared Title"),
                releaseDate: "2026-03-30T00:00:00Z",
                trackCount: 1,
              },
            ],
            tracks: [],
          },
        ],
        canonicalName: "Same Name",
        groundTruth,
      }),
    ).toMatchObject({ status: "ambiguous" });
  });

  it("does not confirm matching titles when returned credits identify another artist", () => {
    expect(
      resolveItunesArtistFromCatalogEvidence({
        aliases: [],
        candidates: [
          {
            candidate: candidate("candidate", "Same Name"),
            collections: [
              {
                ...collection("release", "Shared Title"),
                artistId: "different",
                collectionArtistId: "different",
                releaseDate: "2026-07-01T00:00:00Z",
                trackCount: 1,
              },
            ],
            tracks: [
              {
                ...track("track", "different"),
                collectionArtistId: "different",
                trackName: "Shared Title",
              },
            ],
          },
        ],
        canonicalName: "Same Name",
        groundTruth: [
          {
            canonicalReleaseId: "canonical",
            normalizedTitle: "shared title",
            releaseDate: "2026-07-01",
            releaseType: "single",
            spotifyReleaseId: "spotify",
            title: "Shared Title",
            trackCount: 1,
          },
        ],
      }),
    ).toMatchObject({ status: "ambiguous" });
  });
});

describe("iTunes discovery normalization", () => {
  it("deduplicates collections and tracks while preserving both-source evidence", () => {
    expect(
      mergeItunesCollections(
        [collection("1")],
        [collection("1", "Release", "song_lookup"), collection("2", "Second", "song_lookup")],
      ),
    ).toEqual([
      expect.objectContaining({ collectionId: "1", source: "both" }),
      expect.objectContaining({ collectionId: "2", source: "song_lookup" }),
    ]);
    expect(dedupeItunesTracks([track("1"), track("1"), track("2")])).toHaveLength(2);
  });

  it("classifies single, EP, album, remix, live, compilation, and appearance evidence", () => {
    expect(classifyItunesCollectionType(collection("1", "Tune - Remixes"))).toBe("remix");
    expect(classifyItunesCollectionType(collection("1", "Live at Home"))).toBe("live");
    expect(
      classifyItunesCollectionType({
        collectionName: "Various Artists Compilation",
        trackCount: 20,
      }),
    ).toBe("compilation");
    expect(classifyItunesCollectionType({ collectionName: "Single", trackCount: 1 })).toBe(
      "single",
    );
    expect(classifyItunesCollectionType({ collectionName: "EP", trackCount: 5 })).toBe("ep");
    expect(classifyItunesCollectionType({ collectionName: "Album", trackCount: 10 })).toBe("album");
    expect(isItunesAppearance("1", track("1"))).toBe(true);
  });

  it("calculates 7, 14, 30, and 60-day windows", () => {
    for (const days of [7, 14, 30, 60] as const) {
      expect(candidateInWindow("2026-07-22T00:00:00Z", "2026-07-28T00:00:00Z", days)).toBe(true);
    }
    expect(candidateInWindow("2026-05-01T00:00:00Z", "2026-07-28T00:00:00Z", 60)).toBe(false);
  });
});

describe("cross-provider comparison", () => {
  it("classifies exact, version conflict, date mismatch, Apple-only, and Spotify-missed cases", () => {
    const groundTruth = [
      {
        canonicalReleaseId: "canonical",
        normalizedTitle: "release",
        releaseDate: "2026-07-01",
        releaseType: "single",
        spotifyReleaseId: "spotify",
        title: "Release",
        trackCount: 2,
      },
    ];
    expect(compareItunesToSpotify(groundTruth, [collection("apple")])[0]).toMatchObject({
      classification: "exact_match",
    });
    expect(
      compareItunesToSpotify(
        [{ ...groundTruth[0]!, title: "Release (Live)", normalizedTitle: "release live" }],
        [collection("apple", "Release (Remix)")],
      )[0],
    ).toMatchObject({ classification: "invalid_match" });
    expect(compareItunesToSpotify(groundTruth, [collection("other", "Different")])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ classification: "spotify_ground_truth_missed_by_itunes" }),
        expect.objectContaining({ classification: "apple_only_or_spotify_missing" }),
      ]),
    );
  });

  it.each([
    ["same date", "2026-07-01T00:00:00Z", "exact_match"],
    ["one day", "2026-07-02T00:00:00Z", "exact_match"],
    ["seven days", "2026-07-08T00:00:00Z", "strong_probable_match"],
    ["fourteen days", "2026-07-15T00:00:00Z", "strong_probable_match"],
    ["thirty days", "2026-07-31T00:00:00Z", "ambiguous_match"],
    ["ninety-three days", "2026-10-02T00:00:00Z", "invalid_match"],
  ])("applies strict date compatibility for %s", (_label, releaseDate, classification) => {
    const spotify: SpotifyGroundTruthRelease = {
      canonicalReleaseId: "canonical",
      normalizedTitle: "release",
      releaseDate: "2026-07-01",
      releaseType: "single",
      spotifyReleaseId: "spotify",
      title: "Release",
      trackCount: 2,
    };
    expect(
      evaluateItunesReleasePair(spotify, {
        ...collection("apple"),
        releaseDate,
      }),
    ).toMatchObject({ classification });
  });

  it("rejects version, track-list, remix, and live conflicts", () => {
    const spotify: SpotifyGroundTruthRelease = {
      canonicalReleaseId: "canonical",
      normalizedTitle: "release",
      releaseDate: "2026-07-01",
      releaseType: "single",
      spotifyReleaseId: "spotify",
      title: "Release",
      trackCount: 2,
    };
    expect(
      evaluateItunesReleasePair(spotify, collection("remix", "Release (Remix)")),
    ).toMatchObject({
      classification: "invalid_match",
    });
    expect(
      evaluateItunesReleasePair(
        { ...spotify, normalizedTitle: "release live", title: "Release (Live)" },
        collection("studio", "Release"),
      ),
    ).toMatchObject({ classification: "invalid_match" });
    expect(
      evaluateItunesReleasePair(spotify, { ...collection("different-tracks"), trackCount: 9 }),
    ).toMatchObject({ classification: "invalid_match" });
  });

  it("does not merge a single with a later album appearance", () => {
    const spotify: SpotifyGroundTruthRelease = {
      canonicalReleaseId: "canonical",
      normalizedTitle: "release",
      releaseDate: "2026-07-01",
      releaseType: "single",
      spotifyReleaseId: "spotify",
      title: "Release",
      trackCount: 1,
    };
    expect(
      evaluateItunesReleasePair(spotify, {
        ...collection("album"),
        releaseDate: "2026-07-08T00:00:00Z",
        trackCount: 12,
      }),
    ).toMatchObject({ classification: "invalid_match" });
  });
});

describe("batch equivalence", () => {
  it("accepts complete attributed batches", () => {
    expect(
      batchEquivalentToIndividuals({
        batchCollections: [collection("1")],
        batchTracks: [track("1")],
        expectedArtistIds: ["1"],
        individualCollections: [collection("1")],
        individualTracks: [track("1")],
      }),
    ).toEqual({ reasons: [], safe: true });
  });

  it("rejects missing artists, global truncation, missing results, and misattribution", () => {
    const result = batchEquivalentToIndividuals({
      batchCollections: [],
      batchTracks: [
        {
          ...track("unexpected", "9"),
          collectionArtistId: "8",
        },
      ],
      expectedArtistIds: ["1", "2"],
      individualCollections: [collection("1")],
      individualTracks: [track("1")],
    });
    expect(result.safe).toBe(false);
    expect(result.reasons.join("|")).toContain("missing_artist");
    expect(result.reasons.join("|")).toContain("missing_collections");
    expect(result.reasons.join("|")).toContain("missing_tracks");
    expect(result.reasons.join("|")).toContain("misattributed");
  });
});
