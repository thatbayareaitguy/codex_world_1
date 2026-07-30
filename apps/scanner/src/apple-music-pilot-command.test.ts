import { describe, expect, it, vi } from "vitest";
import {
  AppleMusicClientError,
  appleMusicArtistViews,
  type AppleMusicAlbum,
  type AppleMusicArtist,
} from "@radar/providers";
import type { AppleMusicMappingDecision } from "@radar/core";
import {
  executeAppleMusicPilotCommand,
  parseAppleMusicPilotCommand,
  type AppleMusicPilotCommandDependencies,
} from "./apple-music-pilot-command";
import {
  appleMusicLiveConfirmation,
  appleMusicPilotDefinition,
  assertSanitizedAppleMusicPilotEvidence,
  createAppleMusicPilotPlan,
  forecastAppleMusicPilotRequests,
  validateAppleMusicPilotSnapshot,
  type AppleMusicPilotDefinition,
} from "./apple-music-pilot-definition";
import {
  authorizeAppleMusicPilotLive,
  runBoundedAppleMusicPilot,
  type AppleMusicPilotClient,
  type AppleMusicPilotStore,
  type AppleMusicPilotStoredEvidence,
} from "./apple-music-pilot-runner";
import type { ItunesPilotSnapshot } from "./itunes-pilot-snapshot";

describe("Apple Music pilot command and plan", () => {
  it("builds the exact zero-network pilot plan from a validated snapshot", async () => {
    const plan = await createAppleMusicPilotPlan("synthetic.json", () =>
      Promise.resolve(snapshot()),
    );
    expect(plan.artists).toHaveLength(25);
    expect(new Set(plan.artists.map((artist) => artist.name)).size).toBe(25);
    expect(plan.networkRequestsStarted).toBe(0);
    expect(plan.storefront).toBe("us");
    expect(plan.directViews).toEqual(appleMusicArtistViews);
    expect(plan.authenticationArtist).toBe("BUNT.");
    expect(plan.canaryArtists).toEqual(["1991", "Alok", "NURKO", "G-Space", "BUNT."]);
  });

  it("does not initialize live runtime, a token manager, or a database in plan mode", async () => {
    const dependencies = commandDependencies();
    await executeAppleMusicPilotCommand(["--plan", "--snapshot", "synthetic.json"], dependencies);
    expect((dependencies.loadLiveSafety as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((dependencies.executeLive as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("declares zero plan-mode database writes", async () => {
    const plan = await createAppleMusicPilotPlan("synthetic.json", () =>
      Promise.resolve(snapshot()),
    );
    expect(plan.writes).toEqual({
      albums: 0,
      cache: 0,
      comparisons: 0,
      leases: 0,
      mappings: 0,
      requestTelemetry: 0,
      runs: 0,
      songs: 0,
    });
  });

  it("fails closed when the snapshot hash differs", () => {
    const value = snapshot();
    value.snapshotHash = "0".repeat(64);
    expect(() => validateAppleMusicPilotSnapshot(value)).toThrow("hash");
  });

  it("fails closed when the pinned cohort count is wrong", () => {
    const definition = definitionCopy();
    definition.cohort.identityFailures.pop();
    expect(() => validateAppleMusicPilotSnapshot(snapshot(), definition)).toThrow("25 artists");
  });

  it("fails closed when the pinned cohort contains a duplicate artist", () => {
    const definition = definitionCopy();
    definition.cohort.identityFailures[0] = definition.cohort.identityFailures[1]!;
    expect(() => validateAppleMusicPilotSnapshot(snapshot(), definition)).toThrow("duplicate");
  });

  it("fails closed when a pinned artist is absent from the snapshot", () => {
    const value = snapshot();
    value.artists.find((artist) => artist.canonicalName === "1991")!.canonicalName = "Missing";
    expect(() => validateAppleMusicPilotSnapshot(value)).toThrow("1991");
  });

  it("rejects a missing live flag before loading live runtime", async () => {
    const dependencies = commandDependencies();
    await expect(
      executeAppleMusicPilotCommand(
        ["--snapshot", "synthetic.json", "--confirm-live", appleMusicLiveConfirmation],
        dependencies,
      ),
    ).rejects.toThrow("exactly one");
    expect((dependencies.loadLiveSafety as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("rejects missing or incorrect live confirmation before loading live runtime", async () => {
    for (const confirmation of [undefined, "WRONG"]) {
      const dependencies = commandDependencies();
      const args = ["--execute-live", "--snapshot", "synthetic.json"];
      if (confirmation) args.push("--confirm-live", confirmation);
      await expect(executeAppleMusicPilotCommand(args, dependencies)).rejects.toThrow(
        appleMusicLiveConfirmation,
      );
      expect((dependencies.loadLiveSafety as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    }
  });

  it("rejects persistent APPLE_MUSIC_ENABLED=true before live execution", async () => {
    const dependencies = commandDependencies({
      persistentAppleMusicEnabled: "true",
    });
    await expect(executeAppleMusicPilotCommand(liveArgs(), dependencies)).rejects.toThrow(
      "exactly false",
    );
    expect((dependencies.executeLive as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("keeps persistent APPLE_MUSIC_ENABLED=false unchanged", () => {
    const authorization = authorizeAppleMusicPilotLive({
      confirmation: appleMusicLiveConfirmation,
      executeLive: true,
      otherProvidersDisabled: true,
      persistentAppleMusicEnabled: "false",
      storefront: "us",
    });
    expect(authorization.persistentProviderEnabled).toBe(false);
  });

  it("rejects access when any other provider is enabled", () => {
    expect(() =>
      authorizeAppleMusicPilotLive({
        confirmation: appleMusicLiveConfirmation,
        executeLive: true,
        otherProvidersDisabled: false,
        persistentAppleMusicEnabled: "false",
        storefront: "us",
      }),
    ).toThrow("non-Apple");
  });

  it("pins conservative canary and full forecasts within immutable budgets", () => {
    expect(forecastAppleMusicPilotRequests("canary")).toMatchObject({
      fitsBudget: true,
      requestBudget: 75,
      totalRequests: 55,
    });
    expect(forecastAppleMusicPilotRequests("full")).toMatchObject({
      fitsBudget: true,
      requestBudget: 225,
      totalRequests: 217,
    });
  });

  it("pins only public IDs and no machine-specific snapshot path", () => {
    expect(appleMusicPilotDefinition.knownArtistIds).toEqual({
      "BUNT.": "1436090348",
      "G-Space": "511671481",
      SampliFire: "696018289",
    });
    expect(JSON.stringify(appleMusicPilotDefinition)).not.toContain("C:\\");
  });

  it("parses only the documented plan and double-confirmed live forms", () => {
    expect(parseAppleMusicPilotCommand(["--plan", "--snapshot", "snapshot.json"])).toEqual({
      mode: "plan",
      snapshotPath: "snapshot.json",
    });
    expect(parseAppleMusicPilotCommand(liveArgs())).toEqual({
      confirmation: appleMusicLiveConfirmation,
      mode: "execute_live",
      snapshotPath: "synthetic.json",
      stopAfterCanary: false,
    });
    expect(parseAppleMusicPilotCommand(liveArgs(true))).toMatchObject({
      mode: "execute_live",
      stopAfterCanary: true,
    });
    expect(() =>
      parseAppleMusicPilotCommand(["--plan", "--snapshot", "snapshot.json", "--stop-after-canary"]),
    ).toThrow("Plan mode");
  });
});

describe("bounded Apple Music pilot controller", () => {
  it("proceeds from mock authentication through the canary and full phase", async () => {
    const harness = runnerHarness();
    const result = await harness.run();
    expect(result.status).toBe("completed");
    expect(result.phases).toEqual({
      authentication: "completed",
      canary: "completed",
      full: "completed",
    });
    expect(harness.store.finished?.status).toBe("completed");
  });

  it("stops after the exact five-artist canary with a bounded terminal status", async () => {
    const harness = runnerHarness({ stopAfterCanary: true });
    const result = await harness.run();
    expect(result).toMatchObject({
      executionScope: "canary_only",
      status: "canary_completed",
      stopReason: "canary_workflow_completed",
      phases: {
        authentication: "completed",
        canary: "completed",
        full: "not_started",
      },
    });
    expect(result.contactedArtists).toHaveLength(5);
    expect(new Set(result.contactedArtists)).toEqual(
      new Set(appleMusicPilotDefinition.canaryArtists),
    );
    expect(harness.calls.fullClients).toBe(0);
    expect(harness.calls.batchIds).toHaveLength(0);
    expect(harness.store.finished?.status).toBe("canary_completed");
    expect(harness.store.createdRun).toMatchObject({
      maximumRuntimeMs: 15 * 60_000,
      requestBudget: 75,
    });
    expect(harness.store.leaseActive).toBe(false);
  });

  it.each([401, 403])("stops after a mock HTTP %s authentication response", async (status) => {
    const harness = runnerHarness({ authenticationStatus: status });
    const result = await harness.run();
    expect(result.status).toBe("controlled_partial");
    expect(result.stopReason).toBe(`authentication_http_${status}`);
    expect(harness.calls.search).toBe(0);
    expect(harness.calls.views).toBe(0);
  });

  it("preserves a mock 429 controlled stop after authentication", async () => {
    const harness = runnerHarness({ authenticationStatus: 429 });
    const result = await harness.run();
    expect(result).toMatchObject({
      status: "controlled_partial",
      stopReason: "provider_http_429",
    });
    expect(harness.store.finished?.status).toBe("controlled_partial");
  });

  it("enforces the canary request budget", async () => {
    const harness = runnerHarness({ evidenceRequestCount: 76 });
    const result = await harness.run();
    expect(result).toMatchObject({
      status: "controlled_partial",
      stopReason: "canary_request_budget_exhausted",
    });
  });

  it("enforces the canary runtime budget with injected time", async () => {
    let calls = 0;
    const harness = runnerHarness({
      now: () => new Date(calls++ === 0 ? 0 : 15 * 60_000 + 1),
    });
    const result = await harness.run();
    expect(result.stopReason).toBe("canary_runtime_budget_exhausted");
  });

  it("treats a full-run request-budget error as a controlled stop", async () => {
    const harness = runnerHarness({ fullFailure: "request_budget_exhausted" });
    const result = await harness.run();
    expect(result).toMatchObject({
      status: "controlled_partial",
      stopReason: "request_budget_exhausted",
    });
  });

  it("reuses authentication and canary results in the full phase", async () => {
    const harness = runnerHarness();
    await harness.run();
    expect(harness.calls.artistByName.get("BUNT.")).toBe(1);
    for (const name of appleMusicPilotDefinition.canaryArtists) {
      expect(harness.calls.viewsByName.get(name)).toBe(1);
    }
  });

  it("validates all three known IDs instead of trusting them", async () => {
    const harness = runnerHarness();
    await harness.run();
    expect(harness.calls.artistByName.get("BUNT.")).toBe(1);
    expect(harness.calls.artistByName.get("G-Space")).toBe(1);
    expect(harness.calls.artistByName.get("SampliFire")).toBe(1);
  });

  it("does not confirm a missing-ID artist from search rank alone", async () => {
    const harness = runnerHarness({ wrongSearchArtist: "1991" });
    const result = await harness.run();
    expect(result.omittedArtists).toContain("1991");
    expect(harness.store.mappingDecisions.get("1991")?.selected).toBeUndefined();
  });

  it("batches only confirmed IDs and permits fewer than 25", async () => {
    const harness = runnerHarness({ wrongSearchArtist: "1991" });
    const result = await harness.run();
    expect(result.batch.confirmedIdsRequested).toBe(24);
    expect(harness.calls.batchIds).toHaveLength(24);
    expect(harness.calls.batchIds).not.toContain("search-1991");
  });

  it("releases the pilot lease on success", async () => {
    const harness = runnerHarness();
    await harness.run();
    expect(harness.store.leaseActive).toBe(false);
    expect(harness.store.releaseCount).toBe(1);
  });

  it("releases the pilot lease on a controlled stop", async () => {
    const harness = runnerHarness({ authenticationStatus: 401 });
    await harness.run();
    expect(harness.store.leaseActive).toBe(false);
    expect(harness.store.releaseCount).toBe(1);
  });

  it("releases the pilot lease and records failure on a thrown error", async () => {
    const harness = runnerHarness({ fullFailure: "unexpected" });
    const result = await harness.run();
    expect(result.status).toBe("failed");
    expect(harness.store.leaseActive).toBe(false);
    expect(harness.store.finished?.status).toBe("failed");
  });

  it("rejects unsafe evidence fields", () => {
    for (const value of [
      { authorizationHeader: "hidden" },
      { rawResponse: {} },
      { artwork: {} },
      { previewUrl: "https://example.test" },
      { privateKeyPath: "hidden" },
    ]) {
      expect(() => assertSanitizedAppleMusicPilotEvidence(value)).toThrow("prohibited");
    }
  });

  it("produces sanitized evidence with no credential, response, artwork, or preview fields", async () => {
    const harness = runnerHarness();
    const result = await harness.run();
    expect(() => assertSanitizedAppleMusicPilotEvidence(result)).not.toThrow();
    expect(JSON.stringify(result)).not.toMatch(
      /authorization|developer.?token|private.?key|raw.?response|artwork|preview/i,
    );
  });

  it("has no Spotify, free-iTunes, or other-provider dependency surface", () => {
    const harness = runnerHarness();
    expect(Object.keys(harness.store).join(",")).not.toMatch(
      /spotify|itunes|musicbrainz|reddit|soundcloud/i,
    );
  });
});

function liveArgs(stopAfterCanary = false): string[] {
  return [
    "--execute-live",
    "--confirm-live",
    appleMusicLiveConfirmation,
    "--snapshot",
    "synthetic.json",
    ...(stopAfterCanary ? ["--stop-after-canary"] : []),
  ];
}

function commandDependencies(
  overrides: Partial<{
    otherProvidersDisabled: boolean;
    persistentAppleMusicEnabled: string;
    storefront: string;
  }> = {},
): AppleMusicPilotCommandDependencies {
  return {
    createPlan: vi.fn(() =>
      createAppleMusicPilotPlan("synthetic.json", () => Promise.resolve(snapshot())),
    ),
    executeLive: vi.fn(() => Promise.reject(new Error("not invoked"))),
    loadLiveSafety: vi.fn(() =>
      Promise.resolve({
        otherProvidersDisabled: overrides.otherProvidersDisabled ?? true,
        persistentAppleMusicEnabled: overrides.persistentAppleMusicEnabled ?? "false",
        storefront: overrides.storefront ?? "us",
      }),
    ),
  };
}

function definitionCopy(): AppleMusicPilotDefinition {
  return structuredClone(appleMusicPilotDefinition);
}

function snapshot(): ItunesPilotSnapshot {
  const pinned = [
    ...appleMusicPilotDefinition.cohort.identityFailures,
    ...appleMusicPilotDefinition.cohort.positiveReleaseArtists,
    ...appleMusicPilotDefinition.cohort.identityCatalogStressArtists,
  ];
  const names = [...pinned, ...Array.from({ length: 25 }, (_, index) => `Filler ${index + 1}`)];
  const artists = names.map((name, index) => ({
    aliases: [],
    canonicalArtistId: uuid(index + 1),
    canonicalName: name,
    cohortReason:
      index < 30
        ? ("positive" as const)
        : index < 40
          ? ("negative" as const)
          : ("identity_stress" as const),
    genres: [],
    inclusionState: { active: true },
    normalizedName: name.toLowerCase(),
    spotifyArtistId: `spotify-artist-${index + 1}`,
    spotifyCoverageTimestamp: "2026-07-29T00:00:00.000Z",
  }));
  const groundTruthReleases = Array.from({ length: 106 }, (_, index) => {
    const artist = artists[index % 35]!;
    return {
      canonicalArtistId: artist.canonicalArtistId,
      canonicalReleaseId: uuid(1_000 + index),
      creditedArtists: [],
      feedEligible: true,
      normalizedTitle: `release ${index + 1}`,
      releaseDate: "2026-07-24",
      releaseDatePrecision: "day",
      releaseType: "single",
      spotifyReleaseId: `spotify-release-${index + 1}`,
      title: `Release ${index + 1}`,
      tracks: [],
    };
  });
  return {
    artists,
    groundTruthReleases,
    mainRepositoryCommit: "a".repeat(40),
    mainSchemaVersion: 17,
    snapshotHash: appleMusicPilotDefinition.snapshot.sha256,
    snapshotTimestamp: "2026-07-29T01:00:00.000Z",
    version: 1,
    windowEnd: "2026-07-29",
    windowStart: "2026-05-30",
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function runnerHarness(
  options: {
    authenticationStatus?: number;
    evidenceRequestCount?: number;
    fullFailure?: "request_budget_exhausted" | "unexpected";
    now?: () => Date;
    stopAfterCanary?: boolean;
    wrongSearchArtist?: string;
  } = {},
) {
  const value = snapshot();
  const nameByCanonicalId = new Map(
    value.artists.map((artist) => [artist.canonicalArtistId, artist.canonicalName]),
  );
  const publicIdByName = new Map(Object.entries(appleMusicPilotDefinition.knownArtistIds));
  const nameByPublicId = new Map([...publicIdByName.entries()].map(([name, id]) => [id, name]));
  const nameByResolvedId = new Map<string, string>(nameByPublicId.entries());
  const calls = {
    artistByName: new Map<string, number>(),
    batchIds: [] as string[],
    fullClients: 0,
    search: 0,
    views: 0,
    viewsByName: new Map<string, number>(),
  };
  const store = new FakeStore(
    nameByCanonicalId,
    () => options.evidenceRequestCount ?? calls.search + calls.views + sum(calls.artistByName),
  );
  const client = (phase: "canary" | "full"): AppleMusicPilotClient => {
    if (phase === "full") calls.fullClients += 1;
    return {
      getAllArtistViews: (artistId) => {
        if (phase === "full" && options.fullFailure) {
          return Promise.reject(
            options.fullFailure === "unexpected"
              ? new Error("synthetic failure")
              : new AppleMusicClientError("budget", "request_budget_exhausted"),
          );
        }
        const name = nameByResolvedId.get(artistId) ?? "Unknown";
        calls.views += 1;
        calls.viewsByName.set(name, (calls.viewsByName.get(name) ?? 0) + 1);
        return Promise.resolve(
          Object.fromEntries(appleMusicArtistViews.map((view) => [view, [] as AppleMusicAlbum[]])),
        );
      },
      getArtist: (artistId) => {
        const name = nameByPublicId.get(artistId) ?? "Unknown";
        calls.artistByName.set(name, (calls.artistByName.get(name) ?? 0) + 1);
        if (name === "BUNT." && options.authenticationStatus) {
          return Promise.reject(
            new AppleMusicClientError(
              "synthetic authentication result",
              options.authenticationStatus === 429 ? "rate_limited" : "authentication_failed",
              options.authenticationStatus,
              options.authenticationStatus === 429 ? 60 : undefined,
            ),
          );
        }
        return Promise.resolve(artist(artistId, name));
      },
      getArtists: (artistIds) => {
        calls.batchIds = [...artistIds];
        return Promise.resolve({
          items: artistIds.map((id) => artist(id, nameByResolvedId.get(id) ?? "Unknown")),
          missingIds: [],
        });
      },
      searchArtists: (term) => {
        calls.search += 1;
        const id = `search-${term}`;
        nameByResolvedId.set(id, term);
        return Promise.resolve([
          artist(id, options.wrongSearchArtist === term ? "Wrong Candidate" : term),
        ]);
      },
    };
  };
  return {
    calls,
    run: () =>
      runBoundedAppleMusicPilot({
        authorization: authorizeAppleMusicPilotLive({
          confirmation: appleMusicLiveConfirmation,
          executeLive: true,
          otherProvidersDisabled: true,
          persistentAppleMusicEnabled: "false",
          ...(options.stopAfterCanary === undefined
            ? {}
            : { stopAfterCanary: options.stopAfterCanary }),
          storefront: "us",
        }),
        createClient: (phase) => client(phase),
        implementationCommit: "b".repeat(40),
        ...(options.now ? { now: options.now } : {}),
        snapshot: value,
        store,
      }),
    store,
  };
}

class FakeStore implements AppleMusicPilotStore {
  createdRun?: Parameters<AppleMusicPilotStore["createRun"]>[0];
  finished?: {
    metrics: Record<string, unknown>;
    status: "canary_completed" | "completed" | "controlled_partial" | "failed";
    stopReason: string;
  };
  leaseActive = false;
  mappingDecisions = new Map<string, AppleMusicMappingDecision>();
  releaseCount = 0;

  constructor(
    private readonly nameByCanonicalId: Map<string, string>,
    private readonly requestCount: () => number,
  ) {}

  claimLease = () => {
    this.leaseActive = true;
    return Promise.resolve("synthetic-lease");
  };

  createRun: AppleMusicPilotStore["createRun"] = (input) => {
    this.createdRun = input;
    return Promise.resolve({ id: uuid(9_999) });
  };

  finishRun: AppleMusicPilotStore["finishRun"] = (_runId, input) => {
    this.finished = input;
    return Promise.resolve();
  };

  importSnapshot = () => Promise.resolve(uuid(8_888));

  operationalStatus = () => Promise.resolve({ cooldownActive: false, leaseActive: false });

  readEvidence = (): Promise<AppleMusicPilotStoredEvidence> =>
    Promise.resolve({
      authenticationAttempts: 1,
      authenticationHttpStatus: 200,
      cacheHits: 0,
      endpointRequestCounts: {},
      httpStatusCounts: {},
      maximumConcurrency: 1,
      minimumRequestIntervalMs: 1_100,
      paginationRequests: 0,
      requestCount: this.requestCount(),
      retryCount: 0,
    });

  releaseLease = () => {
    this.leaseActive = false;
    this.releaseCount += 1;
    return Promise.resolve();
  };

  saveCatalog = () => Promise.resolve();

  saveComparisons = () => Promise.resolve();

  saveMapping: AppleMusicPilotStore["saveMapping"] = (input) => {
    this.mappingDecisions.set(
      this.nameByCanonicalId.get(input.canonicalArtistId) ?? "Unknown",
      input.decision,
    );
    return Promise.resolve();
  };
}

function artist(artistId: string, name: string): AppleMusicArtist {
  return {
    artistId,
    genreNames: [],
    name,
    sourceStorefront: "us",
  };
}

function sum(values: Map<string, number>): number {
  return [...values.values()].reduce((total, value) => total + value, 0);
}
