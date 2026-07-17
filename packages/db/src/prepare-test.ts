import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { createDatabase } from "./client";
import { runMigrations } from "./migration";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";

function startTestDatabase(): void {
  const result = spawnSync("docker", ["compose", "up", "-d", "db-test"], {
    stdio: "inherit",
    shell: false,
  });
  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    throw new Error(
      "Database integration tests require Docker Desktop. Install and start Docker, then rerun pnpm test:integration.",
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Unable to start the test PostgreSQL service (docker exit ${result.status ?? "unknown"}). Start Docker Desktop and rerun pnpm test:integration.`,
    );
  }
}

async function waitForDatabase(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = postgres(TEST_DATABASE_URL, { connect_timeout: 2, max: 1 });
    try {
      await client`select 1`;
      await client.end();
      return;
    } catch {
      await client.end({ timeout: 0 });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(
    "The test PostgreSQL service did not become healthy within 60 seconds. Run docker compose logs db-test.",
  );
}

export async function resetTestDatabase(): Promise<void> {
  startTestDatabase();
  await waitForDatabase();
  const resetClient = postgres(TEST_DATABASE_URL, { max: 1 });
  try {
    await resetClient.unsafe("drop schema if exists public cascade");
    await resetClient.unsafe("drop schema if exists drizzle cascade");
    await resetClient.unsafe("create schema public");
  } finally {
    await resetClient.end();
  }

  const { db, client } = createDatabase(TEST_DATABASE_URL);
  try {
    await runMigrations(db);
  } finally {
    await client.end();
  }
}

await resetTestDatabase();
console.log(JSON.stringify({ level: "info", event: "database.test_ready" }));
