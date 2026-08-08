import type { RadarDatabase, SpotifySchedulerClaim, SpotifySchedulerStatus } from "@radar/db";
import type { SpotifyRequestGate } from "@radar/providers";
import { describe, expect, it, vi } from "vitest";
import {
  runSpotifySchedulerTick,
  type SpotifySchedulerExecutionContext,
  type SpotifySchedulerExecutor,
  SpotifySchedulerRequestBudgetError,
  SpotifySchedulerRuntimeBudgetError,
} from "./spotify-scheduler";

const claim: SpotifySchedulerClaim = {
  artistId: "00000000-0000-4000-8000-000000000001",
  attemptCount: 1,
  campaignId: null,
  campaignMemberId: null,
  discoveryReconciliationCampaignId: null,
  dueAt: new Date("2026-07-22T00:00:00.000Z"),
  expectedSpotifyArtistId: "spotify-artist",
  id: "00000000-0000-4000-8000-000000000002",
  leaseExpiresAt: new Date("2026-07-22T00:02:00.000Z"),
  leaseOwner: "owner",
  releaseTrackRetrievalId: null,
  source: "initial",
  spotifyAlbumId: null,
  workType: "base_artist",
};

const status: SpotifySchedulerStatus = {
  activeLease: null,
  artistsCheckedLast24Hours: 0,
  artistsCheckedLastHour: 0,
  appleCatchupPriorityCount: 0,
  applePriorityCount: 0,
  backlog: {
    artist_reconciliation: 0,
    base_artist: 1,
    release_detail: 0,
    release_tracks: 0,
  },
  blockedCount: 0,
  blockedReasons: [],
  cooldownActive: false,
  cooldownUntil: null,
  dailyBudget: {
    broadArtistsLimit: 75,
    broadArtistsUsed: 0,
    broadRequestsLimit: 300,
    broadRequestsUsed: 0,
    localDate: "2026-07-21",
    playlistRequestReserve: 20,
    priorityRequestReserve: 200,
  },
  dueArtistCount: 1,
  eligibleArtistCount: 1,
  estimatedCompletion: { earliest: null, latest: null, state: "available" },
  endpointBudget: {
    artistAlbums: {
      allowance: 80,
      broadAllowance: 60,
      broadRemaining: 60,
      broadUsed: 0,
      calls: 0,
      nextCapacityAt: null,
      priorityRemaining: 80,
      priorityReserve: 20,
      priorityUsed: 0,
      remaining: 80,
      reserveReleased: false,
    },
    playlist: { reads: 0, writes: 0 },
  },
  http429Last24Hours: 0,
  lastQuotaExceeded: null,
  mode: "automatic",
  nextBaseSlotAt: null,
  oldestOverdueAgeMs: 0,
  overdueArtistCount: 0,
  partialArtistCount: 0,
  requestCounts: {
    byEndpointCategory: {
      album_detail: 0,
      album_tracks: 0,
      artist_albums: 0,
      oauth_or_other: 0,
      playlist_read: 0,
      playlist_write: 0,
    },
    byWorkType: {},
    last24Hours: 0,
    last30Minutes: 0,
  },
  recentWork: null,
  targetArtistCount: 1,
};

const limits = {
  artistAlbums24HourLimit: 80,
  artistAlbumsPriorityReserve: 20,
  artistAlbumsReserveReleaseAfterHours: 20,
  maxBroadArtistsPerLocalDay: 75,
  maxBroadRequestsPerLocalDay: 300,
  maxArtistsPerTick: 1 as const,
  maxRequestsPerTick: 6,
  maxRuntimeMs: 90_000,
  minRequestIntervalMs: 10_000,
  rolling24HourLimit: 1_200,
  rolling30MinuteLimit: 30,
  playlistRequestReserve: 20,
  priorityRequestReserve: 200,
  windowHours: 24 as const,
};

describe("Spotify scheduler tick", () => {
  it("keeps plan mode read-only and does not invoke an executor", async () => {
    const dependencies = fakeDependencies();
    const executor = { execute: vi.fn() };
    const result = await runSpotifySchedulerTick(fakeDatabase(), {
      capabilityEnabled: false,
      dependencies: dependencies as never,
      executor,
      limits,
      mode: "plan",
    });

    expect(result).toMatchObject({ mode: "plan", reason: "planned", requestsStarted: 0 });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(dependencies.acquireLock).not.toHaveBeenCalled();
    expect(dependencies.planTick).toHaveBeenCalledTimes(1);
  });

  it("refuses production work unless the explicit capability is enabled", async () => {
    const dependencies = fakeDependencies();
    const result = await runSpotifySchedulerTick(fakeDatabase(), {
      capabilityEnabled: false,
      dependencies: dependencies as never,
      limits,
      mode: "production",
    });

    expect(result.reason).toBe("capability_disabled");
    expect(dependencies.acquireLock).not.toHaveBeenCalled();
    expect(dependencies.claimWork).not.toHaveBeenCalled();
  });

  it("blocks during cooldown and always releases the global operation lock", async () => {
    const dependencies = fakeDependencies();
    dependencies.getOperationalStatus.mockResolvedValue({ cooldownActive: true });
    const executor = { execute: vi.fn() };
    const result = await runSpotifySchedulerTick(fakeDatabase(), {
      capabilityEnabled: true,
      dependencies: dependencies as never,
      executor,
      limits,
      mode: "credential_free",
    });

    expect(result.reason).toBe("cooldown");
    expect(executor.execute).not.toHaveBeenCalled();
    expect(dependencies.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("counts OAuth and retry starts toward the six-request ceiling", async () => {
    const dependencies = fakeDependencies();
    const underlying = fakeGate();
    const executor: SpotifySchedulerExecutor = {
      execute: vi.fn(
        async (_work: SpotifySchedulerClaim, context: SpotifySchedulerExecutionContext) => {
          const gate = context.wrapRequestGate(underlying);
          await gate.acquire({ endpointCategory: "token", method: "POST" });
          for (let index = 0; index < 5; index += 1) {
            await gate.acquire({
              endpointCategory: index === 0 ? "retry" : "album",
              method: "GET",
            });
          }
          await expect(
            gate.acquire({ endpointCategory: "album_tracks", method: "GET" }),
          ).rejects.toBeInstanceOf(SpotifySchedulerRequestBudgetError);
          throw new SpotifySchedulerRequestBudgetError(6);
        },
      ),
    };
    const result = await runSpotifySchedulerTick(fakeDatabase(), {
      capabilityEnabled: true,
      dependencies: dependencies as never,
      executor,
      limits,
      mode: "credential_free",
    });

    expect(result).toMatchObject({ reason: "failed", requestsStarted: 6 });
    expect(underlying.acquire).toHaveBeenCalledTimes(6);
    expect(dependencies.finishWork).toHaveBeenCalledWith(
      expect.anything(),
      claim,
      { errorClassification: "request_budget_exhausted", status: "retry" },
      expect.any(Date),
    );
  });

  it("stops before a request that cannot fit in the remaining runtime", async () => {
    const dependencies = fakeDependencies();
    const underlying = fakeGate();
    let clock = new Date();
    const executor: SpotifySchedulerExecutor = {
      execute: vi.fn(
        async (_work: SpotifySchedulerClaim, context: SpotifySchedulerExecutionContext) => {
          clock = new Date(context.deadlineAt - 5_000);
          await expect(
            context
              .wrapRequestGate(underlying)
              .acquire({ endpointCategory: "artist_albums", method: "GET" }),
          ).rejects.toBeInstanceOf(SpotifySchedulerRuntimeBudgetError);
          throw new SpotifySchedulerRuntimeBudgetError();
        },
      ),
    };
    const result = await runSpotifySchedulerTick(fakeDatabase(), {
      capabilityEnabled: true,
      dependencies: dependencies as never,
      executor,
      limits,
      mode: "credential_free",
      now: () => clock,
    });

    expect(result).toMatchObject({ reason: "failed", requestsStarted: 0 });
    expect(underlying.acquire).not.toHaveBeenCalled();
    expect(dependencies.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("processes one claimed item and stops immediately after an injected 429", async () => {
    const dependencies = fakeDependencies();
    const executor: SpotifySchedulerExecutor = {
      execute: vi.fn(
        async (_work: SpotifySchedulerClaim, context: SpotifySchedulerExecutionContext) => {
          const gate = context.wrapRequestGate(fakeGate());
          await gate.acquire({ endpointCategory: "artist_albums", method: "GET" });
          throw Object.assign(new Error("rate limited"), { status: 429 });
        },
      ),
    };
    const result = await runSpotifySchedulerTick(fakeDatabase(), {
      capabilityEnabled: true,
      dependencies: dependencies as never,
      executor,
      limits,
      mode: "credential_free",
    });

    expect(result).toMatchObject({ reason: "failed", requestsStarted: 1 });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(dependencies.claimWork).toHaveBeenCalledTimes(1);
    expect(dependencies.finishWork).toHaveBeenCalledWith(
      expect.anything(),
      claim,
      { errorClassification: "rate_limited", status: "retry" },
      expect.any(Date),
    );
  });

  it("requeues interrupted release-detail work without claiming another item", async () => {
    const dependencies = fakeDependencies();
    const detailClaim: SpotifySchedulerClaim = {
      ...claim,
      artistId: claim.artistId,
      spotifyAlbumId: "spotify-album",
      workType: "release_detail",
    };
    dependencies.claimWork.mockResolvedValue(detailClaim);
    const executor: SpotifySchedulerExecutor = {
      execute: vi.fn(() => Promise.reject(new Error("interrupted after checkpoint"))),
    };

    const result = await runSpotifySchedulerTick(fakeDatabase(), {
      capabilityEnabled: true,
      dependencies: dependencies as never,
      executor,
      limits,
      mode: "credential_free",
    });

    expect(result.reason).toBe("failed");
    expect(dependencies.claimWork).toHaveBeenCalledOnce();
    expect(dependencies.finishWork).toHaveBeenCalledWith(
      expect.anything(),
      detailClaim,
      { errorClassification: "scheduler_work_failed", status: "retry" },
      expect.any(Date),
    );
  });
});

function fakeDatabase(): RadarDatabase {
  return {} as RadarDatabase;
}

function fakeGate() {
  return {
    acquire: vi.fn(() =>
      Promise.resolve({
        eventId: "event",
        leaseToken: "lease",
        queueLength: 0,
        queueWaitMs: 0,
        startedAt: new Date(),
      }),
    ),
    complete: vi.fn(() => Promise.resolve()),
  } satisfies SpotifyRequestGate;
}

function fakeDependencies() {
  return {
    acquireLock: vi.fn(() => Promise.resolve({ lockKey: "scan:global", ownerToken: "owner" })),
    claimWork: vi.fn(() => Promise.resolve(claim)),
    finishWork: vi.fn(() => Promise.resolve(true)),
    getOperationalStatus: vi.fn(() => Promise.resolve({ cooldownActive: false })),
    getStatus: vi.fn(() => Promise.resolve(status)),
    planTick: vi.fn(() => Promise.resolve({ selected: claim, status })),
    reconcileWork: vi.fn(() => Promise.resolve(status)),
    recordTick: vi.fn(() => Promise.resolve()),
    releaseLock: vi.fn(() => Promise.resolve()),
  };
}
