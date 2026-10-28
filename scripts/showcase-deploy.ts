import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { deploymentFailure } from "./showcase-deployment-diagnostics";
import { publicationStage } from "./showcase-diagnostics";

function deploymentEnvironment(): NodeJS.ProcessEnv {
  // Never pass scanner, publisher, provider, or database credentials to the CLI.
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "LOCALAPPDATA",
    "APPDATA",
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

async function runVercelCommand(arguments_: readonly string[], deadline: number): Promise<void> {
  if (Date.now() >= deadline) throw new Error("Deployment deadline exceeded.");
  await new Promise<void>((resolvePromise, reject) => {
    let outputTail = "";
    const child = spawn(
      process.execPath,
      [resolve(".app-runtime/deployer/node_modules/vercel/dist/index.js"), ...arguments_],
      { env: deploymentEnvironment(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const capture = (data: Buffer) => {
      outputTail = (outputTail + data.toString("utf8")).slice(-32_768);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(
      () => {
        if (child.pid && process.platform === "win32")
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
        else child.kill();
        reject(new Error("Deployment deadline exceeded."));
      },
      Math.max(1, deadline - Date.now()),
    );
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(deploymentFailure(outputTail, { exitCode: code, signal }));
    });
  });
}

export async function deployShowcase(deadline: number): Promise<void> {
  // Vercel CLI 62.2.0 refreshes auth independently in concurrent project/owner
  // lookups. An expired stored session can race its single-use refresh token.
  // whoami makes one serial authenticated lookup and persists the refreshed
  // session before the deploy process loads it. No token is read or copied here.
  await publicationStage("deployment-auth");
  await runVercelCommand(["whoami", "--non-interactive"], Math.min(deadline, Date.now() + 60_000));
  await publicationStage("deployment");
  await runVercelCommand(["deploy", "--prod", "--yes", "--non-interactive"], deadline);
}
