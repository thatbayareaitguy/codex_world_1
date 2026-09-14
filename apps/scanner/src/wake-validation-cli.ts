import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { acquireWindowsSystemPowerRequest, type WindowsPowerRequest } from "./windows-maintenance";
import type { KeepAwakeDiagnosticRecord } from "./windows-power-diagnostics";

const execFileAsync = promisify(execFile);
export const wakeValidationHoldMs = 90_000;
const activationTimeoutMs = 15_000;
const releaseTimeoutMs = 10_000;

export interface PowerCfgDiagnostic {
  available: boolean;
  error: "access_denied" | "command_failed" | null;
  powerShellSystemRequests: number | null;
}

export interface WakeValidationResult {
  activated: boolean;
  activationAt: string | null;
  completedAt: string;
  diagnosticPath: string | null;
  diagnostics: KeepAwakeDiagnosticRecord | null;
  helperAliveAfterRelease: boolean;
  helperAliveDuring: boolean;
  helperProcessId: number | null;
  optionalPowerCfg: { after: PowerCfgDiagnostic; during: PowerCfgDiagnostic };
  released: boolean;
  startedAt: string;
  status: "failed" | "passed";
}

interface WakeValidationDependencies {
  acquirePower: (maximumRuntimeMs: number) => WindowsPowerRequest;
  holdMs: number;
  now: () => Date;
  outputPath: string;
  powerRequests: () => Promise<string>;
  processAlive: (processId: number) => boolean;
  sleep: (milliseconds: number) => Promise<void>;
  writeResult: (path: string, result: WakeValidationResult) => Promise<void>;
}

export async function runWakeValidation(
  overrides: Partial<WakeValidationDependencies> = {},
): Promise<WakeValidationResult> {
  const dependencies: WakeValidationDependencies = {
    acquirePower: (maximumRuntimeMs) =>
      acquireWindowsSystemPowerRequest(maximumRuntimeMs, {
        phase: "one_time_live_validation",
        reason: "wake_validation",
      }),
    holdMs: wakeValidationHoldMs,
    now: () => new Date(),
    outputPath: wakeValidationOutputPath(),
    powerRequests: readPowerRequests,
    processAlive,
    sleep: wait,
    writeResult: writeWakeValidationResult,
    ...overrides,
  };
  const startedAt = dependencies.now();

  // Activation is deliberately first. powercfg /requests is optional and can require
  // administrator privileges on machines where the helper itself works as a limited user.
  const power = dependencies.acquirePower(dependencies.holdMs + 30_000);
  let diagnostics = await readDiagnostics(power);
  let processId = power.processId ?? diagnostics?.helperProcessId ?? null;
  let helperAliveDuring = processId !== null && dependencies.processAlive(processId);
  let releaseCompleted = false;
  try {
    const activationDeadline = startedAt.getTime() + activationTimeoutMs;
    while (
      (!diagnostics?.activatedAt || !helperAliveDuring) &&
      dependencies.now().getTime() < activationDeadline
    ) {
      await dependencies.sleep(500);
      diagnostics = await readDiagnostics(power);
      processId = power.processId ?? diagnostics?.helperProcessId ?? null;
      helperAliveDuring = processId !== null && dependencies.processAlive(processId);
    }
    const duringPowerCfg = await readOptionalPowerRequests(dependencies.powerRequests);
    const remainingHoldMs =
      dependencies.holdMs - (dependencies.now().getTime() - startedAt.getTime());
    if (remainingHoldMs > 0) await dependencies.sleep(remainingHoldMs);

    await power.release();
    releaseCompleted = true;
    const releaseDeadline = dependencies.now().getTime() + releaseTimeoutMs;
    diagnostics = await readDiagnostics(power);
    let helperAliveAfterRelease = processId !== null && dependencies.processAlive(processId);
    while (
      (!diagnostics?.finalReleased || helperAliveAfterRelease) &&
      dependencies.now().getTime() < releaseDeadline
    ) {
      await dependencies.sleep(500);
      diagnostics = await readDiagnostics(power);
      helperAliveAfterRelease = processId !== null && dependencies.processAlive(processId);
    }
    const afterPowerCfg = await readOptionalPowerRequests(dependencies.powerRequests);
    const activated = Boolean(diagnostics?.activatedAt) && helperAliveDuring;
    const released = Boolean(diagnostics?.finalReleased) && !helperAliveAfterRelease;
    const result: WakeValidationResult = {
      activated,
      activationAt: diagnostics?.activatedAt ?? null,
      completedAt: dependencies.now().toISOString(),
      diagnosticPath: power.diagnosticPath ?? null,
      diagnostics,
      helperAliveAfterRelease,
      helperAliveDuring,
      helperProcessId: processId,
      optionalPowerCfg: { after: afterPowerCfg, during: duringPowerCfg },
      released,
      startedAt: startedAt.toISOString(),
      status: activated && released ? "passed" : "failed",
    };
    await dependencies.writeResult(dependencies.outputPath, result);
    return result;
  } finally {
    if (!releaseCompleted) await power.release();
  }
}

export function countPowerShellSystemRequests(output: string): number {
  const systemSection =
    output.match(/(?:^|\r?\n)SYSTEM:\s*([\s\S]*?)(?:\r?\n[A-Z][A-Z ]+:|$)/i)?.[1] ?? "";
  return [...systemSection.matchAll(/powershell\.exe/gi)].length;
}

export async function readOptionalPowerRequests(
  powerRequests: () => Promise<string>,
): Promise<PowerCfgDiagnostic> {
  try {
    return {
      available: true,
      error: null,
      powerShellSystemRequests: countPowerShellSystemRequests(await powerRequests()),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      error: /administrator|access.+denied|elevation/i.test(message)
        ? "access_denied"
        : "command_failed",
      powerShellSystemRequests: null,
    };
  }
}

function wakeValidationOutputPath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is required for wake validation.");
  return resolve(localAppData, "TSNewMusicRadar", "logs", "wake-validation-latest.json");
}

async function readPowerRequests(): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const result = await execFileAsync(
    resolve(systemRoot, "System32", "powercfg.exe"),
    ["/requests"],
    {
      timeout: 10_000,
      windowsHide: true,
    },
  );
  return result.stdout;
}

function processAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function readDiagnostics(
  request: WindowsPowerRequest,
): Promise<KeepAwakeDiagnosticRecord | null> {
  return (await request.readDiagnostics?.()) ?? null;
}

async function writeWakeValidationResult(
  path: string,
  result: WakeValidationResult,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

if (process.env.VITEST !== "true" && process.argv[1]?.endsWith("wake-validation-cli.ts")) {
  runWakeValidation().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(result.status === "passed" ? 0 : 1);
    },
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Wake validation failed."}\n`,
      );
      process.exit(1);
    },
  );
}
