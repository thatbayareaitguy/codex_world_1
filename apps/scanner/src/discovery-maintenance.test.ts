import { describe, expect, it } from "vitest";
import {
  decideDiscoveryMaintenance,
  maintenanceWakeLeadMs,
  type DiscoveryMaintenanceSnapshot,
} from "./discovery-maintenance";

describe("discovery maintenance decisions", () => {
  it("holds power for an Apple job due within ten minutes", () => {
    const now = new Date("2026-08-28T03:50:00.000Z");
    const snapshot = baseSnapshot();
    snapshot.discovery.full.next = {
      recoveryDeadline: new Date("2026-08-29T04:00:00.000Z"),
      scheduledFor: new Date("2026-08-28T04:00:00.000Z"),
      status: "scheduled",
    };
    expect(decideDiscoveryMaintenance(snapshot, now)).toMatchObject({
      holdPower: true,
      reason: "apple_due_soon",
      runNow: false,
      waitUntil: new Date("2026-08-28T04:00:00.000Z"),
    });
  });

  it("schedules one wake ten minutes before rolling capacity returns", () => {
    const now = new Date("2026-08-28T08:00:00.000Z");
    const nextCapacityAt = new Date("2026-08-28T09:30:00.000Z");
    const snapshot = baseSnapshot();
    snapshot.discovery.phase = "apple_priority";
    snapshot.spotify.applePriorityCount = 3;
    snapshot.spotify.endpointBudget.artistAlbums.priorityRemaining = 0;
    snapshot.spotify.endpointBudget.artistAlbums.nextCapacityAt = nextCapacityAt;
    const decision = decideDiscoveryMaintenance(snapshot, now);
    expect(decision.dynamicWakeAt?.getTime()).toBe(
      nextCapacityAt.getTime() - maintenanceWakeLeadMs,
    );
    expect(decision).toMatchObject({ holdPower: false, reason: "priority_capacity_wait" });
  });

  it("holds power only when known capacity is near", () => {
    const now = new Date("2026-08-28T09:10:00.000Z");
    const snapshot = baseSnapshot();
    snapshot.discovery.phase = "apple_priority";
    snapshot.spotify.applePriorityCount = 2;
    snapshot.spotify.endpointBudget.artistAlbums.priorityRemaining = 0;
    snapshot.spotify.endpointBudget.artistAlbums.nextCapacityAt = new Date(
      now.getTime() + 12 * 60_000,
    );
    expect(decideDiscoveryMaintenance(snapshot, now)).toMatchObject({
      dynamicWakeAt: null,
      holdPower: true,
      reason: "priority_capacity_wait",
      runNow: false,
    });
  });

  it("exits early when no due work or capacity exists", () => {
    expect(
      decideDiscoveryMaintenance(baseSnapshot(), new Date("2026-08-27T20:00:00.000Z")),
    ).toEqual({
      dynamicWakeAt: null,
      holdPower: false,
      reason: "no_work",
      runNow: false,
      waitUntil: null,
    });
  });

  it("keeps broad Spotify work out of Thursday and Friday priority windows", () => {
    const snapshot = baseSnapshot();
    snapshot.spotify.dueArtistCount = 10;
    expect(
      decideDiscoveryMaintenance(snapshot, new Date("2026-08-28T03:00:00.000Z")),
    ).toMatchObject({ reason: "no_work", runNow: false });
    expect(
      decideDiscoveryMaintenance(snapshot, new Date("2026-08-29T03:00:00.000Z")),
    ).toMatchObject({ reason: "no_work", runNow: false });
  });

  it("allows bounded broad work on Saturday", () => {
    const snapshot = baseSnapshot();
    snapshot.spotify.dueArtistCount = 10;
    expect(
      decideDiscoveryMaintenance(snapshot, new Date("2026-08-29T16:00:00.000Z")),
    ).toMatchObject({ holdPower: true, reason: "broad_work", runNow: true });
  });

  it("runs Apple priority before an otherwise eligible broad backlog", () => {
    const snapshot = baseSnapshot();
    snapshot.discovery.phase = "apple_priority";
    snapshot.spotify.applePriorityCount = 2;
    snapshot.spotify.dueArtistCount = 10;
    expect(
      decideDiscoveryMaintenance(snapshot, new Date("2026-08-29T16:00:00.000Z")),
    ).toMatchObject({ holdPower: true, reason: "priority_work", runNow: true });
  });

  it("never bypasses a priority cooldown and wakes ten minutes before it ends", () => {
    const now = new Date("2026-08-28T03:00:00.000Z");
    const cooldownUntil = new Date("2026-08-28T05:00:00.000Z");
    const snapshot = baseSnapshot();
    snapshot.discovery.phase = "apple_priority";
    snapshot.spotify.applePriorityCount = 2;
    snapshot.spotify.cooldownActive = true;
    snapshot.spotify.cooldownUntil = cooldownUntil;
    expect(decideDiscoveryMaintenance(snapshot, now)).toMatchObject({
      dynamicWakeAt: new Date(cooldownUntil.getTime() - maintenanceWakeLeadMs),
      holdPower: false,
      reason: "cooldown_wait",
      runNow: false,
    });
  });
});

function baseSnapshot(): DiscoveryMaintenanceSnapshot {
  return {
    discovery: {
      catchup: { latest: null, next: null },
      full: { latest: null, next: null },
      phase: "broad_spotify",
      playlistInbox: { pendingCount: 0, status: "completed" },
    },
    spotify: {
      appleCatchupPriorityCount: 0,
      applePriorityCount: 0,
      backlog: {
        artist_reconciliation: 0,
        base_artist: 0,
        release_detail: 0,
        release_tracks: 0,
        track_resolution: 0,
      },
      cooldownActive: false,
      cooldownUntil: null,
      dailyBudget: {
        broadArtistsLimit: 75,
        broadArtistsUsed: 0,
        broadRequestsLimit: 300,
        broadRequestsUsed: 0,
        localDate: "2026-08-27",
        playlistRequestReserve: 20,
        priorityRequestReserve: 200,
      },
      dueArtistCount: 0,
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
          reserveRemaining: 20,
          reserveReleased: false,
        },
        playlist: { reads: 0, writes: 0 },
      },
    },
  };
}
