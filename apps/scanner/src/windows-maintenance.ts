import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { maintenanceDynamicTriggerId, maintenanceTaskName } from "./discovery-maintenance";
import {
  claimKeepAwakeOwner,
  defaultKeepAwakeDiagnosticDirectory,
  finalizeKeepAwakeRelease,
  readKeepAwakeRecord,
  requestKeepAwakeRelease,
  updateKeepAwakeRecordSync,
  type KeepAwakeDiagnosticRecord,
  type KeepAwakeDiagnosticPaths,
} from "./windows-power-diagnostics";

export interface WindowsPowerRequest {
  diagnosticPath?: string;
  processId?: number;
  readDiagnostics?(): Promise<KeepAwakeDiagnosticRecord | null>;
  release(): Promise<void>;
  runId?: string;
  updateContext?(context: WindowsPowerRequestContext): void;
}

export interface WindowsPowerRequestContext {
  phase: string;
  reason: string;
}

interface SpawnDependencies extends Partial<WindowsPowerRequestContext> {
  diagnosticDirectory?: string;
  now?: () => Date;
  ownerProcessId?: number;
  platform?: NodeJS.Platform;
  processAlive?: (processId: number) => boolean;
  releaseGraceMs?: number;
  runId?: string;
  spawnProcess?: typeof spawn;
}

export function acquireWindowsSystemPowerRequest(
  maximumRuntimeMs: number,
  dependencies: SpawnDependencies = {},
): WindowsPowerRequest {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") return { release: () => Promise.resolve() };
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const now = dependencies.now ?? (() => new Date());
  const ownerProcessId = dependencies.ownerProcessId ?? process.pid;
  const processAliveCheck = dependencies.processAlive ?? processAlive;
  const runId = dependencies.runId ?? randomUUID();
  const reason = dependencies.reason ?? "unspecified";
  const phase = dependencies.phase ?? "due_work";
  const diagnosticDirectory =
    dependencies.diagnosticDirectory ?? defaultKeepAwakeDiagnosticDirectory();
  const claimed = claimKeepAwakeOwner({
    directory: diagnosticDirectory,
    maximumRuntimeMs,
    now: now(),
    ownerProcessId,
    phase,
    processAlive: processAliveCheck,
    reason,
    runId,
  });
  const maximumSeconds = Math.max(60, Math.ceil(maximumRuntimeMs / 1_000));
  const script = [
    "$signature='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    "Add-Type -MemberDefinition $signature -Name PowerRequest -Namespace Radar",
    "$continuous=0x80000000",
    "$systemRequired=0x00000001",
    "$activation=[Radar.PowerRequest]::SetThreadExecutionState($continuous -bor $systemRequired)",
    "if ($activation -eq 0) { throw 'SetThreadExecutionState failed.' }",
    "$activatedAt=[DateTimeOffset]::UtcNow.ToString('O')",
    "$activationRecord=[ordered]@{ version=1; runId=$env:RADAR_POWER_RUN_ID; ownerProcessId=[int]$env:RADAR_POWER_PARENT_PID; helperProcessId=$PID; reason=$env:RADAR_POWER_REASON; phase=$env:RADAR_POWER_PHASE; state='active'; activatedAt=$activatedAt }",
    "$activationRecord | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:RADAR_POWER_ACTIVATION_PATH -Encoding utf8",
    "$deadline=[DateTime]::UtcNow.AddSeconds([int]$env:RADAR_POWER_MAX_SECONDS)",
    "$parentId=[int]$env:RADAR_POWER_PARENT_PID",
    "$releaseReason='maximum_runtime_reached'",
    "try { while ([DateTime]::UtcNow -lt $deadline) { if (Test-Path -LiteralPath $env:RADAR_POWER_RELEASE_PATH) { $releaseReason='release_requested'; break }; if (-not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { $releaseReason='owner_process_exited'; break }; Start-Sleep -Milliseconds 250 } } finally { [void][Radar.PowerRequest]::SetThreadExecutionState($continuous); $releasedAt=[DateTimeOffset]::UtcNow.ToString('O'); $releaseRecord=[ordered]@{ version=1; runId=$env:RADAR_POWER_RUN_ID; ownerProcessId=$parentId; helperProcessId=$PID; reason=$env:RADAR_POWER_REASON; phase=$env:RADAR_POWER_PHASE; state='released'; releaseReason=$releaseReason; releasedAt=$releasedAt }; $releaseRecord | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:RADAR_POWER_RELEASE_MARKER_PATH -Encoding utf8 }",
  ].join("; ");
  let child: ChildProcess;
  try {
    child = spawnProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      {
        env: {
          ...process.env,
          RADAR_POWER_ACTIVATION_PATH: claimed.paths.activationPath,
          RADAR_POWER_MAX_SECONDS: String(maximumSeconds),
          RADAR_POWER_PARENT_PID: String(ownerProcessId),
          RADAR_POWER_PHASE: phase,
          RADAR_POWER_REASON: reason,
          RADAR_POWER_RELEASE_MARKER_PATH: claimed.paths.releasePath,
          RADAR_POWER_RELEASE_PATH: claimed.paths.releaseSignalPath,
          RADAR_POWER_RUN_ID: runId,
        },
        stdio: "ignore",
        windowsHide: true,
      },
    );
  } catch (error) {
    markSynchronousActivationFailure(claimed.paths, now(), error);
    throw error;
  }
  updateKeepAwakeRecordSync(claimed.paths, {
    helperProcessId: child.pid ?? null,
  });
  let released = false;
  return {
    diagnosticPath: claimed.paths.recordPath,
    ...(child.pid === undefined ? {} : { processId: child.pid }),
    readDiagnostics: () => readKeepAwakeRecord(claimed.paths),
    release: async () => {
      if (released) return;
      released = true;
      await stopPowerRequest(child, claimed.paths, now, dependencies.releaseGraceMs ?? 2_000);
    },
    runId,
    updateContext: (context) => {
      const timestamp = now().toISOString();
      updateKeepAwakeRecordSync(claimed.paths, {
        contextUpdatedAt: timestamp,
        phase: context.phase,
        reason: context.reason,
      });
    },
  };
}

export async function updateWindowsMaintenanceWake(
  wakeAt: Date | null,
  dependencies: SpawnDependencies & { taskName?: string } = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") return;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const taskName = dependencies.taskName ?? maintenanceTaskName;
  const script = [
    "$task=Get-ScheduledTask -TaskName $env:RADAR_MAINTENANCE_TASK -ErrorAction SilentlyContinue",
    "if (-not $task) { exit 0 }",
    `$existing=@($task.Triggers | Where-Object { $_.Id -eq '${maintenanceDynamicTriggerId}' })`,
    "if (-not $env:RADAR_DYNAMIC_WAKE_AT -and $existing.Count -eq 0) { exit 0 }",
    "if ($env:RADAR_DYNAMIC_WAKE_AT -and $existing.Count -eq 1) {",
    "  $desired=[DateTimeOffset]::Parse($env:RADAR_DYNAMIC_WAKE_AT).LocalDateTime",
    "  $current=[DateTime]::Parse($existing[0].StartBoundary)",
    "  if ([Math]::Abs(($current-$desired).TotalSeconds) -lt 30) { exit 0 }",
    "}",
    `$fixed=@($task.Triggers | Where-Object { $_.Id -ne '${maintenanceDynamicTriggerId}' })`,
    "if ($env:RADAR_DYNAMIC_WAKE_AT) {",
    "  $local=[DateTimeOffset]::Parse($env:RADAR_DYNAMIC_WAKE_AT).LocalDateTime",
    "  $dynamic=New-ScheduledTaskTrigger -Once -At $local",
    `  $dynamic.Id='${maintenanceDynamicTriggerId}'`,
    "  $fixed += $dynamic",
    "}",
    "Set-ScheduledTask -TaskName $env:RADAR_MAINTENANCE_TASK -Trigger $fixed | Out-Null",
  ].join("; ");
  await runHiddenPowerShell(spawnProcess, script, {
    RADAR_DYNAMIC_WAKE_AT: wakeAt?.toISOString() ?? "",
    RADAR_MAINTENANCE_TASK: taskName,
  });
}

async function stopPowerRequest(
  child: ChildProcess,
  paths: KeepAwakeDiagnosticPaths,
  now: () => Date,
  releaseGraceMs: number,
): Promise<void> {
  await requestKeepAwakeRelease(paths, now());
  let exited = child.exitCode !== null || child.killed;
  if (!exited) exited = await waitForChildExit(child, releaseGraceMs);
  let fallbackReleaseReason = "release_requested";
  if (!exited) {
    child.kill();
    await waitForChildExit(child, 2_000);
    fallbackReleaseReason = "terminated_after_release_timeout";
  }
  await finalizeKeepAwakeRelease(paths, now(), fallbackReleaseReason);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.killed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      resolve(exited);
    };
    child.once("exit", () => finish(true));
    child.once("error", () => finish(true));
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    timer.unref();
  });
}

function markSynchronousActivationFailure(
  paths: KeepAwakeDiagnosticPaths,
  now: Date,
  error: unknown,
): void {
  updateKeepAwakeRecordSync(paths, {
    contextUpdatedAt: now.toISOString(),
    finalReleased: true,
    releaseReason:
      error instanceof Error ? `helper_spawn_failed: ${error.message}` : "helper_spawn_failed",
    releasedAt: now.toISOString(),
    state: "released",
  });
  rmSync(paths.ownerPath, { force: true });
}

function processAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function runHiddenPowerShell(
  spawnProcess: typeof spawn,
  script: string,
  environment: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      {
        env: { ...process.env, ...environment },
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Windows maintenance task update failed with exit code ${code}.`));
    });
  });
}
