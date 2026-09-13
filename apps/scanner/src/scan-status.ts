import { createDatabase, listOperationLocks, scanRuns, unlockStaleOperations } from "@radar/db";
import { desc } from "drizzle-orm";
import { loadLocalEnvironment } from "./local-env";

loadLocalEnvironment();
const operation = process.argv[2] ?? "status";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is required.\n");
  process.exitCode = 1;
} else {
  const { db, client } = createDatabase(databaseUrl);
  try {
    if (operation === "unlock-stale") {
      const count = await unlockStaleOperations(db);
      process.stdout.write(`Removed ${count} stale operation lock(s).\n`);
    } else if (operation === "status") {
      const locks = await listOperationLocks(db);
      const runs = await db.select().from(scanRuns).orderBy(desc(scanRuns.startedAt)).limit(10);
      process.stdout.write(
        `${JSON.stringify(
          {
            activeLocks: locks.map((lock) => ({
              acquiredAt: lock.acquiredAt,
              expiresAt: lock.expiresAt,
              lockKey: lock.lockKey,
              operationType: lock.operationType,
              stale: lock.stale,
            })),
            recentRuns: runs.map((run) => ({
              completedAt: run.completedAt,
              discovered: run.discoveredCount,
              duplicatesIgnored: run.duplicatesIgnoredCount,
              id: run.id,
              inserted: run.insertedCount,
              provider: run.provider,
              providersFailed: run.providersFailed,
              reviewItems: run.reviewCount,
              startedAt: run.startedAt,
              status: run.status,
              triggerType: run.triggerType,
            })),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      throw new Error("Expected status or unlock-stale.");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Scan status failed."}\n`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
