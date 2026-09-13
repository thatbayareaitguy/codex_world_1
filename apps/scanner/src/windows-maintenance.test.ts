import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireWindowsSystemPowerRequest,
  ensureWindowsMaintenanceWake,
  updateWindowsMaintenanceWake,
  updateWindowsStartupRecoveryWake,
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
      processAlive: () => true,
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
    await expect(request.confirmActivation?.()).resolves.toMatchObject({
      activatedAt: "2026-08-28T10:00:00.000Z",
      state: "active",
    });
    await expect(request.readDiagnostics?.()).resolves.toMatchObject({
      activatedAt: "2026-08-28T10:00:00.000Z",
      helperProcessId: 4242,
      state: "active",
    });
    request.updateContext?.({ phase: "active_work", reason: "priority_work" });
    expect(
      JSON.parse(
        readFileSync(resolve(dirname(activationPath), "activation-release-run.json"), "utf8"),
      ),
    ).toMatchObject({
      activatedAt: "2026-08-28T10:00:00.000Z",
      phase: "active_work",
      reason: "priority_work",
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

  it("rejects when the helper exits before activation", async () => {
    const { child } = fakeChild(true);
    const request = acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: temporaryDirectory(),
      platform: "win32",
      runId: "activation-failure-run",
      spawnProcess: (() => child) as typeof spawn,
    });
    await expect(request.confirmActivation?.()).rejects.toThrow(
      "exited before activation was confirmed",
    );
    await expect(request.readDiagnostics?.()).resolves.toMatchObject({
      finalReleased: true,
      state: "released",
    });
  });

  it("rejects an asynchronous helper spawn failure instead of accepting stale activation", async () => {
    const { child } = fakeChild(false);
    const request = acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: temporaryDirectory(),
      platform: "win32",
      runId: "asynchronous-spawn-failure",
      spawnProcess: (() => child) as typeof spawn,
    });
    const activation = request.confirmActivation?.();
    child.emit("error", new Error("synthetic spawn failure"));

    await expect(activation).rejects.toThrow("synthetic spawn failure");
    await expect(request.readDiagnostics?.()).resolves.toMatchObject({
      finalReleased: true,
      state: "released",
    });
  });

  it("rejects an activation marker when the helper process is no longer alive", async () => {
    const { child } = fakeChild(false);
    let invocation: SpawnInvocation | undefined;
    const request = acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: temporaryDirectory(),
      platform: "win32",
      processAlive: () => false,
      runId: "dead-after-activation",
      spawnProcess: ((command: string, args: readonly string[], options: SpawnOptions) => {
        invocation = { args, command, options };
        return child;
      }) as typeof spawn,
    });
    writeFileSync(
      String(invocation?.options.env?.RADAR_POWER_ACTIVATION_PATH),
      JSON.stringify({
        activatedAt: "2026-09-12T23:00:00.000Z",
        helperProcessId: 4242,
        state: "active",
      }),
      "utf8",
    );

    await expect(request.confirmActivation?.()).rejects.toThrow("is not alive after activation");
    await expect(request.readDiagnostics?.()).resolves.toMatchObject({
      finalReleased: true,
      releaseReason: "activation_failed_helper_not_alive",
      state: "released",
    });
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
      RADAR_MAINTENANCE_TASK: "Synthetic maintenance task",
      RADAR_WAKE_AT: wakeAt.toISOString(),
      RADAR_WAKE_TRIGGER_ID: "DynamicCapacityWake",
    });
    expect(script).toContain("$existing.Count -eq 0");
    expect(script).toContain("$existing.Count -eq 1");
    expect(script).toContain("TotalSeconds) -lt 30");
    expect(script).toContain("$_.Id -ne $env:RADAR_WAKE_TRIGGER_ID");
    expect(script).toContain("$dynamic.Id=$env:RADAR_WAKE_TRIGGER_ID");
    expect(script).toContain("Set-ScheduledTask");
    expect(script).toContain("TSNewMusicRadarMaintenanceWakeUpdateV1");
    expect(script).toContain("AbandonedMutexException");
    expect(script).toContain("-ErrorAction Stop");
    expect(script).toContain("Maintenance wake verification failed");
    expect(script).not.toContain("; elseif");
  });

  it("verifies that recurring dispatch preserves or creates an imminent wake", async () => {
    const { child } = fakeChild(true);
    let invocation: SpawnInvocation | undefined;
    const spawnProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
      invocation = { args, command, options };
      return child;
    }) as typeof spawn;
    const observedAt = new Date("2026-09-12T23:00:00.000Z");
    const wakeAt = new Date("2026-09-12T23:01:00.000Z");

    await ensureWindowsMaintenanceWake(wakeAt, {
      now: () => observedAt,
      platform: "win32",
      spawnProcess,
    });

    expect(invocation?.options.env).toMatchObject({
      RADAR_ENSURE_FUTURE_WAKE: "true",
      RADAR_WAKE_AT: wakeAt.toISOString(),
      RADAR_WAKE_OBSERVED_AT: observedAt.toISOString(),
      RADAR_WAKE_PRESERVE_UNTIL: "2026-09-12T23:15:00.000Z",
      RADAR_WAKE_RECENT_AFTER: "2026-09-12T22:59:30.000Z",
    });
    expect(invocation?.args.at(-1)).toContain("$current -ge $recentAfter");
    expect(invocation?.args.at(-1)).toContain("$current -le $preserveUntil");
  });

  it("clears the dynamic trigger without changing fixed triggers", async () => {
    const { child } = fakeChild(true);
    let invocation: SpawnInvocation | undefined;
    const spawnProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
      invocation = { args, command, options };
      return child;
    }) as typeof spawn;

    await updateWindowsMaintenanceWake(null, { platform: "win32", spawnProcess });

    expect(invocation?.options.env).toMatchObject({
      RADAR_WAKE_AT: "",
      RADAR_WAKE_TRIGGER_ID: "DynamicCapacityWake",
    });
    expect(invocation?.args.at(-1)).toContain(
      "$preserved=@($task.Triggers | Where-Object { $_.Id -ne $env:RADAR_WAKE_TRIGGER_ID })",
    );
  });

  it("updates one startup-recovery wake while preserving every other trigger", async () => {
    const { child } = fakeChild(true);
    let invocation: SpawnInvocation | undefined;
    const spawnProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
      invocation = { args, command, options };
      return child;
    }) as typeof spawn;
    const wakeAt = new Date("2026-09-08T16:07:00.000Z");

    await updateWindowsStartupRecoveryWake(wakeAt, {
      platform: "win32",
      spawnProcess,
      taskName: "Synthetic maintenance task",
    });

    expect(invocation?.options.env).toMatchObject({
      RADAR_MAINTENANCE_TASK: "Synthetic maintenance task",
      RADAR_WAKE_AT: wakeAt.toISOString(),
      RADAR_WAKE_TRIGGER_ID: "StartupRecoveryWake",
    });
    expect(invocation?.args.at(-1)).toContain(
      "$preserved=@($task.Triggers | Where-Object { $_.Id -ne $env:RADAR_WAKE_TRIGGER_ID })",
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

  it("recovers a corrupt owner marker from the intact per-run record", async () => {
    const directory = temporaryDirectory();
    const abandoned = fakeChild(false);
    const abandonedRequest = acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: directory,
      ownerProcessId: 999_991,
      platform: "win32",
      runId: "corrupt-abandoned-owner",
      spawnProcess: (() => abandoned.child) as typeof spawn,
    });
    writeFileSync(resolve(directory, "active-owner.json"), "{", "utf8");

    const replacement = fakeChild(false);
    const replacementRequest = acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: directory,
      platform: "win32",
      processAlive: () => false,
      releaseGraceMs: 0,
      runId: "corrupt-owner-replacement",
      spawnProcess: (() => replacement.child) as typeof spawn,
    });

    await expect(abandonedRequest.readDiagnostics?.()).resolves.toMatchObject({
      finalReleased: true,
      releaseReason: "corrupt_owner_recovered",
      state: "recovered_after_abnormal_exit",
    });
    expect(readdirSync(directory).some((name) => name.includes("active-owner.json.corrupt-"))).toBe(
      true,
    );
    expect(replacementRequest.runId).toBe("corrupt-owner-replacement");
    await replacementRequest.release();
  });

  it("refuses overlap when a corrupt owner marker has an intact live-owner record", () => {
    const directory = temporaryDirectory();
    const active = fakeChild(false);
    acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: directory,
      ownerProcessId: 777_777,
      platform: "win32",
      runId: "corrupt-live-owner",
      spawnProcess: (() => active.child) as typeof spawn,
    });
    writeFileSync(resolve(directory, "active-owner.json"), "not-json", "utf8");
    const replacementSpawn = vi.fn();

    expect(() =>
      acquireWindowsSystemPowerRequest(90_000, {
        diagnosticDirectory: directory,
        platform: "win32",
        processAlive: (processId) => processId === 777_777,
        runId: "blocked-by-recovered-live-owner",
        spawnProcess: replacementSpawn as unknown as typeof spawn,
      }),
    ).toThrow("refusing a duplicate owner");
    expect(replacementSpawn).not.toHaveBeenCalled();
    expect(readFileSync(resolve(directory, "active-owner.json"), "utf8")).toBe("not-json");
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

  it("retains recovery ownership when helper termination cannot be confirmed", async () => {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      exitCode: null,
      kill: vi.fn(() => true),
      killed: false,
      pid: 4242,
      signalCode: null,
    }) as unknown as ChildProcess;
    const request = acquireWindowsSystemPowerRequest(90_000, {
      diagnosticDirectory: temporaryDirectory(),
      platform: "win32",
      releaseGraceMs: 0,
      runId: "unconfirmed-release",
      spawnProcess: (() => child) as typeof spawn,
    });

    await expect(request.release()).rejects.toThrow("exit could not be confirmed");
    await expect(request.readDiagnostics?.()).resolves.toMatchObject({
      finalReleased: false,
      releaseReason: "helper_exit_unconfirmed",
      state: "recovery_pending",
    });
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
    signalCode: null,
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
