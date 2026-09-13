import {
  createDatabase,
  getAppleMusicOperationalStatus,
  getRecurringDiscoveryScheduleStatus,
  getSpotifySchedulerStatus,
  reconcileDiscoveryScheduleAfterCooldown,
  reconcileDiscoverySchedulePriorityPhase,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { randomUUID } from "node:crypto";
import {
  decideDiscoveryMaintenance,
  maintenanceDatabaseReadinessTimeoutMs,
  maintenanceDatabaseRetryIntervalMs,
  maintenanceHardTerminationRecoveryDelayMs,
  maintenanceMaximumRuntimeMs,
  maintenanceMinimumAppleRuntimeMs,
  maintenanceMinimumProviderRuntimeMs,
  maintenanceShutdownGraceMs,
  maintenanceStartupRecoveryDelayMs,
  maintenanceTaskExecutionLimitMs,
  type DiscoveryMaintenanceDecision,
} from "./discovery-maintenance";
import { runDiscoverySchedulerTick } from "./discovery-scheduler-cli";
import { loadLocalEnvironment } from "./local-env";
import {
  createMaintenanceLifecycleDiagnostics,
  type MaintenanceLifecycleDiagnostics,
} from "./maintenance-diagnostics";
import {
  inspectDockerDatabaseAvailability,
  waitForMaintenanceDatabase,
  type DockerDatabaseAvailability,
} from "./maintenance-readiness";
import {
  acquireWindowsSystemPowerRequest,
  updateWindowsMaintenanceWake,
  updateWindowsStartupRecoveryWake,
  type WindowsPowerRequest,
} from "./windows-maintenance";

loadLocalEnvironment();

const startupRecoveryScheduledMarker = Symbol("startupRecoveryScheduled");
const maintenanceBoundaryWakeMinimumDelayMs = 60_000;

export async function runDiscoveryMaintenanceWindow(
  dependencies: {
    acquirePower?: typeof acquireWindowsSystemPowerRequest;
    databaseReadinessTimeoutMs?: number;
    databaseRetryIntervalMs?: number;
    inspectDocker?: () => Promise<DockerDatabaseAvailability>;
    maximumRuntimeMs?: number;
    now?: () => Date;
    runId?: string;
    sleep?: (milliseconds: number) => Promise<void>;
    updateStartupRecoveryWake?: (wakeAt: Date | null) => Promise<void>;
  } = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const runId = dependencies.runId ?? randomUUID();
  const startedAt = now();
  const lifecycle = createMaintenanceLifecycleDiagnostics(runId, startedAt);
  const maximumRuntimeMs = dependencies.maximumRuntimeMs ?? maintenanceMaximumRuntimeMs;
  const powerRequestMaximumRuntimeMs = Math.min(
    maintenanceTaskExecutionLimitMs,
    maximumRuntimeMs + maintenanceShutdownGraceMs,
  );
  const updateStartupRecoveryWake =
    dependencies.updateStartupRecoveryWake ?? updateWindowsStartupRecoveryWake;
  return executeDiscoveryMaintenanceWindow({
    close: (connection: ReturnType<typeof createDatabase>) => connection.client.end(),
    hardTerminationRecoveryAt: new Date(
      startedAt.getTime() + maintenanceHardTerminationRecoveryDelayMs,
    ),
    lifecycle,
    now,
    prepare: () =>
      prepareDiscoveryMaintenanceStartup<
        ReturnType<typeof loadProviderConfiguration>,
        ReturnType<typeof createDatabase>
      >({
        acquirePower: dependencies.acquirePower ?? acquireWindowsSystemPowerRequest,
        close: (candidate) => candidate.client.end(),
        inspectDocker: dependencies.inspectDocker ?? (() => inspectDockerDatabaseAvailability()),
        lifecycle,
        loadConfiguration: () => {
          const configuration = loadProviderConfiguration();
          if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
          if (!configuration.discoverySchedulerEnabled) {
            throw new Error("Recurring discovery execution is disabled.");
          }
          return configuration;
        },
        maximumRuntimeMs: powerRequestMaximumRuntimeMs,
        now,
        open: (configuration) => createDatabase(configuration.databaseUrl),
        probe: async (candidate) => {
          await candidate.client.unsafe("select 1 as ready");
        },
        readinessTimeoutMs:
          dependencies.databaseReadinessTimeoutMs ?? maintenanceDatabaseReadinessTimeoutMs,
        retryIntervalMs: dependencies.databaseRetryIntervalMs ?? maintenanceDatabaseRetryIntervalMs,
        runId,
        sleep: dependencies.sleep ?? wait,
        updateStartupRecoveryWake,
      }),
    runLoop: (startup) =>
      runDiscoveryMaintenanceLoop({
        acquirePower: acquireWindowsSystemPowerRequest,
        initialPowerRequest: startup.powerRequest,
        maximumRuntimeMs,
        lifecycle,
        now,
        observe: async (observedAt) => {
          await reconcileDiscoveryScheduleAfterCooldown(startup.connection.db, observedAt);
          await reconcileDiscoverySchedulePriorityPhase(startup.connection.db, observedAt);
          const [apple, discovery, spotify] = await Promise.all([
            getAppleMusicOperationalStatus(startup.connection.db, observedAt),
            getRecurringDiscoveryScheduleStatus(startup.connection.db, observedAt),
            getSpotifySchedulerStatus(startup.connection.db, observedAt),
          ]);
          return decideDiscoveryMaintenance({ apple, discovery, spotify }, observedAt);
        },
        runTick: ({ deadlineAt, remainingRuntimeMs }) =>
          runDiscoverySchedulerTick(startup.connection.db, startup.configuration, {
            appleMusicMaximumRuntimeMs: Math.max(60_000, remainingRuntimeMs - 60_000),
            playlistDeadlineAt: deadlineAt,
            priorityMaximumItems: 1,
          }),
        releasePower: false,
        sleep: dependencies.sleep ?? wait,
        startedAt,
        updateStartupRecoveryWake,
        updateWake: updateWindowsMaintenanceWake,
        runId,
      }),
    updateStartupRecoveryWake,
  });
}

export async function executeDiscoveryMaintenanceWindow<Configuration, Connection, Result>(input: {
  close(connection: Connection): Promise<void>;
  hardTerminationRecoveryAt: Date;
  lifecycle: MaintenanceLifecycleDiagnostics;
  now(): Date;
  prepare(): Promise<{
    configuration: Configuration;
    connection: Connection;
    powerRequest: WindowsPowerRequest;
  }>;
  runLoop(startup: {
    configuration: Configuration;
    connection: Connection;
    powerRequest: WindowsPowerRequest;
  }): Promise<Result>;
  updateStartupRecoveryWake(wakeAt: Date | null): Promise<void>;
}): Promise<Result> {
  let connection: Connection | null = null;
  let loopStarted = false;
  let powerRequest: WindowsPowerRequest | null = null;
  try {
    const startup = await input.prepare();
    connection = startup.connection;
    powerRequest = startup.powerRequest;
    const observedAt = input.now();
    try {
      await input.updateStartupRecoveryWake(input.hardTerminationRecoveryAt);
      input.lifecycle.startupRecoveryWake({
        observedAt,
        scheduledFor: input.hardTerminationRecoveryAt,
        state: "scheduled",
      });
    } catch (error) {
      input.lifecycle.startupRecoveryWake({
        error: classifyStartupError(error),
        observedAt,
        scheduledFor: input.hardTerminationRecoveryAt,
        state: "failed",
      });
      throw error;
    }
    loopStarted = true;
    return await input.runLoop(startup);
  } catch (error) {
    if (loopStarted || !wasStartupRecoveryScheduled(error)) {
      const observedAt = input.now();
      const scheduledFor = new Date(observedAt.getTime() + maintenanceStartupRecoveryDelayMs);
      try {
        await input.updateStartupRecoveryWake(scheduledFor);
        input.lifecycle.startupRecoveryWake({ observedAt, scheduledFor, state: "scheduled" });
      } catch (wakeError) {
        input.lifecycle.startupRecoveryWake({
          error: classifyStartupError(wakeError),
          observedAt,
          scheduledFor,
          state: "failed",
        });
      }
    }
    if (!loopStarted) {
      input.lifecycle.finish({
        error: error instanceof Error ? error.message : "Maintenance failed.",
        finalReason: "startup_failure",
        finishedAt: input.now(),
        ticks: 0,
      });
    }
    throw error;
  } finally {
    try {
      await powerRequest?.release();
    } finally {
      if (connection) await input.close(connection);
    }
  }
}

export async function prepareDiscoveryMaintenanceStartup<Configuration, Connection>(input: {
  acquirePower: (
    maximumRuntimeMs: number,
    context: { phase: string; reason: string; runId: string },
  ) => WindowsPowerRequest;
  close(connection: Connection): Promise<void>;
  inspectDocker(): Promise<DockerDatabaseAvailability>;
  lifecycle?: MaintenanceLifecycleDiagnostics;
  loadConfiguration(): Configuration;
  maximumRuntimeMs: number;
  now(): Date;
  open(configuration: Configuration): Connection;
  probe(connection: Connection): Promise<void>;
  readinessTimeoutMs: number;
  retryIntervalMs: number;
  runId: string;
  sleep(milliseconds: number): Promise<void>;
  updateStartupRecoveryWake(wakeAt: Date | null): Promise<void>;
}): Promise<{
  configuration: Configuration;
  connection: Connection;
  powerRequest: WindowsPowerRequest;
}> {
  let powerRequest: WindowsPowerRequest | null = null;
  try {
    powerRequest = input.acquirePower(input.maximumRuntimeMs, {
      phase: "dependency_readiness",
      reason: "startup_readiness",
      runId: input.runId,
    });
    const activation = await powerRequest.confirmActivation?.();
    input.lifecycle?.keepAwake({
      activatedAt: activation?.activatedAt ?? null,
      diagnosticPath: powerRequest.diagnosticPath ?? null,
      helperProcessId: activation?.helperProcessId ?? powerRequest.processId ?? null,
    });
    const configuration = input.loadConfiguration();
    const connection = await waitForMaintenanceDatabase({
      close: (candidate) => input.close(candidate),
      inspectDocker: () => input.inspectDocker(),
      now: () => input.now(),
      open: () => input.open(configuration),
      probe: (candidate) => input.probe(candidate),
      record: (attempt) => input.lifecycle?.readiness(attempt),
      retryIntervalMs: input.retryIntervalMs,
      sleep: (milliseconds) => input.sleep(milliseconds),
      timeoutMs: input.readinessTimeoutMs,
    });
    return { configuration, connection, powerRequest };
  } catch (error) {
    const observedAt = input.now();
    const scheduledFor = new Date(observedAt.getTime() + maintenanceStartupRecoveryDelayMs);
    let recoveryScheduled = false;
    try {
      await input.updateStartupRecoveryWake(scheduledFor);
      input.lifecycle?.startupRecoveryWake({ observedAt, scheduledFor, state: "scheduled" });
      recoveryScheduled = true;
    } catch (wakeError) {
      input.lifecycle?.startupRecoveryWake({
        error: classifyStartupError(wakeError),
        observedAt,
        scheduledFor,
        state: "failed",
      });
    }
    try {
      await powerRequest?.release();
    } catch (releaseError) {
      throw recoveryScheduled ? markStartupRecoveryScheduled(releaseError) : releaseError;
    }
    throw recoveryScheduled ? markStartupRecoveryScheduled(error) : error;
  }
}

export async function runDiscoveryMaintenanceLoop(input: {
  acquirePower: (
    maximumRuntimeMs: number,
    context: { phase: string; reason: string; runId: string },
  ) => WindowsPowerRequest;
  maximumRuntimeMs: number;
  lifecycle?: MaintenanceLifecycleDiagnostics;
  initialPowerRequest?: WindowsPowerRequest;
  now: () => Date;
  observe: (now: Date) => Promise<DiscoveryMaintenanceDecision>;
  releasePower?: boolean;
  runTick: (context: { deadlineAt: Date; remainingRuntimeMs: number }) => Promise<unknown>;
  sleep: (milliseconds: number) => Promise<void>;
  startedAt?: Date;
  updateWake: (wakeAt: Date | null) => Promise<void>;
  updateStartupRecoveryWake?: (wakeAt: Date | null) => Promise<void>;
  runId?: string;
}) {
  const startedAt = input.startedAt ?? input.now();
  const runId = input.runId ?? randomUUID();
  const deadline = new Date(startedAt.getTime() + input.maximumRuntimeMs);
  let powerRequest: WindowsPowerRequest | null = input.initialPowerRequest ?? null;
  let ticks = 0;
  let finalDecision: DiscoveryMaintenanceDecision | null = null;
  let runtimeYield = false;
  const scheduleContinuation = async (observedAt: Date) => {
    const scheduledFor = new Date(observedAt.getTime() + maintenanceStartupRecoveryDelayMs);
    try {
      if (!input.updateStartupRecoveryWake) {
        throw new Error("Startup recovery wake updater is required for a maintenance yield.");
      }
      await input.updateStartupRecoveryWake(scheduledFor);
      input.lifecycle?.startupRecoveryWake({ observedAt, scheduledFor, state: "scheduled" });
    } catch (error) {
      input.lifecycle?.startupRecoveryWake({
        error: classifyStartupError(error),
        observedAt,
        scheduledFor,
        state: "failed",
      });
      throw error;
    }
  };
  try {
    while (input.now() < deadline) {
      const observedAt = input.now();
      const decision = await input.observe(observedAt);
      finalDecision = decision;
      input.lifecycle?.decision(decision, observedAt);
      if (!decision.holdPower) break;
      const powerContext = {
        phase: decision.waitUntil ? "near_term_capacity_wait" : "due_work",
        reason: decision.reason,
        runId,
      };
      powerRequest ??= input.acquirePower(
        Math.max(60_000, deadline.getTime() - observedAt.getTime()),
        powerContext,
      );
      powerRequest.updateContext?.(powerContext);
      const activation = await powerRequest.confirmActivation?.();
      input.lifecycle?.keepAwake({
        activatedAt: activation?.activatedAt ?? null,
        diagnosticPath: powerRequest.diagnosticPath ?? null,
        helperProcessId: activation?.helperProcessId ?? powerRequest.processId ?? null,
      });
      if (decision.waitUntil) {
        const waitMs = decision.waitUntil.getTime() - observedAt.getTime();
        if (waitMs >= maintenanceBoundaryWakeMinimumDelayMs) {
          // Keep one wake trigger armed for meaningful waits while this process holds the system
          // awake. If the process is terminated outside normal error handling, the trigger can
          // restart maintenance instead of leaving deferred work stranded. Sub-minute provider
          // gate waits stay under the active keep-awake owner without rewriting the task trigger.
          await input.updateWake(decision.waitUntil);
        }
        await input.sleep(Math.max(1_000, Math.min(60_000, waitMs)));
        continue;
      }
      await input.updateWake(decision.dynamicWakeAt);
      if (!decision.runNow) break;
      const remainingRuntimeMs = Math.max(0, deadline.getTime() - observedAt.getTime());
      const minimumRuntimeMs =
        decision.reason === "apple_due"
          ? maintenanceMinimumAppleRuntimeMs
          : maintenanceMinimumProviderRuntimeMs;
      if (remainingRuntimeMs < minimumRuntimeMs) {
        await scheduleContinuation(observedAt);
        runtimeYield = true;
        break;
      }
      try {
        await input.runTick({ deadlineAt: deadline, remainingRuntimeMs });
        ticks += 1;
      } catch (error) {
        if (!isExpectedMaintenanceContention(error)) throw error;
        powerRequest.updateContext?.({
          phase: "live_owner_wait",
          reason: "maintenance_operation_contention",
        });
        await input.sleep(30_000);
        continue;
      }
      await input.sleep(1_000);
    }
    const finishedAt = input.now();
    const reachedDeadline = finishedAt >= deadline && finalDecision?.holdPower === true;
    if (reachedDeadline && !runtimeYield) await scheduleContinuation(finishedAt);
    if (!finalDecision?.holdPower) await input.updateWake(finalDecision?.dynamicWakeAt ?? null);
    if (!reachedDeadline && !runtimeYield && input.updateStartupRecoveryWake) {
      await input.updateStartupRecoveryWake(null);
      input.lifecycle?.startupRecoveryWake({
        observedAt: finishedAt,
        scheduledFor: null,
        state: "cleared",
      });
    }
    const result = {
      finalReason:
        reachedDeadline || runtimeYield ? "runtime_yield" : (finalDecision?.reason ?? "no_work"),
      finishedAt: finishedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      ticks,
    };
    input.lifecycle?.finish({
      finalReason: result.finalReason,
      finishedAt: new Date(result.finishedAt),
      ticks,
    });
    return result;
  } catch (error) {
    input.lifecycle?.finish({
      error: error instanceof Error ? error.message : "Maintenance failed.",
      finalReason: finalDecision?.reason ?? "runtime_failure",
      finishedAt: input.now(),
      ticks,
    });
    throw error;
  } finally {
    if (input.releasePower !== false) await powerRequest?.release();
  }
}

export function isExpectedMaintenanceContention(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /^Operation [A-Za-z0-9:_-]+ is already running\.$/.test(error.message) ||
    /^A [a-z_]+ scan is already running\.?$/.test(error.message)
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function classifyStartupError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code).trim();
    if (code) return code.slice(0, 80);
  }
  if (error instanceof Error && error.name) return error.name.slice(0, 80);
  return "unknown_error";
}

function markStartupRecoveryScheduled(error: unknown): unknown {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    Object.defineProperty(error, startupRecoveryScheduledMarker, { value: true });
    return error;
  }
  const wrapped = new Error(String(error));
  Object.defineProperty(wrapped, startupRecoveryScheduledMarker, { value: true });
  return wrapped;
}

function wasStartupRecoveryScheduled(error: unknown): boolean {
  return (
    ((typeof error === "object" && error !== null) || typeof error === "function") &&
    Reflect.get(error, startupRecoveryScheduledMarker) === true
  );
}

if (process.env.VITEST !== "true" && process.argv[1]?.endsWith("discovery-maintenance-cli.ts")) {
  runDiscoveryMaintenanceWindow().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(0);
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "Maintenance failed."}\n`);
      process.exit(1);
    },
  );
}
