import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimMaintenanceEpisode,
  inspectMaintenanceEpisode,
  maintenanceFixedWindow,
} from "./maintenance-episode";

const directories: string[] = [];
function fixture(initial = "2026-09-11T03:50:00Z") {
  const directory = mkdtempSync(join(tmpdir(), "radar-episode-"));
  directories.push(directory);
  let clock = new Date(initial);
  const options = { directory, now: () => clock, processAlive: () => false };
  return {
    options,
    set: (date: string) => {
      clock = new Date(date);
    },
    status: () => inspectMaintenanceEpisode(clock, options),
  };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("fixed-window maintenance episodes", () => {
  it("preserves Thursday evening and both Friday wakes across Pacific DST changes", () => {
    expect(maintenanceFixedWindow(new Date("2026-09-10T17:00:00Z")).next.toISOString()).toBe(
      "2026-09-11T03:50:00.000Z",
    );
    expect(maintenanceFixedWindow(new Date("2026-09-11T04:00:00Z")).next.toISOString()).toBe(
      "2026-09-11T15:50:00.000Z",
    );
    expect(maintenanceFixedWindow(new Date("2026-09-11T16:00:00Z")).next.toISOString()).toBe(
      "2026-09-12T03:50:00.000Z",
    );
    expect(maintenanceFixedWindow(new Date("2026-11-01T16:00:00Z")).next.toISOString()).toBe(
      "2026-11-01T16:50:00.000Z",
    );
    expect(maintenanceFixedWindow(new Date("2026-03-08T15:00:00Z")).next.toISOString()).toBe(
      "2026-03-08T15:50:00.000Z",
    );
  });

  it("allows two recoveries total, including abnormal launches, without resetting the deadline", () => {
    const f = fixture();
    const first = claimMaintenanceEpisode("fixed", f.options)!;
    expect(first.deadlineAt.toISOString()).toBe("2026-09-11T07:45:00.000Z");
    first.reserveWait(600_000);
    // No finish marker: a process crash still consumes a launch and its wait reservation.
    f.set("2026-09-11T04:10:00Z");
    const second = claimMaintenanceEpisode("recovery-1", f.options)!;
    expect(second.deadlineAt).toEqual(first.deadlineAt);
    second.reserveWait(300_000);
    second.finish();
    f.set("2026-09-11T04:20:00Z");
    const third = claimMaintenanceEpisode("recovery-2", f.options)!;
    expect(() => third.reserveWait(1)).toThrow("capacity-wait allowance");
    expect(third.recoveryWake(new Date("2026-09-11T04:27:00Z"))).toBeNull();
    third.finish();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(claimMaintenanceEpisode(`coordinator-${attempt}`, f.options)).toBeNull();
    }
    expect(f.status()).toMatchObject({
      launches: 3,
      recoveryLaunches: 2,
      capacityWaitMs: 900_000,
      reason: "launch_limit",
    });
  });

  it("refuses after the original deadline even if no process has ever launched", () => {
    const f = fixture("2026-09-11T08:00:00Z");
    expect(claimMaintenanceEpisode("late-deadman", f.options)).toBeNull();
    expect(f.status()).toMatchObject({
      reason: "deadline",
      nextFixedWakeAt: "2026-09-11T15:50:00.000Z",
    });
    f.set("2026-09-11T15:50:00Z");
    expect(claimMaintenanceEpisode("friday", f.options)?.deadlineAt.toISOString()).toBe(
      "2026-09-11T19:45:00.000Z",
    );
  });

  it("never lets a duplicate live owner consume another recovery", () => {
    const f = fixture();
    const options = { ...f.options, processAlive: () => true };
    const first = claimMaintenanceEpisode("first", options)!;
    expect(claimMaintenanceEpisode("overlap", options)).toBeNull();
    expect(inspectMaintenanceEpisode(options.now(), options).launches).toBe(1);
    first.finish();
    expect(claimMaintenanceEpisode("released", options)).not.toBeNull();
  });

  it("rejects a wait or recovery crossing the original deadline", () => {
    const f = fixture("2026-09-11T07:44:00Z");
    const episode = claimMaintenanceEpisode("late", f.options)!;
    expect(() => episode.reserveWait(60_001)).toThrow("capacity-wait allowance");
    expect(episode.recoveryWake(new Date("2026-09-11T07:51:00Z"))).toBeNull();
    expect(f.status().capacityWaitMs).toBe(0);
  });
});
