import { describe, expect, it, vi } from "vitest";
import { runDiscoveryMaintenanceLoop } from "./discovery-maintenance-cli";
import type { DiscoveryMaintenanceDecision } from "./discovery-maintenance";

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
    const result = await runDiscoveryMaintenanceLoop({
      acquirePower,
      maximumRuntimeMs: 60_000,
      now: () => new Date(clock),
      observe: () => Promise.resolve(decisions.shift()!),
      runTick,
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      updateWake: () => Promise.resolve(),
      runId: "priority-run",
    });
    expect(result).toMatchObject({ finalReason: "no_work", ticks: 1 });
    expect(runTick).toHaveBeenCalledTimes(1);
    expect(acquirePower).toHaveBeenCalledWith(60_000, {
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
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("holds power only for an explicitly bounded near-term wait", async () => {
    const release = vi.fn(() => Promise.resolve());
    const acquirePower = vi.fn(() => ({ release }));
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
      updateWake: () => Promise.resolve(),
    });
    expect(acquirePower).toHaveBeenCalledWith(60_000, {
      phase: "near_term_capacity_wait",
      reason: "priority_capacity_wait",
      runId: "capacity-wait-run",
    });
    expect(release).toHaveBeenCalledTimes(1);
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
    const result = await runDiscoveryMaintenanceLoop({
      acquirePower,
      maximumRuntimeMs: 2_500,
      now: () => new Date(clock),
      observe: () => Promise.resolve(decision("broad_work", true, true)),
      runTick,
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      updateWake: () => Promise.resolve(),
    });
    expect(result.ticks).toBe(3);
    expect(acquirePower).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases power when a scheduler tick fails", async () => {
    const release = vi.fn(() => Promise.resolve());
    await expect(
      runDiscoveryMaintenanceLoop({
        acquirePower: () => ({ release }),
        maximumRuntimeMs: 60_000,
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
