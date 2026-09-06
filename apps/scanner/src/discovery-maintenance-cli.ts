import {
  createDatabase,
  getRecurringDiscoveryScheduleStatus,
  getSpotifySchedulerStatus,
} from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { randomUUID } from "node:crypto";
import {
  decideDiscoveryMaintenance,
  maintenanceMaximumRuntimeMs,
  type DiscoveryMaintenanceDecision,
} from "./discovery-maintenance";
import { runDiscoverySchedulerTick } from "./discovery-scheduler-cli";
import { loadLocalEnvironment } from "./local-env";
import {
  createMaintenanceLifecycleDiagnostics,
  type MaintenanceLifecycleDiagnostics,
} from "./maintenance-diagnostics";
import {
  acquireWindowsSystemPowerRequest,
  updateWindowsMaintenanceWake,
  type WindowsPowerRequest,
} from "./windows-maintenance";

loadLocalEnvironment();

export async function runDiscoveryMaintenanceWindow(
  dependencies: {
    maximumRuntimeMs?: number;
    now?: () => Date;
    runId?: string;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const now = dependencies.now ?? (() => new Date());
  const runId = dependencies.runId ?? randomUUID();
  const lifecycle = createMaintenanceLifecycleDiagnostics(runId, now());
  let connection: ReturnType<typeof createDatabase> | null = null;
  let loopStarted = false;
  try {
    const configuration = loadProviderConfiguration();
    if (!configuration.databaseUrl) throw new Error("DATABASE_URL is required.");
    if (!configuration.discoverySchedulerEnabled) {
      throw new Error("Recurring discovery execution is disabled.");
    }
    connection = createDatabase(configuration.databaseUrl);
    loopStarted = true;
    return runDiscoveryMaintenanceLoop({
      acquirePower: acquireWindowsSystemPowerRequest,
      maximumRuntimeMs: dependencies.maximumRuntimeMs ?? maintenanceMaximumRuntimeMs,
      lifecycle,
      now,
      observe: async (observedAt) => {
        const [discovery, spotify] = await Promise.all([
          getRecurringDiscoveryScheduleStatus(connection!.db, observedAt),
          getSpotifySchedulerStatus(connection!.db, observedAt),
        ]);
        return decideDiscoveryMaintenance({ discovery, spotify }, observedAt);
      },
      runTick: () => runDiscoverySchedulerTick(connection!.db, configuration),
      sleep: dependencies.sleep ?? wait,
      updateWake: updateWindowsMaintenanceWake,
      runId,
    });
  } catch (error) {
    if (!loopStarted) {
      lifecycle.finish({
        error: error instanceof Error ? error.message : "Maintenance failed.",
        finalReason: "startup_failure",
        finishedAt: now(),
        ticks: 0,
      });
    }
    throw error;
  } finally {
    await connection?.client.end();
  }
}

export async function runDiscoveryMaintenanceLoop(input: {
  acquirePower: (
    maximumRuntimeMs: number,
    context: { phase: string; reason: string; runId: string },
  ) => WindowsPowerRequest;
  maximumRuntimeMs: number;
  lifecycle?: MaintenanceLifecycleDiagnostics;
  now: () => Date;
  observe: (now: Date) => Promise<DiscoveryMaintenanceDecision>;
  runTick: () => Promise<unknown>;
  sleep: (milliseconds: number) => Promise<void>;
  updateWake: (wakeAt: Date | null) => Promise<void>;
  runId?: string;
}) {
  const startedAt = input.now();
  const runId = input.runId ?? randomUUID();
  const deadline = new Date(startedAt.getTime() + input.maximumRuntimeMs);
  let powerRequest: WindowsPowerRequest | null = null;
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
