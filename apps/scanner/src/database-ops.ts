import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { backupDirectory } from "./paths";

export interface DatabaseOperationCommand {
  args: string[];
  executable: string;
}

export function postgresBackupCommand(): DatabaseOperationCommand {
  return {
    args: ["compose", "exec", "-T", "db", "pg_dump", "-U", "radar", "-d", "radar", "-Fc"],
    executable: "docker",
  };
}

export function postgresRestoreCommand(): DatabaseOperationCommand {
  return {
    args: [
      "compose",
      "exec",
      "-T",
      "db",
      "pg_restore",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--exit-on-error",
      "-U",
      "radar",
      "-d",
      "radar",
    ],
    executable: "docker",
  };
}

export async function backupDatabase(
  environment: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Promise<string> {
  const directory = backupDirectory(environment);
  mkdirSync(directory, { recursive: true });
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const path = join(directory, `ts-new-music-radar-${timestamp}.dump`);
  if (existsSync(path)) throw new Error(`Backup already exists: ${path}`);
  await pipeProcessToFile(postgresBackupCommand(), path);
  writeFileSync(
    join(directory, "last-backup.json"),
    JSON.stringify(
      { completedAt: now.toISOString(), file: basename(path), format: "postgres-custom" },
      null,
      2,
    ),
    { encoding: "utf8", flag: "w" },
  );
  return path;
}

export async function restoreDatabase(file: string, confirmed: boolean): Promise<void> {
  if (!confirmed) {
    throw new Error(
      "Restore requires --confirm-replace-data because existing database data will be replaced.",
    );
  }
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`Backup file does not exist: ${path}`);
  if (!path.toLocaleLowerCase("en-US").endsWith(".dump")) {
    throw new Error("Restore requires a PostgreSQL custom-format .dump file.");
  }
  await pipeFileToProcess(path, postgresRestoreCommand());
}

function pipeProcessToFile(command: DatabaseOperationCommand, path: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = createWriteStream(path, { flags: "wx" });
    let errorOutput = "";
    let processClosed = false;
    let processSucceeded = false;
    let streamFinished = false;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      output.destroy();
      rmSync(path, { force: true });
      reject(error);
    };
    const complete = () => {
      if (settled || !processClosed || !processSucceeded || !streamFinished) return;
      settled = true;
      resolvePromise();
    };
    child.stdout.pipe(output);
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8").slice(0, 2_000);
    });
    child.once("error", (error) => fail(error));
    output.once("error", (error) => fail(error));
    output.once("finish", () => {
      streamFinished = true;
      complete();
    });
    child.once("close", (code) => {
      processClosed = true;
      processSucceeded = code === 0;
      if (!processSucceeded) {
        fail(
          new Error(`PostgreSQL backup failed with exit code ${code}: ${sanitize(errorOutput)}`),
        );
        return;
      }
      complete();
    });
  });
}

function pipeFileToProcess(path: string, command: DatabaseOperationCommand): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: process.cwd(),
      stdio: ["pipe", "inherit", "pipe"],
      windowsHide: true,
    });
    let errorOutput = "";
    const input = createReadStream(path);
    input.pipe(child.stdin);
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8").slice(0, 2_000);
    });
    input.once("error", reject);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`PostgreSQL restore failed with exit code ${code}: ${sanitize(errorOutput)}`),
        );
    });
  });
}

function sanitize(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[DATABASE_URL REDACTED]")
    .replace(/(?:password|secret|token)=\S+/gi, "$1=[REDACTED]")
    .trim()
    .slice(0, 1_000);
}
