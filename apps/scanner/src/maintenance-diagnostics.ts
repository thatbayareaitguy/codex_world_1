import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DiscoveryMaintenanceDecision } from "./discovery-maintenance";

export interface MaintenanceLifecycleDiagnostics {
  decision(decision: DiscoveryMaintenanceDecision, observedAt: Date): void;
  finish(input: { error?: string; finalReason: string; finishedAt: Date; ticks: number }): void;
  keepAwake(input: {
    activatedAt: string | null;
    diagnosticPath: string | null;
    helperProcessId: number | null;
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
  runId: string;
  startedAt: string;
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
    runId,
    startedAt: startedAt.toISOString(),
    state: "running",
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
