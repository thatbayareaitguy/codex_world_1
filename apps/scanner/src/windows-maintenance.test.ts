import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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
      platform: "win32",
      spawnProcess,
    });

    expect(invocation?.command).toBe("powershell.exe");
    expect(invocation?.args).toContain("Hidden");
    expect(invocation?.args.at(-1)).toContain("SetThreadExecutionState");
    expect(invocation?.args.at(-1)).toContain("$continuous -bor $systemRequired");
    expect(invocation?.options.windowsHide).toBe(true);
    expect(invocation?.options.stdio).toBe("ignore");
    expect(invocation?.options.env).toMatchObject({ RADAR_POWER_MAX_SECONDS: "90" });
    expect(invocation?.options.env).toMatchObject({ RADAR_POWER_ACTIVATION_MARKER: "" });

    await request.release();
    expect(kill).toHaveBeenCalledTimes(1);
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
  }) as unknown as ChildProcess;
  if (autoExit) {
    queueMicrotask(() => {
      Object.defineProperty(child, "exitCode", { configurable: true, value: 0 });
      child.emit("exit", 0, null);
    });
  }
  return { child, kill };
}
