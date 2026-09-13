import { execFile } from "node:child_process";

export type DockerDatabaseAvailability = "healthy" | "not_inspectable" | "running" | "unavailable";

export interface MaintenanceReadinessAttempt {
  attempt: number;
  attemptedAt: Date;
  dockerAvailability: DockerDatabaseAvailability;
  elapsedMs: number;
  errorClassification: string | null;
  postgresReady: boolean;
}

export class MaintenanceDatabaseReadinessError extends Error {
  constructor(
    readonly attempts: number,
    readonly elapsedMs: number,
  ) {
    super(`PostgreSQL was not ready after ${attempts} attempt(s) over ${elapsedMs} ms.`);
    this.name = "MaintenanceDatabaseReadinessError";
  }
}

export async function waitForMaintenanceDatabase<T>(input: {
  close(connection: T): Promise<void>;
  inspectDocker(): Promise<DockerDatabaseAvailability>;
  now(): Date;
  open(): T;
  probe(connection: T): Promise<void>;
  record(attempt: MaintenanceReadinessAttempt): void;
  retryIntervalMs: number;
  sleep(milliseconds: number): Promise<void>;
  timeoutMs: number;
}): Promise<T> {
  const startedAt = input.now();
  let attempt = 0;
  while (true) {
    attempt += 1;
    const attemptedAt = input.now();
    let connection: T | null = null;
    let postgresReady = false;
    let errorClassification: string | null = null;
    const dockerInspection = input.inspectDocker().catch(() => "not_inspectable" as const);
    try {
      connection = input.open();
      await input.probe(connection);
      postgresReady = true;
    } catch (error) {
      errorClassification = classifyReadinessError(error);
    }
    const elapsedMs = Math.max(0, input.now().getTime() - startedAt.getTime());
    input.record({
      attempt,
      attemptedAt,
      dockerAvailability: await dockerInspection,
      elapsedMs,
      errorClassification,
      postgresReady,
    });
    if (postgresReady && connection) return connection;
    if (connection) await input.close(connection).catch(() => undefined);
    if (elapsedMs >= input.timeoutMs) {
      throw new MaintenanceDatabaseReadinessError(attempt, elapsedMs);
    }
    await input.sleep(Math.min(input.retryIntervalMs, input.timeoutMs - elapsedMs));
  }
}

export function inspectDockerDatabaseAvailability(
  dependencies: {
    cwd?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<DockerDatabaseAvailability> {
  if ((dependencies.platform ?? process.platform) !== "win32") {
    return Promise.resolve("not_inspectable");
  }
  return new Promise((resolve) => {
    execFile(
      "docker.exe",
      ["compose", "ps", "--format", "json", "db"],
      {
        cwd: dependencies.cwd ?? process.cwd(),
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve("not_inspectable");
          return;
        }
        const output = stdout.trim().toLowerCase();
        if (!output) {
          resolve("unavailable");
          return;
        }
        if (output.includes('"health":"healthy"')) {
          resolve("healthy");
          return;
        }
        resolve(output.includes('"state":"running"') ? "running" : "unavailable");
      },
    );
  });
}

function classifyReadinessError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code).trim();
    if (code) return code.slice(0, 80);
  }
  if (error instanceof Error && error.name) return error.name.slice(0, 80);
  return "unknown_error";
}
