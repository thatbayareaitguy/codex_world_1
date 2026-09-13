import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceEnvironmentPath = resolve(scriptDirectory, "..", "..", "..", ".env");
if (existsSync(workspaceEnvironmentPath)) {
  const inheritedEnvironment = { ...process.env };
  process.loadEnvFile(workspaceEnvironmentPath);
  Object.assign(process.env, inheritedEnvironment);
}

const nextExecutable = resolve(
  scriptDirectory,
  "..",
  "node_modules",
  "next",
  "dist",
  "bin",
  "next",
);
const child = spawn(process.execPath, [nextExecutable, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  throw error;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
