import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireWindowsSystemPowerRequest,
  updateWindowsMaintenanceWake,
} from "./windows-maintenance";

describe("Windows discovery maintenance integration", () => {
  it("holds a hidden system-required request until explicitly released", async () => {
    const { child, kill } = fakeChild(false);
    let invocation: SpawnInvocation | undefined;
    const spawnProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
      invocation = { args, command, options };
      return child;
    }) as typeof spawn;

    const request = acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: temporaryDirectory(),
      platform: "win32",
      releaseGraceMs: 0,
      runId: "activation-release-run",
      spawnProcess,
    });

    expect(invocation?.command).toBe("powershell.exe");
    expect(invocation?.args).toContain("Hidden");
    expect(invocation?.args.at(-1)).toContain("SetThreadExecutionState");
    expect(invocation?.args.at(-1)).toContain("$continuous -bor $systemRequired");
    expect(invocation?.options.windowsHide).toBe(true);
    expect(invocation?.options.stdio).toBe("ignore");
    expect(invocation?.options.env).toMatchObject({ RADAR_POWER_MAX_SECONDS: "90" });
    expect(invocation?.options.env).toMatchObject({
      RADAR_POWER_PHASE: "due_work",
      RADAR_POWER_REASON: "unspecified",
      RADAR_POWER_RUN_ID: "activation-release-run",
    });
    const activationPath = String(invocation?.options.env?.RADAR_POWER_ACTIVATION_PATH);
    writeFileSync(
      activationPath,
      JSON.stringify({
        activatedAt: "2026-08-28T10:00:00.000Z",
        helperProcessId: 4242,
      }),
      "utf8",
    );
    await expect(request.readDiagnostics?.()).resolves.toMatchObject({
      activatedAt: "2026-08-28T10:00:00.000Z",
      helperProcessId: 4242,
      state: "active",
    });

    await request.release();
    expect(kill).toHaveBeenCalledTimes(1);
    await expect(request.readDiagnostics?.()).resolves.toMatchObject({
      finalReleased: true,
      releaseReason: "terminated_after_release_timeout",
      state: "released",
    });
  });

  it("is a no-op outside Windows", async () => {
    const spawnProcess = vi.fn();
    const request = acquireWindowsSystemPowerRequest(90_000, {
      platform: "linux",
      spawnProcess: spawnProcess as unknown as typeof spawn,
    });
    await request.release();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("updates one idempotent dynamic wake while preserving fixed triggers", async () => {
    const { child } = fakeChild(true);
    let invocation: SpawnInvocation | undefined;
    const spawnProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
      invocation = { args, command, options };
      return child;
    }) as typeof spawn;
    const wakeAt = new Date("2026-08-29T04:15:00.000Z");

    await updateWindowsMaintenanceWake(wakeAt, {
      platform: "win32",
      spawnProcess,
      taskName: "Synthetic maintenance task",
    });

    const script = invocation?.args.at(-1) ?? "";
    expect(invocation?.command).toBe("powershell.exe");
    expect(invocation?.args).toContain("Hidden");
    expect(invocation?.options.windowsHide).toBe(true);
    expect(invocation?.options.env).toMatchObject({
      RADAR_DYNAMIC_WAKE_AT: wakeAt.toISOString(),
      RADAR_MAINTENANCE_TASK: "Synthetic maintenance task",
    });
    expect(script).toContain("$existing.Count -eq 0");
    expect(script).toContain("$existing.Count -eq 1");
    expect(script).toContain("TotalSeconds) -lt 30");
    expect(script).toContain("$_.Id -ne 'DynamicCapacityWake'");
    expect(script).toContain("$dynamic.Id='DynamicCapacityWake'");
    expect(script).toContain("Set-ScheduledTask");
  });

  it("clears the dynamic trigger without changing fixed triggers", async () => {
    const { child } = fakeChild(true);
    let invocation: SpawnInvocation | undefined;
    const spawnProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
      invocation = { args, command, options };
      return child;
    }) as typeof spawn;

    await updateWindowsMaintenanceWake(null, { platform: "win32", spawnProcess });

    expect(invocation?.options.env).toMatchObject({ RADAR_DYNAMIC_WAKE_AT: "" });
    expect(invocation?.args.at(-1)).toContain(
      "$fixed=@($task.Triggers | Where-Object { $_.Id -ne 'DynamicCapacityWake' })",
    );
  });

  it("refuses to create a second keep-awake owner", async () => {
    const directory = temporaryDirectory();
    const first = fakeChild(false);
    const secondSpawn = vi.fn();
    const firstRequest = acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: directory,
      platform: "win32",
      releaseGraceMs: 0,
      runId: "first-owner",
      spawnProcess: (() => first.child) as typeof spawn,
    });

    expect(() =>
      acquireWindowsSystemPowerRequest(90_000, {
        diagnosticDirectory: directory,
        platform: "win32",
        processAlive: () => true,
        runId: "duplicate-owner",
        spawnProcess: secondSpawn as unknown as typeof spawn,
      }),
    ).toThrow("refusing a duplicate owner");
    expect(secondSpawn).not.toHaveBeenCalled();
    await firstRequest.release();
  });

  it("recovers a released request left by an abnormally exited owner", async () => {
    const directory = temporaryDirectory();
    const abandoned = fakeChild(false);
    const abandonedRequest = acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: directory,
      ownerProcessId: 999_991,
      platform: "win32",
      runId: "abandoned-owner",
      spawnProcess: (() => abandoned.child) as typeof spawn,
    });
    const replacement = fakeChild(false);
    const replacementRequest = acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: directory,
      platform: "win32",
      processAlive: () => false,
      releaseGraceMs: 0,
      runId: "replacement-owner",
      spawnProcess: (() => replacement.child) as typeof spawn,
    });

    const abandonedDiagnostics = await abandonedRequest.readDiagnostics?.();
    expect(abandonedDiagnostics).toMatchObject({
      finalReleased: true,
      state: "recovered_after_abnormal_exit",
    });
    expect(typeof abandonedDiagnostics?.abnormalExitDetectedAt).toBe("string");
    expect(typeof abandonedDiagnostics?.recoveredAt).toBe("string");
    expect(replacementRequest.runId).toBe("replacement-owner");
    await replacementRequest.release();
  });

  it("waits for an abandoned helper to exit instead of overlapping it", () => {
    const directory = temporaryDirectory();
    const abandoned = fakeChild(false);
    acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: directory,
      ownerProcessId: 999_991,
      platform: "win32",
      runId: "abandoned-live-helper",
      spawnProcess: (() => abandoned.child) as typeof spawn,
    });
    const replacementSpawn = vi.fn();

    expect(() =>
      acquireWindowsSystemPowerRequest(90_000, {
        diagnosticDirectory: directory,
        platform: "win32",
        processAlive: (processId) => processId === 4242,
        runId: "blocked-replacement",
        spawnProcess: replacementSpawn as unknown as typeof spawn,
      }),
    ).toThrow("still releasing");
    expect(replacementSpawn).not.toHaveBeenCalled();
  });
});

interface SpawnInvocation {
  args: readonly string[];
  command: string;
  options: SpawnOptions;
}

function fakeChild(autoExit: boolean): { child: ChildProcess; kill: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter();
  const kill = vi.fn(() => {
    Object.defineProperty(emitter, "killed", { configurable: true, value: true });
    queueMicrotask(() => emitter.emit("exit", 0, null));
    return true;
  });
  const child = Object.assign(emitter, {
    exitCode: null,
    kill,
    killed: false,
    pid: 4242,
  }) as unknown as ChildProcess;
  if (autoExit) {
    queueMicrotask(() => {
      Object.defineProperty(child, "exitCode", { configurable: true, value: 0 });
      child.emit("exit", 0, null);
    });
  }
  return { child, kill };
}

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(resolve(tmpdir(), "radar-keep-awake-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

process.on("exit", () => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true });
});
