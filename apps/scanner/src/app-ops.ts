import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadLocalEnvironment } from "./local-env";
import { applicationDataDirectory, logDirectory } from "./paths";

loadLocalEnvironment();
const operation = process.argv[2];
const development = process.argv.includes("--development");
const runtimeDirectory = resolve(applicationDataDirectory(), "runtime");
const pidPath = resolve(runtimeDirectory, "web.pid");

try {
  if (operation === "up") {
    mkdirSync(runtimeDirectory, { recursive: true });
    mkdirSync(logDirectory(), { recursive: true });
    await run("docker", ["compose", "up", "-d", "db"]);
    await runPackageManager(["db:migrate"]);
    if (!development && !existsSync(resolve("apps", "web", ".next", "BUILD_ID"))) {
      await runPackageManager(["build"]);
    }
    const args = development
      ? ["--filter", "@radar/web", "dev", "--hostname", "127.0.0.1", "--port", "3000"]
      : ["--filter", "@radar/web", "start", "--hostname", "127.0.0.1", "--port", "3000"];
    const command = packageManagerCommand(args);
    const child = spawn(command.executable, command.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    writeFileSync(pidPath, String(child.pid), { encoding: "utf8", flag: "w" });
    child.once("exit", (code) => {
      rmSync(pidPath, { force: true });
      process.exitCode = code ?? 1;
    });
  } else if (operation === "down") {
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          if (process.platform === "win32") {
            await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
          } else {
            process.kill(pid, "SIGTERM");
          }
        } catch {
          // The recorded local process is already stopped.
        }
      }
      rmSync(pidPath, { force: true });
    }
    await run("docker", ["compose", "stop", "db"]);
    process.stdout.write("Local application services stopped. Database volume was preserved.\n");
  } else {
    throw new Error("Expected app operation up or down.");
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Application operation failed."}\n`,
  );
  process.exitCode = 1;
}

function run(executable: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${executable} ${args.join(" ")} failed with exit code ${code}.`));
    });
  });
}

function runPackageManager(args: string[]): Promise<void> {
  const command = packageManagerCommand(args);
  return run(command.executable, command.args);
}

function packageManagerCommand(args: string[]): { args: string[]; executable: string } {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (npmExecPath && /\.(?:cjs|mjs|js)$/i.test(npmExecPath)) {
    return { args: [npmExecPath, ...args], executable: process.execPath };
  }
  if (process.platform === "win32") {
    return {
      args: ["/d", "/s", "/c", "pnpm.cmd", ...args],
      executable: process.env.ComSpec ?? "cmd.exe",
    };
  }
  return { args, executable: "pnpm" };
}
