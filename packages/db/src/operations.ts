import { and, eq, gt, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RadarDatabase } from "./client";
import { operationLocks, scanRuns } from "./schema";

export interface OperationLockHandle {
  lockKey: string;
  ownerToken: string;
}

export async function acquireOperationLock(
  db: RadarDatabase,
  input: {
    lockKey: string;
    metadata?: Record<string, unknown>;
    operationType: string;
    ttlMs?: number;
  },
): Promise<OperationLockHandle> {
  const now = new Date();
  await db
    .delete(operationLocks)
    .where(and(eq(operationLocks.lockKey, input.lockKey), lt(operationLocks.expiresAt, now)));
  const ownerToken = randomUUID();
  const [lock] = await db
    .insert(operationLocks)
    .values({
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? 2 * 60 * 60_000)),
      lockKey: input.lockKey,
      metadata: input.metadata ?? {},
      operationType: input.operationType,
      ownerToken,
    })
    .onConflictDoNothing()
    .returning({ lockKey: operationLocks.lockKey });
  if (!lock) throw new Error(`Operation ${input.lockKey} is already running.`);
  return { lockKey: input.lockKey, ownerToken };
}

export async function releaseOperationLock(
  db: RadarDatabase,
  handle: OperationLockHandle,
): Promise<void> {
  await db
    .delete(operationLocks)
    .where(
      and(
        eq(operationLocks.lockKey, handle.lockKey),
        eq(operationLocks.ownerToken, handle.ownerToken),
      ),
    );
}

export async function heartbeatOperationLock(
  db: RadarDatabase,
  handle: OperationLockHandle,
  metadata: Record<string, unknown>,
  ttlMs = 2 * 60 * 60_000,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(operationLocks)
    .set({
      expiresAt: new Date(now.getTime() + ttlMs),
      metadata: sql`${operationLocks.metadata} || ${JSON.stringify({
        ...metadata,
        heartbeatAt: now.toISOString(),
      })}::jsonb`,
    })
    .where(
      and(
        eq(operationLocks.lockKey, handle.lockKey),
        eq(operationLocks.ownerToken, handle.ownerToken),
      ),
    )
    .returning({ lockKey: operationLocks.lockKey });
  return rows.length === 1;
}

export async function operationCancellationRequested(
  db: RadarDatabase,
  handle: OperationLockHandle,
): Promise<boolean> {
  const lock = await db.query.operationLocks.findFirst({
    where: and(
      eq(operationLocks.lockKey, handle.lockKey),
      eq(operationLocks.ownerToken, handle.ownerToken),
    ),
    columns: { metadata: true },
  });
  return isRecord(lock?.metadata) && lock.metadata.cancelRequested === true;
}

export async function requestOperationCancellation(
  db: RadarDatabase,
  lockKey: string,
): Promise<boolean> {
  const rows = await db
    .update(operationLocks)
    .set({
      metadata: sql`${operationLocks.metadata} || ${JSON.stringify({
        cancelRequested: true,
        cancellationRequestedAt: new Date().toISOString(),
      })}::jsonb`,
    })
    .where(and(eq(operationLocks.lockKey, lockKey), gt(operationLocks.expiresAt, new Date())))
    .returning({ lockKey: operationLocks.lockKey });
  return rows.length === 1;
}

export async function listOperationLocks(db: RadarDatabase) {
  const now = new Date();
  const locks = await db.select().from(operationLocks);
  return locks.map((lock) => ({ ...lock, stale: lock.expiresAt <= now }));
}

export async function unlockStaleOperations(db: RadarDatabase): Promise<number> {
  const rows = await db
    .delete(operationLocks)
    .where(lt(operationLocks.expiresAt, new Date()))
    .returning({ lockKey: operationLocks.lockKey });
  return rows.length;
}

export async function expireDetailedScanData(db: RadarDatabase, now = new Date()): Promise<number> {
  const rows = await db
    .update(scanRuns)
    .set({ errors: [], metadata: {}, providerResults: {} })
    .where(
      and(
        lt(scanRuns.detailedExpiresAt, now),
        sql`(${scanRuns.errors} <> '[]'::jsonb or ${scanRuns.metadata} <> '{}'::jsonb or ${scanRuns.providerResults} <> '{}'::jsonb)`,
      ),
    )
    .returning({ id: scanRuns.id });
  return rows.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
