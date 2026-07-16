import { createDatabase } from "./client";
import { runMigrations } from "./migration";

const { db, client } = createDatabase();

try {
  await runMigrations(db);
  console.log(JSON.stringify({ level: "info", event: "database.migrated" }));
} finally {
  await client.end();
}
