import {
  createDatabase,
  getRecurringDiscoveryScheduleStatus,
  getSpotifySchedulerStatus,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { randomUUID } from "node:crypto";
import {
  decideDiscoveryMaintenance,
  maintenanceDatabaseReadinessTimeoutMs,
  maintenanceDatabaseRetryIntervalMs,
  maintenanceMaximumRuntimeMs,
  maintenanceStartupRecoveryDelayMs,
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
  MaintenanceDatabaseReadinessError,
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
  const updateStartupRecoveryWake =
    dependencies.updateStartupRecoveryWake ?? updateWindowsStartupRecoveryWake;
  return executeDiscoveryMaintenanceWindow({
    close: (connection: ReturnType<typeof createDatabase>) => connection.client.end(),
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
        maximumRuntimeMs,
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
          const [discovery, spotify] = await Promise.all([
            getRecurringDiscoveryScheduleStatus(startup.connection.db, observedAt),
            getSpotifySchedulerStatus(startup.connection.db, observedAt),
          ]);
          return decideDiscoveryMaintenance({ discovery, spotify }, observedAt);
        },
        runTick: () => runDiscoverySchedulerTick(startup.connection.db, startup.configuration),
        sleep: dependencies.sleep ?? wait,
        startedAt,
        updateWake: updateWindowsMaintenanceWake,
        runId,
      }),
    updateStartupRecoveryWake,
  });
}

export async function executeDiscoveryMaintenanceWindow<Configuration, Connection, Result>(input: {
  close(connection: Connection): Promise<void>;
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
    loopStarted = true;
    return await input.runLoop(startup);
  } catch (error) {
    if (loopStarted) {
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
    } else {
      input.lifecycle.finish({
        error: error instanceof Error ? error.message : "Maintenance failed.",
        finalReason: "startup_failure",
        finishedAt: input.now(),
        ticks: 0,
      });
    }
    throw error;
  } finally {
    if (!loopStarted) await powerRequest?.release();
    if (connection) await input.close(connection);
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
  const powerRequest = input.acquirePower(input.maximumRuntimeMs, {
    phase: "dependency_readiness",
    reason: "startup_readiness",
    runId: input.runId,
  });
  try {
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
    const clearedAt = input.now();
    try {
      await input.updateStartupRecoveryWake(null);
      input.lifecycle?.startupRecoveryWake({
        observedAt: clearedAt,
        scheduledFor: null,
        state: "cleared",
      });
    } catch (error) {
      input.lifecycle?.startupRecoveryWake({
        error: classifyStartupError(error),
        observedAt: clearedAt,
        scheduledFor: null,
        state: "failed",
      });
    }
    return { configuration, connection, powerRequest };
  } catch (error) {
    if (error instanceof MaintenanceDatabaseReadinessError) {
      const observedAt = input.now();
      const scheduledFor = new Date(observedAt.getTime() + maintenanceStartupRecoveryDelayMs);
      try {
        await input.updateStartupRecoveryWake(scheduledFor);
        input.lifecycle?.startupRecoveryWake({ observedAt, scheduledFor, state: "scheduled" });
      } catch (wakeError) {
        input.lifecycle?.startupRecoveryWake({
          error: classifyStartupError(wakeError),
          observedAt,
          scheduledFor,
          state: "failed",
        });
      }
    }
    await powerRequest.release();
    throw error;
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
  runTick: () => Promise<unknown>;
  sleep: (milliseconds: number) => Promise<void>;
  startedAt?: Date;
  updateWake: (wakeAt: Date | null) => Promise<void>;
  runId?: string;
}) {
  const startedAt = input.startedAt ?? input.now();
  const runId = input.runId ?? randomUUID();
  const deadline = new Date(startedAt.getTime() + input.maximumRuntimeMs);
  let powerRequest: WindowsPowerRequest | null = input.initialPowerRequest ?? null;
  let ticks = 0;
  let finalDecision: DiscoveryMaintenanceDecision | null = null;
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
      await input.updateWake(decision.dynamicWakeAt);
      if (decision.waitUntil) {
        await input.sleep(
          Math.max(1_000, Math.min(60_000, decision.waitUntil.getTime() - observedAt.getTime())),
        );
        continue;
      }
      if (!decision.runNow) break;
      await input.runTick();
      ticks += 1;
      await input.sleep(1_000);
    }
    if (!finalDecision?.holdPower) await input.updateWake(finalDecision?.dynamicWakeAt ?? null);
    const result = {
      finalReason: finalDecision?.reason ?? "no_work",
      finishedAt: input.now().toISOString(),
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
    await powerRequest?.release();
  }
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
