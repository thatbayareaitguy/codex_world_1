import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import {
  initializeBudget,
  updateRuntimeDirectory,
  withUpdateBudget,
} from "./showcase-update-budget";
import { scheduledSlot } from "./showcase-update-policy";
import { publishShowcaseCatalog } from "./showcase-publish";

const website = "https://showcasedm-showcase-edm.vercel.app";

async function deploy(): Promise<void> {
  // Never hand the scanner/publisher/provider environment to the deployment subprocess.
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
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(".app-runtime/deployer/node_modules/vercel/dist/index.js"),
        "deploy",
        "--prod",
        "--yes",
      ],
      {
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdout.on("data", (data: Buffer) => process.stdout.write(data));
    child.stderr.on("data", (data: Buffer) => process.stderr.write(data));
    const timeout = setTimeout(() => {
      if (child.pid && process.platform === "win32")
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else child.kill();
      reject(new Error("Deployment deadline exceeded."));
    }, 25 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(new Error("Vercel deployment failed."));
    });
  });
}

async function liveHash(): Promise<string | undefined> {
  try {
    const response = await fetch(`${website}/api/catalog-status`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return undefined;
    const result: unknown = await response.json();
    return typeof result === "object" &&
      result !== null &&
      "contentSha256" in result &&
      typeof result.contentSha256 === "string"
      ? result.contentSha256
      : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--initialize-budget")) {
    await initializeBudget();
    return;
  }
  const scheduled = process.argv.includes("--scheduled");
  const slot = scheduled ? scheduledSlot(new Date()) : "manual";
  if (!slot) return;
  process.env.SHOWCASE_SCANNER_ENV_PATH ??= resolve("../codex_world_1/.env");
  const branch = spawnSync("git", ["branch", "--show-current"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (branch.status !== 0 || branch.stdout.trim() !== "codex/showcase-public-site")
    throw new Error("Wrong publication worktree.");
  if (scheduled) {
    const diff = spawnSync("git", ["diff", "HEAD", "--name-only"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const allowed = new Set([
      "apps/showcase/lib/generated-public-catalog.json",
      "apps/showcase/lib/confirmed-artist-genres.json",
      "apps/showcase/next-env.d.ts",
    ]);
    const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (
      diff.status !== 0 ||
      untracked.status !== 0 ||
      untracked.stdout.trim() !== "" ||
      diff.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .some((file) => !allowed.has(file))
    )
      throw new Error("Uncommitted application edits block unattended deployment.");
    process.env.SHOWCASE_PUBLICATION_SCHEDULED = "true";
  }
  const directory = updateRuntimeDirectory();
  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  try {
    const result = await withUpdateBudget(slot, async () => {
      const publication = await publishShowcaseCatalog();
      const alreadyLive = (await liveHash()) === publication.contentSha256;
      const deployed = !alreadyLive || process.argv.includes("--deploy-code");
      if (deployed) await deploy();
      if ((await liveHash()) !== publication.contentSha256)
        throw new Error("Live catalog verification failed.");
      return {
        state: "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        slot,
        deployed,
        ...publication,
      };
    });
    if (result) {
      await writeFile(resolve(directory, "latest.json.tmp"), JSON.stringify(result, null, 2));
      await rename(resolve(directory, "latest.json.tmp"), resolve(directory, "latest.json"));
      await appendFile(resolve(directory, "history.jsonl"), `${JSON.stringify(result)}\n`);
      console.info(JSON.stringify(result));
    }
  } catch {
    const result = {
      state: "failed_or_deferred",
      startedAt,
      finishedAt: new Date().toISOString(),
      slot,
      message:
        "Check scanner readiness, transfer budget, publication lock, Feed, Neon, and Vercel authentication. Existing site remains on its last successful deployment.",
    };
    await writeFile(resolve(directory, "latest.json"), JSON.stringify(result, null, 2));
    await appendFile(resolve(directory, "history.jsonl"), `${JSON.stringify(result)}\n`);
    throw new Error(result.message);
  }
}

void main().catch(() => {
  console.error(
    "Showcase update failed or deferred. See the private publication/latest.json and transfer-budget.json. No credentials are logged.",
  );
  process.exitCode = 1;
});
