import { defaultSchedulerLimits, type createDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { describe, expect, it, vi } from "vitest";
import {
  discoverySchedulerRoute,
  parseDiscoverySchedulerCommand,
  runBroadAutomaticPlaylistCheckpoint,
  runDynamicSpotifyPriorityPhase,
  runReadyAutomaticPlaylistExport,
  selectDiscoverySchedulerAction,
  shouldFlushBroadPlaylistCheckpoint,
} from "./discovery-scheduler-cli";

function broadTick(input: {
  broadRemaining?: number;
  cooldownActive?: boolean;
  dueArtistCount?: number;
  reason?: "completed" | "no_work" | "cooldown";
  rolling30?: number;
  source?: "recurring" | "apple_priority";
}) {
  return {
    reason: input.reason ?? "completed",
    requestsStarted: 1,
    selected: { source: input.source ?? "recurring" },
    status: {
      backlog: {
        artist_reconciliation: 1,
        base_artist: 1,
        release_detail: 0,
        release_tracks: 0,
        track_resolution: 0,
      },
      cooldownActive: input.cooldownActive ?? false,
      dailyBudget: {
        broadArtistsLimit: 75,
        broadArtistsUsed: 1,
        broadRequestsLimit: 300,
        broadRequestsUsed: 1,
        localDate: "2026-08-08",
        playlistRequestReserve: 20,
        priorityRequestReserve: 200,
      },
      dueArtistCount: input.dueArtistCount ?? 1,
      endpointBudget: {
        artistAlbums: {
          allowance: 80,
          broadAllowance: 60,
          broadRemaining: input.broadRemaining ?? 59,
          broadUsed: 1,
          calls: 1,
          nextCapacityAt: null,
          priorityRemaining: 79,
          priorityReserve: 20,
          priorityUsed: 0,
          remaining: 79,
          reserveRemaining: 20,
          reserveReleased: false,
        },
        playlist: { reads: 0, writes: 0 },
      },
      requestCounts: {
        byEndpointCategory: {
          album_detail: 0,
          album_tracks: 0,
          artist_albums: 1,
          oauth_or_other: 0,
          playlist_read: 0,
          playlist_write: 0,
        },
        byWorkType: { base_artist: 1 },
        last24Hours: 1,
        last30Minutes: input.rolling30 ?? 1,
      },
    },
  };
}

describe("discovery scheduler CLI", () => {
  it("parses only the supported commands", () => {
    expect(parseDiscoverySchedulerCommand(["status"])).toBe("status");
    expect(parseDiscoverySchedulerCommand(["--", "tick"])).toBe("tick");
    expect(() => parseDiscoverySchedulerCommand(["run"])).toThrow("Usage:");
  });

  it.each(["ready", "exporting", "partial", "failed"])(
    "routes a %s playlist checkpoint to the automatic exporter",
    (playlistInboxStatus) => {
      expect(discoverySchedulerRoute({ phase: "playlist_inbox", playlistInboxStatus })).toBe(
        "playlist_export",
      );
    },
  );

  it.each(["apple_priority", "apple_catchup_priority", "cooldown_wait"])(
    "routes %s through bounded Spotify priority handling",
    (phase) => {
      expect(discoverySchedulerRoute({ phase, playlistInboxStatus: "pending" })).toBe(
        "spotify_priority",
      );
    },
  );

  it("leaves Apple claims and broad work on the normal route", () => {
    expect(
      discoverySchedulerRoute({ phase: "broad_spotify", playlistInboxStatus: "completed" }),
    ).toBe("apple_or_spotify");
  });

  it.each(["Thursday full scan", "Friday catch-up"])(
    "continues %s into automatic export without an interactive command",
    async () => {
      const runExport = vi.fn(() => Promise.resolve({ reason: "completed" as const }));
      const db = {} as ReturnType<typeof createDatabase>["db"];

      await expect(
        runReadyAutomaticPlaylistExport(db, loadProviderConfiguration({}), {
          getStatus: () =>
            Promise.resolve({ phase: "playlist_inbox", playlistInbox: { status: "ready" } }),
          runExport,
        }),
      ).resolves.toEqual({ reason: "completed" });

      expect(runExport).toHaveBeenCalledOnce();
    },
  );

  it("does not bypass unresolved Apple-priority work", async () => {
    const runExport = vi.fn(() => Promise.resolve({ reason: "completed" as const }));
    const db = {} as ReturnType<typeof createDatabase>["db"];

    await expect(
      runReadyAutomaticPlaylistExport(db, loadProviderConfiguration({}), {
        getStatus: () =>
          Promise.resolve({ phase: "apple_priority", playlistInbox: { status: "pending" } }),
        runExport,
      }),
    ).resolves.toBeNull();
    expect(runExport).not.toHaveBeenCalled();
  });

  it("claims a due Friday catch-up before Spotify cooldown routing", async () => {
    const claim = {
      id: "catchup-job",
      jobKey: "apple_catchup:2026-08-07",
      jobType: "apple_catchup" as const,
      leaseExpiresAt: new Date("2026-08-07T19:00:00.000Z"),
      leaseOwner: "owner",
      recoveryDeadline: new Date("2026-08-08T16:00:00.000Z"),
      scheduledFor: new Date("2026-08-07T16:00:00.000Z"),
    };
    const getStatus = vi.fn();
    const reconcileCooldown = vi.fn();

    await expect(
      selectDiscoverySchedulerAction({} as ReturnType<typeof createDatabase>["db"], {
        claimAppleJob: vi.fn(() => Promise.resolve(claim)),
        getStatus,
        reconcileCooldown,
      }),
    ).resolves.toEqual({ appleClaim: claim, route: "apple_scan" });
    expect(getStatus).not.toHaveBeenCalled();
    expect(reconcileCooldown).not.toHaveBeenCalled();
  });

  it("reconciles an expired cooldown before selecting Spotify work", async () => {
    const reconcileCooldown = vi.fn(() => Promise.resolve(true));
    await expect(
      selectDiscoverySchedulerAction({} as ReturnType<typeof createDatabase>["db"], {
        claimAppleJob: vi.fn(() => Promise.resolve(null)),
        getStatus: vi.fn(() =>
          Promise.resolve({
            phase: "playlist_inbox",
            playlistInbox: { status: "ready" },
          }),
        ),
        reconcileCooldown,
      }),
    ).resolves.toEqual({ route: "playlist_export" });
    expect(reconcileCooldown).toHaveBeenCalledOnce();
  });

  it.each([
    ["rolling request ceiling", broadTick({ rolling30: 30 })],
    ["Artist Albums ceiling", broadTick({ broadRemaining: 0 })],
    ["provider cooldown", broadTick({ cooldownActive: true, reason: "cooldown" })],
    ["drained queue", broadTick({ dueArtistCount: 0, reason: "no_work" })],
  ])("flushes a batched broad playlist checkpoint at the %s", (_label, tick) => {
    expect(shouldFlushBroadPlaylistCheckpoint(tick, defaultSchedulerLimits())).toBe(true);
  });

  it("does not flush a broad checkpoint between ordinary artist slots", () => {
    expect(
      shouldFlushBroadPlaylistCheckpoint(broadTick({ rolling30: 1 }), defaultSchedulerLimits()),
    ).toBe(false);
  });

  it("marks broad discoveries pending and invokes one guarded export at a yield boundary", async () => {
    const db = {} as ReturnType<typeof createDatabase>["db"];
    const markPending = vi.fn(() => Promise.resolve(true));
    const prepare = vi.fn(() => Promise.resolve(true));
    const runExport = vi.fn(() => Promise.resolve({ reason: "completed" as const }));
    const inspect = vi.fn(() => Promise.resolve({ reason: "pending_additions", shouldRun: true }));

    await expect(
      runBroadAutomaticPlaylistCheckpoint(
        db,
        loadProviderConfiguration({}),
        broadTick({ rolling30: 30 }),
        { inspect, markPending, prepare, runExport },
      ),
    ).resolves.toEqual({ reason: "completed" });
    expect(markPending).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(runExport).toHaveBeenCalledOnce();
  });

  it("does not create or run a broad checkpoint when database state has no playlist work", async () => {
    const markPending = vi.fn(() => Promise.resolve(true));
    const prepare = vi.fn(() => Promise.resolve(true));
    const runExport = vi.fn(() => Promise.resolve({ reason: "completed" as const }));

    await expect(
      runBroadAutomaticPlaylistCheckpoint(
        {} as ReturnType<typeof createDatabase>["db"],
        loadProviderConfiguration({}),
        broadTick({ broadRemaining: 0 }),
        {
          inspect: vi.fn(() => Promise.resolve({ reason: "none", shouldRun: false })),
          markPending,
          prepare,
          runExport,
        },
      ),
    ).resolves.toMatchObject({ reason: "no_changes" });
    expect(markPending).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(runExport).not.toHaveBeenCalled();
  });

  it("does not mark priority resolution as a broad playlist batch", async () => {
    const markPending = vi.fn(() => Promise.resolve(true));
    const prepare = vi.fn(() => Promise.resolve(false));

    await runBroadAutomaticPlaylistCheckpoint(
      {} as ReturnType<typeof createDatabase>["db"],
      loadProviderConfiguration({}),
      broadTick({ rolling30: 30, source: "apple_priority" }),
      { markPending, prepare },
    );
    expect(markPending).not.toHaveBeenCalled();
  });

  it("processes five priority artists back-to-back and stops before broad work", async () => {
    const db = {} as ReturnType<typeof createDatabase>["db"];
    const runTick = vi.fn(() =>
      Promise.resolve({
        ...broadTick({ source: "apple_priority" }),
        mode: "credential_free" as const,
        selected: {
          artistId: "artist",
          discoveryReconciliationCampaignId: null,
          dueAt: new Date(),
          id: "work",
          leaseExpiresAt: new Date(),
          leaseOwner: "lease",
          source: "apple_priority" as const,
          spotifyAlbumId: null,
          spotifyReleaseTrackRetrievalId: null,
          workType: "artist_reconciliation" as const,
        },
      }),
    );
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({
        phase: "apple_priority",
        playlistInbox: { status: "completed" },
      })
      .mockResolvedValueOnce({
        phase: "apple_priority",
        playlistInbox: { status: "completed" },
      })
      .mockResolvedValueOnce({
        phase: "apple_priority",
        playlistInbox: { status: "completed" },
      })
      .mockResolvedValueOnce({
        phase: "apple_priority",
        playlistInbox: { status: "completed" },
      })
      .mockResolvedValueOnce({
        phase: "apple_priority",
        playlistInbox: { status: "completed" },
      })
      .mockResolvedValueOnce({
        phase: "broad_spotify",
        playlistInbox: { status: "completed" },
      });
    const runExport = vi.fn(() => Promise.resolve(null));

    await expect(
      runDynamicSpotifyPriorityPhase(
        db,
        loadProviderConfiguration({ SPOTIFY_PRIORITY_MAX_ITEMS_PER_RUN: "10" }),
        { getStatus, runExport, runTick: runTick as never },
      ),
    ).resolves.toEqual({ completedItems: 5, reason: "drained", requestsStarted: 5 });
    expect(runTick).toHaveBeenCalledTimes(5);
    expect(runExport).toHaveBeenCalledTimes(5);
  });

  it("bounds one dynamic priority process at ten committed work items", async () => {
    const runTick = vi.fn(() =>
      Promise.resolve({
        ...broadTick({ source: "apple_priority" }),
        mode: "credential_free" as const,
        selected: {
          artistId: "artist",
          discoveryReconciliationCampaignId: null,
          dueAt: new Date(),
          id: "work",
          leaseExpiresAt: new Date(),
          leaseOwner: "lease",
          source: "apple_priority" as const,
          spotifyAlbumId: null,
          spotifyReleaseTrackRetrievalId: null,
          workType: "artist_reconciliation" as const,
        },
      }),
    );

    await expect(
      runDynamicSpotifyPriorityPhase(
        {} as ReturnType<typeof createDatabase>["db"],
        loadProviderConfiguration({ SPOTIFY_PRIORITY_MAX_ITEMS_PER_RUN: "10" }),
        {
          getStatus: vi.fn(() =>
            Promise.resolve({
              phase: "apple_priority",
              playlistInbox: { status: "completed" },
            }),
          ),
          runExport: vi.fn(() => Promise.resolve(null)),
          runTick: runTick as never,
        },
      ),
    ).resolves.toEqual({ completedItems: 10, reason: "limit_reached", requestsStarted: 10 });
    expect(runTick).toHaveBeenCalledTimes(10);
  });

  it("stops dynamic priority execution immediately on cooldown", async () => {
    const tick = broadTick({ cooldownActive: true, reason: "cooldown", source: "apple_priority" });
    await expect(
      runDynamicSpotifyPriorityPhase(
        {} as ReturnType<typeof createDatabase>["db"],
        loadProviderConfiguration({}),
        {
          getStatus: vi.fn(() =>
            Promise.resolve({
              phase: "apple_priority",
              playlistInbox: { status: "completed" },
            }),
          ),
          runExport: vi.fn(() => Promise.resolve(null)),
          runTick: vi.fn(() =>
            Promise.resolve({ ...tick, mode: "credential_free" as const, selected: null }),
          ) as never,
        },
      ),
    ).resolves.toEqual({ completedItems: 0, reason: "cooldown", requestsStarted: 1 });
  });

  it("stops dynamic priority execution when Artist Albums capacity is exhausted", async () => {
    const tick = broadTick({ broadRemaining: 0, reason: "no_work", source: "apple_priority" });
    tick.status.endpointBudget.artistAlbums.priorityRemaining = 0;
    await expect(
      runDynamicSpotifyPriorityPhase(
        {} as ReturnType<typeof createDatabase>["db"],
        loadProviderConfiguration({}),
        {
          getStatus: vi.fn(() =>
            Promise.resolve({
              phase: "apple_priority",
              playlistInbox: { status: "completed" },
            }),
          ),
          runExport: vi.fn(() => Promise.resolve(null)),
          runTick: vi.fn(() =>
            Promise.resolve({ ...tick, mode: "credential_free" as const, selected: null }),
          ) as never,
        },
      ),
    ).resolves.toEqual({
      completedItems: 0,
      reason: "capacity_exhausted",
      requestsStarted: 1,
    });
  });
});
