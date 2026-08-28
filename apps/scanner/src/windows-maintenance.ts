import { spawn, type ChildProcess } from "node:child_process";
import { maintenanceDynamicTriggerId, maintenanceTaskName } from "./discovery-maintenance";

export interface WindowsPowerRequest {
  processId?: number;
  release(): Promise<void>;
}

interface SpawnDependencies {
  activationMarkerPath?: string;
  platform?: NodeJS.Platform;
  spawnProcess?: typeof spawn;
}

export function acquireWindowsSystemPowerRequest(
  maximumRuntimeMs: number,
  dependencies: SpawnDependencies = {},
): WindowsPowerRequest {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32") return { release: () => Promise.resolve() };
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const maximumSeconds = Math.max(60, Math.ceil(maximumRuntimeMs / 1_000));
  const script = [
    "$signature='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    "Add-Type -MemberDefinition $signature -Name PowerRequest -Namespace Radar",
    "$continuous=0x80000000",
    "$systemRequired=0x00000001",
    "[void][Radar.PowerRequest]::SetThreadExecutionState($continuous -bor $systemRequired)",
    "if ($env:RADAR_POWER_ACTIVATION_MARKER) { Set-Content -LiteralPath $env:RADAR_POWER_ACTIVATION_MARKER -Value ([DateTimeOffset]::UtcNow.ToString('O')) -Encoding ascii }",
    "$deadline=[DateTime]::UtcNow.AddSeconds([int]$env:RADAR_POWER_MAX_SECONDS)",
    "$parentId=[int]$env:RADAR_POWER_PARENT_PID",
    "try { while ([DateTime]::UtcNow -lt $deadline -and (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { Start-Sleep -Seconds 1 } } finally { [void][Radar.PowerRequest]::SetThreadExecutionState($continuous) }",
  ].join("; ");
  const child = spawnProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    {
      env: {
        ...process.env,
        RADAR_POWER_ACTIVATION_MARKER: dependencies.activationMarkerPath ?? "",
        RADAR_POWER_MAX_SECONDS: String(maximumSeconds),
        RADAR_POWER_PARENT_PID: String(process.pid),
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  return {
    ...(child.pid === undefined ? {} : { processId: child.pid }),
    release: () => stopPowerRequest(child),
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

async function stopPowerRequest(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill();
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 2_000).unref();
  });
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
