import { describe, expect, it, vi } from "vitest";
import { normalizeText } from "@radar/core";
import { AppleMusicClientError, type AppleMusicAlbum, type AppleMusicSong } from "@radar/providers";
import {
  appleMusicRecentWindow,
  classifyAppleMusicRecentCandidate,
  compareAppleMusicRecentCandidate,
  extractNamedRemixer,
  mergeAppleMusicRecentCandidates,
  scopedAppleMusicRecentGroundTruth,
} from "./apple-music-recent";
import {
  createAppleMusicRecentPlan,
  parseAppleMusicRecentCommand,
} from "./apple-music-recent-command";
import {
  authorizeAppleMusicRecent,
  runAppleMusicRecentAfterValidation,
  runAppleMusicRecentOptimizationAfterValidation,
  type AppleMusicRecentClient,
  type AppleMusicRecentStore,
} from "./apple-music-recent-runner";
import type { AppleMusicPilotPlanArtist } from "./apple-music-pilot-definition";
import type {
  ItunesPilotGroundTruthRelease,
  ItunesPilotSnapshot,
  ItunesPilotSnapshotArtist,
} from "./itunes-pilot-snapshot";

const end = new Date("2026-07-29T23:59:59Z");
const window = appleMusicRecentWindow(end);

describe("Apple recent window", () => {
  it("uses 30 days for the first successful window", () => {
    expect(window.effectiveStart.toISOString()).toBe("2026-06-29T23:59:59.000Z");
    expect(window.effectiveEnd.toISOString()).toBe("2026-07-29T23:59:59.000Z");
  });

  it("uses a 48-hour overlap after a success without exceeding 30 days", () => {
    expect(
      appleMusicRecentWindow(end, new Date("2026-07-25T12:00:00Z")).effectiveStart.toISOString(),
    ).toBe("2026-07-23T12:00:00.000Z");
    expect(
      appleMusicRecentWindow(end, new Date("2026-05-01T00:00:00Z")).effectiveStart.toISOString(),
    ).toBe("2026-06-29T23:59:59.000Z");
  });
});

describe("Apple recent command gate", () => {
  it("parses plan mode without accepting live-only options", () => {
    expect(
      parseAppleMusicRecentCommand(["--plan", "--sample", "--snapshot", "snapshot.json"]),
    ).toEqual({
      mode: "plan",
      profile: "current",
      scope: "sample",
      snapshotPath: "snapshot.json",
    });
    expect(() =>
      parseAppleMusicRecentCommand([
        "--plan",
        "--sample",
        "--snapshot",
        "snapshot.json",
        "--confirm-live",
        "APPLE_RECENT_MVP_SAMPLE",
      ]),
    ).toThrow("does not accept");
  });

  it("requires exact double confirmation, sample, and evaluation time", () => {
    const base = ["--execute-live", "--sample", "--snapshot", "snapshot.json"];
    expect(() => parseAppleMusicRecentCommand(base)).toThrow("APPLE_RECENT_MVP_SAMPLE");
    expect(() =>
      parseAppleMusicRecentCommand([...base, "--confirm-live", "APPLE_RECENT_MVP_SAMPLE"]),
    ).toThrow("evaluation");
    expect(
      parseAppleMusicRecentCommand([
        ...base,
        "--confirm-live",
        "APPLE_RECENT_MVP_SAMPLE",
        "--evaluation-as-of",
        "2026-07-29T23:59:59Z",
      ]),
    ).toMatchObject({ mode: "execute_live" });
  });

  it("plans the optimized profile with four recurring sources and a 25-request live ceiling", async () => {
    const value = recentSnapshot(recentEntries());
    expect(
      parseAppleMusicRecentCommand([
        "--plan",
        "--sample",
        "--snapshot",
        "snapshot.json",
        "--profile",
        "optimized_four_source",
      ]),
    ).toMatchObject({ mode: "plan", profile: "optimized_four_source" });
    const plan = await createAppleMusicRecentPlan(
      "snapshot.json",
      "optimized_four_source",
      () => Promise.resolve(value),
      () => recentEntries(),
    );
    expect(plan).toMatchObject({
      forecast: {
        armBRequests: 0,
        armCRequests: 20,
        freshSearchRequests: 10,
        freshTopSongsRequests: 10,
        mappingRequests: 0,
        recurringProfileRequests: 40,
        requestBudget: 25,
        reusedHistoricalRequests: 20,
        retryReserve: 5,
        totalRequests: 20,
      },
      limits: {
        concurrency: 1,
        maximumRuntimeMs: 300_000,
        minRequestIntervalMs: 1_100,
        requestBudget: 25,
      },
      networkRequestsStarted: 0,
      noPagination: true,
      profile: "optimized_four_source",
      writes: 0,
    });
  });

  it("requires the committed-manifest validation scope and exact confirmation", () => {
    const base = [
      "--execute-live",
      "--snapshot",
      "snapshot.json",
      "--cohort-manifest",
      "manifest.json",
      "--profile",
      "optimized_four_source",
      "--evaluation-as-of",
      "2026-07-29T23:59:59Z",
    ];
    expect(() => parseAppleMusicRecentCommand(base)).toThrow("APPLE_RECENT_MVP_VALIDATION_25");
    expect(
      parseAppleMusicRecentCommand([...base, "--confirm-live", "APPLE_RECENT_MVP_VALIDATION_25"]),
    ).toMatchObject({
      cohortManifestPath: "manifest.json",
      mode: "execute_live",
      scope: "validation_25",
    });
    expect(() =>
      parseAppleMusicRecentCommand([
        "--plan",
        "--sample",
        "--cohort-manifest",
        "manifest.json",
        "--snapshot",
        "snapshot.json",
      ]),
    ).toThrow("exactly one");
  });
});

describe("Apple recent candidate classification", () => {
  it("classifies singles, explicit EPs, and albums without track-count EP inference", () => {
    expect(classify(album({ isSingle: true })).classification).toBe("primary_single");
    expect(classify(album({ title: "Signal - EP", trackCount: 10 })).classification).toBe(
      "primary_ep",
    );
    expect(classify(album({ title: "Signal", trackCount: 4 })).classification).toBe(
      "primary_album",
    );
  });

  it("excludes compilations, live releases, future dates, and partial dates", () => {
    expect(classify(album({ isCompilation: true })).classification).toBe("compilation_only");
    expect(classify(album({ title: "Signal (Live)" })).classification).toBe("live_release");
    expect(classify(album({ releaseDate: "2026-08-01" })).classification).toBe("date_out_of_scope");
    expect(classify(album({ releaseDate: "2026" })).classification).toBe("date_uncertain");
  });

  it("includes and distinguishes both NURKO remix directions", () => {
    const byWatched = classify(
      album({
        artistName: "Frank Walker & salem ilese",
        title: "All Cried Out (NURKO Remix)",
      }),
      false,
    );
    const ofWatched = classify(
      album({
        artistName: "NURKO & iann dior",
        title: "I Want You (PatFromLastYear Remix)",
      }),
      false,
    );
    expect(byWatched).toMatchObject({
      classification: "remix_by_watched_artist",
      eligible: true,
      namedRemixer: "NURKO",
    });
    expect(ofWatched).toMatchObject({
      classification: "remix_of_watched_artist_by_other",
      eligible: true,
      namedRemixer: "PatFromLastYear",
    });
  });

  it("uses aliases case-insensitively but rejects partial-name collisions", () => {
    expect(
      classify(album({ artistName: "Other", title: "Signal (Night Kid Remix)" }), false, [
        "Night Kid",
      ]).classification,
    ).toBe("remix_by_watched_artist");
    expect(
      classify(album({ artistName: "Other", title: "Signal (NURK Remix)" }), false).classification,
    ).toBe("remix_direction_uncertain");
  });

  it("does not infer direction from generic remix wording or remix collections", () => {
    expect(classify(album({ title: "Signal (Remix)" }), false).classification).toBe(
      "remix_direction_uncertain",
    );
    expect(classify(album({ title: "The Remixes" }), false).classification).toBe(
      "remix_direction_uncertain",
    );
  });

  it("classifies an individual song only with explicit remix evidence", () => {
    const result = classifySong(
      song({
        artistName: "Other",
        title: "Signal [NURKO Remix]",
      }),
    );
    expect(result).toMatchObject({
      classification: "remix_by_watched_artist",
      eligible: true,
    });
    expect(classifySong(song({ title: "Signal" })).classification).toBe("feature_only");
  });

  it("applies ordinary and bidirectional remix rules to recent top songs", () => {
    expect(
      classifyTopSong(song({ albumName: "Signal - Single", artistName: "NURKO" })),
    ).toMatchObject({
      classification: "primary_single",
      eligible: true,
    });
    expect(
      classifyTopSong(
        song({
          albumName: "LOL OK (Axel Boy Remix) - Single",
          artistName: "MUST DIE!",
          title: "LOL OK (Axel Boy Remix)",
        }),
        "MUST DIE!",
      ),
    ).toMatchObject({
      classification: "remix_of_watched_artist_by_other",
      eligible: true,
      namedRemixer: "Axel Boy",
    });
    expect(
      classifyTopSong(
        song({
          albumName: "Signal (NURKO Remix) - Single",
          artistName: "Other",
          title: "Signal (NURKO Remix)",
        }),
      ),
    ).toMatchObject({
      classification: "remix_by_watched_artist",
      eligible: true,
    });
    expect(classifyTopSong(song({ artistName: "NURKO", title: "Popular Remix" }))).toMatchObject({
      classification: "remix_direction_uncertain",
      eligible: false,
    });
    expect(classifyTopSong(song({ artistName: "NURKO", releaseDate: "2026-01-01" }))).toMatchObject(
      {
        classification: "date_out_of_scope",
        eligible: false,
      },
    );
  });

  it("deduplicates album and song discovery while preserving source evidence", () => {
    const first = classify(album({ albumId: "same" }), true);
    const second = {
      ...first,
      sources: ["catalog-search-song" as const],
    };
    expect(mergeAppleMusicRecentCandidates([first, second])).toMatchObject([
      {
        sources: ["catalog-search-song", "singles"],
      },
    ]);
  });

  it("extracts only explicit named remixer markers", () => {
    expect(extractNamedRemixer("Signal - NURKO Remix")).toBe("NURKO");
    expect(extractNamedRemixer("Signal Remix by NURKO")).toBe("NURKO");
    expect(extractNamedRemixer("Signal (Remix)")).toBeUndefined();
  });

  it("matches a Top Songs remix by song title when the parent album title differs", () => {
    const candidate = classifyTopSong(
      song({
        albumName: "Never Say Die Legacy",
        artistName: "MUST DIE!, Akeos & Skream",
        releaseDate: "2026-07-03",
        title: "LOL OK (Axel Boy Remix)",
      }),
      "MUST DIE!",
    );
    expect(candidate).toMatchObject({
      albumTitle: "Never Say Die Legacy",
      classification: "remix_of_watched_artist_by_other",
      comparisonTitle: "LOL OK (Axel Boy Remix)",
      granularity: "song",
      songTitle: "LOL OK (Axel Boy Remix)",
    });
    expect(
      compareAppleMusicRecentCandidate(candidate, [
        release("LOL OK (Axel Boy Remix)", "2026-07-03", "remix"),
      ]),
    ).toBe("exact_match");
  });

  it("does not let a matching parent album override a nonmatching song title", () => {
    const candidate = classifyTopSong(
      song({
        albumName: "Expected Single",
        artistName: "NURKO",
        title: "Different Song",
      }),
    );
    expect(
      compareAppleMusicRecentCandidate(candidate, [
        release("Expected Single", "2026-07-10", "single"),
      ]),
    ).toBe("apple_only_candidate");
  });

  it("compares ordinary song and album candidates at their explicit granularity", () => {
    const songCandidate = classifyTopSong(
      song({
        albumName: "Collection - Single",
        artistName: "NURKO",
        title: "Signal",
      }),
    );
    const albumCandidate = classify(album({ title: "Signal - Single", isSingle: true }));
    const truth = [release("Signal", "2026-07-10", "single")];
    expect(compareAppleMusicRecentCandidate(songCandidate, truth)).toBe("exact_match");
    expect(compareAppleMusicRecentCandidate(albumCandidate, truth)).toBe("exact_match");
    expect(songCandidate).toMatchObject({
      albumTitle: "Collection - Single",
      comparisonTitle: "Signal",
      granularity: "song",
      songTitle: "Signal",
    });
    expect(albumCandidate).toMatchObject({
      albumTitle: "Signal - Single",
      comparisonTitle: "Signal - Single",
      granularity: "album",
    });
  });

  it("deduplicates album and song representations while retaining both source granularities", () => {
    const albumCandidate = classify(
      album({
        albumId: "release-synthetic",
        isSingle: true,
        title: "Signal - Single",
      }),
    );
    const songCandidate = classifyTopSong(
      song({
        albumId: "release-synthetic",
        albumName: "Signal - Single",
        artistName: "NURKO",
        songId: "song-synthetic",
        title: "Signal",
      }),
    );
    expect(mergeAppleMusicRecentCandidates([albumCandidate, songCandidate])).toMatchObject([
      {
        albumTitle: "Signal - Single",
        comparisonTitle: "Signal",
        granularity: "album_and_song",
        songTitle: "Signal",
        sources: ["singles", "top-songs"],
      },
    ]);
  });

  it("keeps remixes, originals, named remixers, live versions, and distant dates distinct", () => {
    const original = classify(album({ albumId: "original", title: "Signal - Single" }));
    const remixA = classify(album({ albumId: "remix-a", title: "Signal (Alpha Remix) - Single" }));
    const remixB = classify(album({ albumId: "remix-b", title: "Signal (Beta Remix) - Single" }));
    const live = classify(album({ albumId: "live", title: "Signal (Live) - Single" }));
    expect(mergeAppleMusicRecentCandidates([original, remixA, remixB, live])).toHaveLength(4);
    expect(
      compareAppleMusicRecentCandidate(original, [release("Signal", "2026-01-01", "single")]),
    ).toBe("ambiguous_match");
    expect(
      compareAppleMusicRecentCandidate(remixA, [release("Signal", "2026-07-10", "single")]),
    ).toBe("apple_only_candidate");
  });

  it("does not merge the same recording when it appears on distinct dated releases", () => {
    const single = classifyTopSong(
      song({
        albumId: "single-release",
        albumName: "Signal - Single",
        isrc: "SYNTHETICISRC",
        releaseDate: "2026-07-10",
        songId: "single-song",
      }),
    );
    const albumAppearance = classifyTopSong(
      song({
        albumId: "later-album",
        albumName: "Later Album",
        isrc: "SYNTHETICISRC",
        releaseDate: "2026-07-20",
        songId: "album-song",
      }),
    );
    expect(mergeAppleMusicRecentCandidates([single, albumAppearance])).toHaveLength(2);
  });
});

describe("Apple recent frozen scope", () => {
  it("pins both NURKO remix directions and excludes older releases", () => {
    const artist = snapshotArtist();
    const releases = [
      release("All Cried Out (NURKO Remix)", "2026-07-10", "feature"),
      release("I Want You (PatFromLastYear Remix)", "2026-07-17", "remix"),
      release("Old Single", "2026-06-06", "single"),
      release("Old EP", "2026-06-26", "ep"),
    ];
    const result = scopedAppleMusicRecentGroundTruth(snapshot(artist, releases), artist, end);
    expect(result.map((item) => item.title)).toEqual([
      "All Cried Out (NURKO Remix)",
      "I Want You (PatFromLastYear Remix)",
    ]);
  });

  it("excludes feature-only and keeps ordinary primary kinds", () => {
    const artist = snapshotArtist();
    const releases = [
      release("Feature", "2026-07-10", "feature"),
      release("Single", "2026-07-11", "single"),
      release("EP", "2026-07-12", "ep"),
      release("Album", "2026-07-13", "album"),
    ];
    expect(
      scopedAppleMusicRecentGroundTruth(snapshot(artist, releases), artist, end).map(
        (item) => item.title,
      ),
    ).toEqual(["Single", "EP", "Album"]);
  });
});

describe("Apple recent bounded runner", () => {
  it("reuses mappings, calls six fresh shallow operations per artist, and releases the lease", async () => {
    const entries = recentEntries();
    const value = recentSnapshot(entries);
    const client = recentClient();
    const store = recentStore();
    const summary = await runAppleMusicRecentAfterValidation(
      {
        authorization: recentAuthorization(),
        createClient: () => client,
        implementationCommit: "a".repeat(40),
        snapshot: value,
        store,
      },
      entries,
    );
    expect(summary.status).toBe("completed");
    expect(summary.artists).toHaveLength(10);
    expect(client.getArtist).not.toHaveBeenCalled();
    expect(client.searchArtists).not.toHaveBeenCalled();
    expect(client.getArtistViewFirstPage).toHaveBeenCalledTimes(40);
    expect(client.getArtistAlbumsFirstPage).toHaveBeenCalledTimes(10);
    expect(client.searchRecentRemixes).toHaveBeenCalledTimes(10);
    expect(store.releaseLease).toHaveBeenCalledTimes(1);
    expect(store.saveCandidates).toHaveBeenCalledTimes(10);
  });

  it("runs exactly four first-page optimized sources without legacy or pagination calls", async () => {
    const entries = recentEntries();
    const client = recentClient();
    const store = recentStore();
    const summary = await runAppleMusicRecentOptimizationAfterValidation(
      {
        authorization: recentAuthorization(),
        createClient: () => client,
        implementationCommit: "a".repeat(40),
        snapshot: recentSnapshot(entries),
        store,
      },
      entries,
      { freshSupplementOnly: false },
    );
    expect(summary.status).toBe("completed");
    expect(client.getArtistViewFirstPage).toHaveBeenCalledTimes(20);
    expect(client.getArtistViewFirstPage.mock.calls.map((call) => call[1])).toEqual(
      Array.from({ length: 10 }, () => ["singles", "full-albums"]).flat(),
    );
    expect(client.getArtistTopSongsFirstPage).toHaveBeenCalledTimes(10);
    expect(client.searchRecentRemixes).toHaveBeenCalledTimes(10);
    expect(client.getArtistAlbumsFirstPage).not.toHaveBeenCalled();
    expect(client.getArtist).not.toHaveBeenCalled();
    expect(client.searchArtists).not.toHaveBeenCalled();
  });

  it("runs only the two fresh supplement requests in the authorized live experiment", async () => {
    const entries = recentEntries();
    const client = recentClient();
    const store = recentStore();
    const summary = await runAppleMusicRecentOptimizationAfterValidation(
      {
        authorization: recentAuthorization(),
        createClient: () => client,
        implementationCommit: "a".repeat(40),
        snapshot: recentSnapshot(entries),
        store,
      },
      entries,
      { freshSupplementOnly: true },
    );
    expect(summary).toMatchObject({
      mode: "recent_optimized_four_source",
      requestBudget: 25,
      status: "completed",
    });
    expect(client.getArtistViewFirstPage).not.toHaveBeenCalled();
    expect(client.getArtistTopSongsFirstPage).toHaveBeenCalledTimes(10);
    expect(client.searchRecentRemixes).toHaveBeenCalledTimes(10);
    expect(store.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("runs four fresh sources for exactly 25 validation artists under the 175-request gate", async () => {
    const entries = validationEntries();
    const client = recentClient();
    const store = recentStore();
    const summary = await runAppleMusicRecentOptimizationAfterValidation(
      {
        authorization: recentValidationAuthorization(),
        createClient: () => client,
        implementationCommit: "a".repeat(40),
        snapshot: recentSnapshot(entries),
        store,
      },
      entries,
      { freshSupplementOnly: false, validation: true },
    );
    expect(summary).toMatchObject({
      mode: "recent_optimized_validation_25",
      requestBudget: 175,
      status: "completed",
    });
    expect(summary.artists).toHaveLength(25);
    expect(client.getArtistViewFirstPage).toHaveBeenCalledTimes(50);
    expect(client.getArtistTopSongsFirstPage).toHaveBeenCalledTimes(25);
    expect(client.searchRecentRemixes).toHaveBeenCalledTimes(25);
    expect(client.getArtistAlbumsFirstPage).not.toHaveBeenCalled();
    expect(store.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("distinguishes top-songs HTTP 404 from an available empty page", async () => {
    const entries = recentEntries();
    const client = recentClient();
    client.getArtistTopSongsFirstPage
      .mockRejectedValueOnce(new AppleMusicClientError("missing", "not_found", 404))
      .mockResolvedValue({ items: [], nextPresent: false });
    const summary = await runAppleMusicRecentOptimizationAfterValidation(
      {
        authorization: recentAuthorization(),
        createClient: () => client,
        implementationCommit: "a".repeat(40),
        snapshot: recentSnapshot(entries),
        store: recentStore(),
      },
      entries,
      { freshSupplementOnly: true },
    );
    expect(summary.artists[0]?.topSongs.status).toBe("unavailable_404");
    expect(summary.artists[1]?.topSongs.status).toBe("available_empty");
    expect(summary.artists).toHaveLength(10);
  });

  it("requires all confirmed mappings before creating a run or client", async () => {
    const entries = recentEntries();
    const store = recentStore();
    store.findConfirmedMapping.mockResolvedValueOnce(undefined);
    const createClient = vi.fn(() => recentClient());
    await expect(
      runAppleMusicRecentOptimizationAfterValidation(
        {
          authorization: recentAuthorization(),
          createClient,
          implementationCommit: "a".repeat(40),
          snapshot: recentSnapshot(entries),
          store,
        },
        entries,
        { freshSupplementOnly: true },
      ),
    ).rejects.toThrow("confirmed Apple mapping");
    expect(store.createRun).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("stops after the same endpoint shape returns HTTP 400 for two artists", async () => {
    const entries = recentEntries();
    const value = recentSnapshot(entries);
    const client = recentClient();
    client.getArtistViewFirstPage.mockImplementation((_artistId, view) => {
      if (view === "singles") {
        return Promise.reject(new AppleMusicClientError("bad", "bad_request", 400));
      }
      return Promise.resolve({ items: [], nextPresent: false });
    });
    const store = recentStore();
    const summary = await runAppleMusicRecentAfterValidation(
      {
        authorization: recentAuthorization(),
        createClient: () => client,
        implementationCommit: "a".repeat(40),
        snapshot: value,
        store,
      },
      entries,
    );
    expect(summary).toMatchObject({
      status: "controlled_partial",
      stopReason: "systematic_endpoint_http_400",
    });
    expect(summary.artists).toHaveLength(1);
    expect(store.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("rejects persistent enablement before a runner can be authorized", () => {
    expect(() =>
      authorizeAppleMusicRecent({
        confirmation: "APPLE_RECENT_MVP_SAMPLE",
        evaluationAsOf: "2026-07-29T23:59:59Z",
        executeLive: true,
        otherProvidersDisabled: true,
        persistentAppleMusicEnabled: "true",
        storefront: "us",
      }),
    ).toThrow("exactly false");
  });
});

function classify(value: AppleMusicAlbum, confirmed = true, aliases: string[] = []) {
  return classifyAppleMusicRecentCandidate({
    aliases,
    album: value,
    confirmedArtistAssociation: confirmed,
    source: "singles",
    watchedArtist: "NURKO",
    window,
  });
}

function classifySong(value: AppleMusicSong) {
  return classifyAppleMusicRecentCandidate({
    aliases: [],
    confirmedArtistAssociation: false,
    song: value,
    source: "catalog-search-song",
    watchedArtist: "NURKO",
    window,
  });
}

function classifyTopSong(value: AppleMusicSong, watchedArtist = "NURKO") {
  return classifyAppleMusicRecentCandidate({
    aliases: [],
    confirmedArtistAssociation: true,
    song: value,
    source: "top-songs",
    watchedArtist,
    window,
  });
}

function album(overrides: Partial<AppleMusicAlbum> = {}): AppleMusicAlbum {
  return {
    albumId: "album-1",
    artistIds: [],
    artistName: "NURKO",
    genreNames: [],
    isCompilation: false,
    isSingle: false,
    pageNumber: 1,
    paginationPath: "/synthetic",
    releaseDate: "2026-07-10",
    sourceStorefront: "us",
    sourceView: "singles",
    title: "Signal",
    trackCount: 2,
    ...overrides,
  };
}

function song(overrides: Partial<AppleMusicSong> = {}): AppleMusicSong {
  return {
    artistIds: [],
    artistName: "Other",
    pageNumber: 1,
    paginationPath: "/synthetic",
    releaseDate: "2026-07-10",
    songId: "song-1",
    sourceStorefront: "us",
    title: "Signal",
    ...overrides,
  };
}

function snapshotArtist(): ItunesPilotSnapshotArtist {
  return {
    aliases: [],
    canonicalArtistId: "00000000-0000-4000-8000-000000000001",
    canonicalName: "NURKO",
    cohortReason: "positive",
    genres: [],
    inclusionState: { active: true },
    normalizedName: "nurko",
    spotifyArtistId: "spotify-artist",
    spotifyCoverageTimestamp: "2026-07-29T00:00:00Z",
  };
}

function release(
  title: string,
  releaseDate: string,
  releaseType: string,
): ItunesPilotGroundTruthRelease {
  return {
    canonicalArtistId: snapshotArtist().canonicalArtistId,
    canonicalReleaseId: `release-${title}`,
    creditedArtists: [],
    feedEligible: true,
    normalizedTitle: normalizeText(title),
    releaseDate,
    releaseDatePrecision: "day",
    releaseType,
    spotifyReleaseId: `spotify-${title}`,
    title,
    tracks: [],
  };
}

function snapshot(
  artist: ItunesPilotSnapshotArtist,
  releases: ItunesPilotGroundTruthRelease[],
): ItunesPilotSnapshot {
  return {
    artists: [artist],
    groundTruthReleases: releases,
    mainRepositoryCommit: "a".repeat(40),
    mainSchemaVersion: 20,
    snapshotHash: "b".repeat(64),
    snapshotTimestamp: "2026-07-29T23:59:59Z",
    version: 1,
    windowEnd: "2026-07-29",
    windowStart: "2026-05-30",
  };
}

function recentAuthorization() {
  return authorizeAppleMusicRecent({
    confirmation: "APPLE_RECENT_MVP_SAMPLE",
    evaluationAsOf: "2026-07-29T23:59:59Z",
    executeLive: true,
    otherProvidersDisabled: true,
    persistentAppleMusicEnabled: "false",
    storefront: "us",
  });
}

function recentValidationAuthorization() {
  return authorizeAppleMusicRecent({
    confirmation: "APPLE_RECENT_MVP_VALIDATION_25",
    evaluationAsOf: "2026-07-29T23:59:59Z",
    executeLive: true,
    otherProvidersDisabled: true,
    persistentAppleMusicEnabled: "false",
    scope: "validation_25",
    storefront: "us",
  });
}

function recentEntries(): AppleMusicPilotPlanArtist[] {
  const names = [
    "NURKO",
    "G-Space",
    "BUNT.",
    "SampliFire",
    "Vibe Chemistry",
    "BARELY ALIVE",
    "Habstrakt",
    "MUST DIE!",
    "1788-L",
    "3LAU",
  ];
  return names.map((name, index) => ({
    canonicalArtistId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    category: "positive_release",
    name,
    requiresSearch: true,
  }));
}

function validationEntries(): AppleMusicPilotPlanArtist[] {
  return Array.from({ length: 25 }, (_, index) => ({
    canonicalArtistId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    category: "identity_catalog_stress",
    name: `Validation Artist ${index + 1}`,
    requiresSearch: true,
  }));
}

function recentSnapshot(entries: AppleMusicPilotPlanArtist[]): ItunesPilotSnapshot {
  return {
    artists: entries.map((entry) => ({
      aliases: [],
      canonicalArtistId: entry.canonicalArtistId,
      canonicalName: entry.name,
      cohortReason: "positive",
      genres: [],
      inclusionState: { active: true },
      normalizedName: normalizeText(entry.name),
      spotifyArtistId: `spotify-${entry.name}`,
      spotifyCoverageTimestamp: "2026-07-29T00:00:00Z",
    })),
    groundTruthReleases: [],
    mainRepositoryCommit: "a".repeat(40),
    mainSchemaVersion: 20,
    snapshotHash: "b".repeat(64),
    snapshotTimestamp: "2026-07-29T23:59:59Z",
    version: 1,
    windowEnd: "2026-07-29",
    windowStart: "2026-05-30",
  };
}

function recentClient() {
  return {
    getArtist: vi.fn<AppleMusicRecentClient["getArtist"]>(),
    getArtistAlbumsFirstPage: vi.fn<AppleMusicRecentClient["getArtistAlbumsFirstPage"]>(() =>
      Promise.resolve({ items: [], nextPresent: true }),
    ),
    getArtistTopSongsFirstPage: vi.fn<AppleMusicRecentClient["getArtistTopSongsFirstPage"]>(() =>
      Promise.resolve({ items: [], nextPresent: true }),
    ),
    getArtistViewFirstPage: vi.fn<AppleMusicRecentClient["getArtistViewFirstPage"]>(() =>
      Promise.resolve({ items: [], nextPresent: true }),
    ),
    searchArtists: vi.fn<AppleMusicRecentClient["searchArtists"]>(() => Promise.resolve([])),
    searchRecentRemixes: vi.fn<AppleMusicRecentClient["searchRecentRemixes"]>(() =>
      Promise.resolve({
        albums: [],
        albumsNextPresent: true,
        songs: [],
        songsNextPresent: true,
      }),
    ),
  };
}

function recentStore() {
  return {
    claimLease: vi.fn<AppleMusicRecentStore["claimLease"]>(() => Promise.resolve("lease")),
    createRun: vi.fn<AppleMusicRecentStore["createRun"]>(() =>
      Promise.resolve({ id: "00000000-0000-4000-8000-000000000100" }),
    ),
    findConfirmedMapping: vi.fn<AppleMusicRecentStore["findConfirmedMapping"]>(
      ({ canonicalArtistId }) => Promise.resolve({ appleArtistId: `apple-${canonicalArtistId}` }),
    ),
    finishRun: vi.fn<AppleMusicRecentStore["finishRun"]>(() => Promise.resolve()),
    importSnapshot: vi.fn<AppleMusicRecentStore["importSnapshot"]>(() =>
      Promise.resolve("00000000-0000-4000-8000-000000000200"),
    ),
    lastSuccessfulCompletedAt: vi.fn<AppleMusicRecentStore["lastSuccessfulCompletedAt"]>(() =>
      Promise.resolve(undefined),
    ),
    operationalStatus: vi.fn<AppleMusicRecentStore["operationalStatus"]>(() =>
      Promise.resolve({ cooldownActive: false, leaseActive: false }),
    ),
    readEvidence: vi.fn<AppleMusicRecentStore["readEvidence"]>(() =>
      Promise.resolve({
        authenticationAttempts: 0,
        cacheHits: 0,
        endpointRequestCounts: {},
        httpStatusCounts: {},
        maximumConcurrency: 1,
        paginationRequests: 0,
        requestCount: 60,
        retryCount: 0,
      }),
    ),
    releaseLease: vi.fn<AppleMusicRecentStore["releaseLease"]>(() => Promise.resolve()),
    saveCandidates: vi.fn<AppleMusicRecentStore["saveCandidates"]>(() => Promise.resolve()),
    saveCatalog: vi.fn<AppleMusicRecentStore["saveCatalog"]>(() => Promise.resolve()),
    saveMapping: vi.fn<AppleMusicRecentStore["saveMapping"]>(() => Promise.resolve()),
  };
}
