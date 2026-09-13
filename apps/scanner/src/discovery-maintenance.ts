import type { AppleMusicOperationalStatus, SpotifySchedulerStatus } from "@radar/db";

export const maintenanceTaskName = "TS New Music Radar Maintenance Window";
export const maintenanceDynamicTriggerId = "DynamicCapacityWake";
export const maintenanceStartupRecoveryTriggerId = "StartupRecoveryWake";
export const maintenanceWakeLeadMs = 10 * 60_000;
export const maintenanceNearTermWaitMs = 15 * 60_000;
export const maintenanceTaskExecutionLimitMs = 4 * 60 * 60_000;
export const maintenanceShutdownGraceMs = 5 * 60_000;
export const maintenanceHardTerminationRecoveryDelayMs = maintenanceTaskExecutionLimitMs + 60_000;
export const maintenanceMaximumRuntimeMs =
  maintenanceTaskExecutionLimitMs - maintenanceShutdownGraceMs;
export const maintenanceMinimumAppleRuntimeMs = 15 * 60_000;
export const maintenanceMinimumProviderRuntimeMs =
  maintenanceNearTermWaitMs + maintenanceShutdownGraceMs;
export const maintenanceDatabaseReadinessTimeoutMs = 10 * 60_000;
export const maintenanceDatabaseRetryIntervalMs = 10_000;
export const maintenanceStartupRecoveryDelayMs = 7 * 60_000;

export interface DiscoveryMaintenanceSnapshot {
  apple: Pick<
    AppleMusicOperationalStatus,
    "cooldownActive" | "cooldownIndefinite" | "cooldownUntil" | "leaseActive" | "nextRequestAt"
  >;
  discovery: {
    actionable: MaintenanceAppleJob | null;
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
    | "broadNextRunnableAt"
    | "broadRunnableCount"
    | "broadRollingRequestNextCapacityAt"
    | "cooldownActive"
    | "cooldownUntil"
    | "dailyBudget"
    | "dueArtistCount"
    | "endpointBudget"
    | "priorityNextRunnableAt"
    | "priorityRollingRequestNextCapacityAt"
    | "priorityRunnableCount"
    | "priorityWorkCanRunWithoutArtistAlbums"
    | "rollingRequestNextCapacityAt"
  >;
}

export interface DiscoveryMaintenanceDecision {
  dynamicWakeAt: Date | null;
  holdPower: boolean;
  reason:
    | "apple_due"
    | "apple_due_soon"
    | "apple_active"
    | "apple_capacity_wait"
    | "broad_capacity_wait"
    | "broad_deferred_wait"
    | "broad_work"
    | "cooldown_wait"
    | "no_work"
    | "playlist_capacity_wait"
    | "playlist_work"
    | "priority_capacity_wait"
    | "priority_deferred_wait"
    | "priority_work";
  runNow: boolean;
  waitUntil: Date | null;
}

interface MaintenanceAppleJob {
  appleMusicBatchId?: string | null;
  nextRetryAt?: Date | null;
  recoveryDeadline: Date;
  scheduledFor: Date;
  status: string;
}

export function decideDiscoveryMaintenance(
  snapshot: DiscoveryMaintenanceSnapshot,
  now = new Date(),
): DiscoveryMaintenanceDecision {
  const appleJobs = [
    snapshot.discovery.actionable,
    snapshot.discovery.full.latest,
    snapshot.discovery.catchup.latest,
  ].filter((job): job is MaintenanceAppleJob => job !== null);
  const dueApple = appleJobs.find(
    (job) =>
      job.status === "scheduled" &&
      job.scheduledFor <= now &&
      (job.recoveryDeadline >= now || Boolean(job.appleMusicBatchId)),
  );
  const activeApple = appleJobs.find((job) => job.status === "leased" && job.scheduledFor <= now);

  const nextApple = [snapshot.discovery.full.next, snapshot.discovery.catchup.next]
    .filter((job): job is MaintenanceAppleJob => job !== null && job.status === "scheduled")
    .sort((left, right) => left.scheduledFor.getTime() - right.scheduledFor.getTime())[0];
  const playlistDue =
    snapshot.discovery.phase === "playlist_inbox" &&
    ["ready", "exporting", "partial", "failed"].includes(snapshot.discovery.playlistInbox.status);
  const priorityDue = snapshot.spotify.priorityRunnableCount > 0;
  const blockedWork = playlistDue || priorityDue;

  if (
    playlistDue &&
    !snapshot.spotify.cooldownActive &&
    snapshot.spotify.rollingRequestNextCapacityAt === null
  ) {
    return runDecision("playlist_work");
  }
  if (activeApple) {
    return {
      dynamicWakeAt: null,
      holdPower: true,
      reason: "apple_active",
      runNow: false,
      waitUntil: new Date(now.getTime() + 60_000),
    };
  }
  if (dueApple) {
    if (snapshot.apple.cooldownIndefinite) {
      return blockedDecision("apple_capacity_wait", null, now);
    }
    const retryAt =
      dueApple.nextRetryAt && dueApple.nextRetryAt > now ? dueApple.nextRetryAt : null;
    const appleCapacityAt = latestCapacityAt(
      snapshot.apple.cooldownActive ? snapshot.apple.cooldownUntil : null,
      retryAt,
    );
    if (snapshot.apple.cooldownActive && !appleCapacityAt) {
      return blockedDecision("apple_capacity_wait", null, now);
    }
    if (appleCapacityAt) {
      return blockedDecision("apple_capacity_wait", appleCapacityAt, now);
    }
    if (snapshot.apple.leaseActive) {
      return blockedDecision(
        "apple_capacity_wait",
        new Date(Math.max(now.getTime() + 60_000, snapshot.apple.nextRequestAt?.getTime() ?? 0)),
        now,
      );
    }
    return runDecision("apple_due");
  }
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

  if (blockedWork && snapshot.spotify.cooldownActive) {
    return blockedDecision("cooldown_wait", snapshot.spotify.cooldownUntil, now);
  }
  if (playlistDue) {
    if (snapshot.spotify.rollingRequestNextCapacityAt) {
      return blockedDecision(
        "playlist_capacity_wait",
        snapshot.spotify.rollingRequestNextCapacityAt,
        now,
      );
    }
    return runDecision("playlist_work");
  }
  if (priorityDue) {
    const artistAlbumsCapacityAt =
      snapshot.spotify.endpointBudget.artistAlbums.priorityRemaining > 0 ||
      snapshot.spotify.priorityWorkCanRunWithoutArtistAlbums
        ? null
        : snapshot.spotify.endpointBudget.artistAlbums.nextCapacityAt;
    const priorityCapacityAt = latestCapacityAt(
      snapshot.spotify.priorityRollingRequestNextCapacityAt,
      artistAlbumsCapacityAt,
    );
    if (priorityCapacityAt) {
      return blockedDecision("priority_capacity_wait", priorityCapacityAt, now);
    }
    if (
      snapshot.spotify.endpointBudget.artistAlbums.priorityRemaining > 0 ||
      snapshot.spotify.priorityWorkCanRunWithoutArtistAlbums
    ) {
      return runDecision("priority_work");
    }
    return blockedDecision(
      "priority_capacity_wait",
      snapshot.spotify.endpointBudget.artistAlbums.nextCapacityAt,
      now,
    );
  }
  if (snapshot.spotify.priorityNextRunnableAt) {
    const nextRunnableAt = latestCapacityAt(
      snapshot.spotify.priorityNextRunnableAt,
      snapshot.spotify.cooldownActive ? snapshot.spotify.cooldownUntil : null,
    );
    return blockedDecision(
      snapshot.spotify.cooldownActive ? "cooldown_wait" : "priority_deferred_wait",
      nextRunnableAt,
      now,
    );
  }

  const broadAllowed = isBroadSpotifyDay(now);
  const broadBacklog = snapshot.spotify.broadRunnableCount > 0;
  const broadCapacity =
    snapshot.spotify.endpointBudget.artistAlbums.broadRemaining > 0 &&
    snapshot.spotify.broadRollingRequestNextCapacityAt === null &&
    snapshot.spotify.dailyBudget.broadArtistsUsed <
      snapshot.spotify.dailyBudget.broadArtistsLimit &&
    snapshot.spotify.dailyBudget.broadRequestsUsed <
      snapshot.spotify.dailyBudget.broadRequestsLimit;
  if (broadAllowed && broadBacklog && broadCapacity && !snapshot.spotify.cooldownActive) {
    return runDecision("broad_work");
  }
  if (broadAllowed && broadBacklog && snapshot.spotify.cooldownActive) {
    return blockedDecision("cooldown_wait", snapshot.spotify.cooldownUntil, now);
  }
  const broadDailyCapacity =
    snapshot.spotify.dailyBudget.broadArtistsUsed <
      snapshot.spotify.dailyBudget.broadArtistsLimit &&
    snapshot.spotify.dailyBudget.broadRequestsUsed <
      snapshot.spotify.dailyBudget.broadRequestsLimit;
  const broadArtistAlbumsBlocked =
    snapshot.spotify.endpointBudget.artistAlbums.broadRemaining === 0;
  const broadCapacityKnown =
    !broadArtistAlbumsBlocked ||
    snapshot.spotify.endpointBudget.artistAlbums.nextCapacityAt !== null;
  const broadCapacityAt = broadCapacityKnown
    ? latestCapacityAt(
        snapshot.spotify.broadRollingRequestNextCapacityAt,
        broadArtistAlbumsBlocked
          ? snapshot.spotify.endpointBudget.artistAlbums.nextCapacityAt
          : null,
      )
    : null;
  if (
    broadAllowed &&
    broadBacklog &&
    broadDailyCapacity &&
    !snapshot.spotify.cooldownActive &&
    broadCapacityAt !== null &&
    isBroadSpotifyDay(broadCapacityAt)
  ) {
    return blockedDecision("broad_capacity_wait", broadCapacityAt, now);
  }
  if (
    broadAllowed &&
    snapshot.spotify.broadNextRunnableAt &&
    isBroadSpotifyDay(snapshot.spotify.broadNextRunnableAt)
  ) {
    const nextRunnableAt = latestCapacityAt(
      snapshot.spotify.broadNextRunnableAt,
      snapshot.spotify.cooldownActive ? snapshot.spotify.cooldownUntil : broadCapacityAt,
    );
    return blockedDecision(
      snapshot.spotify.cooldownActive ? "cooldown_wait" : "broad_deferred_wait",
      nextRunnableAt,
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

function latestCapacityAt(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left > right ? left : right;
}

function blockedDecision(
  reason:
    | "apple_capacity_wait"
    | "broad_capacity_wait"
    | "broad_deferred_wait"
    | "cooldown_wait"
    | "playlist_capacity_wait"
    | "priority_capacity_wait"
    | "priority_deferred_wait",
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
