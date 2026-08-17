import {
  acquireOperationLock,
  claimSpotifySchedulerWork,
  finishSpotifySchedulerWork,
  getSpotifyOperationalStatus,
  getSpotifySchedulerStatus,
  planSpotifySchedulerTick,
  reconcileSpotifySchedulerWork,
  recordSpotifySchedulerTick,
  releaseOperationLock,
  type RadarDatabase,
  type SpotifySchedulerClaim,
  type SpotifySchedulerLimits,
  type SpotifySchedulerStatus,
} from "@radar/db";
import type { SpotifyRequestGate } from "@radar/providers";

export class SpotifySchedulerRequestBudgetError extends Error {
  constructor(readonly maximum: number) {
    super(`Spotify scheduler request budget of ${maximum} was reached.`);
    this.name = "SpotifySchedulerRequestBudgetError";
  }
}

export class SpotifySchedulerRuntimeBudgetError extends Error {
  constructor() {
    super("Spotify scheduler runtime budget cannot safely fit another request.");
    this.name = "SpotifySchedulerRuntimeBudgetError";
  }
}

export interface SpotifySchedulerExecutionContext {
  deadlineAt: number;
  signal: AbortSignal;
  wrapRequestGate: (gate: SpotifyRequestGate) => SpotifyRequestGate;
}

export interface SpotifySchedulerExecutor {
  execute: (
    work: SpotifySchedulerClaim,
    context: SpotifySchedulerExecutionContext,
  ) => Promise<void>;
}

export interface SpotifySchedulerTickResult {
  mode: "plan" | "credential_free" | "production";
  reason: "planned" | "completed" | "no_work" | "capability_disabled" | "cooldown" | "failed";
  requestsStarted: number;
  selected: SpotifySchedulerClaim | null;
  status: SpotifySchedulerStatus;
}

interface SpotifySchedulerDependencies {
  acquireLock: typeof acquireOperationLock;
  claimWork: typeof claimSpotifySchedulerWork;
  finishWork: typeof finishSpotifySchedulerWork;
  getOperationalStatus: typeof getSpotifyOperationalStatus;
  getStatus: typeof getSpotifySchedulerStatus;
  planTick: typeof planSpotifySchedulerTick;
  reconcileWork: typeof reconcileSpotifySchedulerWork;
  recordTick: typeof recordSpotifySchedulerTick;
  releaseLock: typeof releaseOperationLock;
}

const productionDependencies: SpotifySchedulerDependencies = {
  acquireLock: acquireOperationLock,
  claimWork: claimSpotifySchedulerWork,
  finishWork: finishSpotifySchedulerWork,
  getOperationalStatus: getSpotifyOperationalStatus,
  getStatus: getSpotifySchedulerStatus,
  planTick: planSpotifySchedulerTick,
  reconcileWork: reconcileSpotifySchedulerWork,
  recordTick: recordSpotifySchedulerTick,
  releaseLock: releaseOperationLock,
};

export async function runSpotifySchedulerTick(
  db: RadarDatabase,
  input: {
    capabilityEnabled: boolean;
    executor?: SpotifySchedulerExecutor;
    dependencies?: SpotifySchedulerDependencies;
    limits: SpotifySchedulerLimits;
    mode: "plan" | "credential_free" | "production";
    now?: () => Date;
  },
): Promise<SpotifySchedulerTickResult> {
  const now = input.now ?? (() => new Date());
  const dependencies = input.dependencies ?? productionDependencies;
  if (input.mode === "plan") {
    const plan = await dependencies.planTick(db, now());
    return {
      mode: "plan",
      reason: "planned",
      requestsStarted: 0,
      selected: plan.selected,
      status: plan.status,
    };
  }
  if (input.mode === "production" && !input.capabilityEnabled) {
    return {
      mode: "production",
      reason: "capability_disabled",
      requestsStarted: 0,
      selected: null,
      status: await dependencies.getStatus(db, now()),
    };
  }
  if (!input.executor) throw new Error("Spotify scheduler execution requires an executor.");

  const lock = await dependencies.acquireLock(db, {
    lockKey: "scan:global",
    metadata: { provider: "spotify", scheduler: true },
    operationType: "spotify_scheduler_tick",
    ttlMs: input.limits.maxRuntimeMs + 30_000,
  });
  const startedAt = now();
  await dependencies.recordTick(db, { startedAt });
  let selected: SpotifySchedulerClaim | null = null;
  let requestsStarted = 0;
  try {
    const operational = await dependencies.getOperationalStatus(db, startedAt);
    if (operational.cooldownActive) {
      await dependencies.recordTick(db, {
        completedAt: now(),
        errorClassification: "spotify_cooldown",
      });
      return {
        mode: input.mode,
        reason: "cooldown",
        requestsStarted,
        selected: null,
        status: await dependencies.getStatus(db, now()),
      };
    }
    await dependencies.reconcileWork(db, startedAt, input.limits);
    selected = await dependencies.claimWork(db, startedAt);
    if (!selected) {
      await dependencies.recordTick(db, { completedAt: now() });
      return {
        mode: input.mode,
        reason: "no_work",
        requestsStarted,
        selected: null,
        status: await dependencies.getStatus(db, now()),
      };
    }

    const deadlineAt = startedAt.getTime() + input.limits.maxRuntimeMs;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new SpotifySchedulerRuntimeBudgetError()),
      Math.max(1, deadlineAt - now().getTime()),
    );
    timer.unref();
    try {
      await input.executor.execute(selected, {
        deadlineAt,
        signal: controller.signal,
        wrapRequestGate: (gate) => ({
          acquire: async (request) => {
            if (requestsStarted >= input.limits.maxRequestsPerTick) {
              throw new SpotifySchedulerRequestBudgetError(input.limits.maxRequestsPerTick);
            }
            if (now().getTime() + input.limits.minRequestIntervalMs > deadlineAt) {
              throw new SpotifySchedulerRuntimeBudgetError();
            }
            const permit = await gate.acquire({ ...request, signal: controller.signal });
            requestsStarted += 1;
            return permit;
          },
          complete: (permit, completion) => gate.complete(permit, completion),
        }),
      });
      await dependencies.finishWork(db, selected, { status: "completed" }, now());
      await dependencies.reconcileWork(db, now(), input.limits);
      await dependencies.recordTick(db, { completedAt: now() });
      return {
        mode: input.mode,
        reason: "completed",
        requestsStarted,
        selected,
        status: await dependencies.getStatus(db, now()),
      };
    } catch (error) {
      const mismatch =
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "spotify_resolution_mismatch";
      await dependencies.finishWork(
        db,
        selected,
        mismatch
          ? { reason: "spotify_track_mismatch", status: "blocked" }
          : { errorClassification: schedulerErrorClassification(error), status: "retry" },
        now(),
      );
      await dependencies.recordTick(db, {
        completedAt: now(),
        errorClassification: schedulerErrorClassification(error),
      });
      return {
        mode: input.mode,
        reason: "failed",
        requestsStarted,
        selected,
        status: await dependencies.getStatus(db, now()),
      };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await dependencies.releaseLock(db, lock);
  }
}

export function schedulerErrorClassification(error: unknown): string {
  if (error instanceof SpotifySchedulerRequestBudgetError) return "request_budget_exhausted";
  if (error instanceof SpotifySchedulerRuntimeBudgetError) return "runtime_budget_exhausted";
  if (error && typeof error === "object" && "code" in error && error.code === "spotify_cooldown") {
    return "spotify_cooldown";
  }
  if (error && typeof error === "object" && "status" in error && error.status === 429) {
    return "rate_limited";
  }
  return "scheduler_work_failed";
}
