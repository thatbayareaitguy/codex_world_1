import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DiscoveryMaintenanceDecision } from "./discovery-maintenance";

interface RecurringSchedulerDiagnosticRecord {
  decision: DiscoveryMaintenanceDecision | null;
  dispatchedToMaintenance: boolean | null;
  error: { classification: string; message: string } | null;
  finishedAt: string | null;
  ownerProcessId: number;
  runId: string;
  startedAt: string;
  state: "running" | "completed" | "failed";
  version: 1;
}

export interface RecurringSchedulerDiagnostics {
  complete(
    result: {
      decision: DiscoveryMaintenanceDecision;
      dispatchedToMaintenance: boolean;
    },
    finishedAt?: Date,
  ): void;
  fail(error: unknown, finishedAt?: Date): void;
}

export function createRecurringSchedulerDiagnostics(
  startedAt = new Date(),
  directory = defaultRecurringSchedulerDiagnosticDirectory(),
  runId: string = randomUUID(),
): RecurringSchedulerDiagnostics {
  const record: RecurringSchedulerDiagnosticRecord = {
    decision: null,
    dispatchedToMaintenance: null,
    error: null,
    finishedAt: null,
    ownerProcessId: process.pid,
    runId,
    startedAt: startedAt.toISOString(),
    state: "running",
    version: 1,
  };
  const latestPath = resolve(directory, "latest.json");
  const failurePath = resolve(directory, "last-failure.json");
  const persist = () => writeJsonAtomic(latestPath, record);
  persist();
  return {
    complete: (result, finishedAt = new Date()) => {
      record.decision = result.decision;
      record.dispatchedToMaintenance = result.dispatchedToMaintenance;
      record.error = null;
      record.finishedAt = finishedAt.toISOString();
      record.state = "completed";
      persist();
    },
    fail: (error, finishedAt = new Date()) => {
      record.error = classifyDiagnosticError(error);
      record.finishedAt = finishedAt.toISOString();
      record.state = "failed";
      persist();
      writeJsonAtomic(failurePath, record);
    },
  };
}

export function defaultRecurringSchedulerDiagnosticDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is required for recurring scheduler diagnostics.");
  }
  return resolve(localAppData, "TSNewMusicRadar", "logs", "recurring-scheduler");
}

function classifyDiagnosticError(error: unknown): {
  classification: string;
  message: string;
} {
  const classification =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.trim()
      ? error.code.trim()
      : error instanceof Error
        ? error.name
        : "unknown_error";
  const message = error instanceof Error ? error.message : "Recurring scheduler tick failed.";
  return {
    classification: classification.slice(0, 100),
    message: message.replaceAll(/[\r\n]+/g, " ").slice(0, 500),
  };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}
