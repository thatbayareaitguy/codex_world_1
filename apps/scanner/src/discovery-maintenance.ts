import type { SpotifySchedulerStatus } from "@radar/db";

export const maintenanceTaskName = "TS New Music Radar Maintenance Window";
export const maintenanceDynamicTriggerId = "DynamicCapacityWake";
export const maintenanceWakeLeadMs = 10 * 60_000;
export const maintenanceNearTermWaitMs = 15 * 60_000;
export const maintenanceMaximumRuntimeMs = 4 * 60 * 60_000;

export interface DiscoveryMaintenanceSnapshot {
  discovery: {
    catchup: { latest: MaintenanceAppleJob | null; next: MaintenanceAppleJob | null };
    full: { latest: MaintenanceAppleJob | null; next: MaintenanceAppleJob | null };
    phase: string;
    playlistInbox: { pendingCount: number; status: string };
  };
  spotify: Pick<
    SpotifySchedulerStatus,
    | "appleCatchupPriorityCount"
    | "applePriorityCount"
    | "backlog"
    | "cooldownActive"
    | "cooldownUntil"
    | "dailyBudget"
    | "dueArtistCount"
    | "endpointBudget"
  >;
}

export interface DiscoveryMaintenanceDecision {
  dynamicWakeAt: Date | null;
  holdPower: boolean;
  reason:
    | "apple_due"
    | "apple_due_soon"
    | "broad_capacity_wait"
    | "broad_work"
    | "cooldown_wait"
    | "no_work"
    | "playlist_work"
    | "priority_capacity_wait"
    | "priority_work";
  runNow: boolean;
  waitUntil: Date | null;
}

interface MaintenanceAppleJob {
  recoveryDeadline: Date;
  scheduledFor: Date;
  status: string;
}

export function decideDiscoveryMaintenance(
  snapshot: DiscoveryMaintenanceSnapshot,
  now = new Date(),
): DiscoveryMaintenanceDecision {
  const appleJobs = [snapshot.discovery.full.latest, snapshot.discovery.catchup.latest].filter(
    (job): job is MaintenanceAppleJob => job !== null,
  );
  const dueApple = appleJobs.find(
    (job) => job.status === "scheduled" && job.scheduledFor <= now && job.recoveryDeadline >= now,
  );
  if (dueApple) return runDecision("apple_due");

  const nextApple = [snapshot.discovery.full.next, snapshot.discovery.catchup.next]
    .filter((job): job is MaintenanceAppleJob => job !== null && job.status === "scheduled")
    .sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime())[0];
  if (
    nextApple &&
    nextApple.scheduledFor > now &&
    nextApple.scheduledFor.getTime() - now.getTime() <= maintenanceNearTermWaitMs
  ) {
    return {
      dynamicWakeAt: null,
      holdPower: true,
      reason: "apple_due_soon",
      runNow: false,
      waitUntil: nextApple.scheduledFor,
    };
  }

  const playlistDue =
    snapshot.discovery.phase === "playlist_inbox" &&
    ["ready", "exporting", "partial", "failed"].includes(snapshot.discovery.playlistInbox.status);
  const priorityDue =
    snapshot.spotify.applePriorityCount + snapshot.spotify.appleCatchupPriorityCount > 0 ||
    ["apple_priority", "apple_catchup_priority", "cooldown_wait"].includes(
      snapshot.discovery.phase,
    );
  const blockedWork = playlistDue || priorityDue;

  if (blockedWork && snapshot.spotify.cooldownActive) {
    return blockedDecision("cooldown_wait", snapshot.spotify.cooldownUntil, now);
  }
  if (playlistDue) return runDecision("playlist_work");
  if (priorityDue) {
    if (snapshot.spotify.endpointBudget.artistAlbums.priorityRemaining > 0) {
      return runDecision("priority_work");
    }
    return blockedDecision(
      "priority_capacity_wait",
      snapshot.spotify.endpointBudget.artistAlbums.nextCapacityAt,
      now,
    );
  }

  const broadAllowed = isBroadSpotifyDay(now);
  const broadBacklog =
    snapshot.spotify.dueArtistCount > 0 ||
    snapshot.spotify.backlog.artist_reconciliation > 0 ||
    snapshot.spotify.backlog.release_detail > 0 ||
    snapshot.spotify.backlog.release_tracks > 0 ||
    snapshot.spotify.backlog.track_resolution > 0;
  const broadCapacity =
    snapshot.spotify.endpointBudget.artistAlbums.broadRemaining > 0 &&
    snapshot.spotify.dailyBudget.broadArtistsUsed <
      snapshot.spotify.dailyBudget.broadArtistsLimit &&
    snapshot.spotify.dailyBudget.broadRequestsUsed <
      snapshot.spotify.dailyBudget.broadRequestsLimit;
  if (broadAllowed && broadBacklog && broadCapacity && !snapshot.spotify.cooldownActive) {
    return runDecision("broad_work");
  }
  const broadDailyCapacity =
    snapshot.spotify.dailyBudget.broadArtistsUsed <
      snapshot.spotify.dailyBudget.broadArtistsLimit &&
    snapshot.spotify.dailyBudget.broadRequestsUsed <
      snapshot.spotify.dailyBudget.broadRequestsLimit;
  if (
    broadAllowed &&
    broadBacklog &&
    broadDailyCapacity &&
    !snapshot.spotify.cooldownActive &&
    snapshot.spotify.endpointBudget.artistAlbums.broadRemaining === 0 &&
    snapshot.spotify.endpointBudget.artistAlbums.nextCapacityAt !== null &&
    isBroadSpotifyDay(snapshot.spotify.endpointBudget.artistAlbums.nextCapacityAt)
  ) {
    return blockedDecision(
      "broad_capacity_wait",
      snapshot.spotify.endpointBudget.artistAlbums.nextCapacityAt,
      now,
    );
  }
  return {
    dynamicWakeAt: null,
    holdPower: false,
    reason: "no_work",
    runNow: false,
    waitUntil: null,
  };
}

function blockedDecision(
  reason: "broad_capacity_wait" | "cooldown_wait" | "priority_capacity_wait",
  nextRunnableAt: Date | null,
  now: Date,
): DiscoveryMaintenanceDecision {
  if (!nextRunnableAt) {
    return { dynamicWakeAt: null, holdPower: false, reason, runNow: false, waitUntil: null };
  }
  const waitMs = nextRunnableAt.getTime() - now.getTime();
  if (waitMs <= maintenanceNearTermWaitMs) {
    return {
      dynamicWakeAt: null,
      holdPower: true,
      reason,
      runNow: false,
      waitUntil: nextRunnableAt,
    };
  }
  return {
    dynamicWakeAt: new Date(
      Math.max(now.getTime() + 60_000, nextRunnableAt.getTime() - maintenanceWakeLeadMs),
    ),
    holdPower: false,
    reason,
    runNow: false,
    waitUntil: null,
  };
}

function runDecision(
  reason: "apple_due" | "broad_work" | "playlist_work" | "priority_work",
): DiscoveryMaintenanceDecision {
  return { dynamicWakeAt: null, holdPower: true, reason, runNow: true, waitUntil: null };
}

function isBroadSpotifyDay(now: Date): boolean {
  return [0, 1, 2, 3, 6].includes(pacificWeekday(now));
}

function pacificWeekday(now: Date): number {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(now);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short);
}
