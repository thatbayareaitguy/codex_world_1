import { describe, expect, it, vi } from "vitest";
import {
  executeDiscoveryMaintenanceWindow,
  prepareDiscoveryMaintenanceStartup,
  runDiscoveryMaintenanceLoop,
} from "./discovery-maintenance-cli";
import type { DiscoveryMaintenanceDecision } from "./discovery-maintenance";
import type { MaintenanceLifecycleDiagnostics } from "./maintenance-diagnostics";

describe("discovery maintenance startup", () => {
  it("confirms provisional keep-awake before retrying PostgreSQL", async () => {
    const events: string[] = [];
    let clock = Date.parse("2026-09-08T15:50:00.000Z");
    let probes = 0;
    const release = vi.fn(() => Promise.resolve());
    const updateStartupRecoveryWake = vi.fn(() => Promise.resolve());
    const result = await prepareDiscoveryMaintenanceStartup({
      acquirePower: (_runtime, context) => {
        events.push(`acquire:${context.phase}:${context.reason}`);
        return {
          confirmActivation: () => {
            events.push("keep-awake-active");
            return Promise.resolve(null);
          },
          release,
        };
      },
      close: () => Promise.resolve(),
      inspectDocker: () => Promise.resolve("running"),
      lifecycle: lifecycle(),
      loadConfiguration: () => {
        events.push("configuration");
        return { databaseUrl: "hidden" };
      },
      maximumRuntimeMs: 4 * 60 * 60_000,
      now: () => new Date(clock),
      open: () => {
        events.push("database-open");
        return { id: probes + 1 };
      },
      probe: () => {
        probes += 1;
        events.push(`database-probe-${probes}`);
        return probes < 4
          ? Promise.reject(Object.assign(new Error("offline"), { code: "ECONNREFUSED" }))
          : Promise.resolve();
      },
      readinessTimeoutMs: 10 * 60_000,
      retryIntervalMs: 10_000,
      runId: "wake-startup",
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      updateStartupRecoveryWake,
    });
    expect(events.slice(0, 4)).toEqual([
      "acquire:dependency_readiness:startup_readiness",
      "keep-awake-active",
      "configuration",
      "database-open",
    ]);
    expect(probes).toBe(4);
    expect(result.connection).toEqual({ id: 4 });
    expect(updateStartupRecoveryWake).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("schedules one startup recovery wake and releases power after readiness timeout", async () => {
    let clock = Date.parse("2026-09-08T15:50:00.000Z");
    const release = vi.fn(() => Promise.resolve());
    const updateStartupRecoveryWake = vi.fn(() => Promise.resolve());
    await expect(
      prepareDiscoveryMaintenanceStartup({
        acquirePower: () => ({ confirmActivation: () => Promise.resolve(null), release }),
        close: () => Promise.resolve(),
        inspectDocker: () => Promise.resolve("unavailable"),
        lifecycle: lifecycle(),
        loadConfiguration: () => ({ databaseUrl: "hidden" }),
        maximumRuntimeMs: 4 * 60 * 60_000,
        now: () => new Date(clock),
        open: () => ({}),
        probe: () => Promise.reject(Object.assign(new Error("offline"), { code: "ECONNREFUSED" })),
        readinessTimeoutMs: 30_000,
        retryIntervalMs: 10_000,
        runId: "wake-timeout",
        sleep: (milliseconds) => {
          clock += milliseconds;
          return Promise.resolve();
        },
        updateStartupRecoveryWake,
      }),
    ).rejects.toThrow("PostgreSQL was not ready");
    expect(updateStartupRecoveryWake).toHaveBeenCalledTimes(1);
    expect(updateStartupRecoveryWake).toHaveBeenCalledWith(new Date("2026-09-08T15:57:30.000Z"));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("arms startup recovery before failing when helper activation is not confirmed", async () => {
    const release = vi.fn(() => Promise.resolve());
    const loadConfiguration = vi.fn(() => ({ databaseUrl: "hidden" }));
    const updateStartupRecoveryWake = vi.fn(() => Promise.resolve());
    await expect(
      prepareDiscoveryMaintenanceStartup({
        acquirePower: () => ({
          confirmActivation: () => Promise.reject(new Error("activation failed")),
          release,
        }),
        close: () => Promise.resolve(),
        inspectDocker: () => Promise.resolve("not_inspectable"),
        lifecycle: lifecycle(),
        loadConfiguration,
        maximumRuntimeMs: 4 * 60 * 60_000,
        now: () => new Date("2026-09-08T15:50:00.000Z"),
        open: () => ({}),
        probe: () => Promise.resolve(),
        readinessTimeoutMs: 30_000,
        retryIntervalMs: 10_000,
        runId: "activation-failure",
        sleep: () => Promise.resolve(),
        updateStartupRecoveryWake,
      }),
    ).rejects.toThrow("activation failed");
    expect(loadConfiguration).not.toHaveBeenCalled();
    expect(updateStartupRecoveryWake).toHaveBeenCalledOnce();
    expect(updateStartupRecoveryWake).toHaveBeenCalledWith(new Date("2026-09-08T15:57:00.000Z"));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("arms startup recovery even when the keep-awake helper cannot be acquired", async () => {
    const updateStartupRecoveryWake = vi.fn(() => Promise.resolve());

    await expect(
      prepareDiscoveryMaintenanceStartup({
        acquirePower: () => {
          throw new Error("keep-awake owner unavailable");
        },
        close: () => Promise.resolve(),
        inspectDocker: () => Promise.resolve("not_inspectable"),
        lifecycle: lifecycle(),
        loadConfiguration: () => ({ databaseUrl: "hidden" }),
        maximumRuntimeMs: 4 * 60 * 60_000,
        now: () => new Date("2026-09-12T23:00:00.000Z"),
        open: () => ({}),
        probe: () => Promise.resolve(),
        readinessTimeoutMs: 30_000,
        retryIntervalMs: 10_000,
        runId: "acquisition-failure",
        sleep: () => Promise.resolve(),
        updateStartupRecoveryWake,
      }),
    ).rejects.toThrow("keep-awake owner unavailable");
    expect(updateStartupRecoveryWake).toHaveBeenCalledOnce();
    expect(updateStartupRecoveryWake).toHaveBeenCalledWith(new Date("2026-09-12T23:07:00.000Z"));
  });
});

describe("discovery maintenance window lifecycle", () => {
  it("keeps PostgreSQL open until the maintenance loop resolves and closes it afterward", async () => {
    const events: string[] = [];
    const connection = { closed: false };
    let resolveLoop!: (result: { ticks: number }) => void;
    const loopResult = new Promise<{ ticks: number }>((resolve) => {
      resolveLoop = resolve;
    });
    const close = vi.fn((candidate: typeof connection) => {
      candidate.closed = true;
      events.push("database-closed");
      return Promise.resolve();
    });
    const runLoop = vi.fn(async () => {
      events.push("loop-started");
      expect(connection.closed).toBe(false);
      const result = await loopResult;
      expect(connection.closed).toBe(false);
      events.push("loop-resolved");
      return result;
    });
    const updateStartupRecoveryWake = vi.fn(() => Promise.resolve());

    const resultPromise = executeDiscoveryMaintenanceWindow({
      close,
      hardTerminationRecoveryAt: new Date("2026-09-12T07:51:00.000Z"),
      lifecycle: lifecycle(),
      now: () => new Date("2026-09-12T03:50:00.000Z"),
      prepare: () =>
        Promise.resolve({
          configuration: { schedulerEnabled: true },
          connection,
          powerRequest: { release: () => Promise.resolve() },
        }),
      runLoop,
      updateStartupRecoveryWake,
    });

    await vi.waitFor(() => expect(runLoop).toHaveBeenCalledOnce());
    expect(updateStartupRecoveryWake).toHaveBeenCalledOnce();
    expect(updateStartupRecoveryWake).toHaveBeenCalledWith(new Date("2026-09-12T07:51:00.000Z"));
    expect(close).not.toHaveBeenCalled();
    expect(connection.closed).toBe(false);

    resolveLoop({ ticks: 2 });
    await expect(resultPromise).resolves.toEqual({ ticks: 2 });
    expect(close).toHaveBeenCalledOnce();
    expect(events).toEqual(["loop-started", "loop-resolved", "database-closed"]);
  });

  it("overwrites the hard-termination deadman when the running loop fails", async () => {
    const events: string[] = [];
    const observedAt = new Date("2026-09-12T03:51:00.000Z");
    const close = vi.fn(() => {
      events.push("database-closed");
      return Promise.resolve();
    });
    const release = vi.fn(() => {
      events.push("power-released");
      return Promise.resolve();
    });
    const updateStartupRecoveryWake = vi.fn(() => {
      events.push("recovery-scheduled");
      return Promise.resolve();
    });
    const startupRecoveryWake = vi.fn();
    const diagnostics = { ...lifecycle(), startupRecoveryWake };

    await expect(
      executeDiscoveryMaintenanceWindow({
        close,
        hardTerminationRecoveryAt: new Date("2026-09-12T07:51:00.000Z"),
        lifecycle: diagnostics,
        now: () => observedAt,
        prepare: () =>
          Promise.resolve({
            configuration: {},
            connection: { id: "production" },
            powerRequest: { release },
          }),
        runLoop: () => Promise.reject(new Error("Synthetic runtime failure")),
        updateStartupRecoveryWake,
      }),
    ).rejects.toThrow("Synthetic runtime failure");

    const scheduledFor = new Date("2026-09-12T03:58:00.000Z");
    expect(updateStartupRecoveryWake).toHaveBeenCalledTimes(2);
    expect(updateStartupRecoveryWake).toHaveBeenNthCalledWith(
      1,
      new Date("2026-09-12T07:51:00.000Z"),
    );
    expect(updateStartupRecoveryWake).toHaveBeenNthCalledWith(2, scheduledFor);
    expect(startupRecoveryWake).toHaveBeenLastCalledWith({
      observedAt,
      scheduledFor,
      state: "scheduled",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(events).toEqual([
      "recovery-scheduled",
      "recovery-scheduled",
      "power-released",
      "database-closed",
    ]);
  });
});

describe("discovery maintenance loop", () => {
  it("exits without a power request or scheduler tick when no work is due", async () => {
    const acquirePower = vi.fn();
    const runTick = vi.fn();
    const updateWake = vi.fn(() => Promise.resolve());
    const result = await runDiscoveryMaintenanceLoop({
      acquirePower,
      maximumRuntimeMs: 60_000,
      now: () => new Date("2026-08-27T20:00:00.000Z"),
      observe: () => Promise.resolve(decision("no_work", false, false)),
      runTick,
      sleep: () => Promise.resolve(),
      updateWake,
    });
    expect(result).toMatchObject({ finalReason: "no_work", ticks: 0 });
    expect(acquirePower).not.toHaveBeenCalled();
    expect(runTick).not.toHaveBeenCalled();
    expect(updateWake).toHaveBeenCalledWith(null);
  });

  it("releases the power request after eligible work drains", async () => {
    const release = vi.fn(() => Promise.resolve());
    const confirmActivation = vi.fn(() => Promise.resolve(null));
    const updateContext = vi.fn();
    const acquirePower = vi.fn(() => ({ confirmActivation, release, updateContext }));
    const decisions = [decision("priority_work", true, true), decision("no_work", false, false)];
    let clock = Date.parse("2026-08-27T20:00:00.000Z");
    const runTick = vi.fn(() => Promise.resolve());
    const updateStartupRecoveryWake = vi.fn(() => Promise.resolve());
    const result = await runDiscoveryMaintenanceLoop({
      acquirePower,
      maximumRuntimeMs: 21 * 60_000,
      now: () => new Date(clock),
      observe: () => Promise.resolve(decisions.shift()!),
      runTick,
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      updateStartupRecoveryWake,
      updateWake: () => Promise.resolve(),
      runId: "priority-run",
    });
    expect(result).toMatchObject({ finalReason: "no_work", ticks: 1 });
    expect(runTick).toHaveBeenCalledTimes(1);
    expect(acquirePower).toHaveBeenCalledWith(21 * 60_000, {
      phase: "due_work",
      reason: "priority_work",
      runId: "priority-run",
    });
    expect(updateContext).toHaveBeenCalledWith({
      phase: "due_work",
      reason: "priority_work",
      runId: "priority-run",
    });
    expect(confirmActivation).toHaveBeenCalled();
    expect(updateStartupRecoveryWake).toHaveBeenCalledOnce();
    expect(updateStartupRecoveryWake).toHaveBeenCalledWith(null);
    expect(runTick).toHaveBeenCalledWith({
      reason: "priority_work",
      deadlineAt: new Date("2026-08-27T20:21:00.000Z"),
      remainingRuntimeMs: 21 * 60_000,
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("keeps sub-minute capacity waits under the active owner without trigger churn", async () => {
    const release = vi.fn(() => Promise.resolve());
    const acquirePower = vi.fn(() => ({ release }));
    const updateWake = vi.fn(() => Promise.resolve());
    let clock = Date.parse("2026-08-27T20:00:00.000Z");
    const waitUntil = new Date(clock + 30_000);
    const decisions: DiscoveryMaintenanceDecision[] = [
      {
        dynamicWakeAt: null,
        holdPower: true,
        reason: "priority_capacity_wait",
        runNow: false,
        waitUntil,
      },
      decision("no_work", false, false),
    ];
    await runDiscoveryMaintenanceLoop({
      acquirePower,
      maximumRuntimeMs: 60_000,
      now: () => new Date(clock),
      observe: () => Promise.resolve(decisions.shift()!),
      runId: "capacity-wait-run",
      runTick: () => Promise.resolve(),
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      updateWake,
    });
    expect(acquirePower).toHaveBeenCalledWith(60_000, {
      phase: "near_term_capacity_wait",
      reason: "priority_capacity_wait",
      runId: "capacity-wait-run",
    });
    expect(updateWake).toHaveBeenCalledOnce();
    expect(updateWake).toHaveBeenCalledWith(null);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("clears an armed boundary wake after a meaningful wait drains cleanly", async () => {
    const release = vi.fn(() => Promise.resolve());
    const updateWake = vi.fn(() => Promise.resolve());
    let clock = Date.parse("2026-08-27T20:00:00.000Z");
    const waitUntil = new Date(clock + 10 * 60_000);
    const decisions: DiscoveryMaintenanceDecision[] = [
      {
        dynamicWakeAt: null,
        holdPower: true,
        reason: "priority_capacity_wait",
        runNow: false,
        waitUntil,
      },
      decision("no_work", false, false),
    ];

    await runDiscoveryMaintenanceLoop({
      acquirePower: () => ({ release }),
      maximumRuntimeMs: 15 * 60_000,
      now: () => new Date(clock),
      observe: () => Promise.resolve(decisions.shift()!),
      runId: "clean-boundary-fallback-run",
      runTick: () => Promise.resolve(),
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      updateWake,
    });

    expect(updateWake).toHaveBeenNthCalledWith(1, waitUntil);
    expect(updateWake).toHaveBeenNthCalledWith(2, null);
    expect(release).toHaveBeenCalledOnce();
  });

  it("arms a boundary wake before entering a near-term wait", async () => {
    const release = vi.fn(() => Promise.resolve());
    const waitUntil = new Date("2026-08-27T20:10:00.000Z");
    const events: string[] = [];
    const updateWake = vi.fn((wakeAt: Date | null) => {
      events.push(`wake:${wakeAt?.toISOString() ?? "cleared"}`);
      return Promise.resolve();
    });

    await expect(
      runDiscoveryMaintenanceLoop({
        acquirePower: () => ({ release }),
        maximumRuntimeMs: 15 * 60_000,
        now: () => new Date("2026-08-27T20:00:00.000Z"),
        observe: () =>
          Promise.resolve({
            dynamicWakeAt: null,
            holdPower: true,
            reason: "priority_capacity_wait",
            runNow: false,
            waitUntil,
          }),
        runId: "boundary-fallback-run",
        runTick: () => Promise.resolve(),
        sleep: () => {
          events.push("wait-started");
          return Promise.reject(new Error("Synthetic wait interruption"));
        },
        updateWake,
      }),
    ).rejects.toThrow("Synthetic wait interruption");

    expect(events).toEqual([`wake:${waitUntil.toISOString()}`, "wait-started"]);
    expect(updateWake).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses the shared keep-awake owner for a near-term broad capacity wait", async () => {
    const release = vi.fn(() => Promise.resolve());
    const acquirePower = vi.fn(() => ({ release }));
    let clock = Date.parse("2026-08-29T16:00:00.000Z");
    const decisions: DiscoveryMaintenanceDecision[] = [
      {
        dynamicWakeAt: null,
        holdPower: true,
        reason: "broad_capacity_wait",
        runNow: false,
        waitUntil: new Date(clock + 30_000),
      },
      decision("no_work", false, false),
    ];
    await runDiscoveryMaintenanceLoop({
      acquirePower,
      maximumRuntimeMs: 60_000,
      now: () => new Date(clock),
      observe: () => Promise.resolve(decisions.shift()!),
      runId: "broad-capacity-run",
      runTick: () => Promise.resolve(),
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      updateWake: () => Promise.resolve(),
    });
    expect(acquirePower).toHaveBeenCalledWith(60_000, {
      phase: "near_term_capacity_wait",
      reason: "broad_capacity_wait",
      runId: "broad-capacity-run",
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("stops at the absolute runtime deadline and releases power", async () => {
    const release = vi.fn(() => Promise.resolve());
    const acquirePower = vi.fn(() => ({ release }));
    let clock = Date.parse("2026-08-27T20:00:00.000Z");
    const runTick = vi.fn(() => Promise.resolve());
    const updateStartupRecoveryWake = vi.fn(() => Promise.resolve());
    const result = await runDiscoveryMaintenanceLoop({
      acquirePower,
      maximumRuntimeMs: 20 * 60_000 + 2_500,
      now: () => new Date(clock),
      observe: () => Promise.resolve(decision("broad_work", true, true)),
      runTick,
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      updateWake: () => Promise.resolve(),
      updateStartupRecoveryWake,
    });
    expect(result.ticks).toBe(3);
    expect(result.finalReason).toBe("runtime_yield");
    expect(acquirePower).toHaveBeenCalledTimes(1);
    expect(updateStartupRecoveryWake).toHaveBeenCalledOnce();
    expect(updateStartupRecoveryWake).toHaveBeenCalledWith(new Date("2026-08-27T20:07:03.000Z"));
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("yields a due Apple workflow instead of starting it with too little runtime", async () => {
    const now = new Date("2026-09-12T23:00:00.000Z");
    const release = vi.fn(() => Promise.resolve());
    const runTick = vi.fn(() => Promise.resolve());
    const updateStartupRecoveryWake = vi.fn(() => Promise.resolve());

    await expect(
      runDiscoveryMaintenanceLoop({
        acquirePower: () => ({ release }),
        maximumRuntimeMs: 10 * 60_000,
        now: () => now,
        observe: () => Promise.resolve(decision("apple_due", true, true)),
        runTick,
        sleep: () => Promise.resolve(),
        updateStartupRecoveryWake,
        updateWake: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({ finalReason: "runtime_yield", ticks: 0 });
    expect(runTick).not.toHaveBeenCalled();
    expect(updateStartupRecoveryWake).toHaveBeenCalledOnce();
    expect(updateStartupRecoveryWake).toHaveBeenCalledWith(new Date("2026-09-12T23:07:00.000Z"));
    expect(release).toHaveBeenCalledOnce();
  });

  it("yields playlist work before its capacity wait could cross the task deadline", async () => {
    const now = new Date("2026-09-12T23:00:00.000Z");
    const release = vi.fn(() => Promise.resolve());
    const runTick = vi.fn(() => Promise.resolve());
    const updateStartupRecoveryWake = vi.fn(() => Promise.resolve());

    await expect(
      runDiscoveryMaintenanceLoop({
        acquirePower: () => ({ release }),
        maximumRuntimeMs: 19 * 60_000,
        now: () => now,
        observe: () => Promise.resolve(decision("playlist_work", true, true)),
        runTick,
        sleep: () => Promise.resolve(),
        updateStartupRecoveryWake,
        updateWake: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({ finalReason: "runtime_yield", ticks: 0 });
    expect(runTick).not.toHaveBeenCalled();
    expect(updateStartupRecoveryWake).toHaveBeenCalledOnce();
    expect(updateStartupRecoveryWake).toHaveBeenCalledWith(new Date("2026-09-12T23:07:00.000Z"));
    expect(release).toHaveBeenCalledOnce();
  });

  it("re-observes expected live-owner contention instead of failing maintenance", async () => {
    const release = vi.fn(() => Promise.resolve());
    const decisions = [decision("playlist_work", true, true), decision("no_work", false, false)];
    let clock = Date.parse("2026-09-12T23:00:00.000Z");
    const runTick = vi.fn(() =>
      Promise.reject(new Error("Operation spotify:playlist-export is already running.")),
    );

    await expect(
      runDiscoveryMaintenanceLoop({
        acquirePower: () => ({ release }),
        maximumRuntimeMs: 21 * 60_000,
        now: () => new Date(clock),
        observe: () => Promise.resolve(decisions.shift()!),
        runTick,
        sleep: (milliseconds) => {
          clock += milliseconds;
          return Promise.resolve();
        },
        updateWake: () => Promise.resolve(),
      }),
    ).resolves.toMatchObject({ finalReason: "no_work", ticks: 0 });
    expect(runTick).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases power when a scheduler tick fails", async () => {
    const release = vi.fn(() => Promise.resolve());
    await expect(
      runDiscoveryMaintenanceLoop({
        acquirePower: () => ({ release }),
        maximumRuntimeMs: 21 * 60_000,
        now: () => new Date("2026-08-27T20:00:00.000Z"),
        observe: () => Promise.resolve(decision("priority_work", true, true)),
        runTick: () => Promise.reject(new Error("Synthetic tick failure")),
        sleep: () => Promise.resolve(),
        updateWake: () => Promise.resolve(),
      }),
    ).rejects.toThrow("Synthetic tick failure");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("fails before waiting or running work when keep-awake activation is not confirmed", async () => {
    const release = vi.fn(() => Promise.resolve());
    const runTick = vi.fn();
    const sleep = vi.fn(() => Promise.resolve());
    const updateWake = vi.fn(() => Promise.resolve());
    await expect(
      runDiscoveryMaintenanceLoop({
        acquirePower: () => ({
          confirmActivation: () => Promise.reject(new Error("activation failed")),
          release,
        }),
        maximumRuntimeMs: 60_000,
        now: () => new Date("2026-08-28T03:50:00.000Z"),
        observe: () =>
          Promise.resolve({
            dynamicWakeAt: null,
            holdPower: true,
            reason: "apple_due_soon",
            runNow: false,
            waitUntil: new Date("2026-08-28T04:00:00.000Z"),
          }),
        runTick,
        sleep,
        updateWake,
      }),
    ).rejects.toThrow("activation failed");
    expect(runTick).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(updateWake).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});

function decision(
  reason: DiscoveryMaintenanceDecision["reason"],
  holdPower: boolean,
  runNow: boolean,
): DiscoveryMaintenanceDecision {
  return { dynamicWakeAt: null, holdPower, reason, runNow, waitUntil: null };
}

function lifecycle(): MaintenanceLifecycleDiagnostics {
  return {
    decision: vi.fn(),
    finish: vi.fn(),
    keepAwake: vi.fn(),
    readiness: vi.fn(),
    startupRecoveryWake: vi.fn(),
  };
}
