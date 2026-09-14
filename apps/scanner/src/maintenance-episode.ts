import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { maintenanceMaximumRuntimeMs, maintenanceNearTermWaitMs } from "./discovery-maintenance";

export const maintenanceMaximumRecoveryLaunches = 2;

const launchSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  startedAt: z.string().datetime(),
  deadlineAt: z.string().datetime(),
  ownerPid: z.number().int().positive(),
});
const waitSchema = z.object({ milliseconds: z.number().int().positive() });

export interface MaintenanceEpisodeStatus {
  episodeId: string;
  scheduledFor: string;
  deadlineAt: string;
  nextFixedWakeAt: string;
  launches: number;
  recoveryLaunches: number;
  capacityWaitMs: number;
  holdMs: number;
  allowed: boolean;
  reason: "available" | "deadline" | "launch_limit" | "active_owner";
}

/** Fixed Pacific boundaries, including daylight saving changes. Never anchored to a retry. */
export function maintenanceFixedWindow(now: Date): { previous: Date; next: Date } {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid maintenance clock.");
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const hour = new Date(now);
  hour.setUTCMinutes(50, 0, 0);
  const windows: Date[] = [];
  for (let offset = -48; offset <= 48; offset += 1) {
    const candidate = new Date(hour.getTime() + offset * 3_600_000);
    const parts = formatter.formatToParts(candidate);
    const day = parts.find((part) => part.type === "weekday")?.value;
    const localHour = parts.find((part) => part.type === "hour")?.value;
    if (localHour === "20" || (localHour === "08" && day !== "Thu")) windows.push(candidate);
  }
  const previous = windows.filter((time) => time <= now).at(-1);
  const next = windows.find((time) => time > now);
  if (!previous || !next) throw new Error("Cannot determine fixed maintenance window.");
  return { previous, next };
}

export function maintenanceEpisodeDirectory(): string {
  if (!process.env.LOCALAPPDATA)
    throw new Error("LOCALAPPDATA is required for maintenance episodes.");
  return join(process.env.LOCALAPPDATA, "TSNewMusicRadar", "runtime", "maintenance-episodes");
}

function episodePaths(directory: string, now: Date) {
  const { previous, next } = maintenanceFixedWindow(now);
  const episodeId = previous.toISOString().replaceAll(/[:.]/g, "-");
  return { directory: join(directory, episodeId), episodeId, previous, next };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

/** Append-only reservations survive process death and cannot be reset by the coordinator. */
export function inspectMaintenanceEpisode(
  now = new Date(),
  options: { directory?: string; processAlive?: (pid: number) => boolean } = {},
): MaintenanceEpisodeStatus {
  const paths = episodePaths(options.directory ?? maintenanceEpisodeDirectory(), now);
  const deadline = new Date(paths.previous.getTime() + maintenanceMaximumRuntimeMs);
  const files = existsSync(paths.directory) ? readdirSync(paths.directory) : [];
  const launchFiles = files.filter((name) => /^launch-[012]\.json$/.test(name));
  let holdMs = 0;
  let active = false;
  for (const name of launchFiles) {
    const launch = launchSchema.parse(
      JSON.parse(readFileSync(join(paths.directory, name), "utf8")),
    );
    const finishPath = join(paths.directory, name.replace("launch-", "finish-"));
    const finish = existsSync(finishPath)
      ? z
          .object({ finishedAt: z.string().datetime() })
          .parse(JSON.parse(readFileSync(finishPath, "utf8")))
      : null;
    if (!finish && (options.processAlive ?? processAlive)(launch.ownerPid)) active = true;
    // Abnormal exits are conservatively charged through observation, bounded by the episode.
    const end = Math.min(new Date(finish?.finishedAt ?? now).getTime(), deadline.getTime());
    holdMs += Math.max(0, end - new Date(launch.startedAt).getTime());
  }
  let capacityWaitMs = 0;
  for (const name of files.filter((file) => file.startsWith("wait-") && file.endsWith(".json"))) {
    capacityWaitMs += waitSchema.parse(
      JSON.parse(readFileSync(join(paths.directory, name), "utf8")),
    ).milliseconds;
  }
  const reason =
    now >= deadline
      ? "deadline"
      : active
        ? "active_owner"
        : launchFiles.length >= 1 + maintenanceMaximumRecoveryLaunches
          ? "launch_limit"
          : "available";
  return {
    episodeId: paths.episodeId,
    scheduledFor: paths.previous.toISOString(),
    deadlineAt: deadline.toISOString(),
    nextFixedWakeAt: paths.next.toISOString(),
    launches: launchFiles.length,
    recoveryLaunches: Math.max(0, launchFiles.length - 1),
    capacityWaitMs,
    holdMs: Math.min(holdMs, maintenanceMaximumRuntimeMs),
    allowed: reason === "available",
    reason,
  };
}

export interface MaintenanceEpisode {
  deadlineAt: Date;
  status(): MaintenanceEpisodeStatus;
  reserveWait: (milliseconds: number) => void;
  finish(): void;
  recoveryWake(requestedAt: Date | null): Date | null;
}

export class MaintenanceEpisodeWaitLimitError extends Error {
  constructor() {
    super("Maintenance episode capacity-wait allowance exhausted.");
    this.name = "MaintenanceEpisodeWaitLimitError";
  }
}

export function claimMaintenanceEpisode(
  runId: string,
  options: {
    directory?: string;
    now?: () => Date;
    ownerPid?: number;
    processAlive?: (pid: number) => boolean;
  } = {},
): MaintenanceEpisode | null {
  const now = options.now ?? (() => new Date());
  const directory = options.directory ?? maintenanceEpisodeDirectory();
  const inspect = () =>
    inspectMaintenanceEpisode(now(), {
      directory,
      ...(options.processAlive ? { processAlive: options.processAlive } : {}),
    });
  const status = inspect();
  if (!status.allowed) return null;
  const paths = episodePaths(directory, now());
  mkdirSync(paths.directory, { recursive: true });
  const launchName = `launch-${status.launches}.json`;
  // A race loses this exact slot and must exit; it cannot consume a different recovery slot.
  try {
    durableExclusiveJson(join(paths.directory, launchName), {
      version: 1,
      runId,
      startedAt: now().toISOString(),
      deadlineAt: status.deadlineAt,
      ownerPid: options.ownerPid ?? process.pid,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return null;
    throw error;
  }
  const deadlineAt = new Date(status.deadlineAt);
  let finished = false;
  return {
    deadlineAt,
    status: inspect,
    reserveWait: (milliseconds) => {
      if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0)
        throw new Error("Invalid maintenance wait.");
      const current = inspect();
      if (
        finished ||
        now().getTime() + milliseconds > deadlineAt.getTime() ||
        current.capacityWaitMs + milliseconds > maintenanceNearTermWaitMs
      )
        throw new MaintenanceEpisodeWaitLimitError();
      // Reserve the full wait before sleeping. Interrupted reservations are never refunded.
      durableExclusiveJson(join(paths.directory, `wait-${randomUUID()}.json`), { milliseconds });
    },
    recoveryWake: (requestedAt) => {
      if (!requestedAt || requestedAt >= deadlineAt || requestedAt <= now()) return null;
      const current = inspect();
      return current.launches < 1 + maintenanceMaximumRecoveryLaunches ? requestedAt : null;
    },
    finish: () => {
      if (finished) return;
      durableExclusiveJson(join(paths.directory, launchName.replace("launch-", "finish-")), {
        finishedAt: now().toISOString(),
      });
      finished = true;
    },
  };
}

function durableExclusiveJson(path: string, value: unknown): void {
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
