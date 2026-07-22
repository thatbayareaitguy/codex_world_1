import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  end,
  findFirst,
  getSpotifyOperationalStatus,
  getSpotifySchedulerStatus,
  history,
  launchScanNow,
  latestSpotifyBatch,
  listScanHistoryPage,
  requestOperationCancellation,
  select,
  selectDefaultScanHistoryEntry,
  spotifyCoverageSummary,
} = vi.hoisted(() => {
  const history = [
    {
      artistCount: 50,
      artistFilter: null,
      batchId: "11111111-1111-4111-8111-111111111111",
      batchMode: "daily",
      completedAt: new Date("2026-07-21T04:13:51.904Z"),
      createdCount: 90,
      dryRun: false,
      failureCount: 0,
      id: "22222222-2222-4222-8222-222222222222",
      partialArtistCount: 50,
      provider: "spotify",
      providersRequested: ["spotify"],
      requestCount: 102,
      reviewCount: 1,
      startedAt: new Date("2026-07-21T04:04:55.085Z"),
      status: "completed",
      triggerType: "provider_manual",
      updatedCount: 0,
    },
  ];
  return {
    end: vi.fn(() => Promise.resolve()),
    findFirst: vi.fn(),
    getSpotifyOperationalStatus: vi.fn(() => Promise.resolve({ queueDepth: 0 })),
    getSpotifySchedulerStatus: vi.fn(() =>
      Promise.resolve({
        backlog: {
          artist_reconciliation: 0,
          base_artist: 593,
          release_detail: 0,
          release_tracks: 0,
        },
        cooldownActive: false,
        eligibleArtistCount: 593,
        mode: "disabled",
      }),
    ),
    history,
    launchScanNow: vi.fn(() => Promise.resolve({ pid: 4242 })),
    latestSpotifyBatch: vi.fn(() => Promise.resolve(null)),
    listScanHistoryPage: vi.fn(() =>
      Promise.resolve({ entries: history, hasMore: false, nextCursor: null }),
    ),
    requestOperationCancellation: vi.fn(() => Promise.resolve(true)),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })),
      })),
    })),
    selectDefaultScanHistoryEntry: vi.fn(() => history[0]),
    spotifyCoverageSummary: vi.fn(() =>
      Promise.resolve({
        currentCycleCompletedPages: 50,
        estimatedRemainingPages: 50,
        estimatedRemainingRequests: 50,
        failedArtists: 0,
        fullyReconciledArtists: 0,
        inProgressArtists: 0,
        partialArtists: 50,
        pausedArtists: 0,
        queuedArtists: 50,
        rateLimitedArtists: 0,
        totalArtists: 50,
      }),
    ),
  };
});

vi.mock("drizzle-orm", () => ({
  asc: vi.fn(() => "ascending"),
  and: vi.fn(() => "where"),
  desc: vi.fn(() => "order"),
  eq: vi.fn(() => "eq"),
  gt: vi.fn(() => "gt"),
}));
vi.mock("@radar/db", () => ({
  createDatabase: vi.fn(() => ({
    client: { end },
    db: {
      query: {
        musicbrainzProviderState: { findFirst },
        musicbrainzScanBatches: { findFirst },
        operationLocks: { findFirst },
      },
      select,
    },
  })),
  getSpotifyOperationalStatus,
  getSpotifySchedulerStatus,
  latestSpotifyBatch,
  listScanHistoryPage,
  musicbrainzArtistScans: {},
  musicbrainzProviderState: {},
  musicbrainzScanBatches: {},
  operationLocks: { expiresAt: "expiresAt", lockKey: "lockKey" },
  requestOperationCancellation,
  scanRuns: { startedAt: "startedAt" },
  selectDefaultScanHistoryEntry,
  spotifyCoverageSummary,
}));
vi.mock("@radar/providers", () => ({
  loadProviderConfiguration: vi.fn(() => ({
    databaseUrl: "postgres://synthetic",
    musicbrainz: { configured: false },
    spotify: {
      artistsPerBatch: 15,
      batchPauseSeconds: 60,
      configured: true,
      distributionHours: 24,
      minRequestIntervalMs: 10000,
      maxRequestsPerRun: 150,
      reconciliationArtistsPerBatch: 15,
      reconciliationCycleDays: 30,
      reconciliationMaxPagesPerRun: 2,
      scanDistributionHours: 24,
    },
  })),
}));
vi.mock("../../../lib/request-security", () => ({
  assertSameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
}));
vi.mock("../../../lib/scan-launcher", () => ({ launchScanNow }));

import { DELETE, describeActiveScan, GET, POST } from "./route";

const request = (method = "POST") =>
  new NextRequest("http://127.0.0.1:3000/api/scans", {
    headers: { origin: "http://127.0.0.1:3000" },
    method,
  });

const jsonRequest = (body: unknown) =>
  new NextRequest("http://127.0.0.1:3000/api/scans", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" },
    method: "POST",
  });

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue(undefined);
});

describe("on-demand scan route", () => {
  it("returns persisted history with the meaningful batch selected by default", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      defaultHistoryId: history[0]!.id,
      history: [
        {
          artistCount: 50,
          id: history[0]!.id,
          partialArtistCount: 50,
          requestCount: 102,
        },
      ],
      spotify: {
        scheduler: {
          backlog: { base_artist: 593 },
          eligibleArtistCount: 593,
          mode: "disabled",
        },
      },
    });
    expect(listScanHistoryPage).toHaveBeenCalledOnce();
    expect(getSpotifySchedulerStatus).toHaveBeenCalledOnce();
    expect(selectDefaultScanHistoryEntry).toHaveBeenCalledWith(history);
  });

  it("launches one background scan", async () => {
    const response = await POST(request());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(launchScanNow).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("launches an isolated one-artist MusicBrainz scan", async () => {
    const artistId = "11111111-1111-4111-8111-111111111111";
    const response = await POST(jsonRequest({ artistId, provider: "musicbrainz" }));

    expect(response.status).toBe(202);
    expect(launchScanNow).toHaveBeenCalledWith(undefined, undefined, undefined, [
      "--provider",
      "musicbrainz",
      "--artist",
      artistId,
    ]);
  });

  it("reports provider-stage progress from the active lock and completed runs", () => {
    const startedAt = new Date("2026-07-17T17:23:31.517Z");
    const progress = describeActiveScan(
      {
        acquiredAt: startedAt,
        expiresAt: new Date("2026-07-17T19:23:31.517Z"),
        metadata: { provider: "all" },
      },
      [
        {
          provider: "spotify",
          providersCompleted: ["spotify"],
          providersFailed: [],
          startedAt: new Date("2026-07-17T17:24:00.000Z"),
          status: "completed",
        },
        {
          provider: "mock",
          providersCompleted: ["mock"],
          providersFailed: [],
          startedAt: new Date("2026-07-17T17:20:00.000Z"),
          status: "completed",
        },
      ],
      ["spotify", "musicbrainz"],
    );

    expect(progress).toEqual({
      cancelRequested: false,
      completedUnits: 0,
      currentProvider: "musicbrainz",
      currentStage: null,
      currentUnit: null,
      expiresAt: new Date("2026-07-17T19:23:31.517Z"),
      heartbeatAt: null,
      lastPersistedResult: null,
      phase: null,
      providersCompleted: ["spotify"],
      providersFailed: [],
      providersRequested: ["spotify", "musicbrainz"],
      rateLimitWaitMs: 0,
      requests: 0,
      retryAfterMs: 0,
      startedAt,
      totalUnits: 0,
    });
  });

  it("requests cooperative cancellation for the active scan", async () => {
    const response = await DELETE(request("DELETE"));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(requestOperationCancellation).toHaveBeenCalledWith(expect.anything(), "scan:global");
  });

  it("rejects a duplicate launch while the global scan lock is active", async () => {
    findFirst.mockResolvedValue({ lockKey: "scan:global" });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "A scan is already running" });
    expect(launchScanNow).not.toHaveBeenCalled();
  });
});
