import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createRecurringSchedulerDiagnostics } from "./recurring-scheduler-diagnostics";

describe("recurring scheduler diagnostics", () => {
  it("records a completed maintenance dispatch decision", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "radar-recurring-diagnostics-"));
    const diagnostics = createRecurringSchedulerDiagnostics(
      new Date("2026-09-13T00:00:00.000Z"),
      directory,
      "completed-run",
    );
    diagnostics.complete(
      {
        decision: {
          dynamicWakeAt: null,
          holdPower: true,
          reason: "priority_work",
          runNow: true,
          waitUntil: null,
        },
        dispatchedToMaintenance: true,
      },
      new Date("2026-09-13T00:00:02.000Z"),
    );

    expect(read(directory, "latest.json")).toMatchObject({
      decision: { reason: "priority_work", runNow: true },
      dispatchedToMaintenance: true,
      finishedAt: "2026-09-13T00:00:02.000Z",
      runId: "completed-run",
      state: "completed",
    });
  });

  it("records a bounded sanitized failure independently of the task host result", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "radar-recurring-diagnostics-"));
    const diagnostics = createRecurringSchedulerDiagnostics(
      new Date("2026-09-13T00:00:00.000Z"),
      directory,
      "failed-run",
    );
    diagnostics.fail(
      Object.assign(new Error(`task update failed\n${"x".repeat(600)}`), { code: "TASK_UPDATE" }),
      new Date("2026-09-13T00:00:03.000Z"),
    );

    const record = read(directory, "last-failure.json");
    expect(record).toMatchObject({
      error: { classification: "TASK_UPDATE" },
      finishedAt: "2026-09-13T00:00:03.000Z",
      state: "failed",
    });
    expect((record.error as { message: string }).message).not.toContain("\n");
    expect((record.error as { message: string }).message.length).toBeLessThanOrEqual(500);
  });
});

function read(directory: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(directory, name), "utf8")) as Record<string, unknown>;
}
