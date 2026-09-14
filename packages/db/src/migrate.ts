import { createDatabase } from "./client";
import { runMigrations } from "./migration";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (!process.env.DATABASE_URL) {
  const candidates = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "..", "..", ".env")];
  const environmentPath = candidates.find(existsSync);
  if (environmentPath) process.loadEnvFile(environmentPath);
}

const { db, client } = createDatabase();

try {
  await runMigrations(db);
  console.log(JSON.stringify({ level: "info", event: "database.migrated" }));
} finally {
  await client.end();
}
