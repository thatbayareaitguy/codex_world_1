import type {
  RadarDatabase,
  SpotifySchedulerClaim,
  SpotifySyncCampaignClaim,
  SpotifySyncCampaignStatusView,
} from "@radar/db";
import { describe, expect, it, vi } from "vitest";
import { runSpotifySyncCampaignTick } from "./spotify-sync-campaign";
import type { SpotifySchedulerExecutionContext } from "./spotify-scheduler";

const claim: SpotifySyncCampaignClaim = {
  artistId: "00000000-0000-4000-8000-000000000001",
  attemptCount: 1,
  campaignId: "00000000-0000-4000-8000-000000000002",
  campaignMemberId: "00000000-0000-4000-8000-000000000003",
  discoveryReconciliationCampaignId: null,
  dueAt: new Date("2026-07-23T00:00:00.000Z"),
  expectedSpotifyArtistId: "spotify-artist",
  id: "00000000-0000-4000-8000-000000000004",
  leaseExpiresAt: new Date("2026-07-23T00:02:00.000Z"),
  leaseOwner: "lease",
  releaseTrackRetrievalId: null,
  source: "initial",
  spotifyAlbumId: null,
  workType: "base_artist",
};

const status: SpotifySyncCampaignStatusView = {
  activeReservations: 0,
  baselineSize: 492,
  blockedMembers: 0,
  campaignId: claim.campaignId,
  campaignType: "bounded_initial_sync",
  canaryPassed: false,
  canaryReviewRequired: false,
  canaryTarget: 10,
  claimedMember: null,
  completedAt: null,
  createdAt: new Date("2026-07-23T00:00:00.000Z"),
  detailBacklog: 0,
  expiresAt: new Date("2026-07-23T08:00:00.000Z"),
  failedMembers: 0,
  lastError: null,
  nextBaseClaimAt: null,
  pendingMembers: 492,
  qualifyingSuccesses: 0,
  skippedMembers: 0,
  startedAt: new Date("2026-07-23T00:00:00.000Z"),
  status: "running",
  stopReason: null,
  target: 100,
  trackBacklog: 0,
};

const limits = {
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

describe("Spotify sync campaign tick", () => {
  it("plans without locks, leases, or provider execution", async () => {
    const dependencies = fakeDependencies();
    const executor = { execute: vi.fn() };
    const result = await runSpotifySyncCampaignTick(fakeDatabase(), {
      campaignId: claim.campaignId,
      dependencies: dependencies as never,
      executor,
      limits,
      mode: "plan",
    });
    expect(result).toMatchObject({ reason: "planned", requestsStarted: 0 });
    expect(dependencies.acquireLock).not.toHaveBeenCalled();
    expect(dependencies.claimWork).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it.each([
    ["canary_review", "canary_review"],
    ["paused", "campaign_paused"],
    ["completed", "campaign_complete"],
  ] as const)("returns a provider-free no-op for %s", async (campaignStatus, reason) => {
    const dependencies = fakeDependencies();
    dependencies.getStatus.mockResolvedValue({ ...status, status: campaignStatus });
    const executor = { execute: vi.fn() };
    const result = await runSpotifySyncCampaignTick(fakeDatabase(), {
      campaignId: claim.campaignId,
      dependencies: dependencies as never,
      executor,
      limits,
      mode: "production",
    });
    expect(result).toMatchObject({ reason, requestsStarted: 0 });
    expect(dependencies.acquireLock).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("executes one work item and preserves the six-request and 90-second bounds", async () => {
    const dependencies = fakeDependencies();
    const gate = {
      acquire: vi.fn(() =>
        Promise.resolve({
          eventId: "event",
          leaseToken: "token",
          queueLength: 0,
          queueWaitMs: 0,
          startedAt: new Date(),
        }),
      ),
      complete: vi.fn(() => Promise.resolve()),
    };
    const executor = {
      execute: vi.fn(
        async (_work: SpotifySchedulerClaim, context: SpotifySchedulerExecutionContext) => {
          const wrapped = context.wrapRequestGate(gate);
          for (let index = 0; index < 6; index += 1) {
            await wrapped.acquire({ endpointCategory: "artist_albums", method: "GET" });
          }
        },
      ),
    };
    const result = await runSpotifySyncCampaignTick(fakeDatabase(), {
      campaignId: claim.campaignId,
      dependencies: dependencies as never,
      executor,
      limits,
      mode: "production",
    });
    expect(result).toMatchObject({ reason: "completed", requestsStarted: 6 });
    expect(dependencies.claimWork).toHaveBeenCalledOnce();
    expect(dependencies.finishWork).toHaveBeenCalledOnce();
    expect(executor.execute).toHaveBeenCalledOnce();
  });
});

function fakeDatabase(): RadarDatabase {
  return {} as RadarDatabase;
}

function fakeDependencies() {
  return {
    acquireLock: vi.fn(() => Promise.resolve({ lockKey: "scan:global", ownerToken: "owner" })),
    claimWork: vi.fn(() => Promise.resolve(claim)),
    finishWork: vi.fn(() => Promise.resolve(true)),
    getOperationalStatus: vi.fn(() => Promise.resolve({ cooldownActive: false })),
    getStatus: vi.fn(() => Promise.resolve(status)),
    planTick: vi.fn(() => Promise.resolve(claim)),
    releaseLock: vi.fn(() => Promise.resolve()),
  };
}
