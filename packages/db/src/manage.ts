import { spawnSync } from "node:child_process";

const command = process.argv[2];
if (command !== "up" && command !== "down") {
  throw new Error("Usage: tsx packages/db/src/manage.ts <up|down>");
}

const args = command === "up" ? ["compose", "up", "-d", "db", "db-test"] : ["compose", "down"];
const result = spawnSync("docker", args, { stdio: "inherit", shell: false });

if (result.error && "code" in result.error && result.error.code === "ENOENT") {
  throw new Error(
    "Docker CLI was not found. Install and start Docker Desktop, then rerun pnpm db:up.",
  );
}
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`docker ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
}
