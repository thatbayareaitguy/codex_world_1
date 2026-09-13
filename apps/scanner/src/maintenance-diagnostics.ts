import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DiscoveryMaintenanceDecision } from "./discovery-maintenance";
import type { MaintenanceReadinessAttempt } from "./maintenance-readiness";

export interface MaintenanceLifecycleDiagnostics {
  decision(decision: DiscoveryMaintenanceDecision, observedAt: Date): void;
  finish(input: { error?: string; finalReason: string; finishedAt: Date; ticks: number }): void;
  keepAwake(input: {
    activatedAt: string | null;
    diagnosticPath: string | null;
    helperProcessId: number | null;
  }): void;
  readiness(attempt: MaintenanceReadinessAttempt): void;
  startupRecoveryWake(input: {
    error?: string;
    observedAt: Date;
    scheduledFor: Date | null;
    state: "cleared" | "failed" | "scheduled";
  }): void;
}

interface MaintenanceLifecycleRecord {
  decisions: Array<{
    dynamicWakeAt: string | null;
    holdPower: boolean;
    observedAt: string;
    reason: DiscoveryMaintenanceDecision["reason"];
    runNow: boolean;
    waitUntil: string | null;
  }>;
  error: string | null;
  finalReason: string | null;
  finishedAt: string | null;
  keepAwake: {
    activatedAt: string | null;
    diagnosticPath: string | null;
    helperProcessId: number | null;
  } | null;
  ownerProcessId: number;
  readiness: {
    attempts: Array<{
      attempt: number;
      attemptedAt: string;
      dockerAvailability: MaintenanceReadinessAttempt["dockerAvailability"];
      elapsedMs: number;
      errorClassification: string | null;
      postgresReady: boolean;
    }>;
    finalResult: "pending" | "ready" | "timeout";
  };
  runId: string;
  startedAt: string;
  startupRecoveryWake: {
    error: string | null;
    observedAt: string;
    scheduledFor: string | null;
    state: "cleared" | "failed" | "scheduled";
  } | null;
  state: "running" | "completed" | "failed";
  ticks: number;
  version: 1;
}

export function createMaintenanceLifecycleDiagnostics(
  runId: string,
  startedAt: Date,
  directory = defaultMaintenanceDiagnosticDirectory(),
): MaintenanceLifecycleDiagnostics {
  const record: MaintenanceLifecycleRecord = {
    decisions: [],
    error: null,
    finalReason: null,
    finishedAt: null,
    keepAwake: null,
    ownerProcessId: process.pid,
    readiness: { attempts: [], finalResult: "pending" },
    runId,
    startedAt: startedAt.toISOString(),
    state: "running",
    startupRecoveryWake: null,
    ticks: 0,
    version: 1,
  };
  const runPath = resolve(directory, `${runId}.json`);
  const latestPath = resolve(directory, "latest.json");
  const persist = () => {
    writeJsonAtomic(runPath, record);
    writeJsonAtomic(latestPath, record);
  };
  persist();
  return {
    decision: (decision, observedAt) => {
      record.decisions.push({
        dynamicWakeAt: decision.dynamicWakeAt?.toISOString() ?? null,
        holdPower: decision.holdPower,
        observedAt: observedAt.toISOString(),
        reason: decision.reason,
        runNow: decision.runNow,
        waitUntil: decision.waitUntil?.toISOString() ?? null,
      });
      persist();
    },
    finish: (input) => {
      record.error = input.error ?? null;
      record.finalReason = input.finalReason;
      record.finishedAt = input.finishedAt.toISOString();
      record.state = input.error ? "failed" : "completed";
      record.ticks = input.ticks;
      persist();
    },
    keepAwake: (input) => {
      record.keepAwake = input;
      persist();
    },
    readiness: (attempt) => {
      record.readiness.attempts.push({
        attempt: attempt.attempt,
        attemptedAt: attempt.attemptedAt.toISOString(),
        dockerAvailability: attempt.dockerAvailability,
        elapsedMs: attempt.elapsedMs,
        errorClassification: attempt.errorClassification,
        postgresReady: attempt.postgresReady,
      });
      record.readiness.finalResult = attempt.postgresReady ? "ready" : "pending";
      persist();
    },
    startupRecoveryWake: (input) => {
      record.startupRecoveryWake = {
        error: input.error ?? null,
        observedAt: input.observedAt.toISOString(),
        scheduledFor: input.scheduledFor?.toISOString() ?? null,
        state: input.state,
      };
      if (input.scheduledFor) record.readiness.finalResult = "timeout";
      persist();
    },
  };
}

export function defaultMaintenanceDiagnosticDirectory(): string {
  const local = process.env.LOCALAPPDATA;
  if (!local) throw new Error("LOCALAPPDATA is required for maintenance diagnostics.");
  return resolve(local, "TSNewMusicRadar", "logs", "maintenance");
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}
