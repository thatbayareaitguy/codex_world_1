import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AppleMusicClientError } from "@radar/providers";
import type { AppleMusicDurableArtistMapping } from "@radar/db";
import {
  appleMusicFullWatchlistConfirmation,
  authorizeAppleMusicFullWatchlist,
  createAppleMusicFullWatchlistPlan,
  createAppleMusicManualReviewArtifacts,
  resolveFullWatchlistAmbiguousCandidate,
  runAppleMusicFullWatchlistStrongSeeds,
  type AppleMusicFullWatchlistClient,
  type AppleMusicFullWatchlistCampaignEntry,
  type AppleMusicFullWatchlistStore,
} from "./apple-music-full-watchlist-mapping";
import {
  readAppleMusicIdentitySeedArtifact,
  type AppleMusicIdentitySeedArtifact,
} from "./apple-music-identity-seed-artifact";

let artifact: AppleMusicIdentitySeedArtifact;

beforeAll(async () => {
  artifact = await readAppleMusicIdentitySeedArtifact(
    resolve("apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json"),
  );
});

describe("Apple full-watchlist identity campaign", () => {
  it("plans the exact artifact with zero side effects and bounded Stage A batches", () => {
    const plan = createAppleMusicFullWatchlistPlan(artifact, []);
    expect(plan).toMatchObject({
      artifact: { schemaVersion: 1, totalArtists: 593 },
      categories: {
        ambiguousSeeds: 272,
        evidenceSupportedSeeds: 13,
        highConfidenceSeeds: 307,
        manualReview: 1,
      },
      safety: {
        credentialsAccessed: false,
        databaseWrites: 0,
        developerTokenGenerated: false,
        networkRequestsStarted: 0,
        providerClientInitialized: false,
        releaseDiscoveryReachable: false,
      },
      stageA: {
        batchRequests: 13,
        noNameSearch: true,
        noPagination: true,
        requestBudget: 40,
        strongSeeds: 320,
      },
      stageB: { executionAuthorized: false, remainingAmbiguousArtists: 272 },
    });
  });

  it("validates strong seeds in ID batches and confirms by identity rather than batch position", async () => {
    const client = compatibleClient();
    const store = campaignStore(() => client.getArtists.mock.calls.length);
    const summary = await runAppleMusicFullWatchlistStrongSeeds({
      artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      store,
    });
    expect(summary).toMatchObject({
      confirmed: 320,
      evidenceSupportedConfirmed: 13,
      highConfidenceConfirmed: 307,
      status: "completed",
      stopReason: "strong_seed_validation_completed",
      totalDurableMappings: 320,
    });
    expect(client.getArtists).toHaveBeenCalledTimes(13);
    expect(client.getArtists.mock.calls.every(([ids]) => ids.length <= 25)).toBe(true);
    expect(store.saveDurableMapping).toHaveBeenCalledTimes(320);
    expect(store.releaseLease).toHaveBeenCalledOnce();
  });

  it("reuses durable mappings and never requests those candidate IDs", async () => {
    const strong = artifact.entries.filter((entry) => entry.candidateArtistId).slice(0, 25);
    const client = compatibleClient();
    const store = campaignStore(() => client.getArtists.mock.calls.length);
    store.listDurableMappings.mockResolvedValue(
      strong.map((entry) => ({
        appleArtistId: entry.candidateArtistId!,
        artistName: entry.canonicalArtistName,
        canonicalArtistId: entry.watchedArtistId,
        confirmationMethod: "legacy_validated",
        sourceClassification: "existing_id_confirmed",
      })),
    );
    const summary = await runAppleMusicFullWatchlistStrongSeeds({
      artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      store,
    });
    const requested = new Set(client.getArtists.mock.calls.flatMap(([ids]) => ids));
    expect(strong.every((entry) => !requested.has(entry.candidateArtistId!))).toBe(true);
    expect(summary.existingMappingsReused).toBe(25);
  });

  it("leaves a missing batch ID unresolved without attributing another artist", async () => {
    const missing = artifact.entries.find((entry) => entry.candidateArtistId)!;
    const client = compatibleClient();
    client.getArtists.mockImplementationOnce((ids) =>
      Promise.resolve({
        items: ids.slice(1).map((id) => artistForCandidate(id)),
        missingIds: [missing.candidateArtistId!],
      }),
    );
    const store = campaignStore(() => client.getArtists.mock.calls.length);
    const summary = await runAppleMusicFullWatchlistStrongSeeds({
      artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      store,
    });
    expect(summary).toMatchObject({ missing: 1, status: "completed" });
    expect(
      store.saveDurableMapping.mock.calls.some(
        ([input]) => input.canonicalArtistId === missing.watchedArtistId,
      ),
    ).toBe(false);
  });

  it("blocks incompatible names and rejects unsafe extra batch identities", async () => {
    const client = compatibleClient();
    client.getArtists.mockImplementationOnce((ids) =>
      Promise.resolve({
        items: ids.map((id, index) =>
          index === 0
            ? { ...artistForCandidate(id), name: "Wrong Artist" }
            : artistForCandidate(id),
        ),
        missingIds: [],
      }),
    );
    const first = await runAppleMusicFullWatchlistStrongSeeds({
      artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      store: campaignStore(() => client.getArtists.mock.calls.length),
    });
    expect(first.rejected).toBe(1);

    const unsafe = compatibleClient();
    unsafe.getArtists.mockImplementationOnce((ids) =>
      Promise.resolve({
        items: [...ids.map((id) => artistForCandidate(id)), artistForCandidate("999999999999")],
        missingIds: [],
      }),
    );
    const unsafeStore = campaignStore(() => unsafe.getArtists.mock.calls.length);
    const second = await runAppleMusicFullWatchlistStrongSeeds({
      artifact,
      authorization: authorization(),
      createClient: () => unsafe,
      implementationCommit: "a".repeat(40),
      store: unsafeStore,
    });
    expect(second).toMatchObject({ status: "failed", stopReason: "unsafe_batch_response" });
    expect(unsafe.getArtists).toHaveBeenCalledOnce();
    expect(unsafeStore.releaseLease).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "apple_unauthorized"],
    [403, "apple_forbidden"],
    [429, "apple_rate_limited"],
  ])("stops HTTP %i and releases the lease", async (status, reason) => {
    const client = compatibleClient();
    client.getArtists.mockRejectedValueOnce(
      new AppleMusicClientError("terminal", "http_error", status),
    );
    const store = campaignStore(() => client.getArtists.mock.calls.length);
    const summary = await runAppleMusicFullWatchlistStrongSeeds({
      artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      store,
    });
    expect(summary).toMatchObject({ status: "failed", stopReason: reason });
    expect(client.getArtists).toHaveBeenCalledOnce();
    expect(store.releaseLease).toHaveBeenCalledOnce();
  });

  it.each([
    [500, "http_error", "apple_server_error", "controlled_partial"],
    [undefined, "request_budget_exhausted", "request_budget_exhausted", "controlled_partial"],
    [undefined, "runtime_budget_exhausted", "runtime_budget_exhausted", "controlled_partial"],
  ] as const)(
    "stops safely for status %s classification %s",
    async (httpStatus, classification, reason, status) => {
      const client = compatibleClient();
      client.getArtists.mockRejectedValueOnce(
        new AppleMusicClientError("bounded stop", classification, httpStatus),
      );
      const store = campaignStore(() => client.getArtists.mock.calls.length);
      const summary = await runAppleMusicFullWatchlistStrongSeeds({
        artifact,
        authorization: authorization(),
        createClient: () => client,
        implementationCommit: "a".repeat(40),
        store,
      });
      expect(summary).toMatchObject({ status, stopReason: reason });
      expect(client.getArtists).toHaveBeenCalledOnce();
      expect(store.releaseLease).toHaveBeenCalledOnce();
    },
  );

  it("reconciles a durable mapping left behind by an interrupted batch before requesting", async () => {
    const interrupted = artifact.entries.find((entry) => entry.candidateArtistId)!;
    const client = compatibleClient();
    const store = campaignStore(() => client.getArtists.mock.calls.length, {
      durable: [
        {
          appleArtistId: interrupted.candidateArtistId!,
          artistName: interrupted.canonicalArtistName,
          canonicalArtistId: interrupted.watchedArtistId,
          confirmationMethod: "high_confidence_seed",
          sourceClassification: interrupted.classification,
        },
      ],
      pendingDurableArtistId: interrupted.watchedArtistId,
    });
    await runAppleMusicFullWatchlistStrongSeeds({
      artifact,
      authorization: authorization(),
      createClient: () => client,
      implementationCommit: "a".repeat(40),
      store,
    });
    expect(client.getArtists.mock.calls.flatMap(([ids]) => ids)).not.toContain(
      interrupted.candidateArtistId,
    );
    expect(store.updateCampaignEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalArtistId: interrupted.watchedArtistId,
        status: "reused",
      }),
    );
  });

  it("delegates ambiguous evidence to the existing resolver and preserves its thresholds", () => {
    const decision = resolveFullWatchlistAmbiguousCandidate({
      aliases: [],
      candidateCatalogs: [
        {
          albums: [album("candidate-a", "Known Release")],
          artist: artist("candidate-a", "Same Name"),
          songs: [],
        },
        {
          albums: [],
          artist: artist("candidate-b", "Same Name"),
          songs: [],
        },
      ],
      canonicalName: "Same Name",
      groundTruth: [groundTruth("Known Release")],
    });
    expect(decision).toMatchObject({ status: "evidence_confirmed" });
    expect(decision.evidence.map((item) => item.score)).toEqual([3, 0]);
  });

  it("produces a sanitized committed review and a local ID-bearing review artifact", () => {
    const entry = artifact.entries.find((item) => item.classification === "ambiguous_seed")!;
    const outputs = createAppleMusicManualReviewArtifacts(artifact, [
      {
        artifactClassification: entry.classification,
        attempts: 0,
        batchIndex: null,
        candidateCount: entry.alternateCandidateIds.length,
        canonicalArtistId: entry.watchedArtistId,
        evidence: {},
        manualReviewReason: "Evidence remains tied.",
        selectedAppleArtistId: null,
        selectedArtistName: null,
        status: "manual_review",
        validationPath: "stage_b_or_manual_review",
      },
    ]);
    expect(outputs.localJson).toContain(entry.alternateCandidateIds[0]!);
    expect(outputs.markdown).not.toContain(entry.alternateCandidateIds[0]!);
    expect(outputs.markdown).not.toMatch(/authorization|developer token|private key/i);
  });

  it("rejects missing confirmation and persistent enablement before store or HTTP work", () => {
    expect(() =>
      authorizeAppleMusicFullWatchlist({
        confirmation: "WRONG",
        executeLive: true,
        otherProvidersDisabled: true,
        persistentAppleMusicEnabled: "false",
        stage: "strong_seeds",
        storefront: "us",
      }),
    ).toThrow(appleMusicFullWatchlistConfirmation);
    expect(() =>
      authorizeAppleMusicFullWatchlist({
        confirmation: appleMusicFullWatchlistConfirmation,
        executeLive: true,
        otherProvidersDisabled: true,
        persistentAppleMusicEnabled: "true",
        stage: "strong_seeds",
        storefront: "us",
      }),
    ).toThrow("exactly false");
  });
});

function authorization() {
  return authorizeAppleMusicFullWatchlist({
    confirmation: appleMusicFullWatchlistConfirmation,
    executeLive: true,
    otherProvidersDisabled: true,
    persistentAppleMusicEnabled: "false",
    stage: "strong_seeds",
    storefront: "us",
  });
}

function compatibleClient() {
  const byId = new Map(
    artifact.entries.flatMap((entry) =>
      entry.candidateArtistId ? [[entry.candidateArtistId, entry] as const] : [],
    ),
  );
  return {
    getArtists: vi.fn<AppleMusicFullWatchlistClient["getArtists"]>((ids) =>
      Promise.resolve({
        items: [...ids].reverse().map((id) => {
          const entry = byId.get(id);
          if (!entry) throw new Error("Unexpected synthetic candidate.");
          return artist(id, entry.canonicalArtistName);
        }),
        missingIds: [],
      }),
    ),
  };
}

function artistForCandidate(id: string) {
  const entry = artifact.entries.find((candidate) => candidate.candidateArtistId === id);
  return artist(id, entry?.canonicalArtistName ?? "Unrequested");
}

function artist(artistId: string, name: string) {
  return { artistId, genreNames: [], name, sourceStorefront: "us" };
}

function album(artistId: string, title: string) {
  return {
    albumId: `album-${artistId}`,
    artistIds: [artistId],
    artistName: "Same Name",
    genreNames: [],
    paginationPath: "/synthetic",
    pageNumber: 1,
    releaseDate: "2026-07-01",
    sourceStorefront: "us",
    sourceView: "singles" as const,
    title,
  };
}

function groundTruth(title: string) {
  return {
    canonicalArtistId: "00000000-0000-4000-8000-000000000001",
    canonicalReleaseId: "release-1",
    creditedArtists: [],
    feedEligible: true,
    normalizedTitle: title.toLocaleLowerCase(),
    releaseDate: "2026-07-01",
    releaseDatePrecision: "day",
    releaseType: "single",
    spotifyReleaseId: "synthetic-release",
    title,
    tracks: [],
  };
}

function campaignStore(
  requestCount: () => number,
  options: {
    durable?: AppleMusicDurableArtistMapping[];
    pendingDurableArtistId?: string;
  } = {},
) {
  const entries = new Map<string, AppleMusicFullWatchlistCampaignEntry>();
  const durable: AppleMusicDurableArtistMapping[] = [...(options.durable ?? [])];
  const store = {
    advanceCampaign: vi.fn<AppleMusicFullWatchlistStore["advanceCampaign"]>(() =>
      Promise.resolve(),
    ),
    claimLease: vi.fn<AppleMusicFullWatchlistStore["claimLease"]>(() =>
      Promise.resolve("lease-token"),
    ),
    createRun: vi.fn<AppleMusicFullWatchlistStore["createRun"]>(() =>
      Promise.resolve({ id: "00000000-0000-4000-8000-000000000100" }),
    ),
    findCampaign: vi.fn<AppleMusicFullWatchlistStore["findCampaign"]>(() =>
      Promise.resolve(undefined),
    ),
    finishCampaign: vi.fn<AppleMusicFullWatchlistStore["finishCampaign"]>(() => Promise.resolve()),
    finishRun: vi.fn<AppleMusicFullWatchlistStore["finishRun"]>(() => Promise.resolve()),
    latestOperationalSnapshotId: vi.fn<AppleMusicFullWatchlistStore["latestOperationalSnapshotId"]>(
      () => Promise.resolve("00000000-0000-4000-8000-000000000200"),
    ),
    listCampaignEntries: vi.fn<AppleMusicFullWatchlistStore["listCampaignEntries"]>(() =>
      Promise.resolve([...entries.values()]),
    ),
    listDurableMappings: vi.fn<AppleMusicFullWatchlistStore["listDurableMappings"]>(() =>
      Promise.resolve([...durable]),
    ),
    operationalStatus: vi.fn<AppleMusicFullWatchlistStore["operationalStatus"]>(() =>
      Promise.resolve({ cooldownActive: false, leaseActive: false, queueDepth: 0 }),
    ),
    readEvidence: vi.fn<AppleMusicFullWatchlistStore["readEvidence"]>(() =>
      Promise.resolve({
        authenticationAttempts: 0,
        cacheHits: 0,
        endpointRequestCounts: { artists_batch: requestCount() },
        httpStatusCounts: { "200": requestCount() },
        maximumConcurrency: requestCount() > 0 ? 1 : 0,
        ...(requestCount() > 1 ? { minimumRequestIntervalMs: 1_100 } : {}),
        paginationRequests: 0,
        requestCount: requestCount(),
        retryCount: 0,
      }),
    ),
    releaseLease: vi.fn<AppleMusicFullWatchlistStore["releaseLease"]>(() => Promise.resolve()),
    saveDurableMapping: vi.fn<AppleMusicFullWatchlistStore["saveDurableMapping"]>((input) => {
      const mapping = {
        appleArtistId: input.appleArtistId,
        artistName: input.artistName,
        canonicalArtistId: input.canonicalArtistId,
        confirmationMethod: input.confirmationMethod,
        sourceClassification: input.sourceClassification,
      };
      durable.push(mapping);
      return Promise.resolve(mapping);
    }),
    saveMapping: vi.fn<AppleMusicFullWatchlistStore["saveMapping"]>(() => Promise.resolve()),
    seedCampaignEntries: vi.fn<AppleMusicFullWatchlistStore["seedCampaignEntries"]>(
      (_campaignId, values) => {
        for (const value of values) {
          if (!entries.has(value.canonicalArtistId)) {
            entries.set(value.canonicalArtistId, {
              ...value,
              attempts: 0,
              batchIndex: null,
              evidence: {},
              manualReviewReason: value.manualReviewReason ?? null,
              selectedAppleArtistId: null,
              selectedArtistName: null,
              ...(value.canonicalArtistId === options.pendingDurableArtistId
                ? { status: "pending" as const }
                : {}),
            });
          }
        }
        return Promise.resolve();
      },
    ),
    startCampaign: vi.fn<AppleMusicFullWatchlistStore["startCampaign"]>(() =>
      Promise.resolve({
        artifactHash: artifact.artifactSelfHash,
        id: "00000000-0000-4000-8000-000000000300",
        nextBatchIndex: 0,
        stage: "strong_seeds",
        status: "running",
        watchlistHash: artifact.inputWatchlistHash,
      }),
    ),
    updateCampaignEntry: vi.fn<AppleMusicFullWatchlistStore["updateCampaignEntry"]>((input) => {
      const previous = entries.get(input.canonicalArtistId);
      if (!previous) throw new Error("Synthetic campaign entry was not seeded.");
      entries.set(input.canonicalArtistId, {
        ...previous,
        ...input,
        attempts: (previous?.attempts ?? 0) + 1,
        batchIndex: input.batchIndex ?? previous?.batchIndex ?? null,
        manualReviewReason: input.manualReviewReason ?? null,
        selectedAppleArtistId: input.selectedAppleArtistId ?? null,
        selectedArtistName: input.selectedArtistName ?? null,
      });
      return Promise.resolve();
    }),
  } satisfies AppleMusicFullWatchlistStore;
  return store;
}
