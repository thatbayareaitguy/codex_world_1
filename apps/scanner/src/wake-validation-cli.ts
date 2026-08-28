import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { acquireWindowsSystemPowerRequest, type WindowsPowerRequest } from "./windows-maintenance";

const execFileAsync = promisify(execFile);
export const wakeValidationHoldMs = 90_000;
const activationTimeoutMs = 15_000;
const releaseTimeoutMs = 10_000;

export interface WakeValidationResult {
  activated: boolean;
  activationMarkerAt: string | null;
  completedAt: string;
  helperAliveAfterRelease: boolean;
  helperAliveDuring: boolean;
  helperProcessId: number | null;
  powerShellSystemRequests: { after: number; before: number; during: number };
  released: boolean;
  startedAt: string;
  status: "failed" | "passed";
}

interface WakeValidationDependencies {
  acquirePower: (maximumRuntimeMs: number, markerPath: string) => WindowsPowerRequest;
  clearMarker: (path: string) => Promise<void>;
  holdMs: number;
  markerPath: string;
  now: () => Date;
  outputPath: string;
  powerRequests: () => Promise<string>;
  processAlive: (processId: number) => boolean;
  readMarker: (path: string) => Promise<string | null>;
  sleep: (milliseconds: number) => Promise<void>;
  writeResult: (path: string, result: WakeValidationResult) => Promise<void>;
}

export async function runWakeValidation(
  overrides: Partial<WakeValidationDependencies> = {},
): Promise<WakeValidationResult> {
  const paths = wakeValidationPaths();
  const dependencies: WakeValidationDependencies = {
    acquirePower: (maximumRuntimeMs, markerPath) =>
      acquireWindowsSystemPowerRequest(maximumRuntimeMs, { activationMarkerPath: markerPath }),
    clearMarker: async (path) => {
      await mkdir(dirname(path), { recursive: true });
      await rm(path, { force: true });
    },
    holdMs: wakeValidationHoldMs,
    markerPath: paths.markerPath,
    now: () => new Date(),
    outputPath: paths.outputPath,
    powerRequests: readPowerRequests,
    processAlive,
    readMarker: readActivationMarker,
    sleep: wait,
    writeResult: writeWakeValidationResult,
    ...overrides,
  };
  await dependencies.clearMarker(dependencies.markerPath);
  const startedAt = dependencies.now();
  const before = countPowerShellSystemRequests(await dependencies.powerRequests());
  const power = dependencies.acquirePower(dependencies.holdMs + 30_000, dependencies.markerPath);
  const processId = power.processId ?? null;
  let markerAt: string | null = null;
  let during = before;
  let helperAliveDuring = false;
  try {
    const activationDeadline = startedAt.getTime() + activationTimeoutMs;
    do {
      await dependencies.sleep(500);
      markerAt = await dependencies.readMarker(dependencies.markerPath);
      helperAliveDuring = processId !== null && dependencies.processAlive(processId);
      during = countPowerShellSystemRequests(await dependencies.powerRequests());
    } while (
      (!markerAt || !helperAliveDuring || during <= before) &&
      dependencies.now().getTime() < activationDeadline
    );
    const remainingHoldMs =
      dependencies.holdMs - (dependencies.now().getTime() - startedAt.getTime());
    if (remainingHoldMs > 0) await dependencies.sleep(remainingHoldMs);
  } finally {
    await power.release();
  }

  const releaseDeadline = dependencies.now().getTime() + releaseTimeoutMs;
  let helperAliveAfterRelease = processId !== null && dependencies.processAlive(processId);
  let after = countPowerShellSystemRequests(await dependencies.powerRequests());
  while (
    (helperAliveAfterRelease || after > before) &&
    dependencies.now().getTime() < releaseDeadline
  ) {
    await dependencies.sleep(500);
    helperAliveAfterRelease = processId !== null && dependencies.processAlive(processId);
    after = countPowerShellSystemRequests(await dependencies.powerRequests());
  }
  const activated = Boolean(markerAt) && helperAliveDuring && during > before;
  const released = !helperAliveAfterRelease && after <= before;
  const result: WakeValidationResult = {
    activated,
    activationMarkerAt: markerAt,
    completedAt: dependencies.now().toISOString(),
    helperAliveAfterRelease,
    helperAliveDuring,
    helperProcessId: processId,
    powerShellSystemRequests: { after, before, during },
    released,
    startedAt: startedAt.toISOString(),
    status: activated && released ? "passed" : "failed",
  };
  await dependencies.writeResult(dependencies.outputPath, result);
  return result;
}

export function countPowerShellSystemRequests(output: string): number {
  const systemSection =
    output.match(/(?:^|\r?\n)SYSTEM:\s*([\s\S]*?)(?:\r?\n[A-Z][A-Z ]+:|$)/i)?.[1] ?? "";
  return [...systemSection.matchAll(/powershell\.exe/gi)].length;
}

function wakeValidationPaths(): { markerPath: string; outputPath: string } {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is required for wake validation.");
  const directory = resolve(localAppData, "TSNewMusicRadar", "logs");
  return {
    markerPath: resolve(directory, "wake-validation-20260828.active"),
    outputPath: resolve(directory, "wake-validation-20260828.json"),
  };
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

async function readActivationMarker(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim() || null;
  } catch {
    return null;
  }
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
