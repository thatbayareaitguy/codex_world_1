// Compatibility launcher. Showcase orchestration lives outside the scanner package.
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/showcase-publish.ts")], {
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
