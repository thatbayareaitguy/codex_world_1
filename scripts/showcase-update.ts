import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deploymentFailure } from "./showcase-deployment-diagnostics";
import { recoverOnce } from "./showcase-recovery";
import {
  initializeBudget,
  updateRuntimeDirectory,
  withUpdateBudget,
} from "./showcase-update-budget";
import { scheduledSlot } from "./showcase-update-policy";
import { publishShowcaseCatalog } from "./showcase-publish";
import {
  diagnosticDetails,
  publicationStage,
  safeFailure,
  withPublicationDiagnostics,
} from "./showcase-diagnostics";

const website = "https://showcasedm-showcase-edm.vercel.app";

async function deploy(deadline: number): Promise<void> {
  if (Date.now() >= deadline) throw new Error("Deployment deadline exceeded.");
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
    let outputTail = "";
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
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else reject(deploymentFailure(outputTail));
    });
  });
}

async function liveHash(): Promise<string> {
  try {
    const response = await fetch(`${website}/api/catalog-status`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("Live catalog status could not be read.");
    const result: unknown = await response.json();
    if (
      typeof result === "object" &&
      result !== null &&
      "contentSha256" in result &&
      typeof result.contentSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(result.contentSha256)
    )
      return result.contentSha256;
    throw new Error("Live catalog status could not be read.");
  } catch {
    throw new Error("Live catalog status could not be read.");
  }
}

export async function runShowcaseUpdate(): Promise<void> {
  if (process.argv.includes("--initialize-budget")) {
    await initializeBudget();
    return;
  }
  const scheduled = process.argv.includes("--scheduled");
  const slot = scheduled ? scheduledSlot(new Date()) : "manual";
  if (!slot) return;
  const directory = updateRuntimeDirectory();
  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  try {
    await publicationStage("preflight");
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
    await publicationStage("budget");
    const result = await withUpdateBudget(slot, async (reserveRecovery) => {
      const publication = await publishShowcaseCatalog(reserveRecovery);
      await publicationStage("live-status");
      const alreadyLive =
        (await recoverOnce("live-status", liveHash, reserveRecovery)) === publication.contentSha256;
      const deployed = !alreadyLive || process.argv.includes("--deploy-code");
      if (deployed) {
        await publicationStage("deployment");
        const deadline = Date.now() + 25 * 60_000;
        let attempted = false;
        await recoverOnce(
          "deployment",
          async () => {
            // A CLI error can occur after deployment succeeded. Check before retrying
            // an upload, and never repeat Feed enrichment or the Neon publishing write.
            if (
              attempted &&
              (await liveHash()) === publication.contentSha256 &&
              !process.argv.includes("--deploy-code")
            )
              return;
            attempted = true;
            await deploy(deadline);
          },
          reserveRecovery,
        );
      }
      await publicationStage("live-verification");
      await recoverOnce(
        "live-verification",
        async () => {
          if ((await liveHash()) !== publication.contentSha256)
            throw new Error("Live catalog verification failed.");
        },
        reserveRecovery,
      );
      return {
        state: "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        slot,
        deployed,
        ...diagnosticDetails(),
        ...publication,
      };
    });
    if (result) {
      await publicationStage("record-outcome");
      await writeFile(resolve(directory, "latest.json.tmp"), JSON.stringify(result, null, 2));
      await rename(resolve(directory, "latest.json.tmp"), resolve(directory, "latest.json"));
      await appendFile(resolve(directory, "history.jsonl"), `${JSON.stringify(result)}\n`);
      console.info(JSON.stringify(result));
    }
  } catch (error) {
    const result = {
      state: "failed_or_deferred",
      startedAt,
      finishedAt: new Date().toISOString(),
      slot,
      ...diagnosticDetails(),
      ...safeFailure(error),
      message:
        "Check scanner readiness, transfer budget, publication lock, Feed, Neon, and Vercel authentication. Existing site remains on its last successful deployment.",
    };
    await writeFile(resolve(directory, "latest.json"), JSON.stringify(result, null, 2));
    await appendFile(resolve(directory, "history.jsonl"), `${JSON.stringify(result)}\n`);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void withPublicationDiagnostics(runShowcaseUpdate).catch(() => {
    console.error(
      "Showcase update failed or deferred. See the private publication/latest.json and transfer-budget.json. No credentials are logged.",
    );
    process.exitCode = 1;
  });
}
