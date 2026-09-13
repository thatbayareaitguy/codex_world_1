import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadLocalEnvironment } from "./local-env";
import { applicationDataDirectory } from "./paths";
import { parsePid, runWebSupervisor } from "./web-supervisor";

loadLocalEnvironment();
const operation = process.argv[2];
const development = process.argv.includes("--development");
const runtimeDirectory = resolve(applicationDataDirectory(), "runtime");
const pidPath = resolve(runtimeDirectory, "web.pid");
const stopPath = resolve(runtimeDirectory, "web.stop");

try {
  if (operation === "up") {
    await runWebSupervisor({ development });
  } else if (operation === "down") {
    mkdirSync(runtimeDirectory, { recursive: true });
    writeFileSync(stopPath, "stop\n", { encoding: "utf8", flag: "w" });
    if (existsSync(pidPath)) {
      const pid = parsePid(readFileSync(pidPath, "utf8"));
      if (pid !== undefined) {
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
