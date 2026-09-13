import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMaintenanceLifecycleDiagnostics } from "./maintenance-diagnostics";

const directories: string[] = [];

describe("maintenance lifecycle diagnostics", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("persists startup before decisions and records the final release-independent outcome", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "radar-maintenance-test-"));
    directories.push(directory);
    const diagnostics = createMaintenanceLifecycleDiagnostics(
      "maintenance-run",
      new Date("2026-09-04T15:50:00.000Z"),
      directory,
    );
    expect(read(directory, "latest.json")).toMatchObject({
      decisions: [],
      readiness: { attempts: [], finalResult: "pending" },
      runId: "maintenance-run",
      state: "running",
    });
    diagnostics.readiness({
      attempt: 1,
      attemptedAt: new Date("2026-09-04T15:50:01.000Z"),
      dockerAvailability: "running",
      elapsedMs: 1_000,
      errorClassification: "ECONNREFUSED",
      postgresReady: false,
    });
    diagnostics.readiness({
      attempt: 2,
      attemptedAt: new Date("2026-09-04T15:50:11.000Z"),
      dockerAvailability: "healthy",
      elapsedMs: 11_000,
      errorClassification: null,
      postgresReady: true,
    });
    diagnostics.startupRecoveryWake({
      observedAt: new Date("2026-09-04T15:50:12.000Z"),
      scheduledFor: null,
      state: "cleared",
    });
    diagnostics.decision(
      {
        dynamicWakeAt: null,
        holdPower: true,
        reason: "apple_due_soon",
        runNow: false,
        waitUntil: new Date("2026-09-04T16:00:00.000Z"),
      },
      new Date("2026-09-04T15:50:01.000Z"),
    );
    diagnostics.keepAwake({
      activatedAt: "2026-09-04T15:50:02.000Z",
      diagnosticPath: "keep-awake.json",
      helperProcessId: 42,
    });
    diagnostics.finish({
      finalReason: "no_work",
      finishedAt: new Date("2026-09-04T16:05:00.000Z"),
      ticks: 2,
    });
    expect(read(directory, "maintenance-run.json")).toMatchObject({
      decisions: [{ holdPower: true, reason: "apple_due_soon" }],
      finalReason: "no_work",
      keepAwake: { helperProcessId: 42 },
      readiness: {
        attempts: [
          { attempt: 1, errorClassification: "ECONNREFUSED", postgresReady: false },
          { attempt: 2, dockerAvailability: "healthy", postgresReady: true },
        ],
        finalResult: "ready",
      },
      state: "completed",
      startupRecoveryWake: { state: "cleared" },
      ticks: 2,
    });
  });
});

function read(directory: string, name: string): unknown {
  return JSON.parse(readFileSync(resolve(directory, name), "utf8"));
}
