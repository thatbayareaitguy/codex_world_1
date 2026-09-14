import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  maintenanceDynamicTriggerId,
  maintenanceNearTermWaitMs,
  maintenanceStartupRecoveryTriggerId,
  maintenanceTaskName,
} from "./discovery-maintenance";
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
  confirmActivation?(): Promise<KeepAwakeDiagnosticRecord | null>;
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
  deadlineAt?: Date;
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
  const deadlineAt = new Date(
    Math.min(
      now().getTime() + maximumRuntimeMs,
      dependencies.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY,
    ),
  );
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
    "$parentId=[int]$env:RADAR_POWER_PARENT_PID",
    "$deadline=[DateTimeOffset]::Parse($env:RADAR_POWER_DEADLINE).UtcDateTime",
    "if ((Test-Path -LiteralPath $env:RADAR_POWER_RELEASE_PATH) -or -not (Get-Process -Id $parentId -ErrorAction SilentlyContinue) -or [DateTime]::UtcNow -ge $deadline) { exit 0 }",
    "$signature='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    "Add-Type -MemberDefinition $signature -Name PowerRequest -Namespace Radar",
    "if ((Test-Path -LiteralPath $env:RADAR_POWER_RELEASE_PATH) -or -not (Get-Process -Id $parentId -ErrorAction SilentlyContinue) -or [DateTime]::UtcNow -ge $deadline) { exit 0 }",
    "$continuous=0x80000000",
    "$systemRequired=0x00000001",
    "$activation=[Radar.PowerRequest]::SetThreadExecutionState($continuous -bor $systemRequired)",
    "if ($activation -eq 0) { throw 'SetThreadExecutionState failed.' }",
    "$activatedAt=[DateTimeOffset]::UtcNow.ToString('O')",
    "$activationRecord=[ordered]@{ version=1; runId=$env:RADAR_POWER_RUN_ID; ownerProcessId=[int]$env:RADAR_POWER_PARENT_PID; helperProcessId=$PID; reason=$env:RADAR_POWER_REASON; phase=$env:RADAR_POWER_PHASE; state='active'; activatedAt=$activatedAt }",
    "$activationRecord | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:RADAR_POWER_ACTIVATION_PATH -Encoding utf8",
    "$releaseReason='maximum_runtime_reached'",
    "try { while ([DateTime]::UtcNow -lt $deadline) { if (Test-Path -LiteralPath $env:RADAR_POWER_RELEASE_PATH) { $releaseReason='release_requested'; break }; if (-not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { $releaseReason='owner_process_exited'; break }; Start-Sleep -Milliseconds 250 } } finally { [void][Radar.PowerRequest]::SetThreadExecutionState($continuous); $releasedAt=[DateTimeOffset]::UtcNow.ToString('O'); $releaseRecord=[ordered]@{ version=1; runId=$env:RADAR_POWER_RUN_ID; ownerProcessId=$parentId; helperProcessId=$PID; reason=$env:RADAR_POWER_REASON; phase=$env:RADAR_POWER_PHASE; state='released'; releaseReason=$releaseReason; releasedAt=$releasedAt }; $releaseRecord | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:RADAR_POWER_RELEASE_MARKER_PATH -Encoding utf8 }",
  ].join("\n");
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
          RADAR_POWER_DEADLINE: deadlineAt.toISOString(),
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
  let helperError: Error | null = null;
  let activationConfirmed = false;
  let releaseStarted = false;
  child.on("error", (error) => {
    helperError = error;
    if (!activationConfirmed && !releaseStarted) {
      markSynchronousActivationFailure(claimed.paths, now(), error);
      return;
    }
    updateKeepAwakeRecordSync(claimed.paths, {
      contextUpdatedAt: now().toISOString(),
      finalReleased: false,
      releaseReason: `helper_process_error: ${error.message}`,
      state: "recovery_pending",
    });
  });
  updateKeepAwakeRecordSync(claimed.paths, {
    helperProcessId: child.pid ?? null,
  });
  let releasePromise: Promise<void> | null = null;
  return {
    confirmActivation: async () => {
      const activationDeadline = Date.now() + 5_000;
      while (Date.now() < activationDeadline) {
        const record = await readKeepAwakeRecord(claimed.paths);
        if (helperError) {
          throw new Error(`Windows keep-awake helper could not start: ${helperError.message}`);
        }
        if (hasChildExited(child)) {
          await finalizeKeepAwakeRelease(
            claimed.paths,
            now(),
            `activation_failed_helper_exit_${child.exitCode ?? "unknown"}`,
          );
          throw new Error("Windows keep-awake helper exited before activation was confirmed.");
        }
        if (record?.activatedAt && record.state === "active") {
          if (child.pid !== undefined && !processAliveCheck(child.pid)) {
            await finalizeKeepAwakeRelease(
              claimed.paths,
              now(),
              "activation_failed_helper_not_alive",
            );
            throw new Error("Windows keep-awake helper is not alive after activation.");
          }
          activationConfirmed = true;
          return updateKeepAwakeRecordSync(claimed.paths, {
            activatedAt: record.activatedAt,
            helperProcessId: record.helperProcessId ?? child.pid ?? null,
            state: "active",
          });
        }
        await delay(50);
      }
      releaseStarted = true;
      releasePromise ??= stopPowerRequest(
        child,
        claimed.paths,
        now,
        dependencies.releaseGraceMs ?? 2_000,
      );
      await releasePromise;
      throw new Error("Windows keep-awake activation was not confirmed within five seconds.");
    },
    diagnosticPath: claimed.paths.recordPath,
    ...(child.pid === undefined ? {} : { processId: child.pid }),
    readDiagnostics: () => readKeepAwakeRecord(claimed.paths),
    release: async () => {
      releaseStarted = true;
      releasePromise ??= stopPowerRequest(
        child,
        claimed.paths,
        now,
        dependencies.releaseGraceMs ?? 2_000,
      );
      await releasePromise;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function updateWindowsMaintenanceWake(
  wakeAt: Date | null,
  dependencies: SpawnDependencies & { taskName?: string } = {},
): Promise<void> {
  return updateWindowsMaintenanceTrigger(maintenanceDynamicTriggerId, wakeAt, dependencies);
}

export async function updateWindowsStartupRecoveryWake(
  wakeAt: Date | null,
  dependencies: SpawnDependencies & { taskName?: string } = {},
): Promise<void> {
  return updateWindowsMaintenanceTrigger(maintenanceStartupRecoveryTriggerId, wakeAt, dependencies);
}

export async function ensureWindowsMaintenanceWake(
  wakeAt: Date,
  dependencies: SpawnDependencies & { taskName?: string } = {},
): Promise<void> {
  return updateWindowsMaintenanceTrigger(maintenanceDynamicTriggerId, wakeAt, dependencies, {
    ensureFutureWake: true,
  });
}

async function updateWindowsMaintenanceTrigger(
  triggerId: string,
  wakeAt: Date | null,
  dependencies: SpawnDependencies & { taskName?: string },
  options: { ensureFutureWake?: boolean } = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") return;
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const taskName = dependencies.taskName ?? maintenanceTaskName;
  const observedAt = dependencies.now?.() ?? new Date();
  const script = [
    "$mutex=[Threading.Mutex]::new($false, 'Local\\TSNewMusicRadarMaintenanceWakeUpdateV1')",
    "$mutexHeld=$false",
    "try {",
    "  try { $mutexHeld=$mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $mutexHeld=$true }",
    "  if (-not $mutexHeld) { throw 'Timed out waiting for the maintenance wake update lock.' }",
    "  $task=Get-ScheduledTask -TaskName $env:RADAR_MAINTENANCE_TASK -ErrorAction Stop",
    "  if ($task.State -eq 'Disabled') { throw 'The maintenance task is disabled.' }",
    "  $existing=@($task.Triggers | Where-Object { $_.Id -eq $env:RADAR_WAKE_TRIGGER_ID })",
    "  $skipUpdate=$false",
    "  if ($env:RADAR_ENSURE_FUTURE_WAKE -eq 'true') {",
    "    if ($task.State -eq 'Running') { $skipUpdate=$true }",
    "    elseif ($existing.Count -eq 1 -and $existing[0].Enabled -ne $false) {",
    "      $current=[DateTimeOffset]::Parse($existing[0].StartBoundary).UtcDateTime",
    "      $observed=[DateTimeOffset]::Parse($env:RADAR_WAKE_OBSERVED_AT).UtcDateTime",
    "      $recentAfter=[DateTimeOffset]::Parse($env:RADAR_WAKE_RECENT_AFTER).UtcDateTime",
    "      $preserveUntil=[DateTimeOffset]::Parse($env:RADAR_WAKE_PRESERVE_UNTIL).UtcDateTime",
    "      if ($current -ge $recentAfter -and $current -le $preserveUntil) { $skipUpdate=$true }",
    "    }",
    "  } elseif (-not $env:RADAR_WAKE_AT -and $existing.Count -eq 0) { $skipUpdate=$true }",
    "  elseif ($env:RADAR_WAKE_AT -and $existing.Count -eq 1) {",
    "    $desired=[DateTimeOffset]::Parse($env:RADAR_WAKE_AT).UtcDateTime",
    "    $current=[DateTimeOffset]::Parse($existing[0].StartBoundary).UtcDateTime",
    "    if ([Math]::Abs(($current-$desired).TotalSeconds) -lt 30) { $skipUpdate=$true }",
    "  }",
    "  if (-not $skipUpdate) {",
    "    $preserved=@($task.Triggers | Where-Object { $_.Id -ne $env:RADAR_WAKE_TRIGGER_ID })",
    "    if ($env:RADAR_WAKE_AT) {",
    "      $local=[DateTimeOffset]::Parse($env:RADAR_WAKE_AT).LocalDateTime",
    "      $dynamic=New-ScheduledTaskTrigger -Once -At $local",
    "      $dynamic.Id=$env:RADAR_WAKE_TRIGGER_ID",
    "      $preserved += $dynamic",
    "    }",
    "    Set-ScheduledTask -TaskName $env:RADAR_MAINTENANCE_TASK -Trigger $preserved | Out-Null",
    "    $verified=Get-ScheduledTask -TaskName $env:RADAR_MAINTENANCE_TASK -ErrorAction Stop",
    "    $verifiedWake=@($verified.Triggers | Where-Object { $_.Id -eq $env:RADAR_WAKE_TRIGGER_ID })",
    "    if ($env:RADAR_WAKE_AT) {",
    "      if ($verifiedWake.Count -ne 1) { throw 'Maintenance wake verification failed.' }",
    "      $actual=[DateTimeOffset]::Parse($verifiedWake[0].StartBoundary).UtcDateTime",
    "      $desired=[DateTimeOffset]::Parse($env:RADAR_WAKE_AT).UtcDateTime",
    "      if ([Math]::Abs(($actual-$desired).TotalSeconds) -ge 30) { throw 'Maintenance wake time verification failed.' }",
    "    } elseif ($verifiedWake.Count -ne 0) { throw 'Maintenance wake removal verification failed.' }",
    "  }",
    "} finally {",
    "  if ($mutexHeld) { [void]$mutex.ReleaseMutex() }",
    "  $mutex.Dispose()",
    "}",
  ].join("\n");
  await runHiddenPowerShell(spawnProcess, script, {
    RADAR_ENSURE_FUTURE_WAKE: options.ensureFutureWake ? "true" : "false",
    RADAR_MAINTENANCE_TASK: taskName,
    RADAR_WAKE_OBSERVED_AT: observedAt.toISOString(),
    RADAR_WAKE_PRESERVE_UNTIL: new Date(
      observedAt.getTime() + maintenanceNearTermWaitMs,
    ).toISOString(),
    RADAR_WAKE_RECENT_AFTER: new Date(observedAt.getTime() - 30_000).toISOString(),
    RADAR_WAKE_AT: wakeAt?.toISOString() ?? "",
    RADAR_WAKE_TRIGGER_ID: triggerId,
  });
}

async function stopPowerRequest(
  child: ChildProcess,
  paths: KeepAwakeDiagnosticPaths,
  now: () => Date,
  releaseGraceMs: number,
): Promise<void> {
  const current = await readKeepAwakeRecord(paths);
  if (current?.finalReleased) return;
  await requestKeepAwakeRelease(paths, now());
  let exited = hasChildExited(child);
  if (!exited) exited = await waitForChildExit(child, releaseGraceMs);
  let fallbackReleaseReason = "release_requested";
  if (!exited) {
    try {
      child.kill();
    } catch (error) {
      const timestamp = now().toISOString();
      updateKeepAwakeRecordSync(paths, {
        contextUpdatedAt: timestamp,
        finalReleased: false,
        releaseReason: `helper_termination_failed: ${
          error instanceof Error ? error.message : "unknown_error"
        }`,
        state: "recovery_pending",
      });
      throw error;
    }
    exited = await waitForChildExit(child, Math.max(50, releaseGraceMs));
    fallbackReleaseReason = "terminated_after_release_timeout";
  }
  if (!exited) {
    const timestamp = now().toISOString();
    updateKeepAwakeRecordSync(paths, {
      contextUpdatedAt: timestamp,
      finalReleased: false,
      releaseReason: "helper_exit_unconfirmed",
      state: "recovery_pending",
    });
    throw new Error("Windows keep-awake helper exit could not be confirmed.");
  }
  await finalizeKeepAwakeRelease(paths, now(), fallbackReleaseReason);
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasChildExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    timer.unref();
  });
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || (child.signalCode !== null && child.signalCode !== undefined);
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
    let diagnosticOutput = "";
    const child = spawnProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
      {
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* The updater may already have exited. */
      }
      reject(new Error("Windows maintenance task update exceeded twenty seconds."));
    }, 20_000);
    timer.unref();
    const collectDiagnosticOutput = (chunk: unknown) => {
      if (diagnosticOutput.length >= 2_000) return;
      diagnosticOutput += String(chunk).slice(0, 2_000 - diagnosticOutput.length);
    };
    child.stdout?.on("data", collectDiagnosticOutput);
    child.stderr?.on("data", collectDiagnosticOutput);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const detail = diagnosticOutput.replaceAll(/\s+/g, " ").trim().slice(0, 500);
        reject(
          new Error(
            `Windows maintenance task update failed with exit code ${code}${detail ? `: ${detail}` : "."}`,
          ),
        );
      }
    });
  });
}
