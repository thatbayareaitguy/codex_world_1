import { describe, expect, it, vi } from "vitest";
import { AppleMusicClientError, type AppleMusicArtist } from "@radar/providers";
import {
  appleMusicStageBLiveConfirmation,
  authorizeAppleMusicStageBLive,
  createAppleMusicStageBLivePlan,
  runAppleMusicStageBLive,
  type AppleMusicStageBLiveClient,
  type AppleMusicStageBLiveScope,
  type AppleMusicStageBLiveStore,
} from "./apple-music-stage-b-live";

/* eslint-disable @typescript-eslint/unbound-method */

describe("Apple Music Stage B live evidence", () => {
  it("authorizes only the exact disabled-provider public-catalog gate", () => {
    expect(() =>
      authorizeAppleMusicStageBLive({
        confirmation: "wrong",
        executeLive: true,
        otherProvidersDisabled: true,
        persistentAppleMusicEnabled: "false",
        storefront: "us",
      }),
    ).toThrow(appleMusicStageBLiveConfirmation);
    expect(() =>
      authorizeAppleMusicStageBLive({
        confirmation: appleMusicStageBLiveConfirmation,
        executeLive: true,
        otherProvidersDisabled: true,
        persistentAppleMusicEnabled: "true",
        storefront: "us",
      }),
    ).toThrow("must remain exactly false");
  });

  it("plans exactly six artists, 39 candidates, two batches, and no side effects", () => {
    const plan = createAppleMusicStageBLivePlan(scope());
    expect(plan).toMatchObject({
      candidateBatchLookupRequests: 2,
      candidateCount: 39,
      maximumSinglesFallbackRequests: 39,
      maximumTopSongsRequests: 39,
      networkRequestsStarted: 0,
      requestBudget: 88,
      watchedArtistCount: 6,
    });
    expect(plan.safety).toEqual({
      credentialsAccessed: false,
      databaseWrites: 0,
      developerTokenGenerated: false,
      httpClientInitialized: false,
      privateKeyAccessed: false,
    });
  });

  it("binds two batch responses by returned ID and skips Singles after safe Top Songs winners", async () => {
    const inputScope = scope();
    const fake = client(inputScope, { topSongsWinners: true });
    const store = stageBStore(() => fake.networkRequests());
    const result = await runAppleMusicStageBLive({
      authorization: authorization(),
      createClient: () => fake.client,
      implementationCommit: "a".repeat(40),
      scope: inputScope,
      snapshotId: "snapshot",
      store,
    });
    expect(result.status).toBe("completed");
    expect(result.newDurableMappings).toBe(6);
    expect(result.batchValidation).toMatchObject({ requests: 2, returnedCandidates: 39 });
    expect(fake.client.getArtists).toHaveBeenCalledTimes(2);
    expect(fake.client.getArtistTopSongsFirstPage).toHaveBeenCalledTimes(39);
    expect(fake.client.getArtistViewFirstPage).not.toHaveBeenCalled();
    expect(store.saveDurableMapping).toHaveBeenCalledTimes(6);
    expect(store.releaseLease).toHaveBeenCalledOnce();
  });

  it("uses conditional first-page Singles only after complete Top Songs remains ambiguous", async () => {
    const inputScope = scope();
    const fake = client(inputScope, { singlesWinners: true });
    const store = stageBStore(() => fake.networkRequests());
    const result = await runAppleMusicStageBLive({
      authorization: authorization(),
      createClient: () => fake.client,
      implementationCommit: "b".repeat(40),
      scope: inputScope,
      snapshotId: "snapshot",
      store,
    });
    expect(result.status).toBe("completed");
    expect(result.newDurableMappings).toBe(6);
    expect(fake.client.getArtistTopSongsFirstPage).toHaveBeenCalledTimes(39);
    expect(fake.client.getArtistViewFirstPage).toHaveBeenCalledTimes(39);
    expect(
      vi
        .mocked(fake.client.getArtistViewFirstPage)
        .mock.calls.every((call) => call[1] === "singles"),
    ).toBe(true);
  });

  it.each([400, 404])(
    "keeps a candidate-specific HTTP %i nonterminal and blocks confirmation from missing evidence",
    async (unavailableStatus) => {
      const inputScope = scope();
      const unavailableId = inputScope.artists[0]!.candidateArtistIds[0]!;
      const fake = client(inputScope, {
        topSongsWinners: true,
        unavailableTopSongsId: unavailableId,
        unavailableTopSongsStatus: unavailableStatus,
      });
      const store = stageBStore(() => fake.networkRequests());
      const result = await runAppleMusicStageBLive({
        authorization: authorization(),
        createClient: () => fake.client,
        implementationCommit: "c".repeat(40),
        scope: inputScope,
        snapshotId: "snapshot",
        store,
      });
      expect(result.status).toBe("completed");
      expect(result.artists[0]).toMatchObject({
        durableMappingWritten: false,
        finalClassification: "ambiguous",
        manualReviewRequired: true,
        unavailableCandidateEvidence: 1,
      });
      expect(result.newDurableMappings).toBe(5);
      expect(store.releaseLease).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [401, "apple_unauthorized"],
    [403, "apple_forbidden"],
    [429, "apple_rate_limited"],
  ])("stops on HTTP %i and releases the lease", async (status, reason) => {
    const inputScope = scope();
    const fake = client(inputScope, { terminalStatus: status });
    const store = stageBStore(() => fake.networkRequests());
    const result = await runAppleMusicStageBLive({
      authorization: authorization(),
      createClient: () => fake.client,
      implementationCommit: "d".repeat(40),
      scope: inputScope,
      snapshotId: "snapshot",
      store,
    });
    expect(result).toMatchObject({ status: "failed", stopReason: reason });
    expect(store.releaseLease).toHaveBeenCalledOnce();
  });

  it("rejects duplicate or extra batch identities before catalog evidence", async () => {
    const inputScope = scope();
    const fake = client(inputScope, { duplicateBatchIdentity: true });
    const store = stageBStore(() => fake.networkRequests());
    const result = await runAppleMusicStageBLive({
      authorization: authorization(),
      createClient: () => fake.client,
      implementationCommit: "e".repeat(40),
      scope: inputScope,
      snapshotId: "snapshot",
      store,
    });
    expect(result).toMatchObject({
      status: "failed",
      stopReason: "duplicate_candidate_batch_identity",
    });
    expect(fake.client.getArtistTopSongsFirstPage).not.toHaveBeenCalled();
    expect(store.releaseLease).toHaveBeenCalledOnce();
  });

  it("returns before run creation and HTTP initialization when a durable mapping exists", async () => {
    const inputScope = scope();
    const store = stageBStore(() => 0);
    store.listDurableMappings = vi.fn(() =>
      Promise.resolve([
        {
          appleArtistId: "9000",
          artistName: "Artist 1",
          canonicalArtistId: inputScope.artists[0]!.watchedArtistId,
          confirmationMethod: "manual_confirmation" as const,
          sourceClassification: "manual",
        },
      ]),
    );
    const createClient = vi.fn();
    await expect(
      runAppleMusicStageBLive({
        authorization: authorization(),
        createClient,
        implementationCommit: "f".repeat(40),
        scope: inputScope,
        snapshotId: "snapshot",
        store,
      }),
    ).rejects.toThrow("durable mapping already exists");
    expect(store.createRun).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("classifies request and runtime budget stops and still releases the lease", async () => {
    for (const classification of [
      "request_budget_exhausted",
      "runtime_budget_exhausted",
    ] as const) {
      const inputScope = scope();
      const fake = client(inputScope, { terminalClassification: classification });
      const store = stageBStore(() => fake.networkRequests());
      const result = await runAppleMusicStageBLive({
        authorization: authorization(),
        createClient: () => fake.client,
        implementationCommit: "1".repeat(40),
        scope: inputScope,
        snapshotId: "snapshot",
        store,
      });
      expect(result).toMatchObject({ status: "controlled_partial", stopReason: classification });
      expect(store.releaseLease).toHaveBeenCalledOnce();
    }
  });

  it("rejects scope drift before database or HTTP work", async () => {
    const invalid = scope();
    invalid.artists[0]!.candidateArtistIds.pop();
    const store = stageBStore(() => 0);
    const createClient = vi.fn();
    await expect(
      runAppleMusicStageBLive({
        authorization: authorization(),
        createClient,
        implementationCommit: "2".repeat(40),
        scope: invalid,
        snapshotId: "snapshot",
        store,
      }),
    ).rejects.toThrow("exactly six artists and 39 candidates");
    expect(store.operationalStatus).not.toHaveBeenCalled();
    expect(store.createRun).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("does not fetch evidence or confirm when lookup names are incompatible", async () => {
    const inputScope = scope();
    const fake = client(inputScope, { incompatibleNames: true });
    const store = stageBStore(() => fake.networkRequests());
    const result = await runAppleMusicStageBLive({
      authorization: authorization(),
      createClient: () => fake.client,
      implementationCommit: "3".repeat(40),
      scope: inputScope,
      snapshotId: "snapshot",
      store,
    });
    expect(result.status).toBe("completed");
    expect(result.newDurableMappings).toBe(0);
    expect(result.batchValidation.incompatibleCandidates).toBe(39);
    expect(fake.client.getArtistTopSongsFirstPage).not.toHaveBeenCalled();
    expect(fake.client.getArtistViewFirstPage).not.toHaveBeenCalled();
  });

  it("keeps a missing batch candidate unresolved even when another candidate has strong evidence", async () => {
    const inputScope = scope();
    const missingCandidateId = inputScope.artists[0]!.candidateArtistIds.at(-1)!;
    const fake = client(inputScope, { missingCandidateId, topSongsWinners: true });
    const store = stageBStore(() => fake.networkRequests());
    const result = await runAppleMusicStageBLive({
      authorization: authorization(),
      createClient: () => fake.client,
      implementationCommit: "4".repeat(40),
      scope: inputScope,
      snapshotId: "snapshot",
      store,
    });
    expect(result.artists[0]).toMatchObject({
      durableMappingWritten: false,
      finalClassification: "ambiguous",
    });
    expect(result.batchValidation.missingCandidates).toBe(1);
    expect(result.newDurableMappings).toBe(5);
  });
});

function authorization() {
  return authorizeAppleMusicStageBLive({
    confirmation: appleMusicStageBLiveConfirmation,
    executeLive: true,
    otherProvidersDisabled: true,
    persistentAppleMusicEnabled: "false",
    storefront: "us",
  });
}

function scope(): AppleMusicStageBLiveScope {
  const counts = [5, 9, 8, 5, 10, 2];
  let candidate = 1000;
  return {
    artifactHash: "a".repeat(64),
    artists: counts.map((candidateCount, index) => {
      const canonicalName = `Artist ${index + 1}`;
      const candidateArtistIds = Array.from({ length: candidateCount }, () => String(candidate++));
      return {
        aliases: [],
        candidateArtistIds,
        canonicalName,
        groundTruth: {
          aliases: [],
          canonicalName,
          evidenceCutoff: "2026-07-29T23:59:59.000Z",
          evidenceSources: ["approved_frozen_spotify_snapshot"],
          releases: [
            {
              canonicalReleaseId: `release-${index}`,
              evidenceCutoff: "2026-07-29T23:59:59.000Z",
              evidenceSource: "approved_frozen_spotify_snapshot",
              normalizedTitle: `release ${index + 1}`,
              releaseDate: "2026-07-25",
              releaseType: "single",
              spotifyReleaseId: `source-${index}`,
              title: `Release ${index + 1}`,
              tracks: [
                {
                  normalizedTitle: `track ${index + 1}`,
                  releaseDate: "2026-07-25",
                  title: `Track ${index + 1}`,
                },
              ],
            },
          ],
          watchedArtistId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        },
        watchedArtistId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      };
    }),
    candidateCount: 39,
    reviewArtifactHash: "b".repeat(64),
    sourceWatchlistHash: "c".repeat(64),
  };
}

function client(
  inputScope: AppleMusicStageBLiveScope,
  options: {
    duplicateBatchIdentity?: boolean;
    incompatibleNames?: boolean;
    missingCandidateId?: string;
    singlesWinners?: boolean;
    terminalClassification?: "request_budget_exhausted" | "runtime_budget_exhausted";
    terminalStatus?: number;
    topSongsWinners?: boolean;
    unavailableTopSongsId?: string;
    unavailableTopSongsStatus?: number;
  },
) {
  const owner = new Map(
    inputScope.artists.flatMap((artist) =>
      artist.candidateArtistIds.map((id, index) => [id, { artist, index }] as const),
    ),
  );
  let requests = 0;
  let terminalThrown = false;
  const maybeTerminal = () => {
    if (terminalThrown) return;
    if (options.terminalStatus !== undefined) {
      terminalThrown = true;
      throw new AppleMusicClientError("terminal", "http_error", options.terminalStatus);
    }
    if (options.terminalClassification) {
      terminalThrown = true;
      throw new AppleMusicClientError("budget", options.terminalClassification);
    }
  };
  const fake: AppleMusicStageBLiveClient = {
    getArtists: vi.fn<AppleMusicStageBLiveClient["getArtists"]>((ids) => {
      requests += 1;
      const items = ids
        .filter((id) => id !== options.missingCandidateId)
        .map((id) => artistResource(id, owner.get(id)!.artist.canonicalName, options));
      if (options.duplicateBatchIdentity && items[0]) items.push(items[0]);
      return Promise.resolve({
        items,
        missingIds: ids.filter((id) => id === options.missingCandidateId),
      });
    }),
    getArtistTopSongsFirstPage: vi.fn<AppleMusicStageBLiveClient["getArtistTopSongsFirstPage"]>(
      (artistId) => {
        requests += 1;
        try {
          maybeTerminal();
          if (artistId === options.unavailableTopSongsId) {
            throw new AppleMusicClientError(
              "unavailable",
              "not_found",
              options.unavailableTopSongsStatus ?? 404,
            );
          }
          const entry = owner.get(artistId)!;
          const winning = options.topSongsWinners && entry.index === 0;
          return Promise.resolve({
            items: [song(artistId, entry.artist, winning)],
            nextPresent: true,
          });
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error("synthetic failure"));
        }
      },
    ),
    getArtistViewFirstPage: vi.fn<AppleMusicStageBLiveClient["getArtistViewFirstPage"]>(
      (artistId) => {
        requests += 1;
        const entry = owner.get(artistId)!;
        const winning = options.singlesWinners && entry.index === 0;
        return Promise.resolve({
          items: [album(artistId, entry.artist, winning)],
          nextPresent: true,
        });
      },
    ),
  };
  return { client: fake, networkRequests: () => requests };
}

function artistResource(
  artistId: string,
  canonicalName: string,
  options: { incompatibleNames?: boolean },
): AppleMusicArtist {
  return {
    artistId,
    genreNames: [],
    name: options.incompatibleNames ? "Different Artist" : canonicalName,
    sourceStorefront: "us",
  };
}

function song(
  artistId: string,
  artist: AppleMusicStageBLiveScope["artists"][number],
  winning: boolean | undefined,
) {
  const index = Number(artist.canonicalName.split(" ")[1]);
  return {
    albumId: `album-${artistId}`,
    albumName: winning ? `Release ${index}` : `Unrelated ${artistId}`,
    artistIds: [artistId],
    artistName: artist.canonicalName,
    paginationPath: "synthetic",
    pageNumber: 1,
    releaseDate: "2026-07-25",
    songId: `song-${artistId}`,
    sourceStorefront: "us",
    title: winning ? `Track ${index}` : `Other ${artistId}`,
  };
}

function album(
  artistId: string,
  artist: AppleMusicStageBLiveScope["artists"][number],
  winning: boolean | undefined,
) {
  const index = Number(artist.canonicalName.split(" ")[1]);
  return {
    albumId: `single-${artistId}`,
    artistIds: [artistId],
    artistName: artist.canonicalName,
    genreNames: [],
    paginationPath: "synthetic",
    pageNumber: 1,
    releaseDate: "2026-07-25",
    sourceStorefront: "us",
    sourceView: "singles" as const,
    title: winning ? `Release ${index}` : `Unrelated ${artistId}`,
  };
}

function stageBStore(requests: () => number): AppleMusicStageBLiveStore {
  return {
    claimLease: vi.fn(() => Promise.resolve("lease")),
    createRun: vi.fn(() => Promise.resolve({ id: "run" })),
    finishRun: vi.fn(() => Promise.resolve()),
    listDurableMappings: vi.fn(() => Promise.resolve([])),
    operationalStatus: vi.fn(() =>
      Promise.resolve({ cooldownActive: false, leaseActive: false, queueDepth: 0 }),
    ),
    readEvidence: vi.fn(() =>
      Promise.resolve({
        authenticationAttempts: 0,
        cacheHits: 0,
        endpointRequestCounts: {},
        httpStatusCounts: {},
        maximumConcurrency: requests() > 0 ? 1 : 0,
        paginationRequests: 0,
        requestCount: requests(),
        retryCount: 0,
      }),
    ),
    releaseLease: vi.fn(() => Promise.resolve()),
    saveDurableMapping: vi.fn<AppleMusicStageBLiveStore["saveDurableMapping"]>((input) =>
      Promise.resolve({
        appleArtistId: input.appleArtistId,
        artistName: input.artistName,
        canonicalArtistId: input.canonicalArtistId,
        confirmationMethod: input.confirmationMethod,
        sourceClassification: input.sourceClassification,
      }),
    ),
    saveMapping: vi.fn(() => Promise.resolve()),
  };
}
