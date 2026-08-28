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
    const decisions = [decision("priority_work", true, true), decision("no_work", false, false)];
    let clock = Date.parse("2026-08-27T20:00:00.000Z");
    const runTick = vi.fn(() => Promise.resolve());
    const result = await runDiscoveryMaintenanceLoop({
      acquirePower: () => ({ release }),
      maximumRuntimeMs: 60_000,
      now: () => new Date(clock),
      observe: () => Promise.resolve(decisions.shift()!),
      runTick,
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      updateWake: () => Promise.resolve(),
    });
    expect(result).toMatchObject({ finalReason: "no_work", ticks: 1 });
    expect(runTick).toHaveBeenCalledTimes(1);
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
});

function decision(
  reason: DiscoveryMaintenanceDecision["reason"],
  holdPower: boolean,
  runNow: boolean,
): DiscoveryMaintenanceDecision {
  return { dynamicWakeAt: null, holdPower, reason, runNow, waitUntil: null };
}
