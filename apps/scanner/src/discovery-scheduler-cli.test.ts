import { defaultSchedulerLimits, type createDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { describe, expect, it, vi } from "vitest";
import {
  applyRecurringDynamicMaintenanceWake,
  discoverySchedulerRoute,
  parseDiscoverySchedulerCommand,
  runBroadAutomaticPlaylistCheckpoint,
  runClaimedAppleJob,
  runDynamicSpotifyPriorityPhase,
  runPendingPriorityPlaylistCheckpoint,
  runPriorityAutomaticPlaylistCheckpoint,
  runReadyAutomaticPlaylistExport,
  runRecurringDiscoverySchedulerTick,
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

  it("preserves an imminent dynamic wake when the minute tick enters the keep-awake window", async () => {
    const updateWake = vi.fn(() => Promise.resolve());
    const ensureWake = vi.fn(() => Promise.resolve());
    let now = new Date("2026-09-12T16:00:00.000Z");

    await applyRecurringDynamicMaintenanceWake(
      {
        dynamicWakeAt: null,
        holdPower: true,
        reason: "priority_capacity_wait",
        runNow: false,
        waitUntil: new Date("2026-09-12T16:10:43.072Z"),
      },
      { ensureWake, now: () => now, updateWake },
    );
    now = new Date("2026-09-12T16:01:00.000Z");
    await applyRecurringDynamicMaintenanceWake(
      {
        dynamicWakeAt: null,
        holdPower: false,
        reason: "priority_work",
        runNow: true,
        waitUntil: null,
      },
      { ensureWake, now: () => now, updateWake },
    );

    expect(updateWake).not.toHaveBeenCalled();
    expect(ensureWake).toHaveBeenCalledTimes(2);
    expect(ensureWake).toHaveBeenNthCalledWith(1, new Date("2026-09-12T16:00:15.000Z"));
    expect(ensureWake).toHaveBeenNthCalledWith(2, new Date("2026-09-12T16:01:15.000Z"));
  });

  it("still updates or clears a dynamic wake when maintenance need has ended", async () => {
    const updateWake = vi.fn(() => Promise.resolve());
    const wakeAt = new Date("2026-09-13T04:00:00.000Z");

    await applyRecurringDynamicMaintenanceWake(
      {
        dynamicWakeAt: wakeAt,
        holdPower: false,
        reason: "priority_capacity_wait",
        runNow: false,
        waitUntil: null,
      },
      { updateWake, now: () => new Date("2026-09-13T03:50:00Z") },
    );
    await applyRecurringDynamicMaintenanceWake(
      {
        dynamicWakeAt: null,
        holdPower: false,
        reason: "no_work",
        runNow: false,
        waitUntil: null,
      },
      { updateWake, now: () => new Date("2026-09-13T03:50:00Z") },
    );

    expect(updateWake).toHaveBeenNthCalledWith(1, wakeAt);
    expect(updateWake).toHaveBeenNthCalledWith(2, null);
  });

  it("uses the minute task only for local reconciliation and maintenance dispatch", async () => {
    const events: string[] = [];
    const decision = {
      dynamicWakeAt: null,
      holdPower: false,
      reason: "priority_work" as const,
      runNow: true,
      waitUntil: null,
    };
    const now = new Date("2026-09-12T23:00:00.000Z");
    const applyWake = vi.fn(() => {
      events.push("dispatch");
      return Promise.resolve(false);
    });

    await expect(
      runRecurringDiscoverySchedulerTick({} as ReturnType<typeof createDatabase>["db"], now, {
        applyWake,
        decide: vi.fn(() => decision),
        ensureOwner: vi.fn(() => {
          events.push("owner");
          return Promise.resolve("user-id");
        }),
        getAppleStatus: vi.fn(() => {
          events.push("apple-status");
          return Promise.resolve({} as never);
        }),
        getDiscoveryStatus: vi.fn(() => {
          events.push("discovery-status");
          return Promise.resolve({} as never);
        }),
        getSpotifyStatus: vi.fn(() => {
          events.push("spotify-status");
          return Promise.resolve({} as never);
        }),
        matureFeed: vi.fn(() => {
          events.push("mature-feed");
          return Promise.resolve({ maturedItemIds: [], productionDate: "2026-09-12" });
        }),
        reconcileCooldown: vi.fn(() => {
          events.push("cooldown");
          return Promise.resolve(false);
        }),
        reconcileDeferredPriority: vi.fn(() => {
          events.push("deferred-priority");
          return Promise.resolve(0);
        }),
        reconcilePriorityPhase: vi.fn(() => {
          events.push("priority-phase");
          return Promise.resolve();
        }),
        reconcileQueueDepth: vi.fn(() => {
          events.push("queue-depth");
          return Promise.resolve(false);
        }),
        surfaceReviews: vi.fn(() => {
          events.push("reviews");
          return Promise.resolve({ candidatesUpdated: 0, feedItemsUpdated: 0 });
        }),
      }),
    ).resolves.toEqual({ decision, dispatchedToMaintenance: false });

    expect(events).toEqual([
      "owner",
      "mature-feed",
      "reviews",
      "queue-depth",
      "deferred-priority",
      "cooldown",
      "priority-phase",
      "apple-status",
      "discovery-status",
      "spotify-status",
      "dispatch",
    ]);
    expect(applyWake).toHaveBeenCalledWith(decision);
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
      const deadlineAt = new Date("2026-09-13T03:55:00.000Z");

      await expect(
        runReadyAutomaticPlaylistExport(db, loadProviderConfiguration({}), {
          deadlineAt,
          getStatus: () =>
            Promise.resolve({ phase: "playlist_inbox", playlistInbox: { status: "ready" } }),
          runExport,
        }),
      ).resolves.toEqual({ reason: "completed" });

      expect(runExport).toHaveBeenCalledWith(db, expect.anything(), { deadlineAt });
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
      appleMusicBatchId: null,
      id: "catchup-job",
      jobKey: "apple_catchup:2026-08-07",
      jobType: "apple_catchup" as const,
      leaseExpiresAt: new Date("2026-08-07T19:00:00.000Z"),
      leaseOwner: "owner",
      recoveryDeadline: new Date("2026-08-08T16:00:00.000Z"),
      scanRunId: null,
      scheduledFor: new Date("2026-08-07T16:00:00.000Z"),
    };
    const getStatus = vi.fn(() =>
      Promise.resolve({ phase: "broad_spotify", playlistInbox: { status: "completed" } }),
    );
    const reconcileCooldown = vi.fn(() => Promise.resolve(false));

    await expect(
      selectDiscoverySchedulerAction({} as ReturnType<typeof createDatabase>["db"], {
        claimAppleJob: vi.fn(() => Promise.resolve(claim)),
        getStatus,
        reconcileCooldown,
      }),
    ).resolves.toEqual({ appleClaim: claim, route: "apple_scan" });
    expect(getStatus).toHaveBeenCalledOnce();
    expect(reconcileCooldown).toHaveBeenCalledOnce();
  });

  it("exports an already-ready playlist before claiming Apple recovery work", async () => {
    const claimAppleJob = vi.fn();
    await expect(
      selectDiscoverySchedulerAction({} as ReturnType<typeof createDatabase>["db"], {
        claimAppleJob,
        getStatus: vi.fn(() =>
          Promise.resolve({ phase: "playlist_inbox", playlistInbox: { status: "ready" } }),
        ),
        reconcileCooldown: vi.fn(() => Promise.resolve(false)),
      }),
    ).resolves.toEqual({ route: "playlist_export" });
    expect(claimAppleJob).not.toHaveBeenCalled();
  });

  it.each(["Operation scan:global is already running.", "A apple_music scan is already running"])(
    "yields a newly claimed Apple job on expected scan contention: %s",
    async (message) => {
      const db = {} as ReturnType<typeof createDatabase>["db"];
      const claim = {
        appleMusicBatchId: null,
        id: "catchup-job",
        jobKey: "apple_catchup:2026-09-11",
        jobType: "apple_catchup" as const,
        leaseExpiresAt: new Date("2026-09-11T20:00:00.000Z"),
        leaseOwner: "maintenance-owner",
        recoveryDeadline: new Date("2026-09-12T16:00:00.000Z"),
        scanRunId: null,
        scheduledFor: new Date("2026-09-11T16:00:00.000Z"),
      };
      const finishJob = vi.fn(() => Promise.resolve(true));
      const yieldJob = vi.fn(() => Promise.resolve(true));

      await expect(
        runClaimedAppleJob(
          db,
          loadProviderConfiguration({
            APPLE_MUSIC_ENABLED: "true",
            APPLE_MUSIC_KEY_ID: "ABCDEFGHIJ",
            APPLE_MUSIC_PRIVATE_KEY_PATH: "test-key.p8",
            APPLE_MUSIC_TEAM_ID: "ABCDEFGHIJ",
          }),
          claim,
          {},
          {
            finishJob,
            runScan: vi.fn(() => Promise.reject(new Error(message))),
            yieldJob,
          },
        ),
      ).rejects.toThrow(message);

      expect(yieldJob).toHaveBeenCalledWith(db, claim, {
        appleMusicBatchId: null,
        errorClassification: "apple_scan_lock_contended",
        scanRunId: null,
      });
      expect(finishJob).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Apple Music requests are blocked by a persisted cooldown.", "apple_music_cooldown"],
    ["An Apple Music request lease is already active.", "apple_request_lease_active"],
  ])(
    "keeps a claimed Apple job resumable after retryable preflight: %s",
    async (message, classification) => {
      const db = {} as ReturnType<typeof createDatabase>["db"];
      const claim = {
        appleMusicBatchId: null,
        id: "catchup-job",
        jobKey: "apple_catchup:2026-09-11",
        jobType: "apple_catchup" as const,
        leaseExpiresAt: new Date("2026-09-11T20:00:00.000Z"),
        leaseOwner: "maintenance-owner",
        recoveryDeadline: new Date("2026-09-12T16:00:00.000Z"),
        scanRunId: null,
        scheduledFor: new Date("2026-09-11T16:00:00.000Z"),
      };
      const finishJob = vi.fn(() => Promise.resolve(true));
      const yieldJob = vi.fn(() => Promise.resolve(true));

      await expect(
        runClaimedAppleJob(
          db,
          loadProviderConfiguration({
            APPLE_MUSIC_ENABLED: "true",
            APPLE_MUSIC_KEY_ID: "ABCDEFGHIJ",
            APPLE_MUSIC_PRIVATE_KEY_PATH: "test-key.p8",
            APPLE_MUSIC_TEAM_ID: "ABCDEFGHIJ",
          }),
          claim,
          {},
          {
            finishJob,
            runScan: vi.fn(() => Promise.reject(new Error(message))),
            yieldJob,
          },
        ),
      ).resolves.toEqual({
        appleMusicBatchId: null,
        errorClassification: classification,
        jobType: "apple_catchup",
        status: "yielded",
      });

      expect(yieldJob).toHaveBeenCalledWith(db, claim, {
        appleMusicBatchId: null,
        errorClassification: classification,
        scanRunId: null,
      });
      expect(finishJob).not.toHaveBeenCalled();
    },
  );

  it("normalizes a database gate cooldown and leaves a pre-batch Apple job resumable", async () => {
    const db = {} as ReturnType<typeof createDatabase>["db"];
    const claim = {
      appleMusicBatchId: null,
      id: "catchup-job",
      jobKey: "apple_catchup:2026-09-11",
      jobType: "apple_catchup" as const,
      leaseExpiresAt: new Date("2026-09-11T20:00:00.000Z"),
      leaseOwner: "maintenance-owner",
      recoveryDeadline: new Date("2026-09-12T16:00:00.000Z"),
      scanRunId: null,
      scheduledFor: new Date("2026-09-11T16:00:00.000Z"),
    };
    const finishJob = vi.fn(() => Promise.resolve(true));
    const yieldJob = vi.fn(() => Promise.resolve(true));
    const cooldownError = Object.assign(new Error("Provider cooldown is active."), {
      classification: "provider_cooldown",
    });

    await expect(
      runClaimedAppleJob(
        db,
        loadProviderConfiguration({
          APPLE_MUSIC_ENABLED: "true",
          APPLE_MUSIC_KEY_ID: "ABCDEFGHIJ",
          APPLE_MUSIC_PRIVATE_KEY_PATH: "test-key.p8",
          APPLE_MUSIC_TEAM_ID: "ABCDEFGHIJ",
        }),
        claim,
        {},
        {
          finishJob,
          runScan: vi.fn(() => Promise.reject(cooldownError)),
          yieldJob,
        },
      ),
    ).resolves.toMatchObject({
      errorClassification: "apple_music_cooldown",
      status: "yielded",
    });
    expect(yieldJob).toHaveBeenCalledWith(db, claim, {
      appleMusicBatchId: null,
      errorClassification: "apple_music_cooldown",
      scanRunId: null,
    });
    expect(finishJob).not.toHaveBeenCalled();
  });

  it("finalizes an already-completed attached Apple batch without scanning it again", async () => {
    const db = {} as ReturnType<typeof createDatabase>["db"];
    const claim = {
      appleMusicBatchId: "completed-batch",
      id: "catchup-job",
      jobKey: "apple_catchup:2026-09-11",
      jobType: "apple_catchup" as const,
      leaseExpiresAt: new Date("2026-09-11T20:00:00.000Z"),
      leaseOwner: "maintenance-owner",
      recoveryDeadline: new Date("2026-09-12T16:00:00.000Z"),
      scanRunId: "completed-run",
      scheduledFor: new Date("2026-09-11T16:00:00.000Z"),
    };
    const finishJob = vi.fn(() => Promise.resolve(true));
    const runReadyPlaylist = vi.fn(() => Promise.resolve(null));
    const runScan = vi.fn(() => Promise.resolve({} as never));

    await expect(
      runClaimedAppleJob(
        db,
        loadProviderConfiguration({}),
        claim,
        {},
        {
          finishJob,
          getBatch: vi.fn(() =>
            Promise.resolve({
              completedArtists: 593,
              failedArtists: 0,
              finishedAt: new Date("2026-09-11T19:00:00.000Z"),
              id: "completed-batch",
              scanRunId: "completed-run",
              status: "completed",
              totalArtists: 593,
            }),
          ),
          runReadyPlaylist,
          runScan,
        },
      ),
    ).resolves.toMatchObject({
      appleMusicBatchId: "completed-batch",
      completedArtists: 593,
      status: "completed",
      totalArtists: 593,
    });

    expect(runScan).not.toHaveBeenCalled();
    expect(finishJob).toHaveBeenCalledWith(db, claim, {
      appleMusicBatchId: "completed-batch",
      scanRunId: "completed-run",
      status: "completed",
    });
    expect(runReadyPlaylist).toHaveBeenCalledOnce();
  });

  it("completes a terminal-partial Apple workflow and queues successful discoveries", async () => {
    const db = {} as ReturnType<typeof createDatabase>["db"];
    const claim = {
      appleMusicBatchId: "partial-batch",
      id: "catchup-job",
      jobKey: "apple_catchup:2026-09-11",
      jobType: "apple_catchup" as const,
      leaseExpiresAt: new Date("2026-09-11T20:00:00.000Z"),
      leaseOwner: "maintenance-owner",
      recoveryDeadline: new Date("2026-09-12T16:00:00.000Z"),
      scanRunId: "partial-run",
      scheduledFor: new Date("2026-09-11T16:00:00.000Z"),
    };
    const finishJob = vi.fn(() => Promise.resolve(true));
    const runReadyPlaylist = vi.fn(() => Promise.resolve(null));
    const runScan = vi.fn(() => Promise.resolve({} as never));

    await expect(
      runClaimedAppleJob(
        db,
        loadProviderConfiguration({}),
        claim,
        {},
        {
          finishJob,
          getBatch: vi.fn(() =>
            Promise.resolve({
              completedArtists: 592,
              failedArtists: 1,
              finishedAt: new Date("2026-09-11T19:00:00.000Z"),
              id: "partial-batch",
              scanRunId: "partial-run",
              status: "partial",
              totalArtists: 593,
            }),
          ),
          runReadyPlaylist,
          runScan,
        },
      ),
    ).resolves.toMatchObject({
      appleMusicBatchId: "partial-batch",
      completedArtists: 592,
      failedArtists: 1,
      status: "completed_with_failures",
      totalArtists: 593,
    });

    expect(runScan).not.toHaveBeenCalled();
    expect(finishJob).toHaveBeenCalledWith(db, claim, {
      appleMusicBatchId: "partial-batch",
      errorClassification: "apple_terminal_artist_failures",
      scanRunId: "partial-run",
      status: "completed",
    });
    expect(runReadyPlaylist).toHaveBeenCalledOnce();
  });

  it("yields a partial Apple batch while retryable artists remain unfinished", async () => {
    const db = {} as ReturnType<typeof createDatabase>["db"];
    const claim = {
      appleMusicBatchId: "partial-batch",
      id: "catchup-job",
      jobKey: "apple_catchup:2026-09-11",
      jobType: "apple_catchup" as const,
      leaseExpiresAt: new Date("2026-09-11T20:00:00.000Z"),
      leaseOwner: "maintenance-owner",
      recoveryDeadline: new Date("2026-09-12T16:00:00.000Z"),
      scanRunId: "partial-run",
      scheduledFor: new Date("2026-09-11T16:00:00.000Z"),
    };
    const finishJob = vi.fn(() => Promise.resolve(true));
    const yieldJob = vi.fn(() => Promise.resolve(true));
    const batch = {
      completedArtists: 592,
      failedArtists: 1,
      finishedAt: null,
      id: "partial-batch",
      scanRunId: "partial-run",
      status: "partial",
      totalArtists: 593,
    };

    await expect(
      runClaimedAppleJob(
        db,
        loadProviderConfiguration({
          APPLE_MUSIC_ENABLED: "true",
          APPLE_MUSIC_KEY_ID: "ABCDEFGHIJ",
          APPLE_MUSIC_PRIVATE_KEY_PATH: "test-key.p8",
          APPLE_MUSIC_TEAM_ID: "ABCDEFGHIJ",
        }),
        claim,
        {},
        {
          finishJob,
          getBatch: vi.fn(() => Promise.resolve(batch)),
          runScan: vi.fn(() => Promise.resolve({} as never)),
          yieldJob,
        },
      ),
    ).resolves.toMatchObject({
      appleMusicBatchId: "partial-batch",
      errorClassification: "apple_items_deferred",
      status: "yielded",
    });

    expect(yieldJob).toHaveBeenCalledWith(db, claim, {
      appleMusicBatchId: "partial-batch",
      errorClassification: "apple_items_deferred",
      scanRunId: "partial-run",
    });
    expect(finishJob).not.toHaveBeenCalled();
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
    const deadlineAt = new Date("2026-09-13T03:55:00.000Z");

    await expect(
      runBroadAutomaticPlaylistCheckpoint(
        db,
        loadProviderConfiguration({}),
        broadTick({ rolling30: 30 }),
        { deadlineAt, inspect, markPending, prepare, runExport },
      ),
    ).resolves.toEqual({ reason: "completed" });
    expect(markPending).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(runExport).toHaveBeenCalledWith(db, expect.anything(), { deadlineAt });
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

  it("runs a guarded priority checkpoint only when confirmed playlist work exists", async () => {
    const db = {} as ReturnType<typeof createDatabase>["db"];
    const prepare = vi.fn(() => Promise.resolve(true));
    const runExport = vi.fn(() => Promise.resolve({ reason: "completed" as const }));
    const deadlineAt = new Date("2026-09-13T03:55:00.000Z");

    await expect(
      runPriorityAutomaticPlaylistCheckpoint(db, loadProviderConfiguration({}), {
        deadlineAt,
        inspect: vi.fn(() => Promise.resolve({ reason: "pending_additions", shouldRun: true })),
        prepare,
        runExport,
      }),
    ).resolves.toEqual({ reason: "completed" });
    expect(prepare).toHaveBeenCalledOnce();
    expect(runExport).toHaveBeenCalledWith(db, expect.anything(), { deadlineAt });
  });

  it("does not open a priority checkpoint when there are no playlist changes", async () => {
    const prepare = vi.fn(() => Promise.resolve(true));
    const runExport = vi.fn(() => Promise.resolve({ reason: "completed" as const }));

    await expect(
      runPriorityAutomaticPlaylistCheckpoint(
        {} as ReturnType<typeof createDatabase>["db"],
        loadProviderConfiguration({}),
        {
          inspect: vi.fn(() => Promise.resolve({ reason: "none", shouldRun: false })),
          prepare,
          runExport,
        },
      ),
    ).resolves.toMatchObject({ reason: "no_changes" });
    expect(prepare).not.toHaveBeenCalled();
    expect(runExport).not.toHaveBeenCalled();
  });

  it("flushes an existing pending priority checkpoint before more scheduled work", async () => {
    const db = {} as ReturnType<typeof createDatabase>["db"];
    const runCheckpoint = vi.fn(() => Promise.resolve({ reason: "completed" as const }));
    const deadlineAt = new Date("2026-09-13T03:55:00.000Z");

    await expect(
      runPendingPriorityPlaylistCheckpoint(db, loadProviderConfiguration({}), {
        deadlineAt,
        getStatus: vi.fn(() =>
          Promise.resolve({
            phase: "apple_priority",
            playlistInbox: { status: "pending" },
          }),
        ),
        runCheckpoint,
      }),
    ).resolves.toEqual({ reason: "completed" });
    expect(runCheckpoint).toHaveBeenCalledWith(db, expect.anything(), { deadlineAt });
  });

  it("falls through after a no-change pending priority checkpoint inspection", async () => {
    const runCheckpoint = vi.fn(() => Promise.resolve({ reason: "no_changes" as const }));

    await expect(
      runPendingPriorityPlaylistCheckpoint(
        {} as ReturnType<typeof createDatabase>["db"],
        loadProviderConfiguration({}),
        {
          getStatus: vi.fn(() =>
            Promise.resolve({
              phase: "apple_catchup_priority",
              playlistInbox: { status: "pending" },
            }),
          ),
          runCheckpoint,
        },
      ),
    ).resolves.toBeNull();
    expect(runCheckpoint).toHaveBeenCalledOnce();
  });

  it("does not inspect a priority checkpoint outside an active priority phase", async () => {
    const runCheckpoint = vi.fn(() => Promise.resolve({ reason: "completed" as const }));

    await expect(
      runPendingPriorityPlaylistCheckpoint(
        {} as ReturnType<typeof createDatabase>["db"],
        loadProviderConfiguration({}),
        {
          getStatus: vi.fn(() =>
            Promise.resolve({
              phase: "broad_spotify",
              playlistInbox: { status: "completed" },
            }),
          ),
          runCheckpoint,
        },
      ),
    ).resolves.toBeNull();
    expect(runCheckpoint).not.toHaveBeenCalled();
  });

  it("checks a completed priority checkpoint for newly eligible tracks", async () => {
    const runCheckpoint = vi.fn(() => Promise.resolve({ reason: "completed" as const }));

    await expect(
      runPendingPriorityPlaylistCheckpoint(
        {} as ReturnType<typeof createDatabase>["db"],
        loadProviderConfiguration({}),
        {
          getStatus: vi.fn(() =>
            Promise.resolve({
              phase: "apple_priority",
              playlistInbox: { status: "completed" },
            }),
          ),
          runCheckpoint,
        },
      ),
    ).resolves.toEqual({ reason: "completed" });
    expect(runCheckpoint).toHaveBeenCalledOnce();
  });

  it("yields for re-observation when priority checkpoint preparation loses a state race", async () => {
    await expect(
      runPendingPriorityPlaylistCheckpoint(
        {} as ReturnType<typeof createDatabase>["db"],
        loadProviderConfiguration({}),
        {
          getStatus: vi.fn(() =>
            Promise.resolve({
              phase: "apple_catchup_priority",
              playlistInbox: { status: "pending" },
            }),
          ),
          runCheckpoint: vi.fn(() => Promise.resolve(null)),
        },
      ),
    ).resolves.toEqual({ reason: "checkpoint_state_changed" });
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
    const runCheckpoint = vi.fn(() => Promise.resolve(null));

    await expect(
      runDynamicSpotifyPriorityPhase(
        db,
        loadProviderConfiguration({ SPOTIFY_PRIORITY_MAX_ITEMS_PER_RUN: "10" }),
        { getStatus, runCheckpoint, runTick: runTick as never },
      ),
    ).resolves.toEqual({ completedItems: 5, reason: "drained", requestsStarted: 5 });
    expect(runTick).toHaveBeenCalledTimes(5);
    expect(runCheckpoint).toHaveBeenCalledOnce();
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
          runCheckpoint: vi.fn(() => Promise.resolve(null)),
          runTick: runTick as never,
        },
      ),
    ).resolves.toEqual({ completedItems: 10, reason: "limit_reached", requestsStarted: 10 });
    expect(runTick).toHaveBeenCalledTimes(10);
  });

  it("allows maintenance to process one priority item before re-observing", async () => {
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
          maximumItems: 1,
          runCheckpoint: vi.fn(() => Promise.resolve(null)),
          runTick: runTick as never,
        },
      ),
    ).resolves.toEqual({ completedItems: 1, reason: "limit_reached", requestsStarted: 1 });
    expect(runTick).toHaveBeenCalledOnce();
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
          runCheckpoint: vi.fn(() => Promise.resolve(null)),
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
          runCheckpoint: vi.fn(() => Promise.resolve(null)),
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
