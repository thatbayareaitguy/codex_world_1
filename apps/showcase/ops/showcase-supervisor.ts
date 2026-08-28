import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const healthUrl = "http://127.0.0.1:3200/releases";
const healthPollIntervalMs = 5_000;
const healthFailureLimit = 3;
const startupTimeoutMs = 60_000;

interface RuntimePaths {
  logPath: string;
  pidPath: string;
  stopPath: string;
  supervisorPidPath: string;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface FileSnapshot {
  content: string;
  path: string;
}

export async function runShowcaseSupervisor(): Promise<void> {
  const paths = prepareRuntimePaths();
  const log = (message: string): void => writeLog(paths.logPath, message);
  let ownedChild: ChildProcess | undefined;
  let shutdownRequested = false;

  if (!claimSupervisorPid(paths.supervisorPidPath, process.pid)) {
    log("Another Showcase supervisor is already running; this invocation is exiting.");
    return;
  }

  rmSync(paths.stopPath, { force: true });
  const requestShutdown = (): void => {
    shutdownRequested = true;
    if (ownedChild?.pid) void terminateProcessTree(ownedChild.pid, paths.logPath);
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);
  log(`Showcase supervisor started with PID ${process.pid}.`);

  try {
    let restartCount = 0;
    for (;;) {
      if (shutdownRequested || consumeStopRequest(paths.stopPath)) {
        log("Showcase supervisor received a stop request.");
        return;
      }

      if (await healthResponds()) {
        clearStalePidFile(paths.pidPath);
        log("Showcase is already healthy; no duplicate server was started.");
        const result = await monitorExternalHealth(paths.stopPath, () => shutdownRequested);
        if (result === "stop") return;
        log("The previously healthy Showcase server stopped responding; recovery is starting.");
      }

      clearStalePidFile(paths.pidPath);
      if (await healthResponds()) continue;

      const nextEnvironmentSnapshot = captureNextEnvironmentFile();
      const child = startShowcaseProcess(paths.logPath);
      ownedChild = child;
      if (!child.pid) throw new Error("The Showcase process started without a process ID.");
      replacePidFile(paths.pidPath, child.pid);
      log(`Started the loopback Showcase process with PID ${child.pid}.`);

      const startup = await waitForStartup(child, paths.stopPath, () => shutdownRequested);
      restoreNextEnvironmentFile(nextEnvironmentSnapshot, paths.logPath);
      if (startup === "stop") {
        await terminateAndWait(child, paths.logPath);
        removeOwnedPidFile(paths.pidPath, child.pid);
        return;
      }
      if (startup === "failed") {
        await terminateAndWait(child, paths.logPath);
        removeOwnedPidFile(paths.pidPath, child.pid);
        ownedChild = undefined;
        restartCount += 1;
        log("Showcase did not become healthy before the startup deadline.");
        await delay(restartDelayMs(restartCount));
        continue;
      }

      restartCount = 0;
      log(`Showcase is healthy at ${healthUrl}.`);
      const result = await monitorOwnedProcess(
        child,
        paths.stopPath,
        paths.logPath,
        () => shutdownRequested,
      );
      removeOwnedPidFile(paths.pidPath, child.pid);
      ownedChild = undefined;

      if (result.kind === "stop") return;

      restartCount += 1;
      const detail =
        result.kind === "unhealthy"
          ? "the health page stopped responding"
          : `the process exited with code ${result.exit.code ?? "none"} and signal ${result.exit.signal ?? "none"}`;
      log(`Showcase recovery scheduled because ${detail}.`);
      await delay(restartDelayMs(restartCount));
    }
  } finally {
    process.removeListener("SIGINT", requestShutdown);
    process.removeListener("SIGTERM", requestShutdown);
    if (ownedChild?.pid) await terminateAndWait(ownedChild, paths.logPath);
    removeOwnedPidFile(paths.supervisorPidPath, process.pid);
  }
}

export function parsePid(value: string): number | undefined {
  const pid = Number(value.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

export function clearStalePidFile(
  pidPath: string,
  processIsAlive: (pid: number) => boolean = isProcessAlive,
): boolean {
  if (!existsSync(pidPath)) return false;
  let pid: number | undefined;
  try {
    pid = parsePid(readFileSync(pidPath, "utf8"));
  } catch {
    rmSync(pidPath, { force: true });
    return true;
  }
  if (pid !== undefined && processIsAlive(pid)) return false;
  rmSync(pidPath, { force: true });
  return true;
}

export function claimSupervisorPid(
  pidPath: string,
  pid: number,
  processIsAlive: (candidate: number) => boolean = isProcessAlive,
): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(pidPath, String(pid), { encoding: "utf8", flag: "wx" });
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      let existingPid: number | undefined;
      try {
        existingPid = parsePid(readFileSync(pidPath, "utf8"));
      } catch {
        // Invalid and concurrently removed records are stale.
      }
      if (existingPid !== undefined && existingPid !== pid && processIsAlive(existingPid)) {
        return false;
      }
      if (existingPid === pid) return true;
      rmSync(pidPath, { force: true });
    }
  }
  return false;
}

export function restartDelayMs(restartCount: number): number {
  return Math.min(30_000, Math.max(1, restartCount) * 5_000);
}

function prepareRuntimePaths(): RuntimePaths {
  const base = resolve(
    process.env.LOCALAPPDATA ?? resolve(homedir(), ".local", "share"),
    "ShowcasePublicSite",
  );
  const runtime = resolve(base, "runtime");
  const logs = resolve(base, "logs");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(logs, { recursive: true });
  return {
    logPath: resolve(logs, "showcase-supervisor.log"),
    pidPath: resolve(runtime, "showcase.pid"),
    stopPath: resolve(runtime, "showcase.stop"),
    supervisorPidPath: resolve(runtime, "showcase-supervisor.pid"),
  };
}

function startShowcaseProcess(logPath: string): ChildProcess {
  const logHandle = openSync(logPath, "a");
  try {
    return spawn(
      process.execPath,
      [nextExecutable(), "dev", "--hostname", "127.0.0.1", "--port", "3200"],
      {
        cwd: resolve("apps", "showcase"),
        env: {
          ...process.env,
          NEXT_DIST_DIR: ".next-dev",
          NEXT_TELEMETRY_DISABLED: "1",
          SHOWCASE_GENRE_ADMIN_ENABLED: "true",
        },
        stdio: ["ignore", logHandle, logHandle],
        windowsHide: true,
      },
    );
  } finally {
    closeSync(logHandle);
  }
}

function nextExecutable(): string {
  return resolve("apps", "showcase", "node_modules", "next", "dist", "bin", "next");
}

function captureNextEnvironmentFile(): FileSnapshot | undefined {
  const path = resolve("apps", "showcase", "next-env.d.ts");
  if (!existsSync(path)) return undefined;
  return { content: readFileSync(path, "utf8"), path };
}

function restoreNextEnvironmentFile(snapshot: FileSnapshot | undefined, logPath: string): void {
  if (!snapshot || !existsSync(snapshot.path)) return;
  const current = readFileSync(snapshot.path, "utf8");
  if (current === snapshot.content) return;
  if (!current.includes('import "./.next-dev/dev/types/routes.d.ts";')) {
    writeLog(
      logPath,
      "The changed next-env.d.ts was not the expected generated dev update; it was preserved.",
    );
    return;
  }
  writeFileSync(snapshot.path, snapshot.content, "utf8");
  writeLog(
    logPath,
    "Restored next-env.d.ts after Next.js generated its development type reference.",
  );
}

async function waitForStartup(
  child: ChildProcess,
  stopPath: string,
  shutdownRequested: () => boolean,
): Promise<"failed" | "healthy" | "stop"> {
  const deadline = Date.now() + startupTimeoutMs;
  const exit = waitForExit(child);
  while (Date.now() < deadline) {
    if (shutdownRequested() || consumeStopRequest(stopPath)) return "stop";
    if (await healthResponds()) return "healthy";
    const result = await Promise.race([
      exit.then(() => "exit" as const),
      delay(1_000).then(() => "wait" as const),
    ]);
    if (result === "exit") return "failed";
  }
  return "failed";
}

async function monitorExternalHealth(
  stopPath: string,
  shutdownRequested: () => boolean,
): Promise<"stop" | "unhealthy"> {
  let failures = 0;
  for (;;) {
    if (shutdownRequested() || consumeStopRequest(stopPath)) return "stop";
    await delay(healthPollIntervalMs);
    failures = (await healthResponds()) ? 0 : failures + 1;
    if (failures >= healthFailureLimit) return "unhealthy";
  }
}

async function monitorOwnedProcess(
  child: ChildProcess,
  stopPath: string,
  logPath: string,
  shutdownRequested: () => boolean,
): Promise<{ kind: "exit"; exit: ProcessExit } | { kind: "stop" } | { kind: "unhealthy" }> {
  const exit = waitForExit(child);
  let failures = 0;
  for (;;) {
    if (shutdownRequested() || consumeStopRequest(stopPath)) {
      await terminateAndWait(child, logPath);
      return { kind: "stop" };
    }
    const outcome = await Promise.race([
      exit.then((value) => ({ kind: "exit" as const, value })),
      delay(healthPollIntervalMs).then(() => ({ kind: "poll" as const })),
    ]);
    if (outcome.kind === "exit") return { exit: outcome.value, kind: "exit" };
    failures = (await healthResponds()) ? 0 : failures + 1;
    if (failures >= healthFailureLimit) {
      await terminateAndWait(child, logPath);
      return { kind: "unhealthy" };
    }
  }
}

async function healthResponds(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function waitForExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolvePromise) => {
    child.once("error", () => resolvePromise({ code: 1, signal: null }));
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

async function terminateAndWait(child: ChildProcess, logPath: string): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exit = waitForExit(child);
  await terminateProcessTree(child.pid, logPath);
  await Promise.race([exit, delay(10_000)]);
}

async function terminateProcessTree(pid: number, logPath: string): Promise<void> {
  try {
    if (process.platform === "win32") {
      await runLogged("taskkill", ["/PID", String(pid), "/T", "/F"], process.cwd(), logPath);
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch (error) {
    writeLog(
      logPath,
      `Process ${pid} was already stopped or could not be terminated: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function runLogged(
  executable: string,
  args: string[],
  cwd: string,
  logPath: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const logHandle = openSync(logPath, "a");
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", logHandle, logHandle],
      windowsHide: true,
    });
    closeSync(logHandle);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${executable} failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

function replacePidFile(pidPath: string, pid: number): void {
  const temporaryPath = `${pidPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, String(pid), { encoding: "utf8", flag: "w" });
  rmSync(pidPath, { force: true });
  renameSync(temporaryPath, pidPath);
}

function removeOwnedPidFile(pidPath: string, pid: number | undefined): void {
  if (pid === undefined || !existsSync(pidPath)) return;
  try {
    if (parsePid(readFileSync(pidPath, "utf8")) === pid) rmSync(pidPath, { force: true });
  } catch {
    // Another process may be replacing the runtime record.
  }
}

function consumeStopRequest(stopPath: string): boolean {
  if (!existsSync(stopPath)) return false;
  rmSync(stopPath, { force: true });
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeLog(logPath: string, message: string): void {
  appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}
