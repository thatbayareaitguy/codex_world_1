import { hostname } from "node:os";
import type { SpotifyClient } from "@radar/providers";
import { providerExecutionSignal } from "@radar/providers";
import type { RadarDatabase } from "./client";
import {
  acquireOperationLock,
  heartbeatOperationLock,
  loadOperationLock,
  releaseOperationLock,
  type OperationLockHandle,
} from "./operations";

export const spotifyPlaylistWriterLockKey = "spotify:playlist-export";
export const spotifyPlaylistWriterFallbackTtlMs = 5 * 60_000;
export const spotifyPlaylistWriterLeaseMs = 2 * 60 * 60_000;
export const spotifyPlaylistWriterHeartbeatIntervalMs = 30_000;
export const spotifyPlaylistWriterHeartbeatObservationMs =
  spotifyPlaylistWriterHeartbeatIntervalMs + 5_000;

export type SpotifyPlaylistWriterProcessLiveness = "alive" | "dead" | "unknown";

export interface SpotifyPlaylistWriterLock extends OperationLockHandle {
  stopHeartbeat: () => void;
}

type SpotifyPlaylistMutationMethod =
  "addPlaylistItemsAtPosition" | "reorderPlaylistItems" | "setAuthorizedPlaylistPublic";

type SpotifyPlaylistMutationClient = Partial<Pick<SpotifyClient, SpotifyPlaylistMutationMethod>> &
  object;

export class SpotifyPlaylistWriterOwnershipError extends Error {
  constructor(message = "Spotify playlist writer ownership was lost before mutation.") {
    super(message);
    this.name = "SpotifyPlaylistWriterOwnershipError";
  }
}

export async function acquireSpotifyPlaylistWriterLock(
  db: RadarDatabase,
  input: {
    heartbeatIntervalMs?: number;
    inspectProcess?: (pid: number) => SpotifyPlaylistWriterProcessLiveness;
    metadata?: Record<string, unknown>;
    now?: Date;
    ownerHost?: string;
    ownerPid?: number;
    waitForHeartbeatObservation?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<SpotifyPlaylistWriterLock> {
  const now = input.now ?? new Date();
  const ownerHost = input.ownerHost ?? hostname();
  const ownerPid = input.ownerPid ?? process.pid;
  await recoverAbandonedSpotifyPlaylistWriterLock(db, {
    inspectProcess: input.inspectProcess ?? inspectLocalProcess,
    now,
    ownerHost,
    waitForHeartbeatObservation: input.waitForHeartbeatObservation ?? wait,
  });
  const handle = await acquireOperationLock(db, {
    lockKey: spotifyPlaylistWriterLockKey,
    metadata: {
      ...input.metadata,
      heartbeatAt: now.toISOString(),
      ownerHost,
      ownerPid,
      provider: "spotify",
    },
    operationType: "spotify_playlist_export",
    ttlMs: spotifyPlaylistWriterLeaseMs,
  });
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? spotifyPlaylistWriterHeartbeatIntervalMs;
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000) {
    await releaseOperationLock(db, handle);
    throw new Error("Spotify playlist writer heartbeat interval must be at least one second.");
  }
  const timer = setInterval(() => {
    void heartbeatOperationLock(db, handle, {}, spotifyPlaylistWriterLeaseMs).catch(
      () => undefined,
    );
  }, heartbeatIntervalMs);
  timer.unref();
  return {
    ...handle,
    stopHeartbeat: () => clearInterval(timer),
  };
}

export async function releaseSpotifyPlaylistWriterLock(
  db: RadarDatabase,
  lock: SpotifyPlaylistWriterLock,
  dependencies: { releaseLock?: typeof releaseOperationLock } = {},
): Promise<void> {
  lock.stopHeartbeat();
  const marked = await heartbeatOperationLock(
    db,
    lock,
    {
      releaseRequested: true,
      releaseRequestedAt: new Date().toISOString(),
    },
    spotifyPlaylistWriterFallbackTtlMs,
  );
  if (!marked) return;
  await (dependencies.releaseLock ?? releaseOperationLock)(db, lock);
}

export async function assertSpotifyPlaylistWriterLockOwnership(
  db: RadarDatabase,
  lock: OperationLockHandle,
  now = new Date(),
): Promise<void> {
  const existing = await loadOperationLock(db, lock.lockKey);
  providerExecutionSignal();
  const metadata = isRecord(existing?.metadata) ? existing.metadata : {};
  if (
    !existing ||
    existing.ownerToken !== lock.ownerToken ||
    existing.expiresAt <= now ||
    metadata.releaseRequested === true
  ) {
    throw new SpotifyPlaylistWriterOwnershipError();
  }
}

export function guardSpotifyPlaylistWriterClient<T extends SpotifyPlaylistMutationClient>(
  db: RadarDatabase,
  lock: OperationLockHandle,
  client: T,
): T {
  const mutationMethods = new Set<PropertyKey>([
    "addPlaylistItemsAtPosition",
    "reorderPlaylistItems",
    "setAuthorizedPlaylistPublic",
  ] satisfies SpotifyPlaylistMutationMethod[]);
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (!mutationMethods.has(property) || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await assertSpotifyPlaylistWriterLockOwnership(db, lock);
        return Reflect.apply(value as (...parameters: unknown[]) => unknown, target, args);
      };
    },
  });
}

async function recoverAbandonedSpotifyPlaylistWriterLock(
  db: RadarDatabase,
  input: {
    inspectProcess: (pid: number) => SpotifyPlaylistWriterProcessLiveness;
    now: Date;
    ownerHost: string;
    waitForHeartbeatObservation: (milliseconds: number) => Promise<void>;
  },
): Promise<void> {
  const existing = await loadOperationLock(db, spotifyPlaylistWriterLockKey);
  if (!existing) return;

  const metadata = isRecord(existing.metadata) ? existing.metadata : {};
  const recordedHost = typeof metadata.ownerHost === "string" ? metadata.ownerHost : null;
  const recordedPid =
    typeof metadata.ownerPid === "number" && Number.isInteger(metadata.ownerPid)
      ? metadata.ownerPid
      : null;
  const liveness =
    recordedHost === input.ownerHost && recordedPid !== null
      ? input.inspectProcess(recordedPid)
      : "unknown";
  const heartbeatAt = parseTimestamp(metadata.heartbeatAt) ?? existing.acquiredAt;
  const fallbackExpired =
    input.now.getTime() - heartbeatAt.getTime() >= spotifyPlaylistWriterFallbackTtlMs;

  if (metadata.releaseRequested === true || liveness === "dead") {
    await releaseOperationLock(db, existing);
    return;
  }
  if (!fallbackExpired) return;
  if (liveness === "unknown") {
    await releaseOperationLock(db, existing);
    return;
  }

  await input.waitForHeartbeatObservation(spotifyPlaylistWriterHeartbeatObservationMs);
  const observed = await loadOperationLock(db, spotifyPlaylistWriterLockKey);
  if (!observed || observed.ownerToken !== existing.ownerToken) return;
  const observedMetadata = isRecord(observed.metadata) ? observed.metadata : {};
  const observedHeartbeatAt = parseTimestamp(observedMetadata.heartbeatAt) ?? observed.acquiredAt;
  if (
    observedMetadata.releaseRequested !== true &&
    observedHeartbeatAt.getTime() > heartbeatAt.getTime()
  ) {
    return;
  }
  await releaseOperationLock(db, observed);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inspectLocalProcess(pid: number): SpotifyPlaylistWriterProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
