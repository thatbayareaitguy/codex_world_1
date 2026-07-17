import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

type SpawnProcess = typeof spawn;

export interface ScanLaunchResult {
  pid: number | null;
}

export async function launchScanNow(
  spawnProcess: SpawnProcess = spawn,
  environment: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
  scanArguments: string[] = [],
): Promise<ScanLaunchResult> {
  const workspaceRoot = findWorkspaceRoot(startDirectory);
  const command = packageManagerCommand(["scan", ...scanArguments], environment);
  const child = spawnProcess(command.executable, command.args, {
    cwd: workspaceRoot,
    detached: process.platform !== "win32",
    env: environment,
    stdio: "ignore",
    windowsHide: true,
  });

  await new Promise<void>((resolvePromise, reject) => {
    child.once("spawn", resolvePromise);
    child.once("error", reject);
  });
  child.unref();
  return { pid: child.pid ?? null };
}

function findWorkspaceRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  const root = parse(current).root;
  while (true) {
    if (existsSync(resolve(current, "pnpm-workspace.yaml"))) return current;
    if (current === root) break;
    current = dirname(current);
  }
  throw new Error("Unable to locate the application workspace");
}

function packageManagerCommand(
  args: string[],
  environment: NodeJS.ProcessEnv,
): { args: string[]; executable: string } {
  const npmExecPath = environment.npm_execpath?.trim();
  if (npmExecPath && /\.(?:cjs|mjs|js)$/i.test(npmExecPath)) {
    return { args: [npmExecPath, ...args], executable: process.execPath };
  }
  if (process.platform === "win32") {
    return {
      args: ["/d", "/s", "/c", "pnpm.cmd", ...args],
      executable: environment.ComSpec ?? "cmd.exe",
    };
  }
  return { args, executable: "pnpm" };
}
