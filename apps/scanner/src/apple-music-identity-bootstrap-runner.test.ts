import { describe, expect, it, vi } from "vitest";
import { normalizeText, resolveAppleMusicArtistFromCatalogEvidence } from "@radar/core";
import { AppleMusicClientError } from "@radar/providers";
import {
  appleMusicIdentityBootstrapArtists,
  appleMusicIdentityBootstrapConfirmation,
  computeAppleMusicIdentityBootstrapHash,
  type AppleMusicIdentityBootstrapArtifact,
} from "./apple-music-identity-bootstrap";
import {
  authorizeAppleMusicIdentityBootstrap,
  runAppleMusicIdentityBootstrap,
  type AppleMusicIdentityBootstrapClient,
  type AppleMusicIdentityBootstrapStore,
} from "./apple-music-identity-bootstrap-runner";
import type { ItunesPilotSnapshot } from "./itunes-pilot-snapshot";

describe("Apple identity bootstrap runner", () => {
  it("confirms five seeds and resolves eight fixed candidate pairs with the existing resolver", async () => {
    const value = fixture();
    const client = bootstrapClient(value);
    const store = bootstrapStore();
    const resolver = vi.fn(resolveAppleMusicArtistFromCatalogEvidence);
    const summary = await runAppleMusicIdentityBootstrap({
      artifact: value.artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      resolver,
      snapshot: value.snapshot,
      store,
    });

    expect(summary).toMatchObject({
      evidenceConfirmed: 8,
      manualReviewCount: 0,
      seededConfirmed: 5,
      status: "completed",
      stopReason: "mapping_bootstrap_completed",
    });
    expect(client.getArtist).toHaveBeenCalledTimes(5);
    expect(client.getArtistTopSongsFirstPage).toHaveBeenCalledTimes(16);
    expect(resolver).toHaveBeenCalledTimes(8);
    expect(store.saveMapping).toHaveBeenCalledTimes(13);
    expect(store.releaseLease).toHaveBeenCalledOnce();
    expect(summary.artists.every((artist) => artist.durableMappingWritten)).toBe(true);
    expect(
      summary.artists.every((artist) =>
        artist.candidates.every(
          (candidate) =>
            !Object.keys(candidate).some((key) => key.toLocaleLowerCase().includes("id")),
        ),
      ),
    ).toBe(true);
  });

  it("does not treat a seeded public ID as confirmation when lookup is unavailable", async () => {
    const value = fixture();
    const client = bootstrapClient(value);
    client.getArtist.mockResolvedValueOnce(undefined);
    const summary = await runAppleMusicIdentityBootstrap({
      artifact: value.artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      snapshot: value.snapshot,
      store: bootstrapStore(),
    });
    expect(summary.artists[0]).toMatchObject({
      durableMappingWritten: false,
      existingIdResult: "unavailable",
      finalClassification: "ambiguous",
      manualReviewRequired: true,
      path: "seeded_id",
      requestsMade: 1,
    });
  });

  it("rejects a seeded ID that resolves to the wrong artist name", async () => {
    const value = fixture();
    const client = bootstrapClient(value);
    client.getArtist.mockResolvedValueOnce({
      artistId: value.artifact.artists[0]!.candidateArtistId!,
      genreNames: [],
      name: "Different Artist",
      sourceStorefront: "us",
    });
    const summary = await runAppleMusicIdentityBootstrap({
      artifact: value.artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      snapshot: value.snapshot,
      store: bootstrapStore(),
    });
    expect(summary.artists[0]).toMatchObject({
      durableMappingWritten: false,
      existingIdResult: "rejected",
      finalClassification: "rejected",
      manualReviewRequired: true,
    });
  });

  it("uses exactly the two fixed candidate IDs and leaves tied evidence ambiguous", async () => {
    const value = fixture();
    const firstUnseeded = value.artifact.artists.find(
      (artist) => artist.canonicalArtistName === "Alok",
    )!;
    const client = bootstrapClient(value);
    client.getArtistTopSongsFirstPage.mockImplementation((artistId) =>
      Promise.resolve({
        items: [
          topSong(artistId, "Alok", {
            albumId: `album-${artistId}`,
            albumName: "Release Alok",
          }),
        ],
        nextPresent: true,
      }),
    );
    const summary = await runAppleMusicIdentityBootstrap({
      artifact: value.artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      snapshot: value.snapshot,
      store: bootstrapStore(),
    });
    expect(client.getArtistTopSongsFirstPage.mock.calls.slice(0, 2).map((call) => call[0])).toEqual(
      firstUnseeded.candidateEvidenceArtistIds,
    );
    expect(summary.artists.find((artist) => artist.artist === "Alok")).toMatchObject({
      durableMappingWritten: false,
      finalClassification: "ambiguous",
      manualReviewRequired: true,
      scoreGap: 0,
    });
  });

  it("keeps a candidate pair ambiguous when one evidence request is unavailable and does not retry", async () => {
    const value = fixture();
    const client = bootstrapClient(value);
    client.getArtistTopSongsFirstPage.mockRejectedValueOnce(
      new AppleMusicClientError("missing", "not_found", 404),
    );
    const summary = await runAppleMusicIdentityBootstrap({
      artifact: value.artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      snapshot: value.snapshot,
      store: bootstrapStore(),
    });
    expect(summary.artists.find((artist) => artist.artist === "Alok")).toMatchObject({
      durableMappingWritten: false,
      finalClassification: "ambiguous",
      manualReviewRequired: true,
      requestsMade: 2,
      unavailableEvidenceCount: 1,
    });
    expect(client.getArtistTopSongsFirstPage).toHaveBeenCalledTimes(16);
  });

  it("keeps a candidate pair with no frozen evidence in manual review", async () => {
    const value = fixture();
    const alok = value.snapshot.artists.find((artist) => artist.canonicalName === "Alok")!;
    value.snapshot.groundTruthReleases = value.snapshot.groundTruthReleases.filter(
      (release) => release.canonicalArtistId !== alok.canonicalArtistId,
    );
    value.artifact.artists.find(
      (artist) => artist.canonicalArtistName === "Alok",
    )!.frozenReleaseCount = 0;
    value.artifact.artifactHash = computeAppleMusicIdentityBootstrapHash(value.artifact);
    const summary = await runAppleMusicIdentityBootstrap({
      artifact: value.artifact,
      authorization: authorization(),
      createClient: () => bootstrapClient(value),
      implementationCommit: "a".repeat(40),
      snapshot: value.snapshot,
      store: bootstrapStore(),
    });
    expect(summary.artists.find((artist) => artist.artist === "Alok")).toMatchObject({
      durableMappingWritten: false,
      finalClassification: "ambiguous",
      manualReviewRequired: true,
    });
  });

  it.each([
    [401, "apple_unauthorized"],
    [403, "apple_forbidden"],
    [429, "apple_rate_limited"],
  ])("stops on HTTP %i and releases the lease", async (status, stopReason) => {
    const value = fixture();
    const client = bootstrapClient(value);
    client.getArtist.mockRejectedValueOnce(
      new AppleMusicClientError("terminal", "terminal", status),
    );
    const store = bootstrapStore();
    const summary = await runAppleMusicIdentityBootstrap({
      artifact: value.artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      snapshot: value.snapshot,
      store,
    });
    expect(summary).toMatchObject({ status: "failed", stopReason });
    expect(client.getArtist).toHaveBeenCalledOnce();
    expect(client.getArtistTopSongsFirstPage).not.toHaveBeenCalled();
    expect(store.releaseLease).toHaveBeenCalledOnce();
  });

  it("reuses a durable confirmed mapping without making or rewriting an identity request", async () => {
    const value = fixture();
    const client = bootstrapClient(value);
    const store = bootstrapStore();
    store.findConfirmedMapping.mockResolvedValueOnce({ appleArtistId: "existing" });
    const summary = await runAppleMusicIdentityBootstrap({
      artifact: value.artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      snapshot: value.snapshot,
      store,
    });
    expect(summary.artists[0]).toMatchObject({
      durableMappingWritten: false,
      path: "durable_existing",
      requestsMade: 0,
    });
    expect(client.getArtist).toHaveBeenCalledTimes(4);
    expect(store.saveMapping).toHaveBeenCalledTimes(12);
  });

  it("rejects missing source validation and persistent provider enablement", () => {
    expect(() =>
      authorizeAppleMusicIdentityBootstrap({
        confirmation: appleMusicIdentityBootstrapConfirmation,
        evidenceSourcesValidated: false,
        executeLive: true,
        otherProvidersDisabled: true,
        persistentAppleMusicEnabled: "false",
        storefront: "us",
      }),
    ).toThrow("sources");
    expect(() =>
      authorizeAppleMusicIdentityBootstrap({
        confirmation: appleMusicIdentityBootstrapConfirmation,
        evidenceSourcesValidated: true,
        executeLive: true,
        otherProvidersDisabled: true,
        persistentAppleMusicEnabled: "true",
        storefront: "us",
      }),
    ).toThrow("exactly false");
  });
});

function authorization() {
  return authorizeAppleMusicIdentityBootstrap({
    confirmation: appleMusicIdentityBootstrapConfirmation,
    evidenceSourcesValidated: true,
    executeLive: true,
    otherProvidersDisabled: true,
    persistentAppleMusicEnabled: "false",
    storefront: "us",
  });
}

function fixture(): {
  artifact: AppleMusicIdentityBootstrapArtifact;
  snapshot: ItunesPilotSnapshot;
} {
  const seeded = new Set(["ZHU", "Don Diablo", "SISTO", "William Black", "YUSSI"]);
  const artists = appleMusicIdentityBootstrapArtists.map((canonicalName, index) => ({
    aliases: canonicalName === "4B" ? ["Four B"] : [],
    canonicalArtistId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    canonicalName,
    cohortReason: "identity_stress" as const,
    genres: [],
    inclusionState: { active: true },
    normalizedName: normalizeText(canonicalName),
    spotifyArtistId: `spotify-${index + 1}`,
    spotifyCoverageTimestamp: "2026-07-29T00:00:00Z",
  }));
  const groundTruthReleases = artists.map((artist, index) => ({
    canonicalArtistId: artist.canonicalArtistId,
    canonicalReleaseId: `release-${index + 1}`,
    creditedArtists: [],
    feedEligible: true,
    normalizedTitle: normalizeText(`Release ${artist.canonicalName}`),
    releaseDate: "2026-07-01",
    releaseDatePrecision: "day",
    releaseType: "single",
    spotifyReleaseId: `spotify-release-${index + 1}`,
    title: `Release ${artist.canonicalName}`,
    tracks: [],
  }));
  const snapshot: ItunesPilotSnapshot = {
    artists,
    groundTruthReleases,
    mainRepositoryCommit: "a".repeat(40),
    mainSchemaVersion: 20,
    snapshotHash: "b".repeat(64),
    snapshotTimestamp: "2026-07-29T23:59:59Z",
    version: 1,
    windowEnd: "2026-07-29",
    windowStart: "2026-05-30",
  };
  const payload = {
    artists: appleMusicIdentityBootstrapArtists.map((canonicalArtistName, index) =>
      seeded.has(canonicalArtistName)
        ? {
            candidateArtistId: String(1000 + index),
            canonicalArtistName,
            evidenceSource: "docs/itunes-pilot-identity-provenance.csv",
            evidenceSourceHash: "a".repeat(64),
            frozenReleaseCount: 1,
            plausibleExactNameCandidates: 2,
          }
        : {
            candidateEvidenceArtistIds: [String(2000 + index * 2), String(2001 + index * 2)],
            candidateEvidenceSource: "sanitized-apple-response-cache",
            canonicalArtistName,
            frozenReleaseCount: 1,
            plausibleExactNameCandidates: 2,
          },
    ),
    evidenceAsOf: "2026-07-31",
    snapshotHash: snapshot.snapshotHash,
    version: 1 as const,
  };
  return {
    artifact: {
      ...payload,
      artifactHash: computeAppleMusicIdentityBootstrapHash(payload),
    },
    snapshot,
  };
}

function bootstrapClient(value: ReturnType<typeof fixture>) {
  const seedById = new Map(
    value.artifact.artists
      .filter((artist) => artist.candidateArtistId)
      .map((artist) => [artist.candidateArtistId!, artist]),
  );
  const evidenceById = new Map(
    value.artifact.artists.flatMap((artist) =>
      (artist.candidateEvidenceArtistIds ?? []).map(
        (id, index) => [id, { artist, index }] as const,
      ),
    ),
  );
  return {
    getArtist: vi.fn<AppleMusicIdentityBootstrapClient["getArtist"]>((artistId) => {
      const seed = seedById.get(artistId);
      return Promise.resolve(
        seed
          ? {
              artistId,
              genreNames: [],
              name: seed.canonicalArtistName,
              sourceStorefront: "us",
            }
          : undefined,
      );
    }),
    getArtistTopSongsFirstPage: vi.fn<
      AppleMusicIdentityBootstrapClient["getArtistTopSongsFirstPage"]
    >((artistId) => {
      const evidence = evidenceById.get(artistId);
      if (!evidence) throw new Error("Unexpected synthetic candidate.");
      return Promise.resolve({
        items:
          evidence.index === 0
            ? [
                topSong(artistId, evidence.artist.canonicalArtistName, {
                  albumId: `album-${artistId}`,
                  albumName: `Release ${evidence.artist.canonicalArtistName}`,
                }),
              ]
            : [
                topSong(artistId, evidence.artist.canonicalArtistName, {
                  albumId: `album-${artistId}`,
                  albumName: "Unrelated",
                  title: "Unrelated",
                }),
              ],
        nextPresent: true,
      });
    }),
  };
}

function topSong(
  artistId: string,
  artistName: string,
  overrides: { albumId: string; albumName: string; title?: string },
) {
  return {
    artistIds: [artistId],
    artistName,
    pageNumber: 1,
    paginationPath: "/synthetic",
    releaseDate: "2026-07-01",
    songId: `song-${artistId}`,
    sourceStorefront: "us",
    title: overrides.title ?? overrides.albumName,
    ...overrides,
  };
}

function bootstrapStore() {
  return {
    claimLease: vi.fn<AppleMusicIdentityBootstrapStore["claimLease"]>(() =>
      Promise.resolve("lease"),
    ),
    createRun: vi.fn<AppleMusicIdentityBootstrapStore["createRun"]>(() =>
      Promise.resolve({ id: "00000000-0000-4000-8000-000000000100" }),
    ),
    findConfirmedMapping: vi.fn<AppleMusicIdentityBootstrapStore["findConfirmedMapping"]>(() =>
      Promise.resolve(undefined),
    ),
    finishRun: vi.fn<AppleMusicIdentityBootstrapStore["finishRun"]>(() => Promise.resolve()),
    importSnapshot: vi.fn<AppleMusicIdentityBootstrapStore["importSnapshot"]>(() =>
      Promise.resolve("00000000-0000-4000-8000-000000000200"),
    ),
    operationalStatus: vi.fn<AppleMusicIdentityBootstrapStore["operationalStatus"]>(() =>
      Promise.resolve({ cooldownActive: false, leaseActive: false }),
    ),
    readEvidence: vi.fn<AppleMusicIdentityBootstrapStore["readEvidence"]>(() =>
      Promise.resolve({
        authenticationAttempts: 1,
        cacheHits: 0,
        endpointRequestCounts: { artist: 5, artist_top_songs: 16 },
        httpStatusCounts: { "200": 21 },
        maximumConcurrency: 1,
        minimumRequestIntervalMs: 1_100,
        paginationRequests: 0,
        requestCount: 21,
        retryCount: 0,
      }),
    ),
    releaseLease: vi.fn<AppleMusicIdentityBootstrapStore["releaseLease"]>(() => Promise.resolve()),
    saveMapping: vi.fn<AppleMusicIdentityBootstrapStore["saveMapping"]>(() => Promise.resolve()),
  };
}
